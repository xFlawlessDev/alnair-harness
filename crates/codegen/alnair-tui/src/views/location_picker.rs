//! Directory picker modal, shared by every surface that needs one.
//!
//! The picker answers one question — "which directory?" — and the *caller*
//! decides what the answer means: retarget the dashboard's dispatch cwd,
//! create a session there, or just move the pager. That split is why it lives
//! at the app level rather than inside [`DashboardState`]: `/new`, the tab
//! strip's `+`, and the welcome screen all need it, and a second copy of a
//! path-completion modal would drift from this one.
//!
//! Hybrid autocomplete: a non-path query fuzzy-filters [`LocationPickerState::recents`];
//! once the query looks like a path (`/`, `~`, or contains a separator) it
//! switches to shell-style directory completion over the `readdir` of its
//! parent.
//!
//! [`DashboardState`]: crate::views::dashboard::DashboardState

use std::path::{Path, PathBuf};

use crossterm::event::{Event, KeyCode, KeyEventKind, MouseButton, MouseEventKind};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;

use crate::render::line_utils::truncate_str;
use crate::theme::Theme;

/// What the chosen directory is for. Drives the modal title and the
/// worktree toggle's availability; the *apply* step belongs to the dispatcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocationPickerPurpose {
    /// Retarget the dashboard's dispatch cwd (`Ctrl+L`, `/cd`, the header).
    Dashboard,
    /// Create a new session in the chosen directory (`/new`, the strip's `+`).
    NewSession,
    /// Move the pager's cwd without creating anything (the welcome screen).
    PagerCwd,
}

impl LocationPickerPurpose {
    /// Modal title. Distinct titles are the only signal telling the user which
    /// of three different outcomes their Enter will produce.
    fn title(self) -> &'static str {
        match self {
            Self::Dashboard => "Change directory",
            Self::NewSession => "New session directory",
            Self::PagerCwd => "Choose working directory",
        }
    }

    /// Worktrees only make sense for a dashboard dispatch, where the toggle
    /// arms the *next* dispatched agent. The other purposes have no such
    /// staging slot, so the button is hidden rather than inert.
    fn shows_worktree_toggle(self) -> bool {
        matches!(self, Self::Dashboard)
    }
}

/// The open picker: its state plus what the answer means.
pub struct LocationPicker {
    pub state: LocationPickerState,
    pub purpose: LocationPickerPurpose,
}

impl LocationPicker {
    pub fn new(state: LocationPickerState, purpose: LocationPickerPurpose) -> Self {
        Self { state, purpose }
    }
}

/// One selectable directory. `path` is the absolute directory; `label` /
/// `detail` are the pre-formatted display strings (basename, `~/display`
/// path, relative time, `(current)` marker). `worktree` is the managed
/// worktree's human label when this directory is a worktree root, used to
/// render a styled badge.
#[derive(Debug, Clone)]
pub struct LocationCandidate {
    pub path: PathBuf,
    pub label: String,
    pub detail: String,
    pub worktree: Option<String>,
}

/// Max directory entries listed per parent (bounds the cost of a
/// `readdir` on a huge directory) and max rows shown to the picker.
const LOCATION_DIR_LISTING_CAP: usize = 1000;
const LOCATION_VISIBLE_CAP: usize = 200;

