//! Logo component — the Alnair mark, rasterised into braille and lit by a
//! travelling shimmer.
//!
//! The mark is one embedded raster (`assets/logo-white.png`, the project's own
//! artwork) decoded once, on first paint. Only its alpha channel matters: the
//! artwork is white on transparency, so coverage *is* the shape and the theme
//! decides what colour that shape takes. Rendering is split in two because
//! animation needs it that way — [`Prepared`] is the artwork resampled onto one
//! braille sample grid (2×4 dots per cell) and it is the expensive half, while a
//! frame only re-thresholds those cached samples.
//!
//! Two waves drive a frame: a diagonal shimmer that travels across the mark and a
//! slow global breath. Braille dots are present or absent, so the shimmer moves
//! the coverage threshold a dot must clear rather than tinting a colour — dot
//! *density* swells and thins, which is what reads as shimmer in a braille glyph.
//!
//! Hidden entirely on legacy Windows consoles: the U+2800 braille block is not
//! covered by the ConHost raster fonts and would render as tofu.

use std::sync::OnceLock;
use std::time::Instant;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;

use crate::render::color::blend_color;
use crate::theme::Theme;

/// The rasterised mark, embedded so the binary needs no asset directory at
/// runtime. Regenerate it from the source SVG at 200×200.
pub const LOGO_PNG: &[u8] = include_bytes!("../../../assets/logo-white.png");

/// Full-size mark (hero box and tall stacked layouts), in braille cells.
///
/// The artwork's ink box is 199×171 px, so a faithful braille grid keeps
/// `cols ≈ 2 × 1.16 × rows` — braille dots are close to square in a terminal
/// cell, and a cell is about twice as tall as it is wide.
const FULL_COLS: u16 = 23;
const FULL_ROWS: u16 = 10;
/// Small mark for short windows, in braille cells.
const SMALL_COLS: u16 = 12;
const SMALL_ROWS: u16 = 5;

/// Width reported when the logo is hidden, so the menu column keeps its size.
const HIDDEN_VISUAL_WIDTH: u16 = 24;

/// Height at or above which the small mark is shown (below it, no logo).
const SMALL_LOGO_MIN_HEIGHT: u16 = 22;
/// Height at or above which the full mark is shown.
const FULL_LOGO_MIN_HEIGHT: u16 = 26;

/// Redraw cadence in frames per second. The shimmer moves slowly, so a modest
/// rate looks smooth while sparing the long-lived welcome screen from full-rate
/// repaints; frames are quantized to this same clock, so the picture and the
/// repaint decision can never disagree.
const LOGO_FPS: f32 = 12.0;

/// Seconds for the shimmer to travel one full cycle.
const SHIMMER_PERIOD: f32 = 5.0;
/// Seconds for one breath.
const BREATH_PERIOD: f32 = 4.0;

/// Animation time wraps here, which is a whole number of both periods. Wrapping
/// keeps elapsed time small and stops `sin` from losing precision during a long
/// session.
const PHASE_WRAP: f32 = 60.0;

/// How far the shimmer swings the ink threshold. Braille decides each dot by
/// comparing coverage against a threshold, so moving the threshold is what makes
/// dots appear and disappear: wide enough to drop a solid pixel at a trough and
/// ink faint pixels at a crest, but not so wide that whole regions vanish at once.
const INK_SWING: f32 = 0.55;

/// Ink threshold in the middle of a wave, matching the resting density.
const INK_THRESHOLD_BASE: f32 = 0.30;

/// Threshold bounds. The floor lets faint anti-aliased edges ink at a crest; the
/// ceiling sits above `1.0` so a trough can extinguish even solid interior dots.
const INK_THRESHOLD_MIN: f32 = 0.06;
const INK_THRESHOLD_MAX: f32 = 1.45;

/// Coverage at or above which a dot is inked no matter how far the wave has
/// receded. The mark's thinnest strokes — the apex of the "A", the tip of the
/// swoosh — peak near `0.53`, so a threshold swing alone can extinguish a whole
/// row at a trough and the mark visibly loses its silhouette. Keeping the
/// strongest strokes lit turns the shimmer into density *inside* a shape that
/// never collapses.
const SILHOUETTE_FLOOR: f32 = 0.40;

