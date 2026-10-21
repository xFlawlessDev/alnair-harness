use super::{encode_key, encode_paste};
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

fn enc(code: KeyCode, mods: KeyModifiers) -> Option<Vec<u8>> {
    encode_key(&key(code, mods), &modes())
}

#[test]
fn plain_text_passes_through() {
    assert_eq!(enc(KeyCode::Char('a'), KeyModifiers::NONE).unwrap(), b"a");
    assert_eq!(enc(KeyCode::Char(' '), KeyModifiers::NONE).unwrap(), b" ");
}

#[test]
fn enter_is_carriage_return_not_newline() {
    // A PTY wants CR: LF alone does not run the line in a raw-mode shell.
    assert_eq!(enc(KeyCode::Enter, KeyModifiers::NONE).unwrap(), b"\r");
}

#[test]
fn backspace_is_del() {
    assert_eq!(
        enc(KeyCode::Backspace, KeyModifiers::NONE).unwrap(),
        b"\x7f"
    );
}

#[test]
fn tab_and_backtab() {
    assert_eq!(enc(KeyCode::Tab, KeyModifiers::NONE).unwrap(), b"\t");
    assert_eq!(enc(KeyCode::Tab, KeyModifiers::SHIFT).unwrap(), b"\x1b[Z");
}

#[test]
fn ctrl_letters_map_to_control_characters() {
    assert_eq!(
        enc(KeyCode::Char('c'), KeyModifiers::CONTROL).unwrap(),
        b"\x03"
    );
    assert_eq!(
        enc(KeyCode::Char('a'), KeyModifiers::CONTROL).unwrap(),
        b"\x01"
    );
    assert_eq!(
        enc(KeyCode::Char('z'), KeyModifiers::CONTROL).unwrap(),
        b"\x1a"
    );
}

#[test]
fn ctrl_punctuation_matches_the_documented_exceptions() {
    // The set every terminal agrees on.
    assert_eq!(
        enc(KeyCode::Char('['), KeyModifiers::CONTROL).unwrap(),
        b"\x1b"
    );
    assert_eq!(
        enc(KeyCode::Char('\\'), KeyModifiers::CONTROL).unwrap(),
        b"\x1c"
    );
    assert_eq!(
        enc(KeyCode::Char(']'), KeyModifiers::CONTROL).unwrap(),
        b"\x1d"
    );
    assert_eq!(
        enc(KeyCode::Char('_'), KeyModifiers::CONTROL).unwrap(),
        b"\x1f"
    );
}

#[test]
fn a_ctrl_combo_with_no_control_form_is_dropped() {
    // Sending the bare character would look like Ctrl silently stopped working.
    assert_eq!(enc(KeyCode::Char('1'), KeyModifiers::CONTROL), None);
}

#[test]
fn alt_prefixes_escape() {
    assert_eq!(
        enc(KeyCode::Char('b'), KeyModifiers::ALT).unwrap(),
        b"\x1bb"
    );
    assert_eq!(enc(KeyCode::Enter, KeyModifiers::ALT).unwrap(), b"\x1b\r");
}

#[test]
fn arrows_follow_decckm() {
    let mut m = modes();
    assert_eq!(
        encode_key(&key(KeyCode::Up, KeyModifiers::NONE), &m).unwrap(),
        b"\x1b[A",
        "normal mode uses CSI"
    );
    m.app_cursor = true;
    assert_eq!(
        encode_key(&key(KeyCode::Up, KeyModifiers::NONE), &m).unwrap(),
        b"\x1bOA",
        "application mode uses SS3"
    );
    assert_eq!(
        encode_key(&key(KeyCode::Left, KeyModifiers::NONE), &m).unwrap(),
        b"\x1bOD"
    );
}

#[test]
fn home_end_follow_decckm_but_insert_delete_do_not() {
    let mut m = modes();
    m.app_cursor = true;
    assert_eq!(
        encode_key(&key(KeyCode::Home, KeyModifiers::NONE), &m).unwrap(),
        b"\x1bOH"
    );
    assert_eq!(
        encode_key(&key(KeyCode::End, KeyModifiers::NONE), &m).unwrap(),
        b"\x1bOF"
    );
    // These use the `ESC [ n ~` family in both modes.
    assert_eq!(
        encode_key(&key(KeyCode::Delete, KeyModifiers::NONE), &m).unwrap(),
        b"\x1b[3~"
    );
    assert_eq!(
        encode_key(&key(KeyCode::PageUp, KeyModifiers::NONE), &m).unwrap(),
        b"\x1b[5~"
    );
}

#[test]
fn function_keys() {
    assert_eq!(enc(KeyCode::F(1), KeyModifiers::NONE).unwrap(), b"\x1bOP");
    assert_eq!(enc(KeyCode::F(5), KeyModifiers::NONE).unwrap(), b"\x1b[15~");
    assert_eq!(
        enc(KeyCode::F(12), KeyModifiers::NONE).unwrap(),
        b"\x1b[24~"
    );
    assert_eq!(enc(KeyCode::F(13), KeyModifiers::NONE), None);
}

#[test]
fn keys_without_a_pty_form_are_none() {
    assert_eq!(enc(KeyCode::Null, KeyModifiers::NONE), None);
    assert_eq!(enc(KeyCode::CapsLock, KeyModifiers::NONE), None);
}

#[test]
fn paste_is_raw_without_bracketed_mode() {
    assert_eq!(encode_paste("a\nb", &modes()), b"a\nb");
}

#[test]
fn paste_is_wrapped_with_bracketed_mode() {
    let mut m = modes();
    m.bracketed_paste = true;
    assert_eq!(encode_paste("a\nb", &m), b"\x1b[200~a\nb\x1b[201~");
}

#[test]
fn paste_strips_an_embedded_end_marker() {
    let mut m = modes();
    m.bracketed_paste = true;
    // Without stripping, everything after the marker runs as commands.
    assert_eq!(
        encode_paste("safe\x1b[201~rm -rf /", &m),
        b"\x1b[200~saferm -rf /\x1b[201~"
    );
}

#[test]
fn shift_on_a_lowercase_letter_uppercases_it() {
    // Some terminals report Shift+a as ('a', SHIFT) instead of 'A'.
    assert_eq!(enc(KeyCode::Char('a'), KeyModifiers::SHIFT).unwrap(), b"A");
    // An already-uppercase char is left alone.
    assert_eq!(enc(KeyCode::Char('A'), KeyModifiers::SHIFT).unwrap(), b"A");
}
