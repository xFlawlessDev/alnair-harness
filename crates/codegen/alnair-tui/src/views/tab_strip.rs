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
}

/// What a click on the strip landed on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TabHitTarget {
    Tab(String),
    NewSession,
    /// Open the location picker so `+` creates in a different repo.
    NewSessionElsewhere,
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
}

/// Rendered strip areas.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TabStripRendered {
    pub tabs: Vec<TabHit>,
    pub new_session: Option<Rect>,
    pub new_session_elsewhere: Option<Rect>,
    /// True when chips were dropped and the overflow markers are shown.
    pub overflow: bool,
}

impl TabStripRendered {
    pub fn hit(&self, column: u16, row: u16) -> Option<TabHitTarget> {
        for hit in &self.tabs {
            if hit.rect.contains((column, row).into()) {
                return Some(TabHitTarget::Tab(hit.session_id.clone()));
            }
        }
        if self
            .new_session
            .is_some_and(|r| r.contains((column, row).into()))
        {
            return Some(TabHitTarget::NewSession);
        }
        if self
            .new_session_elsewhere
            .is_some_and(|r| r.contains((column, row).into()))
        {
            return Some(TabHitTarget::NewSessionElsewhere);
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

    // Right-hand affordances reserve their width up front so chips never
    // collide with them.
    let plus = "[ + ]";
    let plus_elsewhere = "[ +\u{2026} ]";
    let plus_w = plus.len() as u16;
    let elsewhere_w = plus_elsewhere.len() as u16;
    let gutter = 1u16;
    let reserve = plus_w + elsewhere_w + gutter * 3;
    if area.width <= reserve + MIN_CHIP {
        // Not enough room for even one chip plus the buttons: show only the
        // buttons, so `+` is never unreachable.
        let x = area.x + area.width.saturating_sub(elsewhere_w + plus_w + gutter);
        let (a, b) = place_buttons(buf, area, theme, x, plus, plus_elsewhere);
        out.new_session_elsewhere = Some(b);
        out.new_session = Some(a);
        return out;
    }
    let chip_budget = area.width - reserve;

    // Build labels, then shrink to fit.
    let labels: Vec<String> = chips
        .iter()
        .enumerate()
        .map(|(i, chip)| chip_label(chip, i, active == Some(i), multi_repo))
        .collect();

    let widths = fit_widths(&labels, chip_budget, active);
    let mut x = area.x;
    let mut shown = 0usize;
    for (i, label) in labels.iter().enumerate() {
        let Some(w) = widths.get(i).copied().flatten() else {
            continue;
        };
        if w == 0 || x + w > area.x + chip_budget {
            break;
        }
        let is_active = active == Some(i);
        let style = if is_active {
            Style::default()
                .fg(theme.text_primary)
                .bg(theme.bg_hover)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(theme.text_secondary).bg(theme.bg_base)
        };
        let text = truncate_str(label, w.saturating_sub(4) as usize);
        let chip = format!("[ {text} ]");
        let chip_w = chip.chars().count() as u16;
        if chip_w > w {
            // Truncation rounding: fall back to the label alone rather than
            // spilling into the next chip.
            continue;
        }
        buf.set_span_safe(x, area.y, &Span::styled(chip, style), chip_w);
        out.tabs.push(TabHit {
            session_id: chips[i].session_id.clone(),
            rect: Rect::new(x, area.y, chip_w, 1),
        });
        x = x.saturating_add(chip_w).saturating_add(gutter);
        shown += 1;
    }
    out.overflow = shown < chips.len();

    let x = area.x + area.width.saturating_sub(elsewhere_w + plus_w + gutter);
    let (a, b) = place_buttons(buf, area, theme, x, plus, plus_elsewhere);
    out.new_session = Some(a);
    out.new_session_elsewhere = Some(b);
    out
}

fn place_buttons(
    buf: &mut Buffer,
    area: Rect,
    theme: &Theme,
    x: u16,
    plus: &str,
    plus_elsewhere: &str,
) -> (Rect, Rect) {
    let style = Style::default().fg(theme.link_fg).bg(theme.bg_base);
    let elsewhere_w = plus_elsewhere.chars().count() as u16;
    let plus_w = plus.chars().count() as u16;
    let elsewhere = Rect::new(x, area.y, elsewhere_w, 1);
    let plus_rect = Rect::new(x + elsewhere_w + 1, area.y, plus_w, 1);
    buf.set_span_safe(
        elsewhere.x,
        area.y,
        &Span::styled(plus_elsewhere, style),
        elsewhere_w,
    );
    buf.set_span_safe(plus_rect.x, area.y, &Span::styled(plus, style), plus_w);
    (plus_rect, elsewhere)
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
/// active one. `None` means "did not fit at all".
fn fit_widths(labels: &[String], budget: u16, active: Option<usize>) -> Vec<Option<u16>> {
    let wanted: Vec<u16> = labels
        .iter()
        .map(|l| (l.chars().count() as u16).saturating_add(4))
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
        let mut buf = Buffer::empty(area);
        let params = TabStripParams { chips, active };
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
        assert!(rendered.new_session_elsewhere.is_some());
    }

    #[test]
    fn plus_chips_are_reachable_at_the_right_edge() {
        let c = chips(&["a"]);
        let area = Rect::new(0, 0, 60, 1);
        let (_, rendered) = draw(area, &c, Some(0));
        let plus = rendered.new_session.expect("+ chip");
        assert!(plus.x + plus.width <= area.right());
        let elsewhere = rendered.new_session_elsewhere.expect("+… chip");
        assert!(elsewhere.x + elsewhere.width <= area.right());
        assert_eq!(
            rendered.hit(plus.x, 0),
            Some(TabHitTarget::NewSession),
            "the + chip must win the hit test at its own columns"
        );
    }

    /// A very narrow strip keeps the buttons even when no chip fits.
    #[test]
    fn narrow_strip_still_offers_the_buttons() {
        let c = chips(&["a", "b", "c"]);
        let area = Rect::new(0, 0, 18, 1);
        let (_, rendered) = draw(area, &c, Some(0));
        assert!(rendered.new_session.is_some());
        assert!(rendered.new_session_elsewhere.is_some());
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
