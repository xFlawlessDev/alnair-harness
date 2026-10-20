//! Session tab model: the pager's ordered list of open sessions.
//!
//! A tab is a *view* of a session, not a session: it holds the stable
//! `session_id` (which survives a client restart) rather than the process-local
//! `AgentId`, which is only a cache resolved at render time. That is what makes
//! a tab list shared between two processes meaningful — both sides name the same
//! sessions.
//!
//! Every operation here is pure. The store ([`store`]) and the dispatcher own
//! the I/O and the `ActiveView` switch; this module only answers "what does the
//! list look like now".
//!
//! ## Why a tab carries its own cwd
//!
//! The strip can be global (one list across every repo the leader hosts). A
//! session's directory is therefore a property of the *tab*, not of the process:
//! `+` creates in the focused tab's directory, and the repo label is derived per
//! chip. Using `AppView::cwd` here would make a global strip lie about where its
//! sessions live.

pub mod store;

use std::path::PathBuf;

/// How many closed tabs can be reopened, most-recent first.
const CLOSED_CAP: usize = 25;

/// One open session.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TabEntry {
    /// The session id — stable across processes and restarts.
    pub session_id: String,
    /// Display title. `None` until a title is known (falls back to the id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The session's own working directory. Never the process cwd.
    pub cwd: PathBuf,
}

impl TabEntry {
    pub fn new(session_id: impl Into<String>, cwd: PathBuf) -> Self {
        Self {
            session_id: session_id.into(),
            title: None,
            cwd,
        }
    }

    /// What the chip renders: the title, else a short session id.
    pub fn display_title(&self) -> String {
        match self.title.as_deref().map(str::trim) {
            Some(t) if !t.is_empty() => t.to_string(),
            _ => {
                let short: String = self.session_id.chars().take(8).collect();
                format!("session {short}")
            }
        }
    }
}

/// A tab that was closed, kept so it can be reopened at its old position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedTab {
    pub tab: TabEntry,
    /// The index the tab occupied when it was closed.
    pub index: usize,
}

/// The pager's tab list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionTabs {
    tabs: Vec<TabEntry>,
    /// Reopen stack, most recently closed last.
    closed: Vec<ClosedTab>,
    /// Index of the active tab. `None` only when the list is empty.
    active: Option<usize>,
}

impl SessionTabs {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build from a persisted list, clamping the active index.
    pub fn from_parts(tabs: Vec<TabEntry>, active: Option<usize>) -> Self {
        let active = match active {
            Some(i) if i < tabs.len() => Some(i),
            _ if tabs.is_empty() => None,
            _ => Some(tabs.len() - 1),
        };
        Self {
            tabs,
            closed: Vec::new(),
            active,
        }
    }

    pub fn len(&self) -> usize {
        self.tabs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tabs.is_empty()
    }

    pub fn tabs(&self) -> &[TabEntry] {
        &self.tabs
    }

    pub fn active_index(&self) -> Option<usize> {
        self.active
    }

    pub fn active(&self) -> Option<&TabEntry> {
        self.active.and_then(|i| self.tabs.get(i))
    }

    pub fn find(&self, session_id: &str) -> Option<usize> {
        self.tabs.iter().position(|t| t.session_id == session_id)
    }

    /// Move the active cursor. Out-of-range indexes are ignored.
    pub fn set_active(&mut self, index: usize) {
        if index < self.tabs.len() {
            self.active = Some(index);
        }
    }

    /// Set the active tab by session id. No-op when the session is not a tab.
    pub fn set_active_id(&mut self, session_id: &str) {
        if let Some(i) = self.find(session_id) {
            self.active = Some(i);
        }
    }

