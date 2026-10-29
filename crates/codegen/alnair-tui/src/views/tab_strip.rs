//! One-row session tab strip.
//!
//! The strip is a *client-side* view of the shared tab list: it shows which
//! sessions are open, which one is active, and what each is doing. It renders
//! into a single row carved off the top of the view area, so Welcome, Agent,
//! and Dashboard all get it uniformly.
//!
//! Chips are written through [`SafeBuf::set_span_safe`] and every label goes
//! through `truncate_str`, so a title can neither overflow the row nor split a
//! wide character — the same contract as `render_follow_ups`.
//!
//! The repo label (`repo ⎇ branch`) appears only when the strip spans more than
//! one repository. With a single repo it is pure noise; with several it is the
//! only thing that says which chip lives where.
//!
//! ## More tabs than columns
//!
//! The strip is a *window* over the tab list, not a fixed set of five. The
//! window follows the active chip while the user is working (activation, open,
//! close, `Ctrl+PageDown`), and it can be scrolled explicitly — wheel over the
//! row, or click an edge marker — when the user is browsing chips that are not
//! the active one. `‹` / `›` mark the hidden side; the window's start is owned by
//! the caller (`AppView::tab_scroll`) so a wheel step continues from the last
//! painted frame instead of re-deriving from the active chip every tick.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Span;

use crate::render::SafeBuf;
use crate::render::line_utils::truncate_str;
use crate::theme::Theme;

/// Minimum columns a chip may occupy, active or not.
const MIN_CHIP: u16 = 6;
/// Minimum columns the ACTIVE chip may occupy before shrinking others.
const MIN_ACTIVE_CHIP: u16 = 8;
/// Cap on a chip's label, before the repo detail is appended.
const MAX_LABEL: usize = 40;
/// Columns an edge scroll marker owns (`‹ ` / ` ›`). Reserved out of the chip
/// budget as soon as anything is hidden on that side, so a marker can never
/// overrun a chip it is supposed to announce.
const SCROLL_MARKER_W: u16 = 2;

/// Per-tab activity, derived by the caller from local agent state or the
/// leader roster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabStatus {
    Idle,
    Running,
    Permission,
    Question,
    /// Server-side watermark says this session changed since it was last read.
    Unread,
}

impl TabStatus {
    /// Glyph shown left of the label. Kept ASCII-ish/single-width so the chip
    /// width math stays exact.
    fn glyph(self) -> &'static str {
        match self {
            Self::Idle => "\u{b7}",
            Self::Running => "\u{25b8}",
            Self::Permission => "!",
            Self::Question => "?",
            Self::Unread => "\u{25cf}",
        }
    }
}

/// One rendered chip, for hit-testing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabHit {
    pub session_id: String,
    pub rect: Rect,
    /// The `×` affordance inside this chip (rich chrome only). Checked before
    /// `rect` so a click on the close glyph never activates the tab.
    pub close_rect: Option<Rect>,
}

/// What a click on the strip landed on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TabHitTarget {
    Tab(String),
    /// The `[ + ]` affordance: ask where the new session should live.
    NewSession,
    /// A chip's `×` affordance: close that tab (never the session).
    CloseTab(String),
    /// An edge scroll marker (`‹` / `›`): the strip holds more tabs in that
    /// direction than fit, so move one step that way. Cheap and honest — the
    /// marker's own meaning is "there is another tab past here".
    ScrollTabs {
        forward: bool,
    },
}

/// One chip's data, gathered by the caller.
///
/// The renderer takes plain data rather than closures over `AppView`: the draw
/// path already holds a mutable borrow of the app, so status/detail resolution
/// happens before the frame and this stays a pure function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabChipInput {
    pub session_id: String,
    /// Already-derived display title (the caller applies `entry_title`).
    pub title: String,
    pub status: TabStatus,
    /// `repo ⎇ branch`, shown only when the strip spans more than one repo.
    pub detail: Option<String>,
    /// The session's directory, used to decide whether the repo label appears.
    pub cwd: std::path::PathBuf,
}

/// Everything the strip needs, gathered by the caller so rendering stays pure.
pub struct TabStripParams<'a> {
    pub chips: &'a [TabChipInput],
    pub active: Option<usize>,
    /// Pinned window start, or `None` to follow `active`.
    ///
    /// `None` is the resting state: the window is derived so the active chip is
    /// visible, which is what cycling (`Ctrl+PageDown`), opening, closing, and
    /// restoring all want for free. `Some` exists only for an explicit scroll of
    /// the strip (wheel, or a click on an edge marker), where the user is
    /// browsing chips that are not the active one — respecting their scroll is
    /// the whole point of the gesture, so the active chip may sit outside the
    /// window until something activates a tab again.
    pub offset: Option<usize>,
}