/// How far the shimmer swings brightness, as a fraction of the midpoint.
const SHIMMER_AMPLITUDE: f32 = 0.55;

/// Crests along the mark's diagonal.
const SHIMMER_WAVES: f32 = 2.0;

/// How far the breath moves the threshold and brightness.
const BREATH_AMPLITUDE: f32 = 0.14;

/// Brightness bounds, chosen so a crest glows without washing out and a trough
/// dims without going black.
const BRIGHTNESS_MIN: f32 = 0.40;
const BRIGHTNESS_MAX: f32 = 1.85;

/// Bit values for the eight braille dots, indexed by `(column, row)` within a
/// cell, per the Unicode braille block layout.
const BRAILLE_DOTS: [(u32, u32, u32); 8] = [
    (0, 0, 0x01),
    (0, 1, 0x02),
    (0, 2, 0x04),
    (0, 3, 0x40),
    (1, 0, 0x08),
    (1, 1, 0x10),
    (1, 2, 0x20),
    (1, 3, 0x80),
];

/// One logo size tier, in braille cells.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct MarkSize {
    cols: u16,
    rows: u16,
}

const FULL: MarkSize = MarkSize {
    cols: FULL_COLS,
    rows: FULL_ROWS,
};
const SMALL: MarkSize = MarkSize {
    cols: SMALL_COLS,
    rows: SMALL_ROWS,
};

fn pick_logo(window_height: u16) -> Option<MarkSize> {
    pick_logo_for(window_height, logo_hidden())
}

/// Pure tier selection so tests can drive the legacy-console flag directly.
fn pick_logo_for(window_height: u16, hidden: bool) -> Option<MarkSize> {
    if hidden || window_height < SMALL_LOGO_MIN_HEIGHT {
        None
    } else if window_height < FULL_LOGO_MIN_HEIGHT {
        Some(SMALL)
    } else {
        Some(FULL)
    }
}

/// The braille mark has no ASCII stand-in; see the module doc.
fn logo_hidden() -> bool {
    crate::glyphs::is_legacy_windows_console()
}

/// Seconds since the first render. Wall-clock based so the shimmer speed is
/// independent of the frame rate.
fn anim_phase_secs() -> f32 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f32()
}

/// Quantized animation frame for the current wall-clock phase, wrapped to
/// [`PHASE_WRAP`]. The welcome screen redraws only when this advances, throttling
/// the animation to ~[`LOGO_FPS`] rather than the full event-loop tick rate.
/// Pinned to 0 when the logo is hidden.
pub fn shimmer_frame() -> u64 {
    if logo_hidden() {
        return 0;
    }
    (anim_phase_secs() % PHASE_WRAP * LOGO_FPS) as u64
}

/// The brightness field for one rendered frame: a diagonal shimmer plus a slow
/// global breath.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Frame {
    phase: f32,
}

impl Frame {
    /// The frame the redraw clock is currently showing.
    fn current() -> Self {
        Self::at(shimmer_frame() as f32 / LOGO_FPS)
    }

    fn at(phase: f32) -> Self {
        Self {
            phase: phase % PHASE_WRAP,
        }
    }

    /// Position of the travelling wave at a cell, in `-1.0..=1.0`.
    fn shimmer(&self, row: u32, column: u32, extent: u32) -> f32 {
        let extent = extent.max(1) as f32;
        // The diagonal coordinate is what makes the wave sweep corner to corner
        // rather than scroll sideways.
        let position = (row + column) as f32 / extent;

        let travel = position * std::f32::consts::TAU * SHIMMER_WAVES;
        let time = -self.phase * std::f32::consts::TAU / SHIMMER_PERIOD;
        (travel + time).sin()
    }

    /// The slow global swell, in `-BREATH_AMPLITUDE..=BREATH_AMPLITUDE`.
    fn breath(&self) -> f32 {
        (self.phase * std::f32::consts::TAU / BREATH_PERIOD).sin() * BREATH_AMPLITUDE
    }

    /// Coverage threshold a braille dot must clear at a cell.
    fn ink_threshold_at(&self, row: u32, column: u32, extent: u32) -> f32 {
        let shimmer = self.shimmer(row, column, extent);
        let value = INK_THRESHOLD_BASE - (INK_SWING * shimmer + self.breath() * 0.5);
        value.clamp(INK_THRESHOLD_MIN, INK_THRESHOLD_MAX)
    }

