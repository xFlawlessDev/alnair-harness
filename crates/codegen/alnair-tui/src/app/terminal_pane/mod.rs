//! Read-only terminal pane state.
//!
//! The pane mirrors one server-side PTY: the pager creates it on demand
//! (`alnair/terminal/pty/create`), replays its ring buffer
//! (`alnair/terminal/pty/load`) and then feeds every
//! `alnair/terminal/pty/notification` output frame into a local VTE emulator.
//!
//! **3a is read-only.** The emulator consumes bytes and renders the grid; no
//! keystroke is forwarded, so `alnair/terminal/pty/input` and
//! `alnair/terminal/pty/resize` have no caller yet. 3b adds them.
//!
//! **One pane per client, not a shared PTY.** `pty_session::load` overwrites
//! the PTY's `target_client_id`, so a second pager loading the same PTY would
//! silently steal the output stream from the first. Each pager therefore owns
//! its own PTY, and no server protocol change is needed. The same fact is why
//! 3a sends no `_meta.clientId`: with a single client the server's default
//! routing already returns output here. Real per-client ids matter only in 3c,
//! where two clients genuinely need to differ.

pub mod keys;

use alnair_terminal_screen::term::{SessionListener, Terminal};

/// Default pane height in rows, before the 40%-of-scrollback cap.
pub const DEFAULT_PANE_ROWS: u16 = 12;

/// The scrollback keeps at least this many rows when the pane is open.
pub const MIN_SCROLLBACK_ROWS: u16 = 8;

/// Pane height for a scrollback rect of `available` rows, or `None` when the
/// pane must stay hidden (too little room to show both).
///
/// The pane takes `min(DEFAULT_PANE_ROWS, 40% of available)` and the scrollback
/// keeps [`MIN_SCROLLBACK_ROWS`]; when those two constraints cannot both hold,
/// there is no honest way to draw a useful pane, so the caller hides it.
pub fn pane_height(available: u16) -> Option<u16> {
    if available <= MIN_SCROLLBACK_ROWS {
        return None;
    }
    let forty_percent = (available as u32 * 2 / 5) as u16;
    let height = DEFAULT_PANE_ROWS.min(forty_percent);
    if height == 0 || available - height < MIN_SCROLLBACK_ROWS {
        return None;
    }
    Some(height)
}

/// One terminal pane, owned by an agent view.
pub struct TerminalPane {
    /// Server-side PTY id; the wire key for every request about this pane.
    pub pty_id: String,
    /// Local VTE emulator mirroring the PTY's output.
    pub screen: Terminal,
    /// Size the emulator was last resized to, so a redraw at the same size does
    /// not thrash the grid. The draw site is the only writer: it is the only
    /// place that knows the rect the grid must fit.
    pub size: (u16, u16),
    /// `Some(code)` once the child exited (`None` = exited without a code,
    /// e.g. killed by a signal).
    pub exited: Option<Option<i32>>,
    /// A foreground process is running (from `process_started`/`process_ended`).
    pub busy: bool,
}

impl TerminalPane {
    /// A pane bound to `pty_id`, with an emulator at `cols`×`rows`.
    ///
    /// Emulator replies (DSR, colour queries) are dropped: 3a forwards no
    /// input, so writing them back would be dead code pretending to work.
    /// 3b swaps this sink for the PTY input channel.
    pub fn new(pty_id: String, cols: u16, rows: u16) -> Self {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            pty_id,
            screen: Terminal::new(cols, rows, SessionListener::new(tx)),
            size: (cols, rows),
            exited: None,
            busy: false,
        }
    }

    /// Resize the emulator if the target size changed. Returns whether it did.
    pub fn resize(&mut self, cols: u16, rows: u16) -> bool {
        if cols == 0 || rows == 0 || self.size == (cols, rows) {
            return false;
        }
        self.screen.resize(cols, rows);
        self.size = (cols, rows);
        true
    }

    /// The `[process exited]` footer, when the child is gone.
    pub fn exit_label(&self) -> Option<String> {
        self.exited.map(|code| match code {
            Some(code) => format!("[process exited with code {code}]"),
            None => "[process exited]".to_string(),
        })
    }
}

/// One `alnair/terminal/pty/notification` payload.
///
/// The server emits four shapes from `pty_session.rs`: output frames (with
/// `data`, `outputOffset` and an optional `isReplay`), `exit` frames (with
/// `exitCode`/`signal`), and the two busy transitions.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyNotification {
    pub terminal_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default)]
    pub is_replay: bool,
    #[serde(default)]
    pub exit_code: Option<i32>,
}

/// What applying a notification did, so the caller knows whether to redraw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// The frame changed something the pane draws.
    Changed,
    /// A `process_started`/`process_ended` flag moved (the title glyph).
    Busy(bool),
    /// Nothing this pane cares about, or the frame was malformed.
    Ignored,
}

impl TerminalPane {
    /// Apply one notification to this pane.
    ///
    /// `isReplay` resets the emulator before feeding: the server documents that
    /// contract ("so the client can reset its VTE emulator and feed all bytes
    /// from scratch"), and without it a re-open would append the whole ring
    /// buffer to what the pane already showed.
    pub fn apply(&mut self, notif: &PtyNotification) -> Applied {
        use base64::Engine as _;

        match notif.kind.as_str() {
            "output" => {
                let Some(data) = notif.data.as_deref() else {
                    return Applied::Ignored;
                };
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
                    tracing::debug!(pty_id = % self.pty_id, "pty output frame is not base64");
                    return Applied::Ignored;
                };
                if notif.is_replay {
                    // Reset by rebuilding the emulator at the current size.
                    self.screen = Terminal::new(
                        self.size.0,
                        self.size.1,
                        SessionListener::new(tokio::sync::mpsc::unbounded_channel().0),
                    );
                }
                self.screen.feed(&bytes);
                Applied::Changed
            }
            "exit" => {
                self.exited = Some(notif.exit_code);
                self.busy = false;
                Applied::Changed
            }
            "process_started" => {
                self.busy = true;
                Applied::Busy(true)
            }
            "process_ended" => {
                self.busy = false;
                Applied::Busy(false)
            }
            other => {
                tracing::debug!(pty_id = % self.pty_id, kind = other, "unknown pty notification");
                Applied::Ignored
            }
        }
    }
}

#[cfg(test)]
mod tests;
