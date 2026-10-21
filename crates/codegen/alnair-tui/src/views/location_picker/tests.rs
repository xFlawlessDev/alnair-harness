//! Tests for the shared directory picker: candidate listing, path
//! completion, and input routing.

use super::*;
use std::path::PathBuf;

fn location_candidate(path: &str, label: &str) -> LocationCandidate {
    LocationCandidate {
        path: PathBuf::from(path),
        label: label.to_string(),
        detail: path.to_string(),
        worktree: None,
    }
}

/// Build a picker over `recents` with a fixed base cwd and no worktrees.
fn location_picker(recents: Vec<LocationCandidate>) -> LocationPickerState {
    LocationPickerState::new(
        recents,
        PathBuf::from("/base"),
        std::collections::HashMap::new(),
    )
}

/// Build a picker with a worktree index for tagging suggestions.
fn location_picker_with_worktrees(
    recents: Vec<LocationCandidate>,
    worktrees: std::collections::HashMap<PathBuf, String>,
) -> LocationPickerState {
    LocationPickerState::new(recents, PathBuf::from("/base"), worktrees)
}

fn visible_labels(lp: &LocationPickerState) -> Vec<String> {
    lp.visible_candidates()
        .into_iter()
        .map(|c| c.label)
        .collect()
}

#[test]
fn location_visible_empty_query_shows_all_recents() {
    let lp = location_picker(vec![
        location_candidate("/home/me/alpha", "alpha"),
        location_candidate("/home/me/beta", "beta"),
    ]);
    assert_eq!(visible_labels(&lp), vec!["alpha", "beta"]);
}

#[test]
fn location_visible_filters_recents_by_substring() {
    let mut lp = location_picker(vec![
        location_candidate("/home/me/alpha", "alpha"),
        location_candidate("/home/me/beta", "beta"),
    ]);
    lp.picker.query = "bet".to_string();
    assert_eq!(visible_labels(&lp), vec!["beta"]);
}

#[test]
fn location_query_is_path_detection() {
    let mut lp = location_picker(vec![]);
    for q in ["/abs", "~/x", "rel/sub", "~"] {
        lp.picker.query = q.to_string();
        assert!(lp.query_is_path(), "`{q}` should be path mode");
    }
    for q in ["", "alpha", "bet"] {
        lp.picker.query = q.to_string();
        assert!(!lp.query_is_path(), "`{q}` should be recents mode");
    }
}

/// Windows drive-prefix detection is platform-independent (the
/// `cfg!(windows)` gate on its use is exercised only on Windows, but the
/// predicate itself must be correct everywhere).
#[test]
fn windows_drive_prefix_detection() {
    assert!(has_windows_drive_prefix("C:\\Users\\me"));
    assert!(has_windows_drive_prefix("d:/projects"));
    assert!(has_windows_drive_prefix("Z:"));
    assert!(!has_windows_drive_prefix("/usr/local"));
    assert!(!has_windows_drive_prefix("~/x"));
    assert!(!has_windows_drive_prefix("C"));
    assert!(!has_windows_drive_prefix("1:\\nope"));
}

#[test]
fn location_chosen_input_falls_back_to_typed_path() {
    let mut lp = location_picker(vec![location_candidate("/home/me/alpha", "alpha")]);
    // A path with no matching suggestion → the raw typed path is used.
    lp.picker.query = "/no/such/dir".to_string();
    assert_eq!(lp.chosen_input().as_deref(), Some("/no/such/dir"));
}

#[test]
fn location_chosen_input_uses_selected_recent() {
    let mut lp = location_picker(vec![
        location_candidate("/home/me/alpha", "alpha"),
        location_candidate("/home/me/beta", "beta"),
    ]);
    lp.picker.selected = 1;
    assert_eq!(lp.chosen_input().as_deref(), Some("/home/me/beta"));
}