    /// Whether a dot at `coverage` is lit at this point in the wave.
    ///
    /// The wave moves the threshold, but a dot above [`SILHOUETTE_FLOOR`] stays
    /// lit regardless: the mark keeps its outline and only its interior density
    /// breathes.
    fn lights(&self, coverage: f32, row: u32, column: u32, extent: u32) -> bool {
        coverage >= SILHOUETTE_FLOOR || coverage >= self.ink_threshold_at(row, column, extent)
    }

    /// Brightness multiplier for the colour a lit dot is tinted with.
    fn brightness_at(&self, row: u32, column: u32, extent: u32) -> f32 {
        let shimmer = self.shimmer(row, column, extent);
        let value = 1.0 + SHIMMER_AMPLITUDE * shimmer + self.breath();
        value.clamp(BRIGHTNESS_MIN, BRIGHTNESS_MAX)
    }
}

/// A rectangle within the source image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Bounds {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

/// The decoded artwork plus the ink box that actually holds the mark.
struct Ink {
    image: image::DynamicImage,
    /// The asset is padded to a square canvas, so the artwork's bounds — not the
    /// canvas size — decide the proportions of the rendered mark.
    bounds: Bounds,
}

fn ink() -> Option<&'static Ink> {
    static INK: OnceLock<Option<Ink>> = OnceLock::new();
    INK.get_or_init(decode).as_ref()
}

fn decode() -> Option<Ink> {
    let image = match image::load_from_memory(LOGO_PNG) {
        Ok(image) => image,
        Err(err) => {
            tracing::warn!(error = %err, "welcome logo asset failed to decode");
            return None;
        }
    };

    let bounds = ink_bounds(&image).unwrap_or(Bounds {
        x: 0,
        y: 0,
        width: image.width(),
        height: image.height(),
    });

    Some(Ink { image, bounds })
}

/// Measures the bounding box of the visible artwork.
///
/// The artwork is white on transparency, so ink is wherever alpha is non-zero.
/// Returns `None` when nothing is visible, so callers can fall back to the full
/// canvas.
fn ink_bounds(image: &image::DynamicImage) -> Option<Bounds> {
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();

    // Alpha below this is treated as empty. The threshold sits above zero so a
    // faint anti-aliasing halo does not stretch the bounds to the full canvas.
    const ALPHA_FLOOR: u8 = 8;

    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0;
    let mut max_y = 0;
    let mut found = false;

    for y in 0..height {
        for x in 0..width {
            if rgba.get_pixel(x, y).0[3] < ALPHA_FLOOR {
                continue;
            }
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            found = true;
        }
    }

    found.then(|| Bounds {
        x: min_x,
        y: min_y,
        width: max_x - min_x + 1,
        height: max_y - min_y + 1,
    })
}

/// The artwork resampled onto one braille sample grid.
///
/// Holding one of these is what makes animation affordable: the resample happens
/// once per size tier, and each frame only walks the cached coverage values.
struct Prepared {
    cols: u16,
    rows: u16,
    /// Coverage per sample, row-major, `cols * 2` wide and `rows * 4` tall.
    coverage: Vec<f32>,
}

impl Prepared {
    /// Resamples the mark into `size`'s cell grid.
    fn build(size: MarkSize) -> Option<Self> {
        let ink = ink()?;
        let (grid_w, grid_h) = (u32::from(size.cols) * 2, u32::from(size.rows) * 4);

        // Crop to the ink box first, so any margin baked into the asset does not
        // shrink the artwork inside the requested grid.
        let art = ink.image.crop_imm(
            ink.bounds.x,
            ink.bounds.y,
            ink.bounds.width.max(1),
            ink.bounds.height.max(1),
        );
        let resized = art
            .resize_exact(grid_w, grid_h, image::imageops::FilterType::Triangle)
            .to_rgba8();

        let coverage = resized
            .pixels()
            .map(|pixel| pixel.0[3] as f32 / 255.0)
            .collect();

        Some(Self {
            cols: size.cols,
            rows: size.rows,
            coverage,
        })
    }

