use super::{TerminalPaneParams, render_terminal_pane, split_scrollback};
use crate::app::terminal_pane::TerminalPane;
use crate::theme::Theme;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

fn pane_with(cols: u16, rows: u16, output: &str) -> TerminalPane {
    let mut pane = TerminalPane::new("pty-1".to_string(), cols, rows);
    let mut notif = crate::app::terminal_pane::PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "output".to_string(),
        ..Default::default()
    };
    use base64::Engine as _;
    notif.data = Some(base64::engine::general_purpose::STANDARD.encode(output.as_bytes()));
    pane.apply(&notif);
    pane
}

fn draw(pane: &TerminalPane, area: Rect) -> (Buffer, Rect) {
    let theme = Theme::alnairnight();
    let mut buf = Buffer::empty(area);
    let grid = render_terminal_pane(
        area,
        &mut buf,
        &theme,
        TerminalPaneParams {
            pane,
            focused: false,
        },
    );
    (buf, grid)
}

/// Read a screen row back as text, for assertions.
fn row_text(buf: &Buffer, y: u16, x: u16, width: u16) -> String {
    let mut out = String::new();
    for col in 0..width {
        if let Some(cell) = buf.cell((x + col, y)) {
            out.push_str(cell.symbol());
        }
    }
    out.trim_end().to_string()
}

fn display_width(s: &str) -> u16 {
    use unicode_width::UnicodeWidthStr;
    u16::try_from(s.width()).unwrap_or(u16::MAX)
}

#[test]
fn zero_area_is_a_noop() {
    let pane = pane_with(10, 3, "hi");
    let theme = Theme::alnairnight();
    let mut buf = Buffer::empty(Rect::new(0, 0, 20, 10));
    let grid = render_terminal_pane(
        Rect::new(0, 0, 0, 0),
        &mut buf,
        &theme,
        TerminalPaneParams {
            pane: &pane,
            focused: false,
        },
    );
    assert_eq!(grid, Rect::default());
}

#[test]
fn tiny_area_is_a_noop() {
    let pane = pane_with(10, 3, "hi");
    let theme = Theme::alnairnight();
    let mut buf = Buffer::empty(Rect::new(0, 0, 20, 10));
    for area in [Rect::new(0, 0, 3, 8), Rect::new(0, 0, 20, 2)] {
        let grid = render_terminal_pane(
            area,
            &mut buf,
            &theme,
            TerminalPaneParams {
                pane: &pane,
                focused: false,
            },
        );
        assert_eq!(grid, Rect::default(), "area {area:?} must not draw");
    }
}

#[test]
fn output_lands_inside_the_border() {
    let pane = pane_with(20, 4, "hello");
    let area = Rect::new(0, 0, 24, 8);
    let (buf, grid) = draw(&pane, area);
    assert_eq!(grid.x, 1);
    assert_eq!(grid.y, 1);
    assert!(row_text(&buf, grid.y, grid.x, grid.width).starts_with("hello"));
}

#[test]
fn the_title_row_names_the_pane() {
    let pane = pane_with(20, 4, "hello");
    let area = Rect::new(0, 0, 24, 8);
    let (buf, _) = draw(&pane, area);
    let title = row_text(&buf, 0, 0, 24);
    assert!(title.contains("terminal"), "title row was {title:?}");
}

#[test]
fn an_exited_pane_shows_the_footer() {
    let mut pane = pane_with(20, 4, "hello");
    pane.apply(&crate::app::terminal_pane::PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "exit".to_string(),
        exit_code: Some(0),
        ..Default::default()
    });
    let area = Rect::new(0, 0, 40, 10);
    let (buf, _) = draw(&pane, area);
    let bottom = row_text(&buf, area.height - 2, 1, area.width - 2);
    assert!(
        bottom.contains("process exited"),
        "footer row was {bottom:?}"
    );
}

#[test]
fn a_long_line_is_clipped_to_the_pane() {
    let pane = pane_with(200, 4, &"x".repeat(200));
    let area = Rect::new(0, 0, 20, 8);
    let (buf, grid) = draw(&pane, area);
    let painted = row_text(&buf, grid.y, grid.x, grid.width);
    // Byte length is not the contract here: an ellipsis is three bytes in one
    // column, so the assertion is on display columns.
    assert_eq!(display_width(&painted), grid.width);
    assert!(painted.starts_with("xxx"));
}

#[test]
fn a_shorter_line_clears_the_previous_longer_one() {
    let mut pane = pane_with(20, 4, "");
    let mut notif = crate::app::terminal_pane::PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "output".to_string(),
        ..Default::default()
    };
    use base64::Engine as _;
    notif.data = Some(base64::engine::general_purpose::STANDARD.encode(b"aaaaaaaaaa"));
    pane.apply(&notif);
    let area = Rect::new(0, 0, 20, 8);
    let (_, grid) = draw(&pane, area);

    // A full-screen clear then a short line must not leave the old glyphs.
    notif.data = Some(base64::engine::general_purpose::STANDARD.encode(b"\x1b[2J\x1b[Hb"));
    pane.apply(&notif);
    let (buf, grid2) = draw(&pane, area);
    assert_eq!(grid, grid2);
    let painted = row_text(&buf, grid.y, grid.x, grid.width);
    assert_eq!(painted, "b");
}