/// Rendered strip areas.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TabStripRendered {
    pub tabs: Vec<TabHit>,
    pub new_session: Option<Rect>,
    /// True when at least one chip is outside the window.
    pub overflow: bool,
    /// `‹` marker: chips exist before the window. Click scrolls back.
    pub scroll_back: Option<Rect>,
    /// `›` marker: chips exist after the window. Click scrolls forward.
    pub scroll_forward: Option<Rect>,
    /// The chip indexes actually painted. The caller pins its scroll offset to
    /// this so a wheel step continues from where the last frame landed.
    pub window: std::ops::Range<usize>,
}

impl TabStripRendered {
    pub fn hit(&self, column: u16, row: u16) -> Option<TabHitTarget> {
        let point = (column, row).into();
        // A chip's close glyph is checked before the chip body: the `×` is
        // inside the rect, so the reverse order would activate instead.
        for hit in &self.tabs {
            if hit.close_rect.is_some_and(|r| r.contains(point)) {
                return Some(TabHitTarget::CloseTab(hit.session_id.clone()));
            }
        }
        for hit in &self.tabs {
            if hit.rect.contains(point) {
                return Some(TabHitTarget::Tab(hit.session_id.clone()));
            }
        }
        if self.scroll_back.is_some_and(|r| r.contains(point)) {
            return Some(TabHitTarget::ScrollTabs { forward: false });
        }
        if self.scroll_forward.is_some_and(|r| r.contains(point)) {
            return Some(TabHitTarget::ScrollTabs { forward: true });
        }
        if self.new_session.is_some_and(|r| r.contains(point)) {
            return Some(TabHitTarget::NewSession);
        }
        None
    }
}