    /// Coverage at a dot offset within a cell.
    fn dot_coverage(&self, row: u32, column: u32, dx: u32, dy: u32) -> f32 {
        let x = column * 2 + dx;
        let y = row * 4 + dy;
        self.coverage[(y * u32::from(self.cols) * 2 + x) as usize]
    }

    /// Diagonal length, used to normalise the shimmer's spatial coordinate so the
    /// wave reads the same at either size tier.
    fn extent(&self) -> u32 {
        u32::from(self.cols) + u32::from(self.rows)
    }
}

/// The prepared grid for a size tier, resampled on first use.
fn prepared(size: MarkSize) -> Option<&'static Prepared> {
    static FULL_PREPARED: OnceLock<Option<Prepared>> = OnceLock::new();
    static SMALL_PREPARED: OnceLock<Option<Prepared>> = OnceLock::new();

    let slot = match size {
        FULL => &FULL_PREPARED,
        SMALL => &SMALL_PREPARED,
        // Only the two tiers above exist; a new tier must add its own cache
        // rather than silently share one, which would serve a wrong-sized grid.
        _ => return None,
    };
    slot.get_or_init(|| Prepared::build(size)).as_ref()
}

/// Paints one frame of the mark, centred horizontally in `area`.
fn render_frame(area: Rect, buf: &mut Buffer, theme: &Theme, size: MarkSize, frame: Frame) {
    let Some(prepared) = prepared(size) else {
        return;
    };
    if area.width == 0 || area.height == 0 {
        return;
    }

    let extent = prepared.extent();
    let base = theme.bg_base;
    let ink = theme.text_primary;

    let cols = prepared.cols.min(area.width);
    let rows = prepared.rows.min(area.height);
    let x0 = area.x + area.width.saturating_sub(cols) / 2;

    for row in 0..u32::from(rows) {
        for column in 0..u32::from(cols) {
            let mut bits = 0u32;
            let mut inked = 0.0;
            let mut count = 0;
            for (dx, dy, bit) in BRAILLE_DOTS {
                let value = prepared.dot_coverage(row, column, dx, dy);
                if frame.lights(value, row, column, extent) {
                    bits |= bit;
                    inked += value;
                    count += 1;
                }
            }

            // Empty cells stay untouched so the surrounding theme shows through.
            if bits == 0 {
                continue;
            }

            let symbol = char::from_u32(0x2800 + bits).unwrap_or(' ');
            // Lit dots keep a visible floor so anti-aliased edges shade rather
            // than vanish, while the shimmer still modulates the colour.
            let mean = inked / count as f32;
            let brightness = frame.brightness_at(row, column, extent);
            let intensity = ((0.45 + 0.55 * mean.min(1.0)) * brightness).min(1.0);
            let color = blend_color(base, ink, intensity).unwrap_or(ink);

            let x = x0 + column as u16;
            let y = area.y + row as u16;
            if let Some(cell) = buf.cell_mut((x, y)) {
                cell.set_char(symbol);
                cell.set_style(Style::default().fg(color));
            }
        }
    }
}

fn render_into(area: Rect, buf: &mut Buffer, theme: &Theme, size: MarkSize) {
    render_frame(area, buf, theme, size, Frame::current());
}

pub fn logo_line_count(window_height: u16) -> u16 {
    pick_logo(window_height).map_or(0, |s| s.rows)
}

pub fn logo_visual_width(window_height: u16) -> u16 {
    pick_logo(window_height).map_or(HIDDEN_VISUAL_WIDTH, |s| s.cols)
}

pub fn render_logo(area: Rect, buf: &mut Buffer, theme: &Theme, window_height: u16) {
    if let Some(size) = pick_logo(window_height) {
        render_into(area, buf, theme, size);
    }
}

/// The hero box always shows the full mark: it is laid out beside the menu, so
/// it fits whenever the box does. These report and render that logo directly,
/// independent of the height-based [`pick_logo`] tiers used by the stacked
/// layout. When [`logo_hidden`], they report 0 and render nothing.
pub fn full_logo_line_count() -> u16 {
    full_logo_line_count_for(logo_hidden())
}

fn full_logo_line_count_for(hidden: bool) -> u16 {
    if hidden { 0 } else { FULL.rows }
}