    /// Open (or refresh) a tab and make it active.
    ///
    /// Idempotent by `session_id`: re-opening an existing tab updates its title
    /// and cwd in place and moves the cursor, so a rename or a worktree move
    /// never produces a duplicate chip.
    pub fn open(&mut self, tab: TabEntry) -> usize {
        if let Some(i) = self.find(&tab.session_id) {
            if let Some(existing) = self.tabs.get_mut(i) {
                if tab.title.is_some() {
                    existing.title = tab.title;
                }
                existing.cwd = tab.cwd;
            }
            self.active = Some(i);
            return i;
        }
        self.tabs.push(tab);
        let i = self.tabs.len() - 1;
        self.active = Some(i);
        i
    }

    /// Refresh the title/cwd of an existing tab without moving the cursor.
    ///
    /// Used after a replay or a `/rename`: the tab list should follow the
    /// session, but merely arriving on a tab must not steal the active cursor
    /// from whatever the user is looking at in another window.
    pub fn refresh(&mut self, session_id: &str, title: Option<String>, cwd: Option<PathBuf>) {
        let Some(i) = self.find(session_id) else {
            return;
        };
        if let Some(existing) = self.tabs.get_mut(i) {
            if title.is_some() {
                existing.title = title;
            }
            if let Some(cwd) = cwd {
                existing.cwd = cwd;
            }
        }
    }

    /// Close a tab by index, returning it so the caller can persist the change.
    ///
    /// Closing the active tab activates the right neighbour, else the left one
    /// — the editor convention. Closing the last tab leaves no active tab.
    pub fn close(&mut self, index: usize) -> Option<TabEntry> {
        if index >= self.tabs.len() {
            return None;
        }
        let tab = self.tabs.remove(index);
        self.closed.push(ClosedTab {
            tab: tab.clone(),
            index,
        });
        if self.closed.len() > CLOSED_CAP {
            self.closed.remove(0);
        }
        self.active = if self.tabs.is_empty() {
            None
        } else {
            match self.active {
                Some(a) if a > index => Some(a - 1),
                Some(a) if a == index => Some(index.min(self.tabs.len() - 1)),
                other => other.filter(|a| *a < self.tabs.len()).or(Some(0)),
            }
        };
        Some(tab)
    }

    /// Close by session id (the keyboard/mouse path).
    pub fn close_id(&mut self, session_id: &str) -> Option<TabEntry> {
        let i = self.find(session_id)?;
        self.close(i)
    }

    /// Reopen the most recently closed tab at its original position.
    ///
    /// No-op when the session has been reopened since (the stack entry is
    /// dropped either way, so a stale entry cannot shadow an older one).
    pub fn reopen(&mut self) -> Option<TabEntry> {
        while let Some(entry) = self.closed.pop() {
            if self.find(&entry.tab.session_id).is_some() {
                continue;
            }
            let index = entry.index.min(self.tabs.len());
            self.tabs.insert(index, entry.tab.clone());
            self.active = Some(index);
            return Some(entry.tab);
        }
        None
    }

    /// Advance the active cursor, wrapping at the end.
    pub fn cycle(&mut self, forward: bool) -> Option<&TabEntry> {
        if self.tabs.is_empty() {
            return None;
        }
        let len = self.tabs.len();
        let next = match (self.active, forward) {
            (Some(a), true) => (a + 1) % len,
            (Some(a), false) => (a + len - 1) % len,
            (None, true) => 0,
            (None, false) => len - 1,
        };
        self.active = Some(next);
        self.tabs.get(next)
    }

    /// Move a tab to a new index, keeping the active cursor on the same tab.
    ///
    /// Pure list reordering; the store persists the resulting order.
    pub fn move_tab(&mut self, from: usize, to: usize) {
        if from >= self.tabs.len() || to >= self.tabs.len() || from == to {
            return;
        }
        let active_id = self.active().map(|t| t.session_id.clone());
        let tab = self.tabs.remove(from);
        self.tabs.insert(to, tab);
        if let Some(id) = active_id {
            self.active = self.find(&id);
        }
    }

    /// The session ids in strip order — the identity two clients compare.
    pub fn session_ids(&self) -> Vec<String> {
        self.tabs.iter().map(|t| t.session_id.clone()).collect()
    }
}

#[cfg(test)]
mod tests;
