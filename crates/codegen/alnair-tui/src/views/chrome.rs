//! Shared visual treatments for compact terminal chrome.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::appearance::{ChromeStyle, cache};
use crate::render::gradient::gradient_line;
use crate::theme::Theme;

pub fn is_rich() -> bool {
    cache::chrome_style() == ChromeStyle::Rich
}

pub fn pill(label: &str, color: ratatui::style::Color) -> Span<'static> {
    if !is_rich() {
        return Span::raw(label.to_owned());
    }
    Span::styled(
        format!(" {label} "),
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    )
}

pub fn inline_badge(label: &str, color: ratatui::style::Color) -> Span<'static> {
    if !is_rich() {
        return Span::raw(label.to_owned());
    }
    Span::styled(
        label.to_owned(),
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    )
}

pub fn keycap(label: &str) -> Span<'static> {
    if !is_rich() {
        return Span::raw(label.to_owned());
    }
    Span::styled(
        format!(" {label} "),
        Style::default()
            .fg(Theme::current().accent_remember)
            .add_modifier(Modifier::BOLD),
    )
}

pub fn gradient_wordmark(label: &str) -> Line<'static> {
    if !is_rich() {
        return Line::raw(label.to_owned());
    }
    let theme = Theme::current();
    gradient_line(label, theme.accent_remember, theme.accent_skill)
}

pub fn section_rule(label: &str) -> Line<'static> {
    if !is_rich() {
        return Line::raw(label.to_owned());
    }
    let theme = Theme::current();
    Line::from(vec![
        Span::styled("-- ", Style::default().fg(theme.gray)),
        Span::styled(label.to_owned(), Style::default().fg(theme.accent_remember)),
        Span::styled(" --", Style::default().fg(theme.gray)),
    ])
}