/// Render the strip into `area` (exactly one row).
///
/// Returns the hit rects for mouse routing. An empty or zero-width area is a
/// no-op so a resize race can never panic.
pub fn render_tab_strip(
    area: Rect,
    buf: &mut Buffer,
    theme: &Theme,
    params: &TabStripParams<'_>,
) -> TabStripRendered {
    let mut out = TabStripRendered::default();
    if area.height == 0 || area.width == 0 || params.chips.is_empty() {
        return out;
    }

    // Clear the row first: a shrinking strip must not leave stale glyphs.
    for col in 0..area.width {
        if let Some(cell) = buf.cell_mut((area.x + col, area.y)) {
            cell.set_char(' ');
            cell.fg = theme.text_secondary;
            cell.bg = theme.bg_base;
        }
    }

    let chips = params.chips;
    let active = params.active;
    let multi_repo = spans_multiple_repos(chips);
    let rich = crate::views::chrome::is_rich();

    // Rich chrome follows the tab-strip idiom: every chip owns its own `×`
    // and `+` sits right after the last chip. Plain keeps the legacy layout
    // (one close button at the right edge, for the active tab only).
    let (plus, close) = if rich {
        (" + ", "\u{00d7}")
    } else {
        ("[ + ]", "[ \u{00d7} ]")
    };
    let plus_w = plus.chars().count() as u16;
    let close_w = close.chars().count() as u16;
    let gutter = 1u16;
    let show_close = !rich && active.is_some();
    let buttons_w = plus_w + if show_close { close_w + gutter } else { 0 };
    let reserve = buttons_w + gutter * 3;
    if area.width <= reserve + MIN_CHIP {
        // Not enough room for even one chip plus the buttons: show only the
        // buttons, so `+` (and `×`) are never unreachable.
        let x = area.x + area.width.saturating_sub(buttons_w + gutter);
        let (add, _) = place_buttons(buf, area, theme, x, plus, show_close.then_some(close));
        out.new_session = Some(add);
        return out;
    }
    let chip_budget = area.width - reserve;
    let left_inset = if rich { 1 } else { 0 };
    let close_suffix = if rich { close_w + 1 } else { 0 };

    // Build labels, then shrink to fit.
    let labels: Vec<String> = chips
        .iter()
        .enumerate()
        .map(|(i, chip)| chip_label(chip, i, active == Some(i), multi_repo))
        .collect();

    // A chip wider than the budget could never be painted, so it is a hard cut
    // for the window rather than another scrolling step.
    let widths = fit_widths(
        &labels,
        chip_budget.saturating_sub(left_inset),
        active,
        close_suffix,
    );
    let window = choose_window(&widths, chip_budget, params.offset, active);

    // A back marker owns the first columns of the row, so the chips it precedes
    // start after it — the same columns `fill_from` already charged to the
    // budget, which is why the last chip still fits.
    let back_marker_w = if window.start > 0 { SCROLL_MARKER_W } else { 0 };
    let mut x = area.x + left_inset + back_marker_w;
    let mut shown = 0usize;
    let mut painted_end = window.start;
    for i in window.clone() {
        let Some(w) = widths.get(i).copied().flatten() else {
            continue;
        };
        if w == 0 || x + w > area.x + chip_budget {
            break;
        }
        let label = labels.get(i).map(String::as_str).unwrap_or("");
        let text = truncate_str(label, w.saturating_sub(4 + close_suffix) as usize);
        let text_w = text.chars().count() as u16;
        let chip_w = text_w + 4 + close_suffix;
        if chip_w > w {
            continue;
        }
        let is_active = active == Some(i);
        let status_style = if rich {
            match chips[i].status {
                TabStatus::Idle => Style::default().fg(theme.gray),
                TabStatus::Running => Style::default().fg(theme.accent_running),
                TabStatus::Permission | TabStatus::Question => {
                    Style::default().fg(theme.accent_user)
                }
                TabStatus::Unread => Style::default().fg(theme.accent_remember),
            }
        } else {
            Style::default().fg(theme.text_secondary)
        };
        let chip_style = if is_active {
            Style::default()
                .fg(if rich {
                    theme.accent_remember
                } else {
                    theme.text_primary
                })
                .bg(theme.bg_hover)
                .add_modifier(Modifier::BOLD)
                .add_modifier(if rich {
                    Modifier::UNDERLINED
                } else {
                    Modifier::empty()
                })
        } else if rich {
            Style::default().fg(theme.text_secondary).bg(theme.bg_dark)
        } else {
            Style::default().fg(theme.text_secondary).bg(theme.bg_base)
        };
        let gap = if shown > 0 { 1 } else { 0 };
        x = x.saturating_add(gap);
        let chip_x = x;
        let glyph = chips[i].status.glyph();
        let mut close_rect = None;
        if rich {
            // Rich chips read `[ 2 · title × ]`: the close glyph lives INSIDE
            // the bracket, and its span carries its own hit rect. A narrow chip
            // may truncate the status glyph away entirely; then the whole text
            // is painted as the prefix and the close glyph still follows.
            let glyph_at = text.find(glyph);
            let (prefix, after_glyph) = match glyph_at {
                Some(at) => (&text[..at], &text[at + glyph.len()..]),
                None => (text.as_str(), ""),
            };
            let mut cursor = chip_x;
            let prefix_span = format!("[ {prefix}");
            let prefix_w = prefix_span.chars().count() as u16;
            buf.set_span_safe(
                cursor,
                area.y,
                &Span::styled(prefix_span, chip_style),
                prefix_w,
            );
            cursor = cursor.saturating_add(prefix_w);
            if glyph_at.is_some() {
                buf.set_span_safe(
                    cursor,
                    area.y,
                    &Span::styled(
                        glyph,
                        status_style.bg(chip_style.bg.unwrap_or(theme.bg_base)),
                    ),
                    1,
                );
                cursor = cursor.saturating_add(1);
            }
            let after_w = after_glyph.chars().count() as u16;
            if after_w > 0 {
                buf.set_span_safe(
                    cursor,
                    area.y,
                    &Span::styled(after_glyph, chip_style),
                    after_w,
                );
                cursor = cursor.saturating_add(after_w);
            }
            buf.set_span_safe(cursor, area.y, &Span::styled(" ", chip_style), 1);
            cursor = cursor.saturating_add(1);
            buf.set_span_safe(
                cursor,
                area.y,
                &Span::styled(close, chip_style.fg(theme.gray_bright)),
                close_w,
            );
            close_rect = Some(Rect::new(cursor, area.y, close_w, 1));
            cursor = cursor.saturating_add(close_w);
            buf.set_span_safe(cursor, area.y, &Span::styled(" ]", chip_style), 2);
        } else {
            let body = format!("[ {text} ]");
            buf.set_span_safe(
                chip_x,
                area.y,
                &Span::styled(body.clone(), chip_style),
                body.chars().count() as u16,
            );
        }
        out.tabs.push(TabHit {
            session_id: chips[i].session_id.clone(),
            rect: Rect::new(chip_x, area.y, chip_w, 1),
            close_rect,
        });
        x = chip_x.saturating_add(chip_w);
        shown += 1;
        painted_end = i + 1;
    }
    out.window = window.start..painted_end.max(window.start);
    out.overflow = out.window.len() < chips.len();

    if rich {
        // `+` follows the last chip instead of floating at the right edge.
        let plus_x = x.saturating_add(1);
        let plus_rect = Rect::new(plus_x, area.y, plus_w, 1);
        if plus_x + plus_w <= area.x + area.width {
            buf.set_span_safe(
                plus_x,
                area.y,
                &Span::styled(
                    plus,
                    Style::default()
                        .fg(theme.link_fg)
                        .bg(theme.bg_base)
                        .add_modifier(Modifier::BOLD),
                ),
                plus_w,
            );
            out.new_session = Some(plus_rect);
        }
        paint_scroll_markers(buf, area, theme, &mut out, chips.len());
        return out;
    }

    let x = area.x + area.width.saturating_sub(buttons_w + gutter);
    let (add, _close_rect) = place_buttons(buf, area, theme, x, plus, show_close.then_some(close));
    out.new_session = Some(add);
    paint_scroll_markers(buf, area, theme, &mut out, chips.len());
    out
}