#[test]
fn location_path_completion_lists_filters_and_hides_dotdirs() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join("alpha")).unwrap();
    std::fs::create_dir(tmp.path().join("beta")).unwrap();
    std::fs::create_dir(tmp.path().join(".hidden")).unwrap();
    let mut lp = location_picker(vec![]);

    // Trailing slash → list the (non-hidden) subdirs.
    lp.picker.query = format!("{}/", tmp.path().display());
    lp.refresh_suggestions();
    let labels = visible_labels(&lp);
    assert!(labels.contains(&"alpha".to_string()), "got: {labels:?}");
    assert!(labels.contains(&"beta".to_string()), "got: {labels:?}");
    assert!(
        !labels.contains(&".hidden".to_string()),
        "dotdirs hidden unless the partial starts with `.`, got: {labels:?}",
    );

    // Prefix filter on the final segment.
    lp.picker.query = format!("{}/al", tmp.path().display());
    lp.refresh_suggestions();
    assert_eq!(visible_labels(&lp), vec!["alpha"]);

    // A leading dot in the partial reveals dot-directories.
    lp.picker.query = format!("{}/.h", tmp.path().display());
    lp.refresh_suggestions();
    assert_eq!(visible_labels(&lp), vec![".hidden"]);
}

#[test]
fn location_path_completion_tags_worktree_subdirs() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join("wt")).unwrap();
    std::fs::create_dir(tmp.path().join("plain")).unwrap();
    // Index `wt` as a managed worktree (keys are canonical paths).
    let canon = dunce::canonicalize(tmp.path()).unwrap_or_else(|_| tmp.path().to_path_buf());
    let mut worktrees = std::collections::HashMap::new();
    worktrees.insert(canon.join("wt"), "my-feature".to_string());

    let mut lp = location_picker_with_worktrees(vec![], worktrees);
    lp.picker.query = format!("{}/", tmp.path().display());
    lp.refresh_suggestions();

    let visible = lp.visible_candidates();
    let wt = visible.iter().find(|c| c.label == "wt").expect("wt listed");
    assert_eq!(wt.worktree.as_deref(), Some("my-feature"));
    let plain = visible
        .iter()
        .find(|c| c.label == "plain")
        .expect("plain listed");
    assert_eq!(plain.worktree, None);
}

/// A worktree directory that is itself a symlink still gets tagged:
/// the index key is the canonical (real) path, so `read_subdirs` must
/// canonicalize the entry (resolving the symlink), not just join the
/// name to the canonical parent.
#[cfg(unix)]
#[test]
fn location_path_completion_tags_symlinked_worktree() {
    // The real worktree target.
    let real = tempfile::tempdir().unwrap();
    // The dir we list.
    let parent = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(real.path(), parent.path().join("link")).unwrap();

    // Index keyed by the real (canonical) path, as the worktree DB is.
    let real_canon = dunce::canonicalize(real.path()).unwrap();
    let mut worktrees = std::collections::HashMap::new();
    worktrees.insert(real_canon, "linked-wt".to_string());

    let mut lp = location_picker_with_worktrees(vec![], worktrees);
    lp.picker.query = format!("{}/", parent.path().display());
    lp.refresh_suggestions();

    let link = lp
        .visible_candidates()
        .into_iter()
        .find(|c| c.label == "link")
        .expect("symlinked dir listed");
    assert_eq!(link.worktree.as_deref(), Some("linked-wt"));
}

#[test]
fn enter_chooses_the_selected_recent() {
    let mut lp = location_picker(vec![
        location_candidate("/home/me/alpha", "alpha"),
        location_candidate("/home/me/beta", "beta"),
    ]);
    lp.picker.selected = 1;
    let enter = crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Enter,
        crossterm::event::KeyModifiers::NONE,
    );
    assert_eq!(
        lp.handle_input(&Event::Key(enter)),
        LocationPickerOutcome::Chosen("/home/me/beta".into()),
    );
}

