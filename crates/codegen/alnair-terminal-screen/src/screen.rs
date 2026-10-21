//! Renderer-facing screen snapshot.
//!
//! [`crate::term::Terminal`] reads back plain text, styled JSON and HTML. A TUI
//! that draws the grid itself needs the cells' colours and attributes in a
//! backend-neutral form, so this module exposes one coalesced snapshot of the
//! visible grid. `alacritty_terminal`'s own types stay inside this crate: a
//! caller maps [`ScreenColor`] to whatever its renderer understands.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::TermMode;
use alacritty_terminal::vte::ansi::{Color, NamedColor};

use crate::term::Terminal;

/// A colour as the emulator recorded it, independent of any renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ScreenColor {
    /// The terminal's own default (foreground, background or cursor colour).
    #[default]
    Default,
    /// A 256-colour palette index; the terminal resolves the actual RGB.
    Indexed(u8),
    /// A direct 24-bit colour.
    Rgb(u8, u8, u8),
}

/// The attributes a run of cells shares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ScreenStyle {
    pub fg: ScreenColor,
    pub bg: ScreenColor,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikeout: bool,
    pub dim: bool,
    /// Swap `fg` and `bg` at draw time. Kept as a flag rather than pre-swapped
    /// colours so a `Default` foreground stays distinguishable from an explicit
    /// background.
    pub inverse: bool,
}

/// A horizontally contiguous run of cells sharing one [`ScreenStyle`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenRun {
    pub text: String,
    pub style: ScreenStyle,
}

/// One visible row, left to right. Trailing default-styled blanks are trimmed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScreenRow {
    pub runs: Vec<ScreenRun>,
}

impl ScreenRow {
    /// Plain text of the row, for tests and for width accounting.
    pub fn text(&self) -> String {
        self.runs.iter().map(|r| r.text.as_str()).collect()
    }
}

impl Terminal {
    /// Snapshot the visible grid as coalesced styled runs.
    ///
    /// Wide-character spacers are skipped, so a double-width glyph occupies one
    /// run entry and the following cell is not emitted as a blank — the same
    /// rule `styled::extract_styled_line` uses.
    ///
    /// The snapshot honours the emulator's display offset, so scrolling back
    /// (`scroll_display`) shows history rows here with no extra caller logic.
    pub fn visible_rows(&self) -> Vec<ScreenRow> {
        let grid = self.grid();
        let rows = grid.screen_lines();
        let cols = grid.columns();
        let offset = grid.display_offset();
        let mut out = Vec::with_capacity(rows);
        for row_idx in 0..rows {
            // Row 0 of the viewport is `-offset` in grid coordinates: negative
            // lines are history, non-negative are the live screen.
            let line = row_idx as i32 - offset as i32;
            let row = &grid[Line(line)];
            let mut runs: Vec<ScreenRun> = Vec::new();
            let mut current: Option<ScreenStyle> = None;
            let mut text = String::new();
            for col_idx in 0..cols {
                let cell = &row[Column(col_idx)];
                if cell.flags.intersects(
                    alacritty_terminal::term::cell::Flags::WIDE_CHAR_SPACER
                        | alacritty_terminal::term::cell::Flags::LEADING_WIDE_CHAR_SPACER,
                ) {
                    continue;
                }
                let style = style_of(cell);
                if let Some(cur) = current
                    && cur != style
                {
                    runs.push(ScreenRun {
                        text: std::mem::take(&mut text),
                        style: cur,
                    });
                }
                current = Some(style);
                text.push(cell.c);
                if let Some(zw) = cell.zerowidth() {
                    for &c in zw {
                        text.push(c);
                    }
                }
            }
            if let Some(style) = current
                && !text.is_empty()
            {
                runs.push(ScreenRun { text, style });
            }
            while let Some(last) = runs.last_mut() {
                // Only default-styled blanks are padding. A blank carrying a
                // background colour is a painted block and must survive.
                if last.style != ScreenStyle::default() {
                    break;
                }
                let trimmed = last.text.trim_end_matches(' ');
                if trimmed.len() == last.text.len() {
                    break;
                }
                last.text.truncate(trimmed.len());
                if last.text.is_empty() {
                    runs.pop();
                } else {
                    break;
                }
            }
            out.push(ScreenRow { runs });
        }
        out
    }

    /// Cursor position as 0-indexed `(row, col)` within the visible grid.
    ///
    /// `None` while the view is scrolled back: the cursor belongs to the live
    /// screen, and drawing it over a history row would point at the wrong line.
    pub fn cursor_cell(&self) -> Option<(usize, usize)> {
        if self.grid().display_offset() > 0 {
            return None;
        }
        let point = self.grid().cursor.point;
        Some((point.line.0.max(0) as usize, point.column.0))
    }

    /// Whether the running program left the cursor visible (DECTCEM).
    pub fn cursor_visible(&self) -> bool {
        self.mode().contains(TermMode::SHOW_CURSOR)
    }

    /// Whether the alternate screen buffer is active (`vim`, `less`, …).
    ///
    /// The alternate screen has no scrollback, so a caller must not offer
    /// scrolling while this is true — the program owns the viewport.
    pub fn alternate_screen(&self) -> bool {
        self.mode().contains(TermMode::ALT_SCREEN)
    }

    /// Rows available above the viewport (the scrollback buffer).
    pub fn history_size(&self) -> usize {
        self.grid().history_size()
    }

