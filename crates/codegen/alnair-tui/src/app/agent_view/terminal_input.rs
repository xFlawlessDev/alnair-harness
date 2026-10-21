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
    // Copy/paste chords. `Ctrl+Shift+C/V` is the terminal convention: plain
    // `Ctrl+C` must stay SIGINT for the shell, so the shift is what separates
    // "copy" from "interrupt".
    if KeyShortcut::new(
        KeyCode::Char('C'),
        KeyModifiers::CONTROL | KeyModifiers::SHIFT,
    )
    .matches(key_event)
    {
        return TerminalKeyOutcome::Action(Box::new(Action::CopyTerminalSelection));
    }
    if KeyShortcut::new(
        KeyCode::Char('V'),
        KeyModifiers::CONTROL | KeyModifiers::SHIFT,
    )
    .matches(key_event)
    {
        return TerminalKeyOutcome::Action(Box::new(Action::PasteIntoTerminal));
    }
    // Scrollback keys. These are the pager's, not the shell's: a program that
    // wants them enables the alternate screen, and `scroll_terminal` refuses
    // there, so the same chord cannot fight `less`.
    match key_event.code {
        KeyCode::PageUp => return TerminalKeyOutcome::Action(Box::new(Action::ScrollTerminal(10))),
        KeyCode::PageDown => {
            return TerminalKeyOutcome::Action(Box::new(Action::ScrollTerminal(-10)));
        }
        KeyCode::Home if key_event.modifiers.is_empty() => {
            return TerminalKeyOutcome::Action(Box::new(Action::ScrollTerminal(isize::MAX / 2)));
        }
        KeyCode::End if key_event.modifiers.is_empty() => {
            return TerminalKeyOutcome::Action(Box::new(Action::ScrollTerminal(isize::MIN / 2)));
        }
        _ => {}
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
    ///
    /// An EXITED pane is still focusable (so the user can read its last output
    /// and scroll it), but nothing is forwarded: writing to a dead PTY silently
    /// discards the bytes, which reads as "the pane is stuck". The escape
    /// hatches keep working, plus `Enter` restarts the shell.
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
        let exited = pane.exited.is_some();
        let modes = pane.screen.terminal_modes();

        if exited {
            // Restart is the one action that makes sense on a dead shell, and
            // it must come before encoding so `Enter` is not sent to the corpse.
            if key_event.code == crossterm::event::KeyCode::Enter {
                return super::InputOutcome::Action(Action::RestartTerminalPane);
            }
            // Escape clears a lingering selection before anything else, so the
            // same key can always undo a highlight the user did not want.
            if key_event.code == crossterm::event::KeyCode::Esc && self.clear_terminal_selection() {
                return super::InputOutcome::Changed;
            }
            return match route_terminal_key(key_event, registry, &modes) {
                TerminalKeyOutcome::Action(action) => super::InputOutcome::Action(*action),
                // Swallow everything else: a dead pane accepts no input, and
                // pretending otherwise is the freeze the user reports.
                _ => super::InputOutcome::Unchanged,
            };
        }

        // A live pane: Escape clears the selection first, then belongs to the
        // program (`vim` needs it). Only when a selection exists do we consume
        // it — otherwise the key must reach the shell untouched.
        if key_event.code == crossterm::event::KeyCode::Esc && self.clear_terminal_selection() {
            return super::InputOutcome::Changed;
        }

        match route_terminal_key(key_event, registry, &modes) {
            TerminalKeyOutcome::Send(bytes) => {
                // Typing means "I am done reading history": snap to the live
                // view, or the keystroke lands somewhere the user cannot see.
                // Only for keys that produce input — a scroll key must not
                // undo the scroll it just asked for.
                if let Some(pane) = self.terminal.as_mut() {
                    pane.screen.scroll_to_bottom();
                }
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
        if pane.exited.is_some() {
            // Same rule as keys: a dead shell must not receive a paste.
            return super::InputOutcome::Unchanged;
        }
        let modes = pane.screen.terminal_modes();
        let bytes = encode_paste(text, &modes);
        if bytes.is_empty() {
            return super::InputOutcome::Unchanged;
        }
        // Same rule as typing: a paste is input, so show where it lands.
        if let Some(pane) = self.terminal.as_mut() {
            pane.screen.scroll_to_bottom();
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

    /// Translate a screen position inside the pane into a grid cell.
    ///
    /// `None` outside the pane's grid. The grid sits one cell inside the pane
    /// rect (the border), which is also the rect the renderer draws into.
    pub(crate) fn pane_grid_cell(&self, col: u16, row: u16) -> Option<(u16, u16)> {
        let area = self.pane_areas.terminal;
        if area.width <= 2 || area.height <= 2 {
            return None;
        }
        let inner_x = area.x + 1;
        let inner_y = area.y + 1;
        let inner_w = area.width - 2;
        let inner_h = area.height - 2;
        if col < inner_x || col >= inner_x + inner_w || row < inner_y || row >= inner_y + inner_h {
            return None;
        }
        Some((row - inner_y, col - inner_x))
    }

    /// Extend the pane's selection to a screen position (drag).
    pub(crate) fn extend_terminal_selection(&mut self, col: u16, row: u16) -> bool {
        let Some(cell) = self.pane_grid_cell(col, row) else {
            return false;
        };
        let Some(pane) = self.terminal.as_mut() else {
            return false;
        };
        let Some(selection) = pane.selection.as_mut() else {
            return false;
        };
        if selection.head == cell {
            return false;
        }
        selection.head = cell;
        true
    }

    /// Finish a drag: copy the selected text and leave it highlighted.
    ///
    /// Auto-copy on release mirrors every terminal emulator's select-to-copy
    /// behaviour; the highlight stays so the user can see what went where.
    pub(crate) fn finish_terminal_selection(&mut self) -> bool {
        let Some(pane) = self.terminal.as_mut() else {
            return false;
        };
        let Some(selection) = pane.selection.as_mut() else {
            return false;
        };
        if !selection.dragging {
            return false;
        }
        selection.dragging = false;
        if selection.is_empty() {
            return true;
        }
        let text = pane.selected_text();
        if text.is_empty() {
            return true;
        }
        self.copy_to_clipboard(&text);
        true
    }

    /// Clear the pane's selection (Escape, or a click elsewhere).
    pub(crate) fn clear_terminal_selection(&mut self) -> bool {
        match self.terminal.as_mut() {
            Some(pane) if pane.selection.is_some() => {
                pane.selection = None;
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
#[path = "terminal_input_tests.rs"]
mod tests;