#[test]
fn tab_completes_the_selected_path() {
    let mut lp = location_picker(vec![
        // Paths outside $HOME so `display_path` leaves them absolute,
        // keeping the assertion independent of the test machine's home.
        location_candidate("/opt/projects/alpha", "alpha"),
        location_candidate("/opt/projects/beta", "beta"),
    ]);
    lp.picker.selected = 1;
    let tab = crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Tab,
        crossterm::event::KeyModifiers::NONE,
    );
    assert_eq!(
        lp.handle_input(&Event::Key(tab)),
        LocationPickerOutcome::Changed
    );
    assert_eq!(lp.picker.query, "/opt/projects/beta/");
    assert_eq!(lp.picker.query_cursor, lp.picker.query.len());
}

#[test]
fn path_completion_enter_uses_the_selected_subdir() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join("alpha")).unwrap();
    let mut lp = location_picker(vec![]);
    lp.picker.query = format!("{}/al", tmp.path().display());
    lp.refresh_suggestions();

    let enter = crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Enter,
        crossterm::event::KeyModifiers::NONE,
    );
    let expected = tmp.path().join("alpha").to_string_lossy().into_owned();
    assert_eq!(
        lp.handle_input(&Event::Key(enter)),
        LocationPickerOutcome::Chosen(expected),
    );
}

#[test]
fn typed_path_with_no_match_uses_the_raw_query() {
    let mut lp = location_picker(vec![location_candidate("/home/me/alpha", "alpha")]);
    // A guaranteed-absent home path → no suggestion → the raw query is used.
    for c in "~/__nope_zzz__".chars() {
        let key = crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char(c),
            crossterm::event::KeyModifiers::NONE,
        );
        let _ = lp.handle_input(&Event::Key(key));
    }
    let enter = crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Enter,
        crossterm::event::KeyModifiers::NONE,
    );
    assert_eq!(
        lp.handle_input(&Event::Key(enter)),
        LocationPickerOutcome::Chosen("~/__nope_zzz__".into()),
    );
}

/// Editing the path clears a stale "Not a directory" error so it
/// doesn't linger next to a corrected (possibly valid) input.
#[test]
fn editing_clears_the_stale_error() {
    let mut lp = location_picker(vec![]);
    lp.error = Some("Not a directory: /bad".to_string());
    let key = crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('x'),
        crossterm::event::KeyModifiers::NONE,
    );
    let _ = lp.handle_input(&Event::Key(key));
    assert!(
        lp.error.is_none(),
        "editing the path must clear the stale error",
    );
}

#[test]
fn esc_closes_the_picker() {
    // Pin vim-mode off; this asserts the non-vim picker path.
    crate::appearance::cache::set_vim_mode(false);
    let mut lp = location_picker(vec![location_candidate("/tmp", "tmp")]);
    let esc = crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Esc,
        crossterm::event::KeyModifiers::NONE,
    );
    assert_eq!(
        lp.handle_input(&Event::Key(esc)),
        LocationPickerOutcome::Closed
    );
}

#[test]
fn resolve_location_input_expands_and_joins() {
    let cwd = PathBuf::from("/work/dir");
    // Absolute path is returned as-is.
    assert_eq!(
        resolve_location_input("/abs/path", &cwd),
        Some(PathBuf::from("/abs/path"))
    );
    // Relative paths join the current cwd.
    assert_eq!(
        resolve_location_input("sub/dir", &cwd),
        Some(PathBuf::from("/work/dir/sub/dir"))
    );
    // `~` / `~/...` expand to the home directory.
    let home = dirs::home_dir().expect("home dir");
    assert_eq!(resolve_location_input("~", &cwd), Some(home.clone()));
    assert_eq!(resolve_location_input("~/x", &cwd), Some(home.join("x")));
    // Empty / whitespace → None.
    assert_eq!(resolve_location_input("   ", &cwd), None);
}

/// Each purpose renders its own title so the user can tell what Enter will
/// do — the same modal serves three different outcomes.
#[test]
fn purposes_have_distinct_titles() {
    let titles = [
        LocationPickerPurpose::Dashboard.title(),
        LocationPickerPurpose::NewSession.title(),
        LocationPickerPurpose::PagerCwd.title(),
    ];
    for (i, a) in titles.iter().enumerate() {
        for b in &titles[i + 1..] {
            assert_ne!(a, b, "picker titles must be distinguishable");
        }
    }
}

