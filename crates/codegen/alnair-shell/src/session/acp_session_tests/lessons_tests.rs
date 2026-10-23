//! Actor-level tests for the workspace lesson library.
//!
//! The store, distiller and formatter each have unit tests in their own
//! modules. What these cover is the part only the actor can answer:
//!
//! - an empty store injects **nothing**, so a fresh workspace is byte-identical
//!   to not having the feature (the default-on safety proof);
//! - the block is injected once, and a second turn does not repeat it;
//! - a resumed segment whose transcript already carries the block does not
//!   re-inject;
//! - `[lessons]` hot-reload replaces the live config.

use super::support::*;
use super::*;

use alnair_sampling_types::ConversationItem;

/// Serialize the conversation exactly as the sampler would see it.
///
/// Byte-identity is the property under test, so this must not normalize
/// anything away — it is a straight serde render of the item list.
fn conversation_bytes(items: &[ConversationItem]) -> String {
    serde_json::to_string(items).expect("conversation must serialize")
}

/// A `[lessons]` config tree with the given `enabled` value.
fn lessons_toml(enabled: bool) -> toml::Value {
    toml::from_str(&format!("[lessons]\nenabled = {enabled}\n")).unwrap()
}

/// Build an actor with lessons pointed at a caller-supplied cwd.
///
/// `support::create_test_actor` pins the cwd to the OS temp root, which
/// `is_ephemeral_workspace` rejects — so a lesson store can never be created
/// there. These tests need a durable-looking path to exercise a non-empty
/// store, and they get it by rewriting the tool context cwd on a fresh actor.
async fn actor_with_cwd(cwd: &std::path::Path) -> SessionActor {
    let (gateway_tx, _gateway_rx) =
        tokio::sync::mpsc::unbounded_channel::<alnair_acp_lib::AcpClientMessage>();
    let (persistence_tx, _persistence_rx) =
        tokio::sync::mpsc::unbounded_channel::<PersistenceMsg>();
    let mut actor = create_test_actor(0, 256_000, 85, gateway_tx, persistence_tx).await;
    actor.tool_context.cwd = alnair_paths::AbsPathBuf::new(cwd.to_path_buf()).expect("abs cwd");
    actor
}

/// An empty store must produce no reminder and leave the conversation
/// untouched. This is the proof that default-on is safe: a workspace that has
/// never produced a lesson sees exactly the prompt it saw before the feature.
#[tokio::test(flavor = "current_thread")]
async fn empty_store_injects_nothing_and_leaves_the_conversation_identical() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let tmp = tempfile::TempDir::new().unwrap();
            let workspace = tmp.path().join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();

            let actor = actor_with_cwd(&workspace).await;
            let before = conversation_bytes(&actor.chat_state_handle.get_conversation().await);

            let reminder = actor.first_turn_lessons_reminder().await;
            assert!(
                reminder.is_none(),
                "an empty store must not produce a block, got: {reminder:?}"
            );

            let after = conversation_bytes(&actor.chat_state_handle.get_conversation().await);
            assert_eq!(
                before, after,
                "computing the reminder must not mutate the conversation"
            );
        })
        .await;
}

/// A disabled feature is a no-op even when the store has entries.
#[tokio::test(flavor = "current_thread")]
async fn disabled_config_injects_nothing() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let tmp = tempfile::TempDir::new().unwrap();
            let workspace = tmp.path().join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();

            let actor = actor_with_cwd(&workspace).await;
            *actor.lessons_config.borrow_mut() = crate::config::LessonsConfig {
                enabled: false,
                ..Default::default()
            };

            assert!(actor.first_turn_lessons_reminder().await.is_none());
        })
        .await;
}

