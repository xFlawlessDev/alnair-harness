//! Minimal (scrollback-native) render mode — `alnair --minimal`.
//!
//! In this mode finalized conversation blocks are printed once into the
//! terminal's *native* scrollback (via `alnair_ratatui_inline::Terminal::insert_before`,
//! reusing `EntryRenderer`) while a small pinned live region holds the
//! running-turn status, the prompt, and a minimal status line. The interactive
//! `ScrollbackPane` (scroll, fold, selection, mouse) is not used; the terminal
//! owns history.
//!
//! # Wiring
//!
//! `alnair-tui` (the lib) does **not** depend on this crate — that would be
//! a cargo dependency cycle, since this crate reads deeply into the pager's
//! [`AppView`] / view model. Instead the pager exposes an inversion-of-control
//! seam ([`alnair_tui::minimal_hook`]) of function pointers, and the
//! composition-root binary (`alnair-bin`) calls [`install`] once at
//! startup to register this crate's [`draw`] entry point. When the seam is not
//! installed the pager's minimal-mode branches are inert.

pub mod auth;
pub mod commit;
pub mod full_view;
pub mod live;
pub mod overlay;
pub mod panel;
pub mod plan;
pub mod todo;
pub mod welcome;

#[cfg(test)]
mod guard;

use crossterm::QueueableCommand;
use crossterm::terminal::BeginSynchronizedUpdate;

use alnair_tui::app::PagerTerminal;
use alnair_tui::app::app_view::AppView;

/// Per-frame entry point for minimal mode, called from [`AppView::draw`].
///
/// The call order is load-bearing. [`overlay::sync_viewport`] sizes the
/// viewport to its **post-commit** height and must run *before*
/// [`commit::commit_active`], so that each `insert_before` prints a finalized
/// block and repositions an already-correctly-sized viewport to sit directly
/// after it (content-anchored — the prompt follows the content, and once the
/// screen is full that position is the bottom). A viewport still at its tall
/// streaming height when the block commits collapses afterwards and strands the
/// prompt at the top of the screen ("input snaps to the top").
///
/// ## Why the synchronized update and autoresize come first
///
/// **Resize:** `draw_frame` runs `terminal.autoresize()` — but that is the
/// *last* step of this function, while the commit passes read
/// `viewport_area().width` first. On the frame that processes a terminal
/// resize, a block finalizing in that same frame would be laid out and printed
/// at the *stale* width; a shrink then hard-wraps every over-wide row on the
/// real terminal, permanently garbling the print-once committed copy. Adopting
/// the new size up front closes that window (a no-op on non-resize frames).
///
/// **Flicker:** the commit `insert_before`s scroll + repaint the screen and
/// flush per chunk. Without a synchronized update around them, a multi-block
/// commit (thinking + tool + message finalizing together) presents as several
/// visible scroll/paint bursts before the live region repaints. Opening the
/// synchronized update *before* the commits batches the whole frame — commits,
/// viewport reposition, and live redraw — into one atomic present. The
/// matching `EndSynchronizedUpdate` is emitted by `draw_frame`, which every
/// path through this function reaches; its own inner
/// `BeginSynchronizedUpdate` is redundant-but-harmless (DEC 2026 is a mode,
/// not a counter — the first End closes it).
pub fn draw(app: &mut AppView, terminal: &mut PagerTerminal) {
    let _ = terminal.backend_mut().queue(BeginSynchronizedUpdate);
    let _ = terminal.autoresize();
    // Sync pending permission/question marks ONCE, up front, so that viewport
    // sizing (`sync_viewport` / `tail_height` / `will_commit`) and the commit
    // pass judge committability against the same state.
    commit::sync_pending_marks(app);
    full_view::pump_transcript(app);
    welcome::maybe_commit_welcome(app, terminal);
    plan::maybe_commit_plan(app);
    overlay::sync_viewport(app, terminal);
    commit::commit_active(app, terminal);
    commit::expand_pending(app, terminal);
    live::draw_live(app, terminal);
}

/// Installs the function-pointer seam so the pager's `ScreenMode::Minimal`
/// branches dispatch into this crate.
///
/// Call early in the binary's `main`, before any frame is drawn. Idempotent:
/// subsequent calls are ignored (see [`alnair_tui::minimal_hook`]).
pub fn install() {
    alnair_tui::minimal_hook::install(alnair_tui::minimal_hook::MinimalHooks { draw });
}
