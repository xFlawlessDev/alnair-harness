//! Encode pager key events into the bytes a PTY expects.
//!
//! The emulator's active modes decide the wire form, so this module takes the
//! pane's [`TerminalModes`] rather than guessing:
//!
//! - **application cursor keys** (`DECCKM`, `TermMode::APP_CURSOR`) — arrows and
//!   `Home`/`End` send `ESC O A` instead of `ESC [ A`. `vim`, `less` and every
//!   readline-style program enable it; sending the CSI form to them makes the
//!   arrow keys do nothing (or insert a literal `[A`).
//! - **bracketed paste** (`DECSET 2004`) — pasted text must be wrapped in
//!   `ESC [ 200 ~ … ESC [ 201 ~`, or the shell runs the newlines as commands.
//!
//! Everything else is a plain xterm sequence, so the table below is deliberately
//! explicit rather than clever: a wrong byte here is invisible until a user
//! reports that one key does nothing.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use alnair_terminal_screen::term::TerminalModes;

/// Bytes for one key press, or `None` when the key has no PTY representation
/// (media keys, caps-lock-only events, a bare modifier press).
pub fn encode_key(key: &KeyEvent, modes: &TerminalModes) -> Option<Vec<u8>> {
    use KeyCode::*;

    // Alt is an ESC prefix in xterm's default mode. Handle it before the switch
    // so every branch below inherits it without repeating the wrap.
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);

    let bytes = match key.code {
        Char(c) => encode_char(c, ctrl, alt, shift)?,
        Enter => {
            if alt {
                b"\x1b\r".to_vec()
            } else {
                b"\r".to_vec()
            }
        }
        Tab => {
            if shift {
                b"\x1b[Z".to_vec() // CBT: back-tab, the same byte a terminal sends
            } else {
                b"\t".to_vec()
            }
        }
        Backspace => b"\x7f".to_vec(),
        Esc => b"\x1b".to_vec(),
        // Arrows and Home/End are the only keys whose encoding depends on
        // DECCKM. Insert/Delete/PageUp/PageDown are unaffected (they use the
        // `ESC [ n ~` family in both modes).
        Up => cursor_key(b'A', modes.app_cursor),
        Down => cursor_key(b'B', modes.app_cursor),
        Right => cursor_key(b'C', modes.app_cursor),
        Left => cursor_key(b'D', modes.app_cursor),
        Home => cursor_key(b'H', modes.app_cursor),
        End => cursor_key(b'F', modes.app_cursor),
        Insert => b"\x1b[2~".to_vec(),
        Delete => b"\x1b[3~".to_vec(),
        PageUp => b"\x1b[5~".to_vec(),
        PageDown => b"\x1b[6~".to_vec(),
        F(n) => function_key(n)?,
        // No PTY meaning: modifier-only presses and media keys.
        _ => return None,
    };

    // A bare Alt+arrow already encodes as `ESC O A`; prefixing again would send
    // a literal ESC the shell reads as "leave insert mode". Only the printable
    // and `Enter` forms above take the prefix, and they do it inline.
    Some(bytes)
}

/// `ESC O x` (application) or `ESC [ x` (normal).
fn cursor_key(final_byte: u8, app_cursor: bool) -> Vec<u8> {
    if app_cursor {
        vec![0x1b, b'O', final_byte]
    } else {
        vec![0x1b, b'[', final_byte]
    }
}

fn function_key(n: u8) -> Option<Vec<u8>> {
    let s = match n {
        1 => "\x1bOP",
        2 => "\x1bOQ",
        3 => "\x1bOR",
        4 => "\x1bOS",
        5 => "\x1b[15~",
        6 => "\x1b[17~",
        7 => "\x1b[18~",
        8 => "\x1b[19~",
        9 => "\x1b[20~",
        10 => "\x1b[21~",
        11 => "\x1b[23~",
        12 => "\x1b[24~",
        _ => return None,
    };
    Some(s.as_bytes().to_vec())
}

/// Encode a character, honouring Ctrl (control characters) and Alt (ESC
/// prefix). Shift is already folded into the character by the terminal, so it
/// only matters for the `Ctrl+Shift+letter` case where crossterm reports the
/// lowercase letter.
fn encode_char(c: char, ctrl: bool, alt: bool, shift: bool) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(4);
    if alt {
        out.push(0x1b);
    }
    if ctrl {
        // The control alphabet is ASCII-only: Ctrl+A..Z map to 0x01..0x1a,
        // and the punctuation set has a handful of documented exceptions.
        let byte = match c {
            'a'..='z' => c as u8 - b'a' + 1,
            'A'..='Z' => c as u8 - b'A' + 1,
            ' ' | '@' | '2' => 0x00,
            '[' | '3' => 0x1b,
            '\\' | '4' => 0x1c,
            ']' | '5' => 0x1d,
            '^' | '6' => 0x1e,
            '_' | '7' | '/' => 0x1f,
            // Ctrl+8 is DEL on most terminals; Ctrl+? too.
            '8' | '?' => 0x7f,
            // Anything else has no control form. Swallow it rather than
            // sending the unmodified character, which would look like the
            // modifier silently stopped working.
            _ => return None,
        };
        out.push(byte);
        return Some(out);
    }

    let mut buf = [0u8; 4];
    let encoded = c.encode_utf8(&mut buf);
    // Shift on a letter that already arrived uppercase needs no work; a
    // lowercase letter with SHIFT set is reported that way by some terminals,
    // so uppercase it to match what the user typed.
    if shift && c.is_ascii_lowercase() {
        out.push(c.to_ascii_uppercase() as u8);
    } else {
        out.extend_from_slice(encoded.as_bytes());
    }
    Some(out)
}

/// Wrap pasted text for a bracketed-paste-aware program.
///
/// The trailing `ESC [ 201 ~` is mandatory: without it the program keeps
/// treating every later byte as pasted content.
pub fn encode_paste(text: &str, modes: &TerminalModes) -> Vec<u8> {
    if !modes.bracketed_paste {
        return text.as_bytes().to_vec();
    }
    let mut out = Vec::with_capacity(text.len() + 12);
    out.extend_from_slice(b"\x1b[200~");
    // A pasted body containing the end marker would terminate the paste early
    // and hand the rest to the shell as commands. Strip it.
    let body = text.replace("\x1b[201~", "");
    out.extend_from_slice(body.as_bytes());
    out.extend_from_slice(b"\x1b[201~");
    out
}

#[cfg(test)]
#[path = "keys_tests.rs"]
mod tests;