/// State for the directory picker modal.
pub struct LocationPickerState {
    pub picker: crate::views::picker::PickerState,
    pub window: crate::views::modal_window::ModalWindowState,
    /// Static suggestions shown when the query isn't a path: current cwd
    /// first, then recent project dirs.
    pub recents: Vec<LocationCandidate>,
    /// Base directory for resolving relative typed paths (the pager cwd
    /// at open time).
    pub base_cwd: PathBuf,
    /// Worktree root path → label index, built once at open. Used to tag
    /// recents and directory suggestions that are managed worktrees.
    worktrees: std::collections::HashMap<PathBuf, String>,
    /// Cached subdirectories of the current path-mode parent.
    dir_listing: Vec<LocationCandidate>,
    /// The parent directory [`Self::dir_listing`] was read from. Used to
    /// skip the `readdir` when only the final (partial) segment changes.
    dir_listing_parent: Option<PathBuf>,
    /// Content-row hit areas from the last render, for mouse click /
    /// hover. `None` until the modal renders once.
    pub content_hits: Option<crate::views::picker::PickerContentHitAreas>,
    /// Inline error (e.g. "Not a directory") shown under the title when a
    /// chosen path fails to resolve. Cleared when the modal re-opens.
    pub error: Option<String>,
    /// When `true`, applying the chosen location also arms worktree mode on
    /// the dashboard, so the next dispatched agent spawns in a fresh
    /// worktree. Toggled by the path-row "worktree" button; seeded from the
    /// dashboard flag on open.
    pub worktree_mode: bool,
    /// Hit area (rect + hover) of the path-row "worktree" toggle button.
    /// The rect is set during render (cleared when the button is hidden —
    /// modal too narrow, or the target isn't a repo); `hovered` is driven by
    /// the modal mouse handler so the button can brighten on hover.
    pub worktree_hit: crate::app::agent_view::HitArea,
    /// Memoized git-repo check for the worktree toggle: `(dir, is_repo)`.
    /// Avoids re-`stat`ing on every render frame while the selection /
    /// query (and thus the target directory) is unchanged.
    worktree_repo_cache: Option<(PathBuf, bool)>,
}

/// What one input event did to the picker.
///
/// The caller owns the meaning of [`Self::Chosen`]: the same Enter produces a
/// dashboard retarget, a new session, or a pager move depending on the
/// [`LocationPickerPurpose`] the modal was opened with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocationPickerOutcome {
    /// Nothing happened.
    Unchanged,
    /// Visual state changed (query, selection, hover).
    Changed,
    /// The user dismissed the modal.
    Closed,
    /// The user chose this path — already resolved to what should be applied.
    Chosen(String),
}

impl LocationPickerState {
    /// Build a fresh picker over the static `recents` list, resolving
    /// relative typed paths against `base_cwd`. `worktrees` is the
    /// root-path → label index used to tag worktree directories. The
    /// search field is active so the cursor shows immediately and a path
    /// can be typed.
    pub fn new(
        recents: Vec<LocationCandidate>,
        base_cwd: PathBuf,
        worktrees: std::collections::HashMap<PathBuf, String>,
    ) -> Self {
        let picker = crate::views::picker::PickerState {
            search_active: true,
            ..crate::views::picker::PickerState::default()
        };
        Self {
            picker,
            window: crate::views::modal_window::ModalWindowState::new(),
            recents,
            base_cwd,
            worktrees,
            dir_listing: Vec::new(),
            dir_listing_parent: None,
            content_hits: None,
            error: None,
            worktree_mode: false,
            worktree_hit: crate::app::agent_view::HitArea::default(),
            worktree_repo_cache: None,
        }
    }

    /// Whether `dir` is inside a git repo (worktrees require one), memoized
    /// so navigating the list doesn't re-`stat` on every render frame.
    pub fn target_is_repo(&mut self, dir: &Path) -> bool {
        if let Some((cached, is_repo)) = &self.worktree_repo_cache
            && cached == dir
        {
            return *is_repo;
        }
        let is_repo = dir.ancestors().any(|p| p.join(".git").exists());
        self.worktree_repo_cache = Some((dir.to_path_buf(), is_repo));
        is_repo
    }

    /// Whether the current query should be treated as a filesystem path
    /// (directory completion) rather than a fuzzy filter over recents.
    pub fn query_is_path(&self) -> bool {
        let q = &self.picker.query;
        q.starts_with('/')
            || q.starts_with('~')
            || q.contains('/')
            // Windows: native absolute paths (`C:\…`) and backslash
            // separators. Gated so a literal backslash in a Unix filename
            // never forces path mode on non-Windows hosts.
            || (cfg!(windows) && (q.contains('\\') || has_windows_drive_prefix(q)))
    }