/// Paint the `‹` / `›` edge markers for whatever the window left out.
///
/// They are drawn last, over the tail of the chip row, because the budget they
/// announce was reserved before any chip was painted (`choose_window` keeps
/// [`SCROLL_MARKER_W`] free whenever a side has hidden chips). So an edge marker
/// only ever lands on padding or on the trailing gap — never on a chip it would
/// cover. They are the only affordance on the strip that can move the window,
/// which is what makes an overflowing strip navigable by mouse as well as by
/// `Ctrl+PageDown`.
fn paint_scroll_markers(
    buf: &mut Buffer,
    area: Rect,
    theme: &Theme,
    out: &mut TabStripRendered,
    total: usize,
) {
    let style = Style::default()
        .fg(theme.gray)
        .bg(theme.bg_base)
        .add_modifier(Modifier::BOLD);
    // The forward marker is anchored to the RIGHT edge of the last painted chip
    // rather than to the row width: `↔` a marker that claims unused space far
    // from the tabs it refers to reads as noise.
    let left_inset = if crate::views::chrome::is_rich() {
        1
    } else {
        0
    };
    if out.window.start > 0 {
        let label = format!("{} ", crate::glyphs::chevron_left());
        let x = area.x + left_inset;
        let rect = Rect::new(x, area.y, SCROLL_MARKER_W, 1);
        if rect.right() <= area.right() {
            buf.set_span_safe(x, area.y, &Span::styled(label, style), SCROLL_MARKER_W);
            out.scroll_back = Some(rect);
        }
    }
    let hidden_after = out.window.end < total;
    let last_right = out.tabs.last().map(|t| t.rect.right());
    if let (true, Some(right)) = (hidden_after, last_right) {
        let x = right.saturating_add(1);
        let rect = Rect::new(x, area.y, SCROLL_MARKER_W, 1);
        if rect.right() <= area.right() {
            let label = format!(" {}", crate::glyphs::chevron());
            buf.set_span_safe(x, area.y, &Span::styled(label, style), SCROLL_MARKER_W);
            out.scroll_forward = Some(rect);
        }
    }
}

/// Pick the window of chips the strip shows.
///
/// Two modes, distinguished by what the caller passes:
///
/// - `offset = None` (**resting**): the window is derived so the ACTIVE chip is
///   visible. Opening, closing, and activating a tab all land here, so the chip
///   the user is looking at never hides itself.
/// - `offset = Some(start)` (**scrolled**): the user has explicitly moved the
///   strip (wheel or an edge marker) and is browsing chips that are not the
///   active one. Their position is honoured as given — snapping back to the
///   active chip on the next frame would undo the gesture — and the caller
///   clears the pin as soon as something activates a tab.
///
/// `widths[i] == None` means that chip cannot be painted at any width; it is
/// skipped rather than ending the window, so one pathological title cannot hide
/// every tab after it.
fn choose_window(
    widths: &[Option<u16>],
    budget: u16,
    offset: Option<usize>,
    active: Option<usize>,
) -> std::ops::Range<usize> {
    let total = widths.len();
    if let Some(start) = offset {
        let start = start.min(total.saturating_sub(1));
        return start..fill_from(widths, start, budget, total).max(start + 1);
    }
    // Resting mode: widest prefix that fits, then slide right so the active
    // chip is inside it. Fitting from the front first is what keeps the strip
    // stable while it still fits (no twitch as the cursor moves over a row of
    // short titles).
    let end = fill_from(widths, 0, budget, total);
    if let Some(a) = active
        && a >= end
        && end > 0
    {
        // The active chip is off the right edge: walk the start forward until
        // it is inside, keeping the window as full as `budget` allows.
        let mut start = end - 1;
        while start + 1 < a.min(total) {
            let candidate = start + 1;
            if a >= fill_from(widths, candidate, budget, total) {
                start = candidate;
            } else {
                break;
            }
        }
        let end = fill_from(widths, start, budget, total);
        return start..end.max(start + 1);
    }
    if end == 0 {
        // Nothing fits from the front (one very wide chip): show at least that
        // one, truncated downstream, rather than an empty strip.
        return 0..total.min(1);
    }
    0..end
}

