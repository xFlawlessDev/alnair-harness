//! Tab model and store tests.

use super::store::{self, PersistedTabs, TabScope, TabState};
use super::*;

fn tab(id: &str) -> TabEntry {
    TabEntry::new(id, PathBuf::from("/repo"))
}

fn tab_in(id: &str, cwd: &str) -> TabEntry {
    TabEntry::new(id, PathBuf::from(cwd))
}

// ---- model -------------------------------------------------------------

#[test]
fn open_appends_and_activates() {
    let mut tabs = SessionTabs::new();
    assert_eq!(tabs.open(tab("a")), 0);
    assert_eq!(tabs.open(tab("b")), 1);
    assert_eq!(tabs.len(), 2);
    assert_eq!(tabs.active_index(), Some(1));
}

/// A rename or a worktree move must update the existing chip, never add one.
#[test]
fn open_is_idempotent_by_session_id() {
    let mut tabs = SessionTabs::new();
    tabs.open(tab("a"));
    tabs.open(tab("b"));

    let mut renamed = tab_in("a", "/repo-wt");
    renamed.title = Some("Fix the roster".into());
    let index = tabs.open(renamed);

    assert_eq!(index, 0, "the existing tab is reused");
    assert_eq!(tabs.len(), 2, "no duplicate chip");
    assert_eq!(tabs.active_index(), Some(0), "opening activates");
    assert_eq!(tabs.tabs()[0].title.as_deref(), Some("Fix the roster"));
    assert_eq!(tabs.tabs()[0].cwd, PathBuf::from("/repo-wt"));
}

#[test]
fn open_does_not_clear_a_known_title_with_none() {
    let mut tabs = SessionTabs::new();
    let mut titled = tab("a");
    titled.title = Some("Kept".into());
    tabs.open(titled);
    tabs.open(tab("a"));
    assert_eq!(tabs.tabs()[0].title.as_deref(), Some("Kept"));
}

#[test]
fn refresh_updates_without_stealing_the_cursor() {
    let mut tabs = SessionTabs::new();
    tabs.open(tab("a"));
    tabs.open(tab("b"));
    assert_eq!(tabs.active_index(), Some(1));

    tabs.refresh(
        "a",
        Some("Renamed".into()),
        Some(PathBuf::from("/elsewhere")),
    );
    assert_eq!(tabs.active_index(), Some(1), "the cursor stays put");
    assert_eq!(tabs.tabs()[0].title.as_deref(), Some("Renamed"));
    assert_eq!(tabs.tabs()[0].cwd, PathBuf::from("/elsewhere"));
}

#[test]
fn refresh_ignores_an_unknown_session() {
    let mut tabs = SessionTabs::new();
    tabs.open(tab("a"));
    tabs.refresh("nope", Some("x".into()), None);
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs.tabs()[0].title, None);
}

/// Closing the active tab activates the right neighbour; at the end, the left.
#[test]
fn close_active_picks_the_right_neighbour_then_the_left() {
    let mut tabs = SessionTabs::new();
    for id in ["a", "b", "c"] {
        tabs.open(tab(id));
    }
    tabs.set_active(1);
    tabs.close(1);
    assert_eq!(tabs.session_ids(), vec!["a", "c"]);
    assert_eq!(
        tabs.active_index(),
        Some(1),
        "right neighbour took the slot"
    );

    tabs.close(1);
    assert_eq!(tabs.session_ids(), vec!["a"]);
    assert_eq!(
        tabs.active_index(),
        Some(0),
        "left neighbour is the fallback"
    );
}

#[test]
fn closing_before_the_active_tab_keeps_the_same_tab_active() {
    let mut tabs = SessionTabs::new();
    for id in ["a", "b", "c"] {
        tabs.open(tab(id));
    }
    tabs.set_active(2);
    tabs.close(0);
    assert_eq!(tabs.session_ids(), vec!["b", "c"]);
    assert_eq!(
        tabs.active().map(|t| t.session_id.as_str()),
        Some("c"),
        "the same session stays active, at its shifted index"
    );
}