    /// How far the view is scrolled back, in rows. `0` = live view.
    ///
    /// This is the emulator's own display offset, so a caller that writes it
    /// (`scroll_display`) keeps the cursor and rendering consistent — the same
    /// mechanism `alacritty` itself uses.
    pub fn display_offset(&self) -> usize {
        self.grid().display_offset()
    }

    /// Scroll the viewport by `delta` rows (positive = back into history).
    ///
    /// Returns the resulting offset. Clamped to `0..=history_size()`, so an
    /// over-scroll is a no-op rather than an error.
    pub fn scroll_by(&mut self, delta: isize) -> usize {
        let current = self.grid().display_offset();
        let target = current
            .saturating_add_signed(delta)
            .min(self.grid().history_size());
        let step = target as i32 - current as i32;
        if step != 0 {
            self.scroll_display(step);
        }
        self.grid().display_offset()
    }

    /// Jump to the live view (offset 0).
    pub fn scroll_to_bottom(&mut self) -> usize {
        self.scroll_by(-(self.grid().display_offset() as isize))
    }
}

fn style_of(cell: &alacritty_terminal::term::cell::Cell) -> ScreenStyle {
    use alacritty_terminal::term::cell::Flags;
    ScreenStyle {
        fg: color_of(cell.fg),
        bg: color_of(cell.bg),
        bold: cell.flags.contains(Flags::BOLD),
        italic: cell.flags.contains(Flags::ITALIC),
        underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
        strikeout: cell.flags.contains(Flags::STRIKEOUT),
        dim: cell.flags.contains(Flags::DIM),
        inverse: cell.flags.contains(Flags::INVERSE),
    }
}

fn color_of(color: Color) -> ScreenColor {
    match color {
        Color::Spec(rgb) => ScreenColor::Rgb(rgb.r, rgb.g, rgb.b),
        Color::Indexed(idx) => ScreenColor::Indexed(idx),
        Color::Named(name) => named_color(name),
    }
}

/// The first sixteen named colours are palette indices; everything else is a
/// role the terminal itself resolves, so it maps to [`ScreenColor::Default`].
fn named_color(name: NamedColor) -> ScreenColor {
    match name {
        NamedColor::Black
        | NamedColor::Red
        | NamedColor::Green
        | NamedColor::Yellow
        | NamedColor::Blue
        | NamedColor::Magenta
        | NamedColor::Cyan
        | NamedColor::White
        | NamedColor::BrightBlack
        | NamedColor::BrightRed
        | NamedColor::BrightGreen
        | NamedColor::BrightYellow
        | NamedColor::BrightBlue
        | NamedColor::BrightMagenta
        | NamedColor::BrightCyan
        | NamedColor::BrightWhite => ScreenColor::Indexed(name as u8),
        _ => ScreenColor::Default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::term::SessionListener;

    fn terminal(cols: u16, rows: u16) -> (Terminal, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (Terminal::new(cols, rows, SessionListener::new(tx)), rx)
    }

    #[test]
    fn plain_text_is_one_default_run() {
        let (mut term, _rx) = terminal(20, 3);
        term.feed(b"hello");
        let rows = term.visible_rows();
        assert_eq!(rows[0].text(), "hello");
        assert_eq!(rows[0].runs.len(), 1);
        assert_eq!(rows[0].runs[0].style, ScreenStyle::default());
    }

    #[test]
    fn sgr_colours_split_runs_and_map_to_indexed() {
        let (mut term, _rx) = terminal(20, 3);
        // Red then default then bold.
        term.feed(b"\x1b[31mred\x1b[0m plain \x1b[1mbold\x1b[0m");
        let rows = term.visible_rows();
        assert_eq!(rows[0].text(), "red plain bold");
        let styles: Vec<ScreenStyle> = rows[0].runs.iter().map(|r| r.style).collect();
        assert_eq!(styles[0].fg, ScreenColor::Indexed(1));
        assert_eq!(styles[1].fg, ScreenColor::Default);
        assert!(styles[2].bold);
    }

    #[test]
    fn truecolor_maps_to_rgb() {
        let (mut term, _rx) = terminal(20, 3);
        term.feed(b"\x1b[38;2;1;2;3mX");
        let rows = term.visible_rows();
        assert_eq!(rows[0].runs[0].style.fg, ScreenColor::Rgb(1, 2, 3));
    }

    #[test]
    fn inverse_is_a_flag_not_a_swap() {
        let (mut term, _rx) = terminal(20, 3);
        term.feed(b"\x1b[7mX");
        let rows = term.visible_rows();
        assert!(rows[0].runs[0].style.inverse);
        assert_eq!(rows[0].runs[0].style.fg, ScreenColor::Default);
    }

    #[test]
    fn wide_glyph_emits_one_entry_and_skips_its_spacer() {
        let (mut term, _rx) = terminal(10, 2);
        term.feed("日本".as_bytes());
        let rows = term.visible_rows();
        assert_eq!(rows[0].text(), "日本");
    }

    #[test]
    fn trailing_default_blanks_are_trimmed() {
        let (mut term, _rx) = terminal(10, 2);
        term.feed(b"ab");
        let rows = term.visible_rows();
        assert_eq!(rows[0].text(), "ab");
    }

    #[test]
    fn cursor_is_zero_indexed() {
        let (mut term, _rx) = terminal(10, 3);
        term.feed(b"abc");
        assert_eq!(term.cursor_cell(), Some((0, 3)));
        assert!(term.cursor_visible());
    }

    #[test]
    fn device_status_replies_reach_the_listener() {
        let (mut term, mut rx) = terminal(10, 3);
        // DSR: cursor position report.
        term.feed(b"\x1b[6n");
        assert!(rx.try_recv().is_ok());
    }
}