    /// Split a path-mode query into the `(parent_dir, partial_name)` to
    /// complete: everything up to the last separator resolves to a directory,
    /// and the trailing segment is the prefix to match. `~` expands to
    /// home; relative parents join [`Self::base_cwd`]. The separator is `/`
    /// on all hosts and additionally `\` on Windows.
    fn path_query_parts(&self) -> (PathBuf, String) {
        let q = self.picker.query.as_str();
        // Last path separator: `/` always; `\` additionally on Windows.
        let sep = match (q.rfind('/'), cfg!(windows).then(|| q.rfind('\\')).flatten()) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
        match sep {
            Some(i) => {
                let parent = resolve_dir_prefix(&q[..=i], &self.base_cwd);
                (parent, q[i + 1..].to_string())
            }
            // No separator: a bare `~` (or `~name`) lists home; on Windows a
            // bare drive (`C:`) lists that drive's root.
            None => {
                if cfg!(windows) && has_windows_drive_prefix(q) && q.len() == 2 {
                    (PathBuf::from(format!("{q}\\")), String::new())
                } else {
                    let home = dirs::home_dir().unwrap_or_else(|| self.base_cwd.clone());
                    (home, q.trim_start_matches('~').to_string())
                }
            }
        }
    }

    /// Re-`readdir` the path-mode parent when it changes. Cheap no-op when
    /// the query isn't a path or the parent is unchanged (typing within a
    /// directory only re-filters the cached listing).
    pub fn refresh_suggestions(&mut self) {
        if !self.query_is_path() {
            if self.dir_listing_parent.is_some() {
                self.dir_listing.clear();
                self.dir_listing_parent = None;
            }
            return;
        }
        let (parent, _partial) = self.path_query_parts();
        if self.dir_listing_parent.as_deref() == Some(parent.as_path()) {
            return;
        }
        self.dir_listing = read_subdirs(&parent, &self.worktrees);
        self.dir_listing_parent = Some(parent);
        self.picker.selected = 0;
        self.picker.scroll_offset = None;
    }

    /// The effective list shown + selected from, given the current query.
    /// Path mode → cached subdirs prefix-matched against the partial
    /// (dot-directories hidden unless the partial starts with `.`); recents
    /// mode → the static list fuzzy-filtered by substring. Capped at
    /// [`LOCATION_VISIBLE_CAP`] rows.
    pub fn visible_candidates(&self) -> Vec<LocationCandidate> {
        if self.query_is_path() {
            let (_parent, partial) = self.path_query_parts();
            let pl = partial.to_lowercase();
            let want_hidden = partial.starts_with('.');
            self.dir_listing
                .iter()
                .filter(|c| {
                    if !want_hidden && c.label.starts_with('.') {
                        return false;
                    }
                    pl.is_empty() || c.label.to_lowercase().starts_with(&pl)
                })
                .take(LOCATION_VISIBLE_CAP)
                .cloned()
                .collect()
        } else {
            let q = self.picker.query.trim().to_lowercase();
            self.recents
                .iter()
                .filter(|c| {
                    q.is_empty()
                        || c.label.to_lowercase().contains(&q)
                        || c.detail.to_lowercase().contains(&q)
                        || c.path.to_string_lossy().to_lowercase().contains(&q)
                })
                .take(LOCATION_VISIBLE_CAP)
                .cloned()
                .collect()
        }
    }

    /// Resolve the path to apply on Enter: the selected visible row, else
    /// the raw typed query (so a path with no matching suggestion still
    /// navigates and validates downstream). `None` when nothing applies.
    pub fn chosen_input(&self) -> Option<String> {
        let visible = self.visible_candidates();
        if let Some(c) = visible.get(self.picker.selected) {
            return Some(c.path.to_string_lossy().into_owned());
        }
        let q = self.picker.query.trim();
        if !q.is_empty() {
            return Some(q.to_string());
        }
        None
    }