#[test]
fn closing_the_last_tab_leaves_no_active_tab() {
    let mut tabs = SessionTabs::new();
    tabs.open(tab("a"));
    tabs.close(0);
    assert!(tabs.is_empty());
    assert_eq!(tabs.active_index(), None);
    assert!(tabs.cycle(true).is_none());
}

#[test]
fn close_out_of_range_is_a_no_op() {
    let mut tabs = SessionTabs::new();
    tabs.open(tab("a"));
    assert!(tabs.close(5).is_none());
    assert_eq!(tabs.len(), 1);
}

#[test]
fn reopen_restores_the_original_position() {
    let mut tabs = SessionTabs::new();
    for id in ["a", "b", "c"] {
        tabs.open(tab(id));
    }
    tabs.close_id("b").expect("b was open");
    assert_eq!(tabs.session_ids(), vec!["a", "c"]);

    let reopened = tabs.reopen().expect("one closed tab");
    assert_eq!(reopened.session_id, "b");
    assert_eq!(tabs.session_ids(), vec!["a", "b", "c"], "index restored");
    assert_eq!(tabs.active_index(), Some(1));
}

/// A reopen stack entry for a session that came back some other way must not
/// shadow an older, still-valid entry.
#[test]
fn reopen_skips_sessions_that_are_open_again() {
    let mut tabs = SessionTabs::new();
    tabs.open(tab("a"));
    tabs.close_id("a");
    tabs.open(tab("a"));
    tabs.close_id("a");
    tabs.open(tab("a"));

    assert!(tabs.reopen().is_none(), "no stale entry may resurrect");
    assert_eq!(tabs.session_ids(), vec!["a"]);
}

#[test]
fn reopen_stack_is_capped() {
    let mut tabs = SessionTabs::new();
    tabs.open(tab("keep"));
    for i in 0..(CLOSED_CAP + 10) {
        let id = format!("s{i}");
        tabs.open(tab(&id));
        tabs.close_id(&id);
    }
    // Only the most recent entries survive, and reopening walks them newest
    // first — the oldest ten were dropped.
    let mut reopened = Vec::new();
    while let Some(t) = tabs.reopen() {
        reopened.push(t.session_id);
    }
    assert_eq!(reopened.len(), CLOSED_CAP);
    assert_eq!(reopened.first().map(String::as_str), Some("s34"));
}

#[test]
fn cycle_wraps_both_directions() {
    let mut tabs = SessionTabs::new();
    for id in ["a", "b", "c"] {
        tabs.open(tab(id));
    }
    tabs.set_active(2);
    assert_eq!(tabs.cycle(true).map(|t| t.session_id.as_str()), Some("a"));
    assert_eq!(tabs.cycle(false).map(|t| t.session_id.as_str()), Some("c"));
    assert_eq!(tabs.cycle(false).map(|t| t.session_id.as_str()), Some("b"));
}

/// `from_parts` never yields a non-empty list without an active tab: a
/// persisted file with a stale `active` (or none) must still render one chip as
/// current. Cycling then works from that tab.
#[test]
fn from_parts_activates_the_last_tab_when_none_is_given() {
    let mut tabs = SessionTabs::from_parts(vec![tab("a"), tab("b")], None);
    assert_eq!(tabs.active_index(), Some(1), "the last tab becomes current");
    assert_eq!(tabs.cycle(true).map(|t| t.session_id.as_str()), Some("a"));
    assert_eq!(tabs.cycle(false).map(|t| t.session_id.as_str()), Some("b"));
}

#[test]
fn move_tab_keeps_the_same_tab_active() {
    let mut tabs = SessionTabs::new();
    for id in ["a", "b", "c"] {
        tabs.open(tab(id));
    }
    tabs.set_active(0);
    tabs.move_tab(0, 2);
    assert_eq!(tabs.session_ids(), vec!["b", "c", "a"]);
    assert_eq!(
        tabs.active().map(|t| t.session_id.as_str()),
        Some("a"),
        "the cursor follows the tab, not the index"
    );
}