/// The worktree toggle belongs to the dashboard's staged dispatch only.
#[test]
fn only_the_dashboard_purpose_offers_the_worktree_toggle() {
    assert!(LocationPickerPurpose::Dashboard.shows_worktree_toggle());
    assert!(!LocationPickerPurpose::NewSession.shows_worktree_toggle());
    assert!(!LocationPickerPurpose::PagerCwd.shows_worktree_toggle());
}

// ---------------------------------------------------------------- rendering

/// Read a buffer row-by-row so multi-cell substring checks see the visible
/// text in left-to-right order.
fn buf_to_text(buf: &ratatui::buffer::Buffer) -> String {
    let mut content = String::new();
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            content.push_str(buf[(x, y)].symbol());
        }
        content.push('\n');
    }
    content
}

fn draw_picker(
    purpose: LocationPickerPurpose,
    modal: &mut LocationPickerState,
    area: ratatui::layout::Rect,
) -> String {
    let mut buf = ratatui::buffer::Buffer::empty(area);
    render_location_picker(
        &mut buf,
        area,
        &crate::theme::Theme::current(),
        purpose,
        modal,
    );
    buf_to_text(&buf)
}

/// The modal paints its title + candidate rows and records the content hit
/// areas for mouse handling.
#[test]
fn render_shows_candidates_and_hit_areas() {
    let mut modal = LocationPickerState::new(
        vec![LocationCandidate {
            path: PathBuf::from("/home/me/frontend"),
            label: "frontend".to_string(),
            detail: "~/me/frontend".to_string(),
            worktree: None,
        }],
        PathBuf::from("/base"),
        std::collections::HashMap::new(),
    );
    let content = draw_picker(
        LocationPickerPurpose::NewSession,
        &mut modal,
        ratatui::layout::Rect::new(0, 0, 80, 24),
    );
    assert!(
        content.contains("New session directory"),
        "modal title missing, got: {content:?}",
    );
    assert!(
        content.contains("path:"),
        "path input field missing, got: {content:?}",
    );
    assert!(
        content.contains("frontend"),
        "candidate label missing, got: {content:?}",
    );
    assert!(
        modal.content_hits.is_some(),
        "content hit areas must be recorded for the mouse handler",
    );
}

/// In a git repo the dashboard-purpose modal paints a worktree toggle
/// reflecting its state, and records the hit rect.
#[test]
fn render_shows_worktree_toggle_only_for_the_dashboard() {
    let repo = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(repo.path().join(".git")).expect("mk .git");

    let mut modal = LocationPickerState::new(
        vec![],
        repo.path().to_path_buf(),
        std::collections::HashMap::new(),
    );
    let area = ratatui::layout::Rect::new(0, 0, 80, 24);
    let content = draw_picker(LocationPickerPurpose::Dashboard, &mut modal, area);
    assert!(
        content.contains("worktree:off"),
        "off-state button missing, got: {content:?}",
    );
    assert!(
        modal.worktree_hit.rect.is_some(),
        "the worktree button hit rect must be recorded",
    );

    modal.worktree_mode = true;
    let content = draw_picker(LocationPickerPurpose::Dashboard, &mut modal, area);
    assert!(
        content.contains("worktree:on"),
        "on-state button missing, got: {content:?}",
    );

    // A new-session picker has no dispatch to arm, so the toggle is hidden
    // rather than shown inert.
    let mut other = LocationPickerState::new(
        vec![],
        repo.path().to_path_buf(),
        std::collections::HashMap::new(),
    );
    let content = draw_picker(LocationPickerPurpose::NewSession, &mut other, area);
    assert!(
        !content.contains("worktree:"),
        "new-session picker must not offer a worktree toggle, got: {content:?}",
    );
    assert!(
        other.worktree_hit.rect.is_none(),
        "no hit rect when the toggle is hidden",
    );
}

