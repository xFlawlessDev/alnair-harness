//! Key and paste routing into a focused terminal pane.
//!
//! The pane is a raw byte sink: everything that is not an escape hatch goes
//! straight to the PTY. The escape hatches exist because a focused pane would
//! otherwise swallow the chords that get the user *out* of it — and because a
//! shell has its own `Ctrl+C`, which must not be confused with the pager's
//! cancel-turn.
//!
//! Escape hatch policy:
//! - the toggle chord (`Ctrl+\``) always wins, so the pane can be closed from
//!   inside it;
//! - `Ctrl+Q` leaves the pane without hiding it (the shell keeps running);
//! - everything else, including `Ctrl+C` and `Esc`, belongs to the program in
//!   the pane. That is the whole point of a terminal: `vim` needs `Esc`, and
//!   `Ctrl+C` must interrupt the *shell's* foreground command, not the agent's
//!   turn.

use crossterm::event::KeyEvent;

use super::super::terminal_pane::keys::{encode_key, encode_paste};
use crate::actions::{ActionId, ActionRegistry};
use crate::app::actions::Action;
use crate::app::agent_view::{AgentPane, AgentView};
use crate::input::key::KeyShortcut;
use crossterm::event::{KeyCode, KeyModifiers};

/// Outcome of a terminal-pane key.
#[derive(Debug)]
pub enum TerminalKeyOutcome {
    /// Forward these bytes to the PTY.
    Send(Box<[u8]>),
    /// A pager action won; do not forward anything.
    ///
    /// Boxed because `Action` is far larger than `Send`, and this enum is built
    /// once per keystroke: leaving it inline made every key pay `Action`'s size.
    Action(Box<Action>),
    /// Nothing to send (a key with no PTY form, or the pane is gone).
    Ignored,
}

/// Decide what a key does while the pane holds focus.
///
/// Split from the `AgentView` method so the policy is testable without building
/// a whole view: the interesting part is the ordering of the escape hatches
/// against the encode step.
pub fn route_terminal_key(
    key_event: &KeyEvent,
    registry: &ActionRegistry,
    modes: &alnair_terminal_screen::term::TerminalModes,
) -> TerminalKeyOutcome {
    // Leaving the pane is a pager chord, not something the shell should see.
    // `Ctrl+Q` is deliberately not a shell control character anyone relies on
    // (it is XON only with flow control enabled, which modern shells disable).
    // `KeyModifiers` is a bitflag, so `key!` (which wants a bare ident) cannot
    // express it; build the shortcut directly.
    if KeyShortcut::new(KeyCode::Char('q'), KeyModifiers::CONTROL).matches(key_event) {
        return TerminalKeyOutcome::Action(Box::new(Action::FocusScrollback));
    }
    // The toggle must work from inside the pane, or the only way out is to
    // remember that some other pane has to be focused first.
    if registry.lookup(key_event, crate::actions::When::AgentScreen)
        == Some(ActionId::ToggleTerminal)
    {
        return TerminalKeyOutcome::Action(Box::new(Action::ToggleTerminal));
    }
    match encode_key(key_event, modes) {
        Some(bytes) => TerminalKeyOutcome::Send(bytes.into_boxed_slice()),
        None => TerminalKeyOutcome::Ignored,
    }
}

impl AgentView {
    /// Route one key to the focused terminal pane.
    pub(super) fn handle_terminal_key(
        &mut self,
        key_event: &KeyEvent,
        registry: &ActionRegistry,
    ) -> super::InputOutcome {
        let Some(pane) = self.terminal.as_ref() else {
            // The pane was closed between the key arriving and dispatch; do not
            // strand focus on a pane that no longer exists.
            return super::InputOutcome::Action(Action::FocusScrollback);
        };
        let modes = pane.screen.terminal_modes();
        match route_terminal_key(key_event, registry, &modes) {
            TerminalKeyOutcome::Send(bytes) => {
                super::InputOutcome::Action(Action::PtySendInput(bytes.into_vec()))
            }
            TerminalKeyOutcome::Action(action) => super::InputOutcome::Action(*action),
            TerminalKeyOutcome::Ignored => super::InputOutcome::Unchanged,
        }
    }

    /// Route a paste into the focused terminal pane.
    pub(super) fn handle_terminal_paste(&mut self, text: &str) -> super::InputOutcome {
        let Some(pane) = self.terminal.as_ref() else {
            return super::InputOutcome::Unchanged;
        };
        let modes = pane.screen.terminal_modes();
        let bytes = encode_paste(text, &modes);
        if bytes.is_empty() {
            return super::InputOutcome::Unchanged;
        }
        super::InputOutcome::Action(Action::PtySendInput(bytes))
    }

    /// Move focus into the pane, if one exists.
    pub fn focus_terminal_pane(&mut self) -> bool {
        if self.terminal.is_none() || !self.terminal_open {
            return false;
        }
        self.set_active_pane(AgentPane::Terminal, false);
        true
    }
}

#[cfg(test)]
#[path = "terminal_input_tests.rs"]
mod tests;
