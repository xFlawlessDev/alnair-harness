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
    /// Replies the emulator wants written back to the PTY (DSR, DA1, colour
    /// queries). Drained by [`Self::take_emulator_replies`]; see [`Self::new`]
    /// for why dropping this breaks the shell.
    emulator_replies: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    /// In-progress or completed mouse selection, in grid coordinates.
    pub selection: Option<PaneSelection>,
    /// Frames remaining in the bell flash. Decremented per drawn frame.
    ///
    /// A frame counter rather than an instant: the pane only redraws when
    /// something changes, so a time-based flash could expire unseen.
    pub bell_flash_frames: u8,
    /// True once any output arrived. Distinguishes "the shell has not spoken
    /// yet" from "the shell printed nothing", which look identical on screen.
    pub saw_output: bool,
}

/// A mouse selection over the pane's grid.
///
/// Coordinates are `(row, col)` in the emulator's own space, NOT screen cells:
/// the grid scrolls under the cursor, so screen coordinates would select
/// different text than the user dragged over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneSelection {
    pub anchor: (u16, u16),
    pub head: (u16, u16),
    /// True while the button is held; the selection is still growing.
    pub dragging: bool,
}

impl PaneSelection {
    pub fn new(anchor: (u16, u16)) -> Self {
        Self {
            anchor,
            head: anchor,
            dragging: true,
        }
    }

    /// Normalized `(start, end)` so a backwards drag selects the same span.
    pub fn span(&self) -> ((u16, u16), (u16, u16)) {
        if self.anchor <= self.head {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }

    /// Whether `(row, col)` falls inside the selection.
    pub fn contains(&self, row: u16, col: u16) -> bool {
        let (start, end) = self.span();
        let cell = (row, col);
        cell >= start && cell <= end
    }

    pub fn is_empty(&self) -> bool {
        self.anchor == self.head
    }
}

impl TerminalPane {
    /// A pane bound to `pty_id`, with an emulator at `cols`×`rows`.
    ///
    /// The emulator's `SessionListener` sink is KEPT, not dropped. A shell
    /// probes its terminal at startup (`ESC[6n` for the cursor position, colour
    /// queries, DA1) and will not print its prompt until it gets an answer.
    /// Dropping the receiver leaves those replies in a channel nobody reads, so
    /// the shell blocks forever and the pane stays blank no matter what is
    /// typed into it — the exact failure mode this sink exists to prevent.
    pub fn new(pty_id: String, cols: u16, rows: u16) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            pty_id,
            screen: Terminal::new(cols, rows, SessionListener::new(tx)),
            emulator_replies: rx,
            size: (cols, rows),
            exited: None,
            busy: false,
            selection: None,
            bell_flash_frames: 0,
            saw_output: false,
        }
    }

    /// Take a pending bell and arm the flash. Returns whether one was pending.
    ///
    /// The flash is 12 frames (~0.4 s at 30 fps): long enough to notice in
    /// peripheral vision, short enough not to be noise during a build loop.
    pub fn take_bell(&mut self) -> bool {
        if !self.screen.take_bell() {
            return false;
        }
        self.bell_flash_frames = 12;
        true
    }

    /// Advance the flash by one frame; returns whether the pane needs a redraw.
    pub fn tick_bell(&mut self) -> bool {
        if self.bell_flash_frames == 0 {
            return false;
        }
        self.bell_flash_frames -= 1;
        true
    }

    /// Whether the bell flash is currently on (the "on" half of a blink).
    pub fn bell_lit(&self) -> bool {
        self.bell_flash_frames > 0 && self.bell_flash_frames % 4 > 1
    }

    /// Scrollback indicator text, e.g. `−42`, or `None` when on the live view.
    pub fn scrollback_label(&self) -> Option<String> {
        let offset = self.screen.display_offset();
        (offset > 0).then(|| format!("\u{2212}{offset}"))
    }

    /// Text under the current selection, one line per row, `\n`-joined.
    ///
    /// Returns an empty string when nothing is selected. Trailing blanks are
    /// already trimmed by `visible_rows`, so a copied block does not carry a
    /// wall of spaces to the right of the longest line.
    pub fn selected_text(&self) -> String {
        let Some(selection) = self.selection else {
            return String::new();
        };
        if selection.is_empty() {
            return String::new();
        }
        let (start, end) = selection.span();
        let rows = self.screen.visible_rows();
        let mut out = String::new();
        for row in start.0..=end.0 {
            let Some(screen_row) = rows.get(row as usize) else {
                continue;
            };
            let text = screen_row.text();
            let from = if row == start.0 { start.1 as usize } else { 0 };
            let to = if row == end.0 {
                (end.1 as usize + 1).min(text.chars().count())
            } else {
                text.chars().count()
            };
            if from < to {
                let line: String = text.chars().skip(from).take(to - from).collect();
                out.push_str(line.trim_end());
            }
            if row != end.0 {
                out.push('\n');
            }
        }
        out
    }

    /// Take everything the emulator wants written back to the PTY.
    ///
    /// Called once per frame: the replies are small and rare (one at startup,
    /// then only on an explicit query), so a per-frame drain is cheap and keeps
    /// the pane free of a second async task.
    pub fn take_emulator_replies(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        while let Ok(chunk) = self.emulator_replies.try_recv() {
            out.extend_from_slice(&chunk);
        }
        out
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
                    // Reset by rebuilding the emulator at the current size. The
                    // reply sink is rebuilt with it: the old receiver belongs to
                    // the discarded emulator.
                    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                    self.screen = Terminal::new(self.size.0, self.size.1, SessionListener::new(tx));
                    self.emulator_replies = rx;
                    // A replay is the shell's whole history: whatever was on
                    // screen before is about to be replaced, so a half-faded
                    // bell from the previous view must not survive.
                    self.bell_flash_frames = 0;
                }
                self.screen.feed(&bytes);
                self.saw_output = true;
                // A BEL can arrive in the same chunk as the text it announces.
                self.take_bell();
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