/// Index one past the last chip that fits starting at `start`.
///
/// The budget it spends already excludes whatever markers the window will need:
/// [`SCROLL_MARKER_W`] on the left when `start > 0` (the back marker owns the
/// first columns of the row, so the first chip must begin after it) and on the
/// right whenever a chip stays hidden. That reservation is what keeps a marker
/// from being painted over a chip — and from stealing its click.
fn fill_from(widths: &[Option<u16>], start: usize, budget: u16, total: usize) -> usize {
    let mut used = if start > 0 { SCROLL_MARKER_W } else { 0 };
    let mut end = start;
    for (i, slot) in widths.iter().enumerate().skip(start) {
        let Some(w) = *slot else {
            end = i + 1;
            continue;
        };
        let gap = if end > start { 1 } else { 0 };
        // Everything after this chip is still hidden, so a forward marker will be
        // painted and it must come out of the same budget.
        let marker = if i + 1 < total { SCROLL_MARKER_W } else { 0 };
        if used
            .saturating_add(gap)
            .saturating_add(w)
            .saturating_add(marker)
            > budget
        {
            break;
        }
        used += gap + w;
        end = i + 1;
    }
    end
}

/// Paint the right-hand affordances right-aligned at `x`.
///
/// Returns `(add_rect, close_rect)`; `close` is `None` when the strip has no
/// active tab and the close button is therefore not offered.
fn place_buttons(
    buf: &mut Buffer,
    area: Rect,
    theme: &Theme,
    x: u16,
    plus: &str,
    close: Option<&str>,
) -> (Rect, Option<Rect>) {
    let style = Style::default()
        .fg(theme.link_fg)
        .bg(theme.bg_base)
        .add_modifier(if crate::views::chrome::is_rich() {
            Modifier::BOLD
        } else {
            Modifier::empty()
        });
    let plus_w = plus.chars().count() as u16;
    let mut cursor = x;
    let close_rect = close.map(|text| {
        let w = text.chars().count() as u16;
        let rect = Rect::new(cursor, area.y, w, 1);
        buf.set_span_safe(cursor, area.y, &Span::styled(text, style), w);
        cursor = cursor.saturating_add(w).saturating_add(1);
        rect
    });
    let plus_rect = Rect::new(cursor, area.y, plus_w, 1);
    buf.set_span_safe(cursor, area.y, &Span::styled(plus, style), plus_w);
    (plus_rect, close_rect)
}

/// `N glyph title` (active) / `glyph title` (inactive), plus the repo detail.
fn chip_label(chip: &TabChipInput, index: usize, is_active: bool, multi_repo: bool) -> String {
    let number = if is_active {
        format!("{} ", index + 1)
    } else {
        String::new()
    };
    let mut label = format!("{number}{} {}", chip.status.glyph(), chip.title);
    if multi_repo
        && let Some(detail) = chip.detail.as_deref()
        && !detail.is_empty()
    {
        label.push_str(" \u{2387} ");
        label.push_str(detail);
    }
    truncate_str(&label, MAX_LABEL)
}

/// Width each chip wants, then shrink inactive chips before touching the
/// active one. `None` means "did not fit at all". `close_suffix` is the
/// per-chip `×` width (rich chrome) so the budget accounts for it.
fn fit_widths(
    labels: &[String],
    budget: u16,
    active: Option<usize>,
    close_suffix: u16,
) -> Vec<Option<u16>> {
    let wanted: Vec<u16> = labels
        .iter()
        .map(|l| {
            (l.chars().count() as u16)
                .saturating_add(4)
                .saturating_add(close_suffix)
        })
        .collect();
    let total: u16 = wanted.iter().copied().sum();
    if total <= budget {
        return wanted.into_iter().map(Some).collect();
    }

    // Shrink every chip proportionally, then floor at MIN_CHIP and let the
    // active chip keep its minimum before the rest.
    let count = wanted.len().max(1) as u16;
    let even = budget / count;
    let mut out: Vec<Option<u16>> = wanted
        .iter()
        .map(|w| Some((*w).min(even.max(MIN_CHIP))))
        .collect();

    // Give the active chip its minimum first.
    if let Some(a) = active
        && let Some(slot) = out.get_mut(a)
        && slot.is_some_and(|w| w < MIN_ACTIVE_CHIP)
    {
        *slot = Some(MIN_ACTIVE_CHIP);
    }

    // Drop chips from the right until the row fits.
    let mut used: u16 = out.iter().flatten().copied().sum();
    for i in (0..out.len()).rev() {
        if used <= budget {
            break;
        }
        if Some(i) == active {
            continue;
        }
        if let Some(slot) = out.get_mut(i)
            && slot.is_some()
        {
            used -= slot.take().unwrap_or(0);
        }
    }
    out
}

