//! Terminal pane lifecycle: toggle, create, load, close.
//!
//! The pane is lazy: nothing is spawned until the chord is pressed. Closing the
//! pane only hides it — the shell keeps its scrollback and cwd, and re-opening
//! replays the ring buffer through the local emulator. `PtyClose` fires only
//! when the agent view itself goes away, because an orphaned shell would
//! outlive the session that owns it.

use crate::app::actions::Effect;
use crate::app::agent::AgentId;
use crate::app::agent_view::{AgentPane, AgentView};
use crate::app::terminal_pane::{DEFAULT_PANE_ROWS, TerminalPane};

/// Toggle the pane for `agent_id`.
///
/// Opening a view with no PTY yet returns `PtyCreate`; the resulting
/// `PtyCreated` arms `PtyLoad` so the pane shows the replay rather than a blank
/// grid. Re-opening an existing pane re-arms `PtyLoad` for the same reason: the
/// server's ring buffer is the only complete picture of what the shell printed
/// while the pane was hidden.
pub(super) fn dispatch_toggle_terminal(view: &mut AgentView) -> Vec<Effect> {
    view.terminal_open = !view.terminal_open;
    if !view.terminal_open {
        return Vec::new();
    }

    let agent_id = view.session.id;

    // Re-opening replays: the ring buffer is the only complete picture of what
    // the shell printed while the pane was hidden. Focus moves in too, so the
    // chord is a single gesture rather than "open, then click".
    if let Some(pane) = view.terminal.as_ref() {
        let pty_id = pane.pty_id.clone();
        view.set_active_pane(AgentPane::Terminal, false);
        return vec![Effect::PtyLoad { agent_id, pty_id }];
    }

    let Some(session_id) = view.session.session_id.clone() else {
        // No session means no cwd to spawn the shell in; the server would fall
        // back to the agent's own directory, which is not what the user sees.
        view.terminal_open = false;
        view.show_toast("Open a session before using the terminal");
        return Vec::new();
    };

    // The PTY is created at the pane's default height; the draw site resizes
    // the local emulator to whatever the rect turns out to be.
    vec![Effect::PtyCreate {
        agent_id,
        session_id,
        rows: DEFAULT_PANE_ROWS,
        cols: 80,
    }]
}

/// Install the pane from a successful `pty/create`.
pub(super) fn handle_pty_created(
    view: &mut AgentView,
    agent_id: AgentId,
    pty_id: String,
) -> Vec<Effect> {
    view.terminal = Some(TerminalPane::new(pty_id.clone(), 80, DEFAULT_PANE_ROWS));
    view.terminal_open = true;
    // Focus the pane on first open: the shell prompt is what the user asked
    // for, and it is empty until something is typed into it.
    view.set_active_pane(AgentPane::Terminal, false);
    vec![Effect::PtyLoad { agent_id, pty_id }]
}

/// Take the server's record of a PTY into the pane before its replay arrives.
///
/// The server's size can differ from what the pane asked for (the PTY outlived
/// an earlier, wider view), and the replayed bytes were laid out at the
/// server's width, so the emulator must match before they arrive or the replay
/// would wrap at the wrong column.
pub(super) fn prepare_loaded_pane(
    pane: &mut TerminalPane,
    rows: u16,
    cols: u16,
    exited: bool,
    exit_code: Option<i32>,
) {
    pane.resize(cols, rows);
    if exited {
        pane.exited = Some(exit_code);
        pane.busy = false;
    }
}

/// Close the PTY when its owning view goes away.
pub(super) fn close_terminal_effect(view: &AgentView) -> Option<Effect> {
    view.terminal.as_ref().map(|pane| Effect::PtyClose {
        pty_id: pane.pty_id.clone(),
    })
}

