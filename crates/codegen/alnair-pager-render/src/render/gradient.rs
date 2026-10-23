//! Small per-character gradients for terminal labels.

use ratatui::style::Color;
use ratatui::text::{Line, Span};

use super::color::resolve_to_rgb;

/// Render text from the start color to the end color. Unknown terminal colors
/// fall back to a single themed span instead of guessing their RGB values.
pub fn gradient_line(text: &str, start: Color, end: Color) -> Line<'static> {
    let (Some((sr, sg, sb)), Some((er, eg, eb))) = (resolve_to_rgb(start), resolve_to_rgb(end))
    else {
        return Line::from(Span::styled(
            text.to_owned(),
            ratatui::style::Style::default().fg(start),
        ));
    };

    let chars: Vec<char> = text.chars().collect();
    let last = chars.len().saturating_sub(1).max(1) as f32;
    Line::from(
        chars
            .into_iter()
            .enumerate()
            .map(|(index, ch)| {
                let t = index as f32 / last;
                let mix = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round() as u8;
                Span::styled(
                    ch.to_string(),
                    ratatui::style::Style::default().fg(Color::Rgb(
                        mix(sr, er),
                        mix(sg, eg),
                        mix(sb, eb),
                    )),
                )
            })
            .collect::<Vec<_>>(),
    )
}
