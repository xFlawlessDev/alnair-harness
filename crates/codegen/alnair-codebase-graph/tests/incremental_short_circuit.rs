//! The `Modified`-event short-circuit: an unchanged file must not be re-parsed.
//!
//! Editors emit a `Modified` event on every save, including saves that change
//! nothing (focus loss, `cargo fmt` producing identical output, a `git
//! checkout` of the same revision). Before the guard in `reindex_file`, each of
//! those tore the file's symbols out of the index and re-parsed it.
//!
//! These tests drive the real actor and assert on state the actor answers
//! through its command channel, so there is no sleep anywhere: `GetStats` is a
//! oneshot, which is the readiness signal.
//!
//! ## What proves the guard, and what does not
//!
//! Counting symbols after a no-op save proves *correctness* (the index still
//! describes the file) but not the short-circuit: re-parsing identical content
//! produces identical counts. The load-bearing test is
//! [`the_guard_skips_a_content_change_that_keeps_size_and_mtime`], which
//! reproduces the guard's documented blind spot on purpose. It fails without
//! the guard — the changed symbol would be indexed — and passes with it. That
//! is the only way to observe the decision from outside the actor.

use alnair_codebase_graph::{FileEvent, IndexManager, IndexManagerConfig};
use std::fs;
use std::time::SystemTime;
use tempfile::tempdir;

type Handle = std::sync::Arc<alnair_codebase_graph::IndexManagerHandle>;

fn manager(root: &std::path::Path) -> Handle {
    IndexManager::spawn(
        IndexManagerConfig::new(root.to_path_buf())
            .without_cache_load()
            .without_cache_save(),
    )
}

/// Capture the file's current modification time.
fn mtime_of(path: &std::path::Path) -> SystemTime {
    fs::metadata(path).unwrap().modified().unwrap()
}

#[test]
fn a_modified_event_for_an_unchanged_file_keeps_its_symbols() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let file = root.join("lib.rs");
    fs::write(&file, "fn alpha() {}\nfn beta() {}\n").unwrap();

    let handle = manager(root);
    let before = handle.get_stats().unwrap();
    assert_eq!(before.files, 1);
    assert_eq!(before.definitions, 2);

    // Same content, same mtime: this is the save-on-focus event.
    handle
        .send_event(FileEvent::modified(file.clone()))
        .unwrap();

    let after = handle.get_stats().unwrap();
    assert_eq!(
        (after.files, after.definitions),
        (before.files, before.definitions),
        "an unchanged file must keep exactly the symbols it had"
    );
    assert_eq!(
        handle.has_definition_blocking("alpha"),
        Some(true),
        "alpha must still be indexed"
    );
    assert_eq!(
        handle.has_definition_blocking("beta"),
        Some(true),
        "beta must still be indexed"
    );

    handle.shutdown().unwrap();
}

#[test]
fn a_modified_event_for_a_changed_file_still_reindexes() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let file = root.join("lib.rs");
    fs::write(&file, "fn alpha() {}\n").unwrap();

    let handle = manager(root);
    assert_eq!(handle.get_stats().unwrap().definitions, 1);

    // A real edit: different length, so the size alone proves it changed.
    fs::write(&file, "fn alpha() {}\nfn gamma() {}\n").unwrap();
    handle
        .send_event(FileEvent::modified(file.clone()))
        .unwrap();

    let after = handle.get_stats().unwrap();
    assert_eq!(after.definitions, 2, "the new definition must be indexed");
    assert_eq!(
        handle.has_definition_blocking("gamma"),
        Some(true),
        "gamma must be findable"
    );

    handle.shutdown().unwrap();
}

#[test]
fn a_modified_event_for_a_new_file_indexes_it() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("first.rs"), "fn one() {}\n").unwrap();

    let handle = manager(root);
    assert_eq!(handle.get_stats().unwrap().files, 1);

    // `Created` and `Modified` share the reindex path; a brand-new file has no
    // stored metadata, so the guard must not skip it.
    let second = root.join("second.rs");
    fs::write(&second, "fn two() {}\n").unwrap();
    handle.send_event(FileEvent::created(second)).unwrap();

    let after = handle.get_stats().unwrap();
    assert_eq!(after.files, 2, "the new file must be in the index");

    handle.shutdown().unwrap();
}

/// Repeated `Modified` events for one unchanged file must be idempotent: the
/// counts cannot drift. This is a correctness property, not the short-circuit —
/// see the module docs.
#[test]
fn repeated_modified_events_are_idempotent() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let file = root.join("lib.rs");
    fs::write(&file, "fn alpha() {}\nfn beta() {}\nfn gamma() {}\n").unwrap();

    let handle = manager(root);
    let baseline = handle.get_stats().unwrap();

    for _ in 0..10 {
        handle
            .send_event(FileEvent::modified(file.clone()))
            .unwrap();
    }

    let after = handle.get_stats().unwrap();
    assert_eq!(
        after, baseline,
        "ten no-op events must not change the index"
    );

    handle.shutdown().unwrap();
}

/// A file that changes between two events is reindexed on the second one; the
/// guard must not latch "unchanged" after a single match.
#[test]
fn an_edit_after_a_no_op_save_still_lands() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let file = root.join("lib.rs");
    fs::write(&file, "fn alpha() {}\n").unwrap();

    let handle = manager(root);

    handle
        .send_event(FileEvent::modified(file.clone()))
        .unwrap();
    assert_eq!(handle.get_stats().unwrap().definitions, 1);

    fs::write(&file, "fn alpha() {}\nfn delta() {}\n").unwrap();
    handle
        .send_event(FileEvent::modified(file.clone()))
        .unwrap();

    assert_eq!(
        handle.get_stats().unwrap().definitions,
        2,
        "the edit after a no-op save must still be indexed"
    );

    handle.shutdown().unwrap();
}

/// The guard's documented blind spot, asserted rather than assumed.
///
/// A same-length rewrite with the original mtime restored is indistinguishable
/// from "nothing happened" to a size+mtime comparison, so the actor keeps the
/// old symbols. This is the test that fails without the guard: before it, the
/// event path re-parsed unconditionally and `fresh_name` would have been
/// indexed despite the unchanged timestamp.
///
/// It is also the reason the guard is not a substitute for the background
/// refresh, which re-reads a file whenever its metadata differs — including
/// when a tool rewrote it with a preserved timestamp.
#[test]
fn the_guard_skips_a_content_change_that_keeps_size_and_mtime() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let file = root.join("lib.rs");

    // Two names of equal length, so only the mtime can distinguish the writes
    // — and we are about to hold that constant.
    fs::write(&file, "fn stale_name() {}\n").unwrap();
    let original_time = mtime_of(&file);

    let handle = manager(root);
    assert_eq!(
        handle.has_definition_blocking("stale_name"),
        Some(true),
        "precondition: the original symbol is indexed"
    );

    // Same byte length, different content, timestamp pinned back.
    fs::write(&file, "fn fresh_name() {}\n").unwrap();
    let times = fs::FileTimes::new().set_modified(original_time);
    fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_times(times)
        .unwrap();
    assert_eq!(
        mtime_of(&file),
        original_time,
        "precondition: the timestamp really was restored"
    );

    handle
        .send_event(FileEvent::modified(file.clone()))
        .unwrap();

    assert_eq!(
        handle.has_definition_blocking("stale_name"),
        Some(true),
        "the guard short-circuits on size+mtime, so the old symbol survives"
    );
    assert_eq!(
        handle.has_definition_blocking("fresh_name"),
        Some(false),
        "the new symbol is NOT indexed: this is the documented blind spot"
    );

    handle.shutdown().unwrap();
}