/// Replace an exited pane's PTY with a fresh one.
///
/// Drops the old pane first: its emulator mirrors a process that is gone, and
/// keeping it would leave dead scrollback above the new shell's prompt. The
/// close is best-effort — an already-reaped PTY answers with an error that is
/// not worth surfacing.
pub(super) fn dispatch_restart_terminal(view: &mut AgentView) -> Vec<Effect> {
    let Some(old_id) = view.terminal.as_ref().map(|p| p.pty_id.clone()) else {
        return Vec::new();
    };
    let Some(session_id) = view.session.session_id.clone() else {
        view.show_toast("Open a session before using the terminal");
        return Vec::new();
    };
    forget_terminal(view);
    view.terminal_open = true;
    vec![
        Effect::PtyClose { pty_id: old_id },
        Effect::PtyCreate {
            agent_id: view.session.id,
            session_id,
            rows: DEFAULT_PANE_ROWS,
            cols: 80,
        },
    ]
}

/// Copy the pane's selection to the clipboard.
///
/// Returns whether anything was copied. A copy with no selection is a no-op
/// rather than a toast: the user pressed the chord with nothing selected, which
/// is not an error worth interrupting them for.
pub(super) fn dispatch_copy_terminal_selection(view: &mut AgentView) -> bool {
    let Some(pane) = view.terminal.as_ref() else {
        return false;
    };
    let text = pane.selected_text();
    if text.is_empty() {
        return false;
    }
    view.copy_to_clipboard(&text);
    true
}

/// Paste the clipboard into the pane.
///
/// Bracketed-paste wrapping is decided by the program's live mode, so this
/// reuses the same encoder as an `Event::Paste` would.
pub(super) fn dispatch_paste_into_terminal(view: &mut AgentView) -> Vec<Effect> {
    let Some(pane) = view.terminal.as_ref() else {
        return Vec::new();
    };
    if pane.exited.is_some() {
        return Vec::new();
    }
    let Ok(Some(text)) = crate::clipboard::system_clipboard_read_text() else {
        return Vec::new();
    };
    if text.is_empty() {
        return Vec::new();
    }
    let bytes = crate::app::terminal_pane::keys::encode_paste(&text, &pane.screen.terminal_modes());
    if bytes.is_empty() {
        return Vec::new();
    }
    vec![Effect::PtyInput {
        pty_id: pane.pty_id.clone(),
        data: bytes,
    }]
}

/// Scroll the pane's viewport.
///
/// Clamped by the emulator to the available history, so an over-scroll is a
/// no-op. Returns whether the visible rows changed, so the caller can skip a
/// redraw when the view was already at the limit.
pub(crate) fn scroll_terminal(view: &mut AgentView, delta: isize) -> bool {
    let Some(pane) = view.terminal.as_mut() else {
        return false;
    };
    // A program on the alternate screen owns its viewport; offering scrollback
    // there would show stale rows the program cannot repaint.
    if pane.screen.alternate_screen() {
        return false;
    }
    let before = pane.screen.display_offset();
    let after = pane.screen.scroll_by(delta);
    before != after
}

/// Drop the pane locally without asking the server to kill anything.
///
/// Used when a frame proves the PTY is already gone (a `PtyFailed` for a load).
pub(super) fn forget_terminal(view: &mut AgentView) {
    view.terminal = None;
    view.terminal_open = false;
}

/// Forward encoded keystrokes to the view's PTY.
///
/// Returns no effect when the pane vanished between the key being routed and
/// this dispatch — a stale key must not resurrect a closed shell.
pub(super) fn dispatch_pty_input(view: &AgentView, data: Vec<u8>) -> Vec<Effect> {
    match view.terminal.as_ref() {
        Some(pane) if !data.is_empty() => vec![Effect::PtyInput {
            pty_id: pane.pty_id.clone(),
            data,
        }],
        _ => Vec::new(),
    }
}

// Resize is NOT dispatched from here: `draw` owns the frame cadence and sends
// the debounced size directly (see `AppView::draw_inner`), because routing it
// through an `Effect` would need a round trip per frame.