    /// Route one event. Enter applies, Esc closes, Tab completes the selected
    /// directory, and everything else is the shared picker's nav/query editing.
    pub fn handle_input(&mut self, ev: &Event) -> LocationPickerOutcome {
        // Mouse is handled separately so the borrow of `self` below stays
        // simple.
        if let Event::Mouse(mouse) = ev {
            return self.handle_mouse(mouse);
        }

        if let Event::Key(key) = ev
            && key.kind != KeyEventKind::Release
            && key.code == KeyCode::Enter
            && key.modifiers.is_empty()
        {
            self.refresh_suggestions();
            return match self.chosen_input() {
                Some(input) => LocationPickerOutcome::Chosen(input),
                None => LocationPickerOutcome::Unchanged,
            };
        }

        // Tab — shell-style completion: fill the input with the selected
        // row's path (tilde-collapsed) plus a trailing `/` so the next
        // listing drills into it. No-op when nothing is selected.
        if let Event::Key(key) = ev
            && key.kind != KeyEventKind::Release
            && key.code == KeyCode::Tab
            && key.modifiers.is_empty()
        {
            let visible = self.visible_candidates();
            let Some(c) = visible.get(self.picker.selected) else {
                return LocationPickerOutcome::Unchanged;
            };
            let mut filled = crate::project_picker::sources::display_path(&c.path);
            if !filled.ends_with('/') {
                filled.push('/');
            }
            self.picker.query = filled;
            self.picker.query_cursor = self.picker.query.len();
            self.picker.selected = 0;
            self.picker.scroll_offset = None;
            // The path changed — drop any stale "Not a directory" error.
            self.error = None;
            self.refresh_suggestions();
            return LocationPickerOutcome::Changed;
        }

        let entry_count = self.visible_candidates().len();
        let config = location_picker_config();
        let query_before = self.picker.query.clone();
        let outcome =
            crate::views::picker::handle_picker_input(ev, &mut self.picker, entry_count, &config);
        // When the user edits the path, drop the stale validation error so a
        // corrected (possibly valid) path isn't shown next to a red
        // "Not a directory" left over from the previous failed attempt.
        if self.picker.query != query_before {
            self.error = None;
        }
        // The query may have changed (typing / backspace / Ctrl+U) — re-list
        // the parent directory if its path-mode parent moved.
        self.refresh_suggestions();
        match outcome {
            crate::views::picker::PickerOutcome::Closed => LocationPickerOutcome::Closed,
            crate::views::picker::PickerOutcome::Changed => LocationPickerOutcome::Changed,
            _ => LocationPickerOutcome::Unchanged,
        }
    }

    /// Mouse handling: modal chrome (close button / click-outside) first, then
    /// the worktree toggle, then content-row click (select + apply) and hover.
    fn handle_mouse(&mut self, mouse: &crossterm::event::MouseEvent) -> LocationPickerOutcome {
        use crate::views::modal_window::{ModalWindowOutcome, handle_modal_mouse};

        match handle_modal_mouse(&mut self.window, mouse.kind, mouse.column, mouse.row) {
            ModalWindowOutcome::CloseRequested => return LocationPickerOutcome::Closed,
            ModalWindowOutcome::Handled => return LocationPickerOutcome::Changed,
            _ => {}
        }

        // Worktree toggle button on the path row: a left-click flips
        // `worktree_mode`, which (when the location is applied) arms the
        // dashboard's worktree dispatch.
        if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left))
            && self.worktree_hit.contains(mouse.column, mouse.row)
        {
            self.worktree_mode = !self.worktree_mode;
            return LocationPickerOutcome::Changed;
        }

        // Map the cursor to a content row (visible-list index) without
        // holding the `content_hits` borrow past the lookup.
        let hit_idx: Option<usize> = self.content_hits.as_ref().and_then(|hits| {
            hits.item_rects.iter().enumerate().find_map(|(i, r)| {
                let inside = mouse.column >= r.x
                    && mouse.column < r.x + r.width
                    && mouse.row >= r.y
                    && mouse.row < r.y + r.height;
                inside.then(|| hits.entry_indices.get(i).copied().unwrap_or(i))
            })
        });

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if let Some(entry_idx) = hit_idx {
                    let visible = self.visible_candidates();
                    if let Some(c) = visible.get(entry_idx) {
                        let input = c.path.to_string_lossy().into_owned();
                        return LocationPickerOutcome::Chosen(input);
                    }
                }
                LocationPickerOutcome::Unchanged
            }
            MouseEventKind::Moved => {
                // Brighten the worktree button when hovered (its rect was
                // set on the prior render).
                let wt_changed = self.worktree_hit.update_hover(mouse.column, mouse.row);
                let row_changed = match hit_idx {
                    Some(entry_idx) if self.picker.selected != entry_idx => {
                        self.picker.selected = entry_idx;
                        true
                    }
                    _ => false,
                };
                if wt_changed || row_changed {
                    LocationPickerOutcome::Changed
                } else {
                    LocationPickerOutcome::Unchanged
                }
            }
            _ => LocationPickerOutcome::Unchanged,
        }
    }
}