#[test]
fn wide_glyphs_stay_inside_the_pane() {
    let pane = pane_with(20, 4, "\u{65e5}\u{672c}\u{8a9e}");
    let area = Rect::new(0, 0, 20, 8);
    let (buf, grid) = draw(&pane, area);
    // A double-width glyph occupies two cells: ratatui writes the symbol into
    // the first and a blank into the continuation, so the raw row reads
    // "日 本 語". Strip the padding to assert the glyphs themselves survived.
    let painted = row_text(&buf, grid.y, grid.x, grid.width);
    let glyphs: String = painted.chars().filter(|c| !c.is_whitespace()).collect();
    assert_eq!(glyphs, "\u{65e5}\u{672c}\u{8a9e}");
    // Three wide glyphs consume six columns, not three and not nine.
    assert_eq!(display_width("\u{65e5}\u{672c}\u{8a9e}"), 6);
}

#[test]
fn colours_map_to_the_palette() {
    let pane = pane_with(20, 4, "\x1b[31mR\x1b[0m");
    let area = Rect::new(0, 0, 20, 8);
    let (buf, grid) = draw(&pane, area);
    let cell = buf.cell((grid.x, grid.y)).expect("first cell");
    assert_eq!(cell.fg, ratatui::style::Color::Indexed(1));
}

#[test]
fn the_cursor_is_inverted_while_alive() {
    let pane = pane_with(20, 4, "ab");
    let area = Rect::new(0, 0, 20, 8);
    let (buf, grid) = draw(&pane, area);
    // The emulator leaves the cursor one past the last glyph.
    let cell = buf.cell((grid.x + 2, grid.y)).expect("cursor cell");
    assert!(
        cell.modifier.contains(ratatui::style::Modifier::REVERSED),
        "cursor cell was {:?}",
        cell.modifier
    );
}

#[test]
fn no_cursor_after_exit() {
    let mut pane = pane_with(20, 4, "ab");
    pane.apply(&crate::app::terminal_pane::PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "exit".to_string(),
        exit_code: Some(0),
        ..Default::default()
    });
    let area = Rect::new(0, 0, 20, 10);
    let (buf, grid) = draw(&pane, area);
    for col in 0..grid.width {
        if let Some(cell) = buf.cell((grid.x + col, grid.y)) {
            assert!(
                !cell.modifier.contains(ratatui::style::Modifier::REVERSED),
                "column {col} kept a cursor after exit"
            );
        }
    }
}

#[test]
fn the_focused_border_differs_from_the_idle_one() {
    let pane = pane_with(20, 4, "hi");
    let theme = Theme::alnairnight();
    let area = Rect::new(0, 0, 20, 8);
    let mut idle = Buffer::empty(area);
    render_terminal_pane(
        area,
        &mut idle,
        &theme,
        TerminalPaneParams {
            pane: &pane,
            focused: false,
        },
    );
    let mut focused = Buffer::empty(area);
    render_terminal_pane(
        area,
        &mut focused,
        &theme,
        TerminalPaneParams {
            pane: &pane,
            focused: true,
        },
    );
    let a = idle.cell((0, 0)).expect("corner").fg;
    let b = focused.cell((0, 0)).expect("corner").fg;
    assert_ne!(a, b, "focus must be visible on the border");
}

#[test]
fn the_title_glyph_tracks_the_shell_state() {
    let theme = Theme::alnairnight();
    let area = Rect::new(0, 0, 24, 8);
    let title = |pane: &TerminalPane| {
        let mut buf = Buffer::empty(area);
        render_terminal_pane(
            area,
            &mut buf,
            &theme,
            TerminalPaneParams {
                pane,
                focused: false,
            },
        );
        row_text(&buf, 0, 0, 24)
    };

    let idle = pane_with(20, 4, "hi");
    assert!(title(&idle).contains('\u{25cb}'), "idle is a hollow circle");

    let mut busy = pane_with(20, 4, "hi");
    busy.apply(&crate::app::terminal_pane::PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "process_started".to_string(),
        ..Default::default()
    });
    assert!(title(&busy).contains('\u{25cf}'), "busy is a filled circle");

    let mut dead = pane_with(20, 4, "hi");
    dead.apply(&crate::app::terminal_pane::PtyNotification {
        terminal_id: "pty-1".to_string(),
        kind: "exit".to_string(),
        exit_code: Some(0),
        ..Default::default()
    });
    assert!(
        title(&dead).contains('\u{25a0}'),
        "exited is a filled square"
    );
}

#[test]
fn the_split_puts_the_pane_below_the_transcript() {
    let scrollback = Rect::new(3, 5, 60, 40);
    let (transcript, pane) = split_scrollback(scrollback).expect("room for both");
    assert_eq!(transcript.y, scrollback.y);
    assert_eq!(transcript.x, scrollback.x);
    assert_eq!(transcript.width, scrollback.width);
    assert_eq!(pane.x, scrollback.x);
    assert_eq!(pane.width, scrollback.width);
    // The two rects tile the original exactly: no gap, no overlap, no overflow.
    assert_eq!(transcript.height + pane.height, scrollback.height);
    assert_eq!(pane.y, transcript.bottom());
    assert_eq!(pane.bottom(), scrollback.bottom());
}

#[test]
fn the_split_hides_the_pane_when_there_is_no_room() {
    assert!(split_scrollback(Rect::new(0, 0, 80, 9)).is_none());
    assert!(split_scrollback(Rect::new(0, 0, 80, 0)).is_none());
}

#[test]
fn the_split_keeps_the_scrollback_usable() {
    for height in 10..120u16 {
        let scrollback = Rect::new(0, 0, 80, height);
        let Some((transcript, pane)) = split_scrollback(scrollback) else {
            continue;
        };
        assert!(
            transcript.height >= crate::app::terminal_pane::MIN_SCROLLBACK_ROWS,
            "height {height} starved the transcript"
        );
        assert!(pane.height > 0);
    }
}