#[test]
fn move_tab_ignores_bad_indexes() {
    let mut tabs = SessionTabs::new();
    tabs.open(tab("a"));
    tabs.open(tab("b"));
    tabs.move_tab(0, 9);
    tabs.move_tab(9, 0);
    tabs.move_tab(1, 1);
    assert_eq!(tabs.session_ids(), vec!["a", "b"]);
}

#[test]
fn from_parts_clamps_the_active_index() {
    let tabs = SessionTabs::from_parts(vec![tab("a")], Some(7));
    assert_eq!(tabs.active_index(), Some(0));
    let empty = SessionTabs::from_parts(Vec::new(), Some(3));
    assert_eq!(empty.active_index(), None);
}

#[test]
fn set_active_rejects_out_of_range() {
    let mut tabs = SessionTabs::new();
    tabs.open(tab("a"));
    tabs.set_active(4);
    assert_eq!(tabs.active_index(), Some(0));
}

#[test]
fn display_title_falls_back_to_a_short_id() {
    assert_eq!(tab("abcdef123456").display_title(), "session abcdef12");
    let mut titled = tab("x");
    titled.title = Some("  Fix it  ".into());
    assert_eq!(titled.display_title(), "Fix it");
    let mut blank = tab("y");
    blank.title = Some("   ".into());
    assert_eq!(blank.display_title(), "session y");
}

// ---- store -------------------------------------------------------------

#[test]
fn store_round_trips_through_disk() {
    let dir = tempfile::tempdir().unwrap();
    store::update_in(dir.path(), |state| {
        state.scope = TabScope::Global;
        state.global.tabs = vec![tab_in("a", "/repo"), tab_in("b", "/other")];
        state.global.active = Some(1);
    })
    .unwrap();

    let loaded = store::load_in(dir.path());
    assert_eq!(loaded.scope, TabScope::Global);
    assert_eq!(loaded.global.tabs.len(), 2);
    assert_eq!(loaded.global.active, Some(1));
    assert_eq!(loaded.global.tabs[1].cwd, PathBuf::from("/other"));
}

#[test]
fn store_missing_file_reads_as_default() {
    let dir = tempfile::tempdir().unwrap();
    let loaded = store::load_in(dir.path());
    assert_eq!(loaded, TabState::default());
    assert_eq!(
        loaded.scope,
        TabScope::Global,
        "global is the default scope"
    );
}

/// A missing directory is created on the first write.
#[test]
fn store_creates_its_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("run");
    assert!(!root.exists());
    store::update_in(&root, |state| state.global.tabs = vec![tab("a")]).unwrap();
    assert!(root.join("pager_tabs.json").is_file());
}

/// The Windows `replace_file` window: an absent data file must read as "no
/// tabs", not as corruption, and must never delete anything.
#[test]
fn store_absent_file_is_not_corruption() {
    let dir = tempfile::tempdir().unwrap();
    // Only the lock exists, as if a writer were mid-swap.
    std::fs::write(dir.path().join("pager_tabs.json.lock"), b"").unwrap();
    assert_eq!(store::load_in(dir.path()), TabState::default());
    assert!(store::stamp(dir.path()).is_none());
}

#[test]
fn store_corrupt_file_warns_and_leaves_the_file_alone() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pager_tabs.json");
    std::fs::write(&path, b"{ this is not json").unwrap();

    let loaded = store::load_in(dir.path());
    assert_eq!(loaded, TabState::default(), "start empty rather than fail");
    assert!(
        path.is_file(),
        "a newer version's file must survive an old reader"
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"{ this is not json");
}

#[test]
fn store_empty_file_reads_as_default() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("pager_tabs.json"), b"").unwrap();
    assert_eq!(store::load_in(dir.path()), TabState::default());
}