/// Per-call config for the picker's shared input handler. Search is always
/// active (no `/` to start), search is not disabled, and rows are flat (no
/// expand / tabs / filter / action keys).
fn location_picker_config<'a>() -> crate::views::picker::PickerConfig<'a> {
    crate::views::picker::PickerConfig {
        title: None,
        show_search_hint: false,
        expandable: false,
        esc_clears_query: false,
        shortcuts: None,
        pending_hint: None,
        shortcuts_area: None,
        non_selectable: &[],
        non_selectable_clickable: &[],
        tabs: None,
        active_tab: 0,
        filter_label: None,
        filter_key_hint: None,
        filter_active: false,
        action_keys: &[],
        disable_search: false,
        compact_bottom_bar: false,
        search_only_on_slash: false,
        vim_normal_first: crate::appearance::cache::load_vim_mode(),
    }
}

/// `true` when `s` starts with a Windows drive prefix like `C:`. Used only
/// under `cfg!(windows)` to route native absolute paths into path mode.
fn has_windows_drive_prefix(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Resolve a path-prefix ending in a separator (e.g. `~/src/`, `/etc/`,
/// `../`, or on Windows `C:\Users\`) to an absolute directory. `~` expands
/// to home; relative prefixes join `base`.
fn resolve_dir_prefix(prefix: &str, base: &Path) -> PathBuf {
    // Strip trailing separators — `/` always, `\` additionally on Windows.
    let trimmed = if cfg!(windows) {
        prefix.trim_end_matches(['/', '\\'])
    } else {
        prefix.trim_end_matches('/')
    };
    if prefix.starts_with('/') {
        if trimmed.is_empty() {
            PathBuf::from("/")
        } else {
            PathBuf::from(trimmed)
        }
    } else if cfg!(windows) && Path::new(prefix).is_absolute() {
        // Windows drive-absolute (`C:\…`) or UNC. Keep the root separator for
        // a bare drive (`C:\` trims to `C:`, which is drive-RELATIVE without it).
        if has_windows_drive_prefix(trimmed) && trimmed.len() == 2 {
            PathBuf::from(format!("{trimmed}\\"))
        } else {
            PathBuf::from(trimmed)
        }
    } else if trimmed == "~" || prefix.starts_with("~/") {
        let rest = trimmed.trim_start_matches('~').trim_start_matches('/');
        let mut home = dirs::home_dir().unwrap_or_else(|| base.to_path_buf());
        if !rest.is_empty() {
            home.push(rest);
        }
        home
    } else if trimmed.is_empty() {
        base.to_path_buf()
    } else {
        base.join(trimmed)
    }
}

/// List the immediate subdirectories of `parent` as location candidates,
/// sorted case-insensitively by name and capped at
/// [`LOCATION_DIR_LISTING_CAP`]. Returns empty for an unreadable parent.
/// Subdirectories that are managed worktree roots are tagged from the
/// `worktrees` index. The lookup key is the entry's fully canonicalized
/// path (matching how the index keys + recent rows are built), so a
/// symlinked worktree directory still matches. The canonicalization is
/// skipped entirely when there are no worktrees to match against.
fn read_subdirs(
    parent: &Path,
    worktrees: &std::collections::HashMap<PathBuf, String>,
) -> Vec<LocationCandidate> {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut out: Vec<LocationCandidate> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // `path.is_dir()` follows symlinks so symlinked dirs are offered.
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Match the index's canonical keys; resolve symlinks on the
            // entry itself (a lexical `parent_canon.join(name)` would not).
            let worktree = if worktrees.is_empty() {
                None
            } else {
                let canon = dunce::canonicalize(&path).unwrap_or_else(|_| path.clone());
                worktrees.get(&canon).cloned()
            };
            out.push(LocationCandidate {
                label: name,
                detail: crate::project_picker::sources::display_path(&path),
                path,
                worktree,
            });
            if out.len() >= LOCATION_DIR_LISTING_CAP {
                break;
            }
        }
    }
    out.sort_by_key(|a| a.label.to_lowercase());
    out
}

