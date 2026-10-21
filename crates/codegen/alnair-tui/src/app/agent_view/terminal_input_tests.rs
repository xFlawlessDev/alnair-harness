//! Terminal pane input routing: escape hatches, encoding, paste.

use super::super::super::terminal_pane::keys::{encode_key, encode_paste};
use super::TerminalKeyOutcome;
use crate::actions::ActionRegistry;
use alnair_terminal_screen::term::TerminalModes;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

fn modes() -> TerminalModes {
    TerminalModes {
        alt_screen: false,
        bracketed_paste: false,
        app_cursor: false,
        app_keypad: false,
        line_wrap: true,
        origin: false,
        show_cursor: true,
        insert: false,
        linefeed_newline: false,
        focus_in_out: false,
        mouse_reporting: false,
    }
}

fn key(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
    KeyEvent::new(code, mods)
}

#[test]
fn ctrl_q_leaves_the_pane() {
    let registry = ActionRegistry::defaults();
    let out = super::route_terminal_key(
        &key(KeyCode::Char('q'), KeyModifiers::CONTROL),
        &registry,
        &modes(),
    );
    assert!(matches!(
        out,
        TerminalKeyOutcome::Action(a)
            if matches!(*a, crate::app::actions::Action::FocusScrollback)
    ));
}

#[test]
fn ctrl_backtick_still_toggles_from_inside_the_pane() {
    let registry = ActionRegistry::defaults();
    let out = super::route_terminal_key(
        &key(KeyCode::Char('`'), KeyModifiers::CONTROL),
        &registry,
        &modes(),
    );
    assert!(
        matches!(
            out,
            TerminalKeyOutcome::Action(a)
                if matches!(*a, crate::app::actions::Action::ToggleTerminal)
        ),
        "the toggle must work from inside, or the pane traps the user"
    );
}

#[test]
fn ctrl_c_belongs_to_the_shell_not_the_pager() {
    // The whole point of a terminal: Ctrl+C interrupts the shell's foreground
    // command. Stealing it for cancel-turn would make the pane useless.
    let registry = ActionRegistry::defaults();
    let out = super::route_terminal_key(
        &key(KeyCode::Char('c'), KeyModifiers::CONTROL),
        &registry,
        &modes(),
    );
    match out {
        TerminalKeyOutcome::Send(bytes) => assert_eq!(&bytes[..], b"\x03"),
        other => panic!("Ctrl+C must reach the PTY, got {other:?}"),
    }
}

#[test]
fn esc_reaches_the_shell() {
    // vim/less need it; the pager's Esc policies must not intercept it here.
    let registry = ActionRegistry::defaults();
    let out =
        super::route_terminal_key(&key(KeyCode::Esc, KeyModifiers::NONE), &registry, &modes());
    match out {
        TerminalKeyOutcome::Send(bytes) => assert_eq!(&bytes[..], b"\x1b"),
        other => panic!("Esc must reach the PTY, got {other:?}"),
    }
}

#[test]
fn plain_typing_is_forwarded() {
    let registry = ActionRegistry::defaults();
    for (code, expected) in [
        (KeyCode::Char('a'), b"a".to_vec()),
        (KeyCode::Enter, b"\r".to_vec()),
        (KeyCode::Backspace, b"\x7f".to_vec()),
    ] {
        let out = super::route_terminal_key(&key(code, KeyModifiers::NONE), &registry, &modes());
        match out {
            TerminalKeyOutcome::Send(bytes) => assert_eq!(&bytes[..], expected.as_slice()),
            other => panic!("{code:?} must reach the PTY, got {other:?}"),
        }
    }
}

#[test]
fn arrows_honour_application_cursor_mode() {
    let registry = ActionRegistry::defaults();
    let mut m = modes();
    m.app_cursor = true;
    let out = super::route_terminal_key(&key(KeyCode::Up, KeyModifiers::NONE), &registry, &m);
    match out {
        TerminalKeyOutcome::Send(bytes) => assert_eq!(&bytes[..], b"\x1bOA"),
        other => panic!("got {other:?}"),
    }
}

#[test]
fn a_key_with_no_pty_form_is_ignored() {
    let registry = ActionRegistry::defaults();
    let out = super::route_terminal_key(
        &key(KeyCode::CapsLock, KeyModifiers::NONE),
        &registry,
        &modes(),
    );
    assert!(matches!(out, TerminalKeyOutcome::Ignored));
}

#[test]
fn paste_wraps_only_when_the_program_asked_for_it() {
    let mut m = modes();
    assert_eq!(encode_paste("ls\n", &m), b"ls\n");
    m.bracketed_paste = true;
    assert_eq!(encode_paste("ls\n", &m), b"\x1b[200~ls\n\x1b[201~");
}

#[test]
fn a_paste_cannot_smuggle_commands_through_the_end_marker() {
    let mut m = modes();
    m.bracketed_paste = true;
    let encoded = encode_paste("safe\x1b[201~rm -rf /\n", &m);
    assert!(
        !encoded.windows(6).skip(1).any(|w| w == b"\x1b[201"),
        "only the trailing end marker may appear"
    );
}

#[test]
fn encoding_a_shifted_letter_matches_what_was_typed() {
    let m = modes();
    assert_eq!(
        encode_key(&key(KeyCode::Char('a'), KeyModifiers::SHIFT), &m).unwrap(),
        b"A"
    );
}