/// Two writers racing through the lock must not lose each other's update.
#[test]
fn store_concurrent_writers_do_not_lose_updates() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    const PER_THREAD: usize = 25;

    let handles: Vec<_> = (0..2)
        .map(|t| {
            let root = root.clone();
            std::thread::spawn(move || {
                for i in 0..PER_THREAD {
                    store::update_in(&root, |state| {
                        state.global.tabs.push(tab(&format!("t{t}-{i}")));
                    })
                    .unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }

    let loaded = store::load_in(&root);
    assert_eq!(
        loaded.global.tabs.len(),
        PER_THREAD * 2,
        "every locked read-modify-write must survive"
    );
}

/// A writer that panics mid-closure must not leave the lock held or a partial
/// document committed.
#[test]
fn store_failed_write_leaves_the_previous_document_intact() {
    let dir = tempfile::tempdir().unwrap();
    store::update_in(dir.path(), |state| state.global.tabs = vec![tab("keep")]).unwrap();

    let root = dir.path().to_path_buf();
    let panicked = std::thread::spawn(move || {
        let _ = store::update_in(&root, |state| {
            state.global.tabs.clear();
            panic!("boom");
        });
    })
    .join();
    assert!(panicked.is_err(), "the closure panicked as intended");

    let loaded = store::load_in(dir.path());
    assert_eq!(
        loaded.global.tabs.len(),
        1,
        "the uncommitted mutation must not have been written"
    );
    // The lock is released, so the next writer proceeds.
    store::update_in(dir.path(), |state| state.global.tabs.push(tab("next"))).unwrap();
    assert_eq!(store::load_in(dir.path()).global.tabs.len(), 2);
}

#[test]
fn cwd_scope_keeps_separate_lists() {
    let dir = tempfile::tempdir().unwrap();
    store::update_in(dir.path(), |state| {
        state.scope = TabScope::Cwd;
        state.list_mut(TabScope::Cwd, "/a").tabs = vec![tab("a1")];
        state.list_mut(TabScope::Cwd, "/b").tabs = vec![tab("b1"), tab("b2")];
    })
    .unwrap();

    let loaded = store::load_in(dir.path());
    assert_eq!(loaded.list(TabScope::Cwd, "/a").tabs.len(), 1);
    assert_eq!(loaded.list(TabScope::Cwd, "/b").tabs.len(), 2);
    assert_eq!(
        loaded.list(TabScope::Cwd, "/never-seen"),
        &PersistedTabs::default(),
        "an unknown cwd is empty, not a panic"
    );
}

#[test]
fn stamp_changes_when_the_file_changes() {
    let dir = tempfile::tempdir().unwrap();
    store::update_in(dir.path(), |state| state.global.tabs = vec![tab("a")]).unwrap();
    let first = store::stamp(dir.path()).expect("file exists");

    // The length alone is enough to notice here; mtime granularity varies by
    // filesystem, which is why the stamp carries both.
    store::update_in(dir.path(), |state| {
        state.global.tabs.push(tab("bbbbbbbbbbbbbbbbbbbbbbbb"))
    })
    .unwrap();
    let second = store::stamp(dir.path()).expect("file exists");
    assert_ne!(first.1, second.1, "a grown file must be noticed");
}

#[test]
fn scope_parses_case_insensitively_and_rejects_junk() {
    assert_eq!(TabScope::parse(" Global "), Some(TabScope::Global));
    assert_eq!(TabScope::parse("CWD"), Some(TabScope::Cwd));
    assert_eq!(TabScope::parse("nope"), None);
    assert_eq!(TabScope::Global.as_str(), "global");
}

/// A file written by a newer version with unknown fields must still load the
/// fields this one understands, rather than blanking the strip.
#[test]
fn unknown_fields_are_tolerated() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("pager_tabs.json"),
        br#"{"version":99,"scope":"global","global":{"tabs":[{"session_id":"s","cwd":"/r","title":null,"future":1}],"active":0},"future_root":true}"#,
    )
    .unwrap();
    let loaded = store::load_in(dir.path());
    assert_eq!(loaded.global.tabs.len(), 1);
    assert_eq!(loaded.global.tabs[0].session_id, "s");
}