/// Render the picker modal. Content-row hit areas from the render are stashed
/// on the modal for the mouse handler.
pub fn render_location_picker(
    buf: &mut Buffer,
    area: Rect,
    theme: &Theme,
    purpose: LocationPickerPurpose,
    modal: &mut LocationPickerState,
) {
    use crate::views::modal_window::{
        ModalSizing, ModalWindowConfig, Shortcut, push_vim_nav_search_hint, render_modal_window,
    };
    use crate::views::picker::{
        PickerEntry, PickerRow, render_divider, render_picker_content, render_search_bar_with_label,
    };

    let mut shortcuts = vec![
        Shortcut {
            label: "\u{2191}\u{2193} nav",
            clickable: false,
            id: 0,
        },
        Shortcut {
            label: "Tab complete",
            clickable: false,
            id: 1,
        },
        Shortcut {
            label: "Enter select",
            clickable: false,
            id: 2,
        },
        Shortcut {
            label: "Esc close",
            clickable: false,
            id: 3,
        },
    ];
    // Surface `i search` in the footer when vim nav mode is active (input-default
    // picker, but Esc drops to nav under vim).
    push_vim_nav_search_hint(&mut shortcuts, modal.picker.search_active);
    let config = ModalWindowConfig {
        title: purpose.title(),
        tabs: None,
        shortcuts: &shortcuts,
        sizing: ModalSizing::medium(),
        fold_info: None,
    };
    let Some(content) = render_modal_window(buf, area, &mut modal.window, &config, theme) else {
        modal.content_hits = None;
        return;
    };

    let mut content_area = content.content;

    // The effective candidate list — computed once and reused for both the
    // worktree-eligibility check and the rows below.
    let visible = modal.visible_candidates();
    // Worktrees require a git repo. The directory a selection would land in
    // (the highlighted row, else the base cwd) decides whether the worktree
    // toggle is meaningful; in a non-repo it's hidden and dispatch proceeds
    // normally.
    let target_dir = visible
        .get(modal.picker.selected)
        .map(|c| c.path.clone())
        .unwrap_or_else(|| modal.base_cwd.clone());
    let show_worktree = purpose.shows_worktree_toggle() && modal.target_is_repo(&target_dir);

    // Path input line — a visible, editable field (cursor always shown)
    // so the user can see / type an absolute, `~`, or relative path.
    // Doubles as the live filter for the candidate list below.
    modal.worktree_hit.set(None);
    if content_area.height >= 2 {
        // Reserve room at the right end of the path row for the worktree
        // toggle button, but only when the modal is wide enough to keep a
        // usable path field; otherwise the field spans the full width and
        // the button is hidden.
        let wt_text = if modal.worktree_mode {
            "[worktree:on]"
        } else {
            "[worktree:off]"
        };
        // ASCII → byte len == display width.
        let wt_w = wt_text.len() as u16;
        const WT_GAP: u16 = 1;
        const MIN_PATH_W: u16 = 16;
        let (path_w, wt_rect) = if show_worktree && content_area.width >= wt_w + WT_GAP + MIN_PATH_W
        {
            (
                content_area.width - wt_w - WT_GAP,
                Some(Rect {
                    x: content_area.x + content_area.width - wt_w,
                    y: content_area.y,
                    width: wt_w,
                    height: 1,
                }),
            )
        } else {
            (content_area.width, None)
        };
        render_search_bar_with_label(
            buf,
            content_area.x,
            content_area.y,
            path_w,
            theme,
            " path: ",
            &modal.picker.query,
            /* active */ false,
            /* show_hint */ false,
            modal.picker.query_cursor,
            Some(theme.bg_base),
        );
        modal.worktree_hit.set(wt_rect);
        if let Some(r) = wt_rect {
            // Dim label by default; brighten the text on hover, like other
            // clickable buttons. When armed, the "on" word is green in either
            // state so the active state reads at a glance.
            let label_fg = if modal.worktree_hit.hovered {
                theme.text_primary
            } else {
                theme.gray
            };
            buf.set_string(
                r.x,
                r.y,
                wt_text,
                Style::default().fg(label_fg).bg(theme.bg_base),
            );
            if modal.worktree_mode
                && let Some(on_at) = wt_text.find("on")
            {
                buf.set_string(
                    r.x + on_at as u16,
                    r.y,
                    "on",
                    Style::default().fg(theme.accent_success).bg(theme.bg_base),
                );
            }
        }
        // Second header row: the inline error (red) when present, else a
        // divider separating the input from the list.
        if let Some(err) = modal.error.as_deref() {
            let err_line = truncate_str(err, content_area.width as usize);
            buf.set_string(
                content_area.x,
                content_area.y + 1,
                &err_line,
                Style::default().fg(theme.accent_error).bg(theme.bg_base),
            );
        } else {
            render_divider(
                buf,
                content_area.x,
                content_area.y + 1,
                content_area.width,
                theme,
                Some(theme.bg_base),
            );
        }
        content_area.y += 2;
        content_area.height = content_area.height.saturating_sub(2);
    }

    // Build entries from the effective list (`visible`, computed above) —
    // recents (fuzzy-filtered) or live directory suggestions
    // (prefix-matched), depending on the query.
    // Worktree badge per row: just `worktree` when the directory name
    // already is the worktree name, else `worktree: <name>`. Built into a
    // parallel Vec so the `&str` badges outlive the entries.
    let badges: Vec<String> = visible
        .iter()
        .map(|c| match &c.worktree {
            Some(name) if name == &c.label => "worktree".to_string(),
            Some(name) => format!("worktree: {name}"),
            None => String::new(),
        })
        .collect();
    // Truncation priority: the directory name (label) is shown in full
    // whenever it fits; the path (right label) is truncated first. The
    // shared `render_picker_row` does the opposite (right label keeps its
    // full width, label truncates), so we pre-truncate the path here to
    // leave room for the full label + badge. Constants mirror
    // `render_picker_row`'s layout (fold prefix 2, gap 2, trailing 1); the
    // `-1` conservatively reserves a scrollbar column.
    let details: Vec<String> = {
        use unicode_width::UnicodeWidthStr;
        const PREFIX: u16 = 2;
        const GAP: u16 = 2;
        const TRAILING: u16 = 1;
        let row_w = content_area.width.saturating_sub(1);
        visible
            .iter()
            .zip(&badges)
            .map(|(c, badge)| {
                let badge_w = if badge.is_empty() {
                    0
                } else {
                    badge.width() as u16 + 1
                };
                let reserved = PREFIX + c.label.width() as u16 + badge_w + GAP + TRAILING;
                let budget = row_w.saturating_sub(reserved) as usize;
                truncate_str(&c.detail, budget)
            })
            .collect()
    };
    let entries: Vec<PickerEntry<'_>> = visible
        .iter()
        .zip(&badges)
        .zip(&details)
        .enumerate()
        .map(|(vis, ((c, badge), detail))| {
            PickerEntry::Row(PickerRow {
                label: c.label.as_str(),
                right_label: detail.as_str(),
                selected: vis == modal.picker.selected,
                expanded: false,
                fields: &[],
                description_lines: &[],
                summary_lines: &[],
                dimmed: false,
                indent: 0,
                badge: badge.as_str(),
                badge_color: (!badge.is_empty()).then_some(theme.accent_user),
                collapsible: false,
            })
        })
        .collect();

    let hits = render_picker_content(
        buf,
        content_area,
        theme,
        &mut modal.picker,
        &entries,
        /* non_selectable */ &[],
        /* non_selectable_clickable */ &[],
        Some(theme.bg_base),
        /* loading */ false,
    );
    modal.content_hits = Some(hits);
}

