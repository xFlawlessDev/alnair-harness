//! Read-only terminal pane renderer.
//!
//! Draws a [`TerminalPane`]'s emulated grid into a rect. Everything here obeys
//! the same contract as the rest of the pager's dynamic content: every cell
//! write goes through [`SafeBuf::set_span_safe`], so a resize race between the
//! computed rect and the buffer cannot panic, and every label is clamped with
//! `truncate_str`, so a hostile program cannot push text past the pane.
//!
//! The pane is drawn *below* the scrollback, carved out of the scrollback rect
//! at the draw site. It is deliberately not a constraint in
//! `AgentViewLayout::compute`: that function takes 17 arguments and its
//! geometry is pinned by ~30 layout tests, so keeping the split local means
//! every existing assertion stays valid.

use alnair_terminal_screen::screen::{ScreenColor, ScreenStyle};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::{Block, BorderType, Borders, Widget};

use crate::app::terminal_pane::TerminalPane;
use crate::render::SafeBuf;
use crate::render::line_utils::truncate_str;
use crate::theme::Theme;

/// Rows the pane header and footer consume when the pane is tall enough to
/// have them.
const CHROME_ROWS: u16 = 2;

/// What the pane knows about itself, beyond the grid.
pub struct TerminalPaneParams<'a> {
    pub pane: &'a TerminalPane,
    /// The pane has keyboard focus (3b forwards keys; 3a only styles the border).
    pub focused: bool,
}

/// Split a scrollback rect into `(scrollback, pane)`.
///
/// The pane takes the bottom [`crate::app::terminal_pane::pane_height`] rows and
/// the scrollback keeps the rest. `None` when the pane must stay hidden: no
/// room for both, or the pane was toggled off (the caller decides the latter).
///
/// This is a pure rect calculation on purpose — `AgentViewLayout::compute` has
/// 17 parameters and ~30 tests pinning its geometry, so the split lives at the
/// draw site where it can be disabled without touching any of them.
pub fn split_scrollback(scrollback: Rect) -> Option<(Rect, Rect)> {
    let height = crate::app::terminal_pane::pane_height(scrollback.height)?;
    let scrollback_height = scrollback.height - height;
    let transcript = Rect {
        height: scrollback_height,
        ..scrollback
    };
    let pane = Rect {
        y: scrollback.y + scrollback_height,
        height,
        ..scrollback
    };
    Some((transcript, pane))
}