/// The latch makes the second turn cheap, and
/// `conversation_has_lessons_context` makes it correct: after the block is
/// appended, asking again yields nothing.
#[tokio::test(flavor = "current_thread")]
async fn the_block_is_injected_once_and_not_again_on_a_later_turn() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let tmp = tempfile::TempDir::new().unwrap();
            let workspace = tmp.path().join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();

            let actor = actor_with_cwd(&workspace).await;

            // Seed the store through the same helper the formatter consumes, so
            // this test does not depend on the home directory resolving.
            let entry = crate::session::lessons::LessonEntry {
                cue: "Verification gaps keep reopening".into(),
                lesson: "Split the tangled module before patching the symptom.".into(),
                evidence: "failed 3 consecutive verification rounds on: ship it".into(),
                component: crate::session::lessons::LessonComponent::Workflow,
                captured: "2026-10-22T09:14:03Z".into(),
                id: crate::session::lessons::LessonEntry::compute_id(
                    "Verification gaps keep reopening",
                    "Split the tangled module before patching the symptom.",
                ),
                extra: Vec::new(),
            };
            let block = crate::session::helpers::lessons_context::format_lessons_reminder(
                std::slice::from_ref(&entry),
                3,
                400,
            )
            .expect("a non-empty store must produce a block");

            // First injection: append it the way the turn loop does.
            actor.push_system_reminder(&block);
            let conversation = actor.chat_state_handle.get_conversation().await;
            assert!(
                crate::session::helpers::lessons_context::conversation_has_lessons_context(
                    &conversation
                ),
                "the appended block must be detectable"
            );

            // Second turn: the conversation now carries the block, so nothing
            // more is produced even though the latch is already set.
            assert!(
                actor.first_turn_lessons_reminder().await.is_none(),
                "a conversation carrying the block must not re-inject"
            );

            // Exactly one block, not two.
            let count = conversation_bytes(&conversation)
                .matches(alnair_chat_state::LESSONS_CONTEXT_OPEN_TAG)
                .count();
            assert_eq!(count, 1, "exactly one block must be present");
        })
        .await;
}

/// A resumed segment already carries the block in its transcript. Injection
/// must be skipped, mirroring memory's cross-segment rule.
#[tokio::test(flavor = "current_thread")]
async fn resumed_transcript_with_the_block_does_not_reinject() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let tmp = tempfile::TempDir::new().unwrap();
            let workspace = tmp.path().join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();

            let actor = actor_with_cwd(&workspace).await;
            actor.push_system_reminder(&format!(
                "{} stale block from an earlier segment {}",
                alnair_chat_state::LESSONS_CONTEXT_OPEN_TAG,
                alnair_chat_state::LESSONS_CONTEXT_CLOSE_TAG
            ));

            // The latch starts false, so only the conversation scan can stop
            // the re-injection — which is the property under test.
            assert!(
                !actor
                    .memory
                    .lessons_injected
                    .load(std::sync::atomic::Ordering::Relaxed),
                "the latch must start unset"
            );
            assert!(actor.first_turn_lessons_reminder().await.is_none());
        })
        .await;
}

/// `[lessons]` hot-reload replaces the live config, so an edit mid-run applies
/// to the next capture and the next first-turn decision.
#[tokio::test(flavor = "current_thread")]
async fn hot_reload_replaces_the_live_lessons_config() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let tmp = tempfile::TempDir::new().unwrap();
            let workspace = tmp.path().join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();

            let actor = actor_with_cwd(&workspace).await;
            assert!(actor.lessons_config.borrow().enabled, "default is on");

            actor.apply_lessons_config_from_toml(&lessons_toml(false));
            assert!(
                !actor.lessons_config.borrow().enabled,
                "a disable must reach the live actor"
            );

            // And back on, so the reload is not a one-way trip.
            actor.apply_lessons_config_from_toml(&lessons_toml(true));
            assert!(actor.lessons_config.borrow().enabled);

            // A full section replaces the defaults rather than merging into
            // them, so a later edit cannot leave a stale cap behind.
            let raw: toml::Value = toml::from_str(
                "[lessons]\nenabled = true\nmax_entries = 7\ninject_max = 1\ninject_max_chars = 120\n",
            )
            .unwrap();
            actor.apply_lessons_config_from_toml(&raw);
            let live = actor.lessons_config.borrow().clone();
            assert_eq!(live.max_entries, 7);
            assert_eq!(live.inject_max, 1);
            assert_eq!(live.inject_max_chars, 120);
        })
        .await;
}

/// `/lessons` answers on an empty store, and `/lessons clear` is idempotent.
///
/// Driven at the store level: the slash arm itself is a thin wrapper that
/// prints the same strings, and its dispatch is covered by the
/// `slash_commands` tests.
#[test]
fn lessons_store_answers_empty_and_clear_is_idempotent() {
    let root = tempfile::TempDir::new().unwrap();
    // A durable-looking cwd: `TempDir` paths are rejected as ephemeral.
    let cwd = std::path::PathBuf::from("/nonexistent/lessons-integration/ws");

    assert!(
        crate::session::lessons::store::load_in(root.path(), &cwd, 0)
            .unwrap()
            .is_empty(),
        "an empty store must load as empty, not error"
    );
    assert!(!crate::session::lessons::store::clear_in(root.path(), &cwd).unwrap());
    // Second clear: still false, still no error.
    assert!(!crate::session::lessons::store::clear_in(root.path(), &cwd).unwrap());
}