/// Recent project directories, for the picker's initial suggestion list.
///
/// Best-effort by design: the source is async, and this runs on the dispatch
/// path, so it blocks the current thread. A caller without a multi-threaded
/// runtime (a unit test, a synchronous startup path) simply gets no recents
/// rather than a panic — the picker still works, it just offers the current
/// directory and live path completion.
fn recent_project_dirs() -> Vec<(PathBuf, chrono::DateTime<chrono::Utc>)> {
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return Vec::new();
    };
    // `block_in_place` panics on a current-thread runtime, so gate on the
    // flavor rather than on the handle existing.
    if handle.runtime_flavor() != tokio::runtime::RuntimeFlavor::MultiThread {
        return Vec::new();
    }
    tokio::task::block_in_place(|| {
        handle.block_on(crate::project_picker::sources::collect_recent_dirs(10))
    })
}

/// Build the picker for a surface: the current directory first, then recent
/// project directories, with managed worktrees tagged.
pub fn open_location_picker(
    cwd: std::path::PathBuf,
    purpose: LocationPickerPurpose,
    worktree_mode: bool,
) -> LocationPicker {
    let recent = recent_project_dirs();

    // Worktree label index (root path → label), built once and reused to
    // tag both recents and live directory suggestions.
    let worktrees = crate::git_info::worktree_label_index();
    let worktree_label = |path: &std::path::Path| -> Option<String> {
        let key = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        worktrees.get(&key).cloned()
    };

    let mut candidates: Vec<LocationCandidate> = Vec::new();
    candidates.push(LocationCandidate {
        label: location_picker_label(&cwd),
        detail: format!(
            "{}  (current)",
            crate::project_picker::sources::display_path(&cwd)
        ),
        worktree: worktree_label(&cwd),
        path: cwd.clone(),
    });
    for (path, ts) in recent.into_iter().filter(|(p, _)| p != &cwd) {
        let detail = format!(
            "{}  ({})",
            crate::project_picker::sources::display_path(&path),
            crate::views::session_title::format_relative_time(
                (chrono::Utc::now() - ts).to_std().unwrap_or_default()
            ),
        );
        candidates.push(LocationCandidate {
            label: location_picker_label(&path),
            detail,
            worktree: worktree_label(&path),
            path,
        });
    }

    let mut state = LocationPickerState::new(candidates, cwd, worktrees);
    state.worktree_mode = worktree_mode;
    LocationPicker::new(state, purpose)
}

/// Short display label for a directory in the picker — the basename
/// (truncated), or `~` for the home directory itself.
fn location_picker_label(path: &std::path::Path) -> String {
    if dirs::home_dir().is_some_and(|h| h == path) {
        return "~".to_string();
    }
    let raw = path.file_name().and_then(|n| n.to_str()).unwrap_or("/");
    truncate_str(raw, 30)
}

/// Resolve a raw picker / `/cd` path string to an absolute path, expanding a
/// leading `~` and joining relative paths against `cwd`. Returns `None` for
/// empty input or when `~` can't be expanded. The caller is responsible for
/// validating the result is a directory.
pub fn resolve_location_input(input: &str, cwd: &std::path::Path) -> Option<PathBuf> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let expanded: PathBuf = if trimmed == "~" {
        dirs::home_dir()?
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        dirs::home_dir()?.join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    if expanded.is_absolute() {
        Some(expanded)
    } else {
        Some(cwd.join(expanded))
    }
}

#[cfg(test)]
mod tests;