/// Worktree directories render a styled `worktree: <name>` badge.
#[test]
fn render_tags_worktree_rows() {
    let mut modal = LocationPickerState::new(
        vec![LocationCandidate {
            path: PathBuf::from("/home/me/wt"),
            label: "wt".to_string(),
            detail: "~/me/wt".to_string(),
            worktree: Some("my-feature".to_string()),
        }],
        PathBuf::from("/base"),
        std::collections::HashMap::new(),
    );
    let content = draw_picker(
        LocationPickerPurpose::Dashboard,
        &mut modal,
        ratatui::layout::Rect::new(0, 0, 80, 24),
    );
    assert!(
        content.contains("worktree: my-feature"),
        "worktree badge missing, got: {content:?}",
    );
}

/// Truncation priority: the directory name is shown in full and the path is
/// truncated first.
#[test]
fn render_truncates_the_path_not_the_label() {
    let mut modal = LocationPickerState::new(
        vec![LocationCandidate {
            path: PathBuf::from("/home/me/myproj"),
            label: "myproj".to_string(),
            detail: "~/very/long/path/that/keeps/going/UNIQUETAIL".to_string(),
            worktree: None,
        }],
        PathBuf::from("/base"),
        std::collections::HashMap::new(),
    );
    let content = draw_picker(
        LocationPickerPurpose::NewSession,
        &mut modal,
        ratatui::layout::Rect::new(0, 0, 54, 20),
    );
    assert!(
        content.contains("myproj"),
        "full label must be shown, got: {content:?}",
    );
    assert!(
        !content.contains("UNIQUETAIL"),
        "the path tail must be truncated away, got: {content:?}",
    );
}

/// A typed path with no matching candidate still echoes in the input field
/// (the list then shows "No matches").
#[test]
fn render_echoes_the_typed_path() {
    let mut modal = LocationPickerState::new(
        vec![LocationCandidate {
            path: PathBuf::from("/home/me/frontend"),
            label: "frontend".to_string(),
            detail: "~/me/frontend".to_string(),
            worktree: None,
        }],
        PathBuf::from("/base"),
        std::collections::HashMap::new(),
    );
    modal.picker.query = "/tmp/zzz".to_string();
    modal.picker.query_cursor = modal.picker.query.len();
    let content = draw_picker(
        LocationPickerPurpose::NewSession,
        &mut modal,
        ratatui::layout::Rect::new(0, 0, 80, 24),
    );
    assert!(
        content.contains("/tmp/zzz"),
        "typed path must echo in the input field, got: {content:?}",
    );
}

/// Under vim, `Esc` drops the picker to nav mode — so the footer must surface
/// the `i search` hint, and hide it while typing or with vim off.
#[test]
fn footer_shows_the_vim_search_hint_in_nav_mode() {
    let make = || {
        LocationPickerState::new(
            vec![],
            PathBuf::from("/tmp"),
            std::collections::HashMap::new(),
        )
    };
    let area = ratatui::layout::Rect::new(0, 0, 160, 48);

    crate::appearance::cache::set_vim_mode(true);
    let mut nav = make();
    nav.picker.search_active = false;
    let content = draw_picker(LocationPickerPurpose::Dashboard, &mut nav, area);
    assert!(
        content.contains("i search"),
        "footer must show `i search` in vim nav mode, got: {content:?}",
    );

    let mut input = make();
    input.picker.search_active = true;
    let content = draw_picker(LocationPickerPurpose::Dashboard, &mut input, area);
    assert!(
        !content.contains("i search"),
        "no `i search` hint while typing, got: {content:?}",
    );

    crate::appearance::cache::set_vim_mode(false);
    let mut off = make();
    off.picker.search_active = false;
    let content = draw_picker(LocationPickerPurpose::Dashboard, &mut off, area);
    assert!(
        !content.contains("i search"),
        "no `i search` hint with vim off, got: {content:?}",
    );
}