pub fn full_logo_visual_width() -> u16 {
    full_logo_visual_width_for(logo_hidden())
}

fn full_logo_visual_width_for(hidden: bool) -> u16 {
    if hidden { 0 } else { FULL.cols }
}

pub fn render_full_logo(area: Rect, buf: &mut Buffer, theme: &Theme) {
    if !logo_hidden() {
        render_into(area, buf, theme, FULL);
    }
}

/// Line count of the small mark used in minimal's committed welcome card
/// (0 on a legacy Windows console, where braille art is suppressed).
pub fn compact_logo_line_count() -> u16 {
    if logo_hidden() { 0 } else { SMALL.rows }
}

/// Render the small mark (centered) into `area` for minimal's welcome card.
/// No-op when the logo is hidden.
pub fn render_compact_logo(area: Rect, buf: &mut Buffer, theme: &Theme) {
    if !logo_hidden() {
        render_into(area, buf, theme, SMALL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Text of the mark rendered at one phase, styling dropped.
    fn render(size: MarkSize, phase: f32) -> Vec<String> {
        let area = Rect::new(0, 0, size.cols, size.rows);
        let mut buf = Buffer::empty(area);
        render_frame(area, &mut buf, &Theme::current(), size, Frame::at(phase));

        (0..size.rows)
            .map(|y| {
                (0..size.cols)
                    .map(|x| {
                        buf.cell((x, y))
                            .map_or(' ', |cell| cell.symbol().chars().next().unwrap_or(' '))
                    })
                    .collect()
            })
            .collect()
    }

    fn non_blank(lines: &[String]) -> usize {
        lines
            .iter()
            .flat_map(|line| line.chars())
            .filter(|symbol| *symbol != ' ')
            .count()
    }

    #[test]
    fn embedded_asset_decodes_with_the_expected_shape() {
        let ink = ink().expect("the embedded logo should decode");
        assert_eq!((ink.image.width(), ink.image.height()), (200, 200));
        assert!(
            ink.bounds.width < ink.image.width(),
            "the square canvas should be wider than the ink box"
        );
        assert!(
            ink.bounds.height < ink.image.height(),
            "the square canvas should be taller than the ink box"
        );
    }

    /// The mark must keep the artwork's proportions instead of being squashed to
    /// a square canvas: braille dots are square, so a cell grid runs at half the
    /// artwork's aspect ratio.
    #[test]
    fn grid_preserves_the_artwork_aspect_ratio() {
        let ink = ink().expect("logo");
        let art_aspect = ink.bounds.width as f32 / ink.bounds.height as f32;

        for size in [FULL, SMALL] {
            let grid_aspect = (f32::from(size.cols) * 2.0) / (f32::from(size.rows) * 4.0);
            assert!(
                (grid_aspect - art_aspect).abs() < 0.12,
                "{size:?} grid aspect {grid_aspect} drifted from the artwork's {art_aspect}"
            );
        }
    }

    #[test]
    fn logo_sizes_by_height() {
        assert!(pick_logo_for(SMALL_LOGO_MIN_HEIGHT - 1, false).is_none());
        assert_eq!(pick_logo_for(SMALL_LOGO_MIN_HEIGHT, false), Some(SMALL));
        assert_eq!(pick_logo_for(FULL_LOGO_MIN_HEIGHT - 1, false), Some(SMALL));
        assert_eq!(pick_logo_for(FULL_LOGO_MIN_HEIGHT, false), Some(FULL));
    }

    // The braille mark has no legacy-safe stand-in, so every height tier must
    // collapse to no logo when the legacy-console flag is set.
    #[test]
    fn logo_hidden_on_legacy_console_at_every_height() {
        for h in [0, SMALL_LOGO_MIN_HEIGHT, FULL_LOGO_MIN_HEIGHT, u16::MAX] {
            assert!(pick_logo_for(h, true).is_none(), "height {h}");
        }
    }

    #[test]
    fn hero_box_always_uses_full_logo() {
        // The box renders the full mark regardless of height (it's laid out
        // beside the menu), and it's the large variant — never the small one.
        assert_eq!(full_logo_line_count_for(false), FULL.rows);
        assert_eq!(full_logo_visual_width_for(false), FULL.cols);
        assert!(full_logo_line_count_for(false) > SMALL.rows);
        assert!(full_logo_visual_width_for(false) > SMALL.cols);
    }

    #[test]
    fn full_logo_helpers_collapse_when_hidden() {
        assert_eq!(full_logo_line_count_for(true), 0);
        assert_eq!(full_logo_visual_width_for(true), 0);
    }

    #[test]
    fn compact_logo_is_the_small_mark() {
        if !logo_hidden() {
            assert_eq!(compact_logo_line_count(), SMALL.rows);
            assert!(compact_logo_line_count() < FULL.rows);
        } else {
            assert_eq!(compact_logo_line_count(), 0);
        }
    }

    /// The mark has to be recognisably drawn: a healthy share of its cells must
    /// carry braille dots, and every row must be exactly the grid width so the
    /// block stays rectangular.
    #[test]
    fn the_mark_fills_its_grid() {
        for size in [FULL, SMALL] {
            let lines = render(size, 1.0);
            assert_eq!(lines.len(), usize::from(size.rows));
            assert!(
                lines
                    .iter()
                    .all(|line| line.chars().count() == usize::from(size.cols))
            );
            assert!(
                non_blank(&lines) > usize::from(size.cols) * usize::from(size.rows) / 4,
                "{size:?} rendered too sparse: {lines:#?}"
            );
        }
    }

    /// Animation must actually change the picture, otherwise the extra frames are
    /// wasted work. A braille frame moves dot density, so the glyphs themselves
    /// must differ — not just their colour.
    #[test]
    fn animation_changes_the_rendered_output() {
        let rest = render(FULL, 0.0);
        let crest = render(FULL, SHIMMER_PERIOD / 4.0);
        assert_ne!(rest, crest, "the shimmer never moved the mark");
    }

    /// The wave should visibly swell and thin the dot density rather than nudging
    /// it imperceptibly — and never dissolve the mark entirely.
    #[test]
    fn braille_density_swings_without_dissolving() {
        let counts: Vec<usize> = (0..24)
            .map(|step| non_blank(&render(FULL, step as f32 * SHIMMER_PERIOD / 24.0)))
            .collect();

        let min = *counts.iter().min().unwrap();
        let max = *counts.iter().max().unwrap();
        let baseline = non_blank(&render(FULL, 0.0));

        assert!(max > min, "density never changed across the cycle");
        assert!(
            max - min > baseline / 20,
            "density swing of {} on a baseline of {baseline} is too subtle",
            max - min
        );
        assert!(
            min > baseline / 4,
            "density fell to {min} against a baseline of {baseline}, which reads as dissolve rather than shimmer"
        );
    }

    /// A long session wraps the phase repeatedly; output must stay stable and
    /// never index outside the sample grid.
    #[test]
    fn wrapping_phase_renders_identically() {
        let base = render(FULL, 0.7);
        let wrapped = render(FULL, 0.7 + PHASE_WRAP * 3.0);
        assert_eq!(base, wrapped, "phase wrap introduced a seam");
    }

    /// The mark's thinnest strokes must survive the whole cycle: a wave that
    /// extinguishes the apex of the "A" collapses the grid by a row and the logo
    /// visibly jumps. Every row of every size tier stays inked at every phase.
    #[test]
    fn every_row_stays_inked_across_the_cycle() {
        for size in [FULL, SMALL] {
            for step in 0..120 {
                let phase = step as f32 * SHIMMER_PERIOD / 120.0;
                let lines = render(size, phase);
                for (row, line) in lines.iter().enumerate() {
                    assert!(
                        line.chars().any(|symbol| symbol != ' '),
                        "{size:?} row {row} went blank at phase {phase}"
                    );
                }
            }
        }
    }

    /// Clipping is the caller's protection against a slot smaller than the grid;
    /// it must not panic or write outside the area.
    #[test]
    fn small_areas_render_without_panicking() {
        let theme = Theme::current();
        for (w, h) in [(1u16, 1u16), (3, 200), (300, 3), (200, 80)] {
            let area = Rect::new(0, 0, w, h);
            let mut buf = Buffer::empty(area);
            render_frame(area, &mut buf, &theme, FULL, Frame::at(1.3));
        }
    }
}