fn spans_multiple_repos(chips: &[TabChipInput]) -> bool {
    let mut first: Option<&std::path::Path> = None;
    for chip in chips {
        match first {
            None => first = Some(chip.cwd.as_path()),
            Some(f) if f != chip.cwd.as_path() => return true,
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;
    use std::path::PathBuf;

    fn theme() -> Theme {
        Theme::default()
    }

    fn chip(id: &str) -> TabChipInput {
        TabChipInput {
            session_id: id.to_string(),
            title: format!("session {id}"),
            status: TabStatus::Idle,
            detail: None,
            cwd: PathBuf::from("/repo"),
        }
    }

    fn chips(ids: &[&str]) -> Vec<TabChipInput> {
        ids.iter().map(|id| chip(id)).collect()
    }

    fn draw(
        area: Rect,
        chips: &[TabChipInput],
        active: Option<usize>,
    ) -> (Buffer, TabStripRendered) {
        draw_at(area, chips, active, None)
    }

    fn draw_at(
        area: Rect,
        chips: &[TabChipInput],
        active: Option<usize>,
        offset: Option<usize>,
    ) -> (Buffer, TabStripRendered) {
        let mut buf = Buffer::empty(area);
        let params = TabStripParams {
            chips,
            active,
            offset,
        };
        let rendered = render_tab_strip(area, &mut buf, &theme(), &params);
        (buf, rendered)
    }

    #[test]
    fn zero_area_is_a_noop() {
        let c = chips(&["a"]);
        let (_, rendered) = draw(Rect::new(0, 0, 0, 0), &c, Some(0));
        assert!(rendered.tabs.is_empty());
        assert!(rendered.new_session.is_none());
    }

    #[test]
    fn empty_chip_list_renders_nothing() {
        let (_, rendered) = draw(Rect::new(0, 0, 80, 1), &[], None);
        assert!(rendered.tabs.is_empty());
    }

    #[test]
    fn chips_are_hit_testable() {
        let c = chips(&["a", "b"]);
        let (_, rendered) = draw(Rect::new(0, 0, 80, 1), &c, Some(0));
        assert_eq!(rendered.tabs.len(), 2);
        let first = rendered.tabs[0].clone();
        assert_eq!(
            rendered.hit(first.rect.x + 1, 0),
            Some(TabHitTarget::Tab("a".into()))
        );
        assert!(rendered.new_session.is_some());
    }

    /// Rich chrome puts `×` inside every chip and `+` right after the last
    /// chip, so the strip reads as a row of tabs rather than a list with
    /// controls floating at the far edge.
    #[test]
    fn rich_chips_own_their_close_button() {
        crate::appearance::cache::set_chrome_style(crate::appearance::ChromeStyle::Rich);
        let c = chips(&["a", "b", "c"]);
        let area = Rect::new(0, 0, 80, 1);
        let (_, rendered) = draw(area, &c, Some(0));
        assert_eq!(rendered.tabs.len(), 3);

        for hit in &rendered.tabs {
            let close = hit.close_rect.expect("every rich chip has a close glyph");
            assert!(close.x >= hit.rect.x && close.right() <= hit.rect.right());
            assert_eq!(
                rendered.hit(close.x, 0),
                Some(TabHitTarget::CloseTab(hit.session_id.clone())),
                "close glyph wins over the chip body"
            );
        }

        let plus = rendered.new_session.expect("+ after the last chip");
        let last = &rendered.tabs[2];
        assert!(
            plus.x > last.rect.x && plus.x <= last.rect.right() + 2,
            "plus follows the last chip: plus={plus:?} last={:?}",
            last.rect
        );
    }

    /// Plain mode keeps the legacy right-aligned controls.
    #[test]
    fn plain_mode_keeps_the_edge_buttons() {
        crate::appearance::cache::set_chrome_style(crate::appearance::ChromeStyle::Plain);
        let c = chips(&["a", "b"]);
        let area = Rect::new(0, 0, 60, 1);
        let (_, rendered) = draw(area, &c, Some(0));
        let plus = rendered.new_session.expect("+ chip");
        assert!(plus.x + plus.width <= area.right());
        assert!(rendered.tabs.iter().all(|hit| hit.close_rect.is_none()));
        crate::appearance::cache::set_chrome_style(crate::appearance::ChromeStyle::Rich);
    }

    /// A very narrow strip keeps the add affordance even when no chip fits.
    #[test]
    fn narrow_strip_still_offers_the_buttons() {
        let c = chips(&["a", "b", "c"]);
        let area = Rect::new(0, 0, 18, 1);
        let (_, rendered) = draw(area, &c, Some(0));
        assert!(rendered.new_session.is_some());
        for hit in &rendered.tabs {
            assert!(hit.rect.right() <= area.right(), "no chip may overflow");
        }
    }

    #[test]
    fn overflow_drops_chips_from_the_right() {
        let c = chips(&["a", "b", "c", "d", "e"]);
        let area = Rect::new(0, 0, 40, 1);
        let (_, rendered) = draw(area, &c, Some(0));
        assert!(rendered.overflow, "not everything fit");
        assert!(!rendered.tabs.is_empty(), "at least the active chip shows");
        assert_eq!(
            rendered.tabs[0].session_id, "a",
            "chips are dropped from the right, so the leftmost survives"
        );
    }

    /// The strip is a window, not a fixed five: a chip past the right edge is
    /// reachable by scrolling instead of being lost. Before this the extra tabs
    /// simply never rendered — no marker, no way to reach them.
    #[test]
    fn overflowing_strip_reports_a_window_and_a_forward_marker() {
        let c = chips(&["a", "b", "c", "d", "e", "f"]);
        let area = Rect::new(0, 0, 40, 1);
        let (_, rendered) = draw(area, &c, Some(0));

        assert!(rendered.overflow);
        assert_eq!(
            rendered.window.start, 0,
            "resting window starts at the left"
        );
        assert!(
            rendered.window.end < c.len(),
            "window must stop before the end: {:?}",
            rendered.window
        );
        assert!(
            rendered.scroll_forward.is_some(),
            "a hidden right side needs a `>` marker"
        );
        assert!(
            rendered.scroll_back.is_none(),
            "nothing is hidden on the left at offset 0"
        );
    }

    /// A pinned offset shows the chips from there, and both markers appear when
    /// something is hidden on both sides.
    #[test]
    fn pinned_offset_scrolls_the_window() {
        let c = chips(&["a", "b", "c", "d", "e", "f"]);
        let area = Rect::new(0, 0, 40, 1);
        let (_, rendered) = draw_at(area, &c, Some(0), Some(2));

        assert_eq!(rendered.window.start, 2, "window honours the pinned offset");
        assert_eq!(
            rendered.tabs.first().map(|h| h.session_id.as_str()),
            Some("c"),
            "the first painted chip is the one at the offset"
        );
        assert!(rendered.scroll_back.is_some(), "left side is hidden now");
        assert!(rendered.scroll_forward.is_some(), "right side still is");
    }

    /// Resting mode follows the ACTIVE chip: activating a tab past the right
    /// edge scrolls it into view instead of hiding it. That is what makes
    /// `Ctrl+PageDown` usable with more tabs than columns.
    #[test]
    fn resting_window_follows_the_active_chip() {
        let c = chips(&["a", "b", "c", "d", "e", "f"]);
        let area = Rect::new(0, 0, 40, 1);
        let (_, rendered) = draw(area, &c, Some(5));

        assert!(
            rendered.window.contains(&5),
            "active chip must be inside the window: {:?}",
            rendered.window
        );
        assert!(
            rendered.scroll_back.is_some(),
            "following the active chip leaves the left side hidden"
        );
        assert!(
            rendered
                .tabs
                .iter()
                .any(|h| h.session_id == "f" && h.rect.width > 0),
            "the active chip must actually be painted"
        );
    }

    /// Edge markers are clickable, so an overflowing strip is reachable with the
    /// mouse as well as with `Ctrl+PageDown`.
    #[test]
    fn edge_markers_are_hit_testable() {
        let c = chips(&["a", "b", "c", "d", "e", "f"]);
        let area = Rect::new(0, 0, 40, 1);
        let (_, rendered) = draw_at(area, &c, Some(2), Some(2));

        let back = rendered.scroll_back.expect("back marker");
        assert_eq!(
            rendered.hit(back.x, 0),
            Some(TabHitTarget::ScrollTabs { forward: false })
        );
        let forward = rendered.scroll_forward.expect("forward marker");
        assert_eq!(
            rendered.hit(forward.x, 0),
            Some(TabHitTarget::ScrollTabs { forward: true })
        );
    }

    /// A marker must never be painted on top of a chip it would cover — the
    /// budget reserves its columns before any chip is placed.
    #[test]
    fn markers_never_overlap_a_chip() {
        let c = chips(&["a", "b", "c", "d", "e", "f", "g"]);
        let area = Rect::new(0, 0, 40, 1);
        let (_, rendered) = draw_at(area, &c, Some(1), Some(1));

        let marker = rendered.scroll_forward.expect("forward marker");
        for hit in &rendered.tabs {
            assert!(
                !hit.rect.intersects(marker),
                "marker {marker:?} overlaps chip {:?}",
                hit.rect
            );
        }
    }

    #[test]
    fn wide_titles_are_truncated_and_never_overflow() {
        let mut c = chips(&["a"]);
        c[0].title = "x".repeat(500);
        let area = Rect::new(0, 0, 40, 1);
        let (_, rendered) = draw(area, &c, Some(0));
        for hit in &rendered.tabs {
            assert!(hit.rect.right() <= area.right());
        }
    }

    /// CJK titles must not split a wide character across the chip boundary.
    #[test]
    fn wide_characters_stay_inside_the_chip() {
        let mut c = chips(&["a"]);
        c[0].title = "\u{4f60}\u{597d}\u{4e16}\u{754c}".repeat(40);
        let (_, rendered) = draw(Rect::new(0, 0, 40, 1), &c, Some(0));
        for hit in &rendered.tabs {
            assert!(hit.rect.right() <= 40);
        }
    }

    #[test]
    fn repo_detail_appears_only_across_repos() {
        let one = vec![chip("a"), chip("b")];
        assert!(!spans_multiple_repos(&one));

        let mut two = vec![chip("a"), chip("b")];
        two[1].cwd = PathBuf::from("/other");
        assert!(spans_multiple_repos(&two));
    }

    #[test]
    fn repo_detail_renders_only_when_multiple_repos() {
        let mut c = chips(&["a"]);
        c[0].detail = Some("alnair \u{2387} main".into());
        let (single, _) = draw(Rect::new(0, 0, 80, 1), &c, Some(0));
        let row: String = (0..80)
            .filter_map(|x| single.cell((x, 0)).map(|c| c.symbol().to_string()))
            .collect();
        assert!(
            !row.contains('\u{2387}'),
            "one repo must hide the detail: {row:?}"
        );

        let mut two = c.clone();
        let mut other = chip("b");
        other.cwd = PathBuf::from("/other");
        other.detail = Some("other \u{2387} dev".into());
        two.push(other);
        let (multi, _) = draw(Rect::new(0, 0, 80, 1), &two, Some(0));
        let row: String = (0..80)
            .filter_map(|x| multi.cell((x, 0)).map(|c| c.symbol().to_string()))
            .collect();
        assert!(row.contains('\u{2387}'), "two repos show it: {row:?}");
    }

    #[test]
    fn status_glyph_reaches_the_chip() {
        let mut c = chips(&["a"]);
        c[0].status = TabStatus::Permission;
        let (buf, _) = draw(Rect::new(0, 0, 40, 1), &c, Some(0));
        let row: String = (0..40)
            .filter_map(|x| buf.cell((x, 0)).map(|c| c.symbol().to_string()))
            .collect();
        assert!(row.contains('!'), "permission glyph expected, got {row:?}");
    }

    #[test]
    fn rich_status_glyph_keeps_its_tint() {
        crate::appearance::cache::set_chrome_style(crate::appearance::ChromeStyle::Rich);
        let mut c = chips(&["a"]);
        c[0].status = TabStatus::Running;
        let (buf, _) = draw(Rect::new(0, 0, 40, 1), &c, Some(0));
        let row: String = (0..40)
            .filter_map(|x| buf.cell((x, 0)).map(|c| c.symbol().to_string()))
            .collect();
        let glyph_at = row.find(TabStatus::Running.glyph()).expect("status glyph");
        let cell = buf.cell((glyph_at as u16, 0)).expect("glyph cell");
        let theme = theme();
        assert_eq!(
            cell.fg, theme.accent_running,
            "running status keeps its accent"
        );
        crate::appearance::cache::set_chrome_style(crate::appearance::ChromeStyle::Rich);
    }

    /// Rich chrome keeps `×` inside the bracket (`[ … × ]`) and `+` just
    /// outside it, so neither control crowds the far edge of the strip.
    #[test]
    fn rich_close_glyph_sits_inside_the_bracket() {
        crate::appearance::cache::set_chrome_style(crate::appearance::ChromeStyle::Rich);
        let c = chips(&["a"]);
        let (buf, rendered) = draw(Rect::new(0, 0, 60, 1), &c, Some(0));
        let hit = &rendered.tabs[0];
        let close = hit.close_rect.expect("close glyph");
        assert_eq!(
            rendered.hit(close.x, 0),
            Some(TabHitTarget::CloseTab("a".into()))
        );

        let last = hit.rect.right().saturating_sub(1);
        let closing = buf.cell((last, 0)).expect("closing bracket");
        assert_eq!(closing.symbol(), "]", "bracket closes after ×");
        assert!(
            close.right() < hit.rect.right(),
            "× stays inside the chip: close={close:?} chip={:?}",
            hit.rect
        );
        crate::appearance::cache::set_chrome_style(crate::appearance::ChromeStyle::Rich);
    }

    #[test]
    fn every_status_has_a_single_width_glyph() {
        use unicode_width::UnicodeWidthStr;
        for s in [
            TabStatus::Idle,
            TabStatus::Running,
            TabStatus::Permission,
            TabStatus::Question,
            TabStatus::Unread,
        ] {
            assert_eq!(s.glyph().width(), 1, "{s:?} must be one column");
        }
    }
}
