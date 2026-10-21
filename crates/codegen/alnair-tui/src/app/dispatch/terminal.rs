//! Terminal pane lifecycle: toggle, create, load, close.
//!
//! The pane is lazy: nothing is spawned until the chord is pressed. Closing the
//! pane only hides it — the shell keeps its scrollback and cwd, and re-opening
//! replays the ring buffer through the local emulator. `PtyClose` fires only
//! when the agent view itself goes away, because an orphaned shell would
//! outlive the session that owns it.

use crate::app::actions::Effect;
use crate::app::agent::AgentId;
use crate::app::agent_view::AgentView;
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
    // the shell printed while the pane was hidden.
    if let Some(pane) = view.terminal.as_ref() {
        return vec![Effect::PtyLoad {
            agent_id,
            pty_id: pane.pty_id.clone(),
        }];
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

/// Drop the pane locally without asking the server to kill anything.
///
/// Used when a frame proves the PTY is already gone (a `PtyFailed` for a load).
pub(super) fn forget_terminal(view: &mut AgentView) {
    view.terminal = None;
    view.terminal_open = false;
}