/// Draw the pane into `area` and return the grid's inner rect, so a later
/// input-forwarding phase can hit-test it.
///
/// A zero-area rect is a no-op: the caller decides visibility, and a degenerate
/// rect (resize in flight) must not panic.
pub fn render_terminal_pane(
    area: Rect,
    buf: &mut Buffer,
    theme: &Theme,
    params: TerminalPaneParams<'_>,
) -> Rect {
    if area.width < 4 || area.height < 3 {
        return Rect::default();
    }

    let border_style = if params.focused {
        Style::default().fg(theme.accent_assistant)
    } else {
        Style::default().fg(theme.gray_dim)
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(border_style)
        .style(Style::default().bg(theme.bg_terminal));
    let inner = block.inner(area);
    block.render(area, buf);

    // Title: "terminal" plus a liveness glyph. A hostile program cannot reach
    // this string - it is built from our own constants and a small integer.
    let glyph = if params.pane.exited.is_some() {
        "\u{25a0}" // filled square: exited
    } else if params.pane.busy {
        "\u{25cf}" // filled circle: running
    } else {
        "\u{25cb}" // hollow circle: idle prompt
    };
    let title = truncate_str(&format!(" terminal {glyph} "), inner.width as usize);
    buf.set_span_safe(
        area.x + 2,
        area.y,
        &Span::styled(title, Style::default().fg(theme.gray).bg(theme.bg_terminal)),
        inner.width,
    );

    // Footer: the exit notice replaces the bottom grid row when the child is
    // gone, so a dead shell does not silently look like a live one.
    let exit_label = params.pane.exit_label();
    let grid_rows = if exit_label.is_some() && inner.height > CHROME_ROWS {
        inner.height - CHROME_ROWS
    } else {
        inner.height
    };
    let grid = Rect {
        x: inner.x,
        y: inner.y,
        width: inner.width,
        height: grid_rows,
    };

    render_grid(grid, buf, theme, params.pane);

    if let Some(label) = exit_label
        && inner.height > CHROME_ROWS
    {
        let y = inner.y + inner.height - 1;
        let label = truncate_str(&label, inner.width as usize);
        buf.set_span_safe(
            inner.x,
            y,
            &Span::styled(
                label,
                Style::default()
                    .fg(theme.warning)
                    .bg(theme.bg_terminal)
                    .add_modifier(Modifier::DIM),
            ),
            inner.width,
        );
    }

    grid
}

/// Paint the emulator's visible rows into `grid`.
///
/// The emulator's grid is `cols`×`rows`; the rect can be smaller after a
/// resize, so both loops are bounded by the rect. Rows beyond the emulator's
/// height are left as the block's background.
fn render_grid(grid: Rect, buf: &mut Buffer, theme: &Theme, pane: &TerminalPane) {
    if grid.width == 0 || grid.height == 0 {
        return;
    }
    let rows = pane.screen.visible_rows();
    let cursor = pane.screen.cursor_cell();
    let cursor_visible = pane.screen.cursor_visible() && pane.exited.is_none();

    for (row_idx, row) in rows.iter().take(grid.height as usize).enumerate() {
        let y = grid.y + row_idx as u16;
        // Clear the row first: the emulator trims trailing blanks, so a shorter
        // line after a longer one would otherwise leave debris behind.
        for col in 0..grid.width {
            if let Some(cell) = buf.cell_mut((grid.x + col, y)) {
                cell.set_char(' ');
                cell.fg = theme.text_primary;
                cell.bg = theme.bg_terminal;
                cell.modifier = Modifier::empty();
            }
        }

        let mut x = 0u16;
        for run in &row.runs {
            if x >= grid.width {
                break;
            }
            let width = grid.width - x;
            let mut style = to_ratatui_style(run.style, theme);
            if run.style.inverse {
                style = style.add_modifier(Modifier::REVERSED);
            }
            let text = truncate_str(&run.text, width as usize);
            if text.is_empty() {
                continue;
            }
            let span_width = display_width(&text);
            buf.set_span_safe(grid.x + x, y, &Span::styled(text, style), width);
            x = x.saturating_add(span_width);
        }

        // Selection highlight, painted OVER the run text so it is visible on
        // coloured output. Only the selected columns are repainted; the rest of
        // the row keeps its colours.
        if let Some(sel) = pane.selection {
            let (start, end) = sel.span();
            let row_u16 = row_idx as u16;
            if row_u16 >= start.0 && row_u16 <= end.0 {
                let from = if row_u16 == start.0 { start.1 } else { 0 };
                let to = if row_u16 == end.0 {
                    (end.1 + 1).min(grid.width)
                } else {
                    grid.width
                };
                for col in from..to {
                    if let Some(cell) = buf.cell_mut((grid.x + col, y)) {
                        cell.bg = theme.bg_highlight;
                        cell.fg = theme.text_primary;
                    }
                }
            }
        }

        // Cursor: an inverted cell drawn only while the pane is alive and the
        // view is live. `cursor_cell` returns `None` while scrolled back, so a
        // history row never gets a cursor painted over it.
        if let Some((crow, ccol)) = cursor
            && cursor_visible
            && row_idx == crow
            && (ccol as u16) < grid.width
        {
            draw_cursor(buf, grid, y, ccol as u16, theme);
        }
    }
}

/// Invert whatever the cell at `(col, y)` currently holds.
fn draw_cursor(buf: &mut Buffer, grid: Rect, y: u16, col: u16, theme: &Theme) {
    let x = grid.x + col;
    let Some(cell) = buf.cell_mut((x, y)) else {
        return;
    };
    // The emulator's cursor may sit past the last glyph (the usual "next
    // character" position), where the row was already cleared to a space.
    if cell.symbol().is_empty() {
        cell.set_char(' ');
    }
    let fg = cell.fg;
    let bg = cell.bg;
    cell.fg = if bg == theme.bg_terminal {
        theme.bg_base
    } else {
        bg
    };
    cell.bg = if fg == theme.text_primary {
        theme.text_primary
    } else {
        fg
    };
    cell.modifier.insert(Modifier::REVERSED);
}

fn to_ratatui_style(style: ScreenStyle, theme: &Theme) -> Style {
    let fg = match style.fg {
        ScreenColor::Default => theme.text_primary,
        ScreenColor::Indexed(idx) => Color::Indexed(idx),
        ScreenColor::Rgb(r, g, b) => Color::Rgb(r, g, b),
    };
    let bg = match style.bg {
        ScreenColor::Default => theme.bg_terminal,
        ScreenColor::Indexed(idx) => Color::Indexed(idx),
        ScreenColor::Rgb(r, g, b) => Color::Rgb(r, g, b),
    };
    let mut out = Style::default().fg(fg).bg(bg);
    if style.bold {
        out = out.add_modifier(Modifier::BOLD);
    }
    if style.italic {
        out = out.add_modifier(Modifier::ITALIC);
    }
    if style.underline {
        out = out.add_modifier(Modifier::UNDERLINED);
    }
    if style.strikeout {
        out = out.add_modifier(Modifier::CROSSED_OUT);
    }
    if style.dim {
        out = out.add_modifier(Modifier::DIM);
    }
    out
}

fn display_width(s: &str) -> u16 {
    use unicode_width::UnicodeWidthStr;
    u16::try_from(s.width()).unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests;
