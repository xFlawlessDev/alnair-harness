//! AGENTS.md hot-reload: a revision queued mid-session is appended at the next
//! turn boundary, never replacing the spawn-time item.
//!
//! The two invariants under test:
//! 1. An unchanged file set queues nothing (the reloader's content hash is the
//!    first line of defence, but the actor must also be idempotent on its own).
//! 2. A revision is an *append*, tagged `ProjectInstructionsUpdate`, so the
//!    spawn-time idempotence guard still sees the original block.

use super::support::*;
use super::*;
use alnair_sampling_types::{ConversationItem, SyntheticReason};

/// The flush appends the queued revision exactly once and clears the slot, so
/// the turn pipeline's multiple safe points cannot duplicate it.
#[tokio::test]
async fn flush_appends_queued_revision_once() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _gateway_rx) = build_actor().await;
            actor
                .chat_state_handle
                .push_user_message(ConversationItem::project_instructions("original body"));

            *actor.pending_project_instructions.lock() = Some(
                ConversationItem::project_instructions_update("revised body"),
            );

            actor.flush_pending_project_instructions().await;

            let conv = actor.chat_state_handle.get_conversation().await;
            assert_eq!(
                conv.len(),
                2,
                "the original item must survive and the revision must be appended"
            );
            assert_eq!(conv[0].text_content(), "original body");
            assert_eq!(conv[1].text_content(), "revised body");
            match &conv[1] {
                ConversationItem::User(u) => assert_eq!(
                    u.synthetic_reason,
                    Some(SyntheticReason::ProjectInstructionsUpdate),
                    "the revision must carry its own tag, not ProjectInstructions"
                ),
                other => panic!("expected a User item, got {other:?}"),
            }

            // Repeated flushes must not duplicate the revision.
            actor.flush_pending_project_instructions().await;
            actor.flush_pending_project_instructions().await;
            assert_eq!(
                actor.chat_state_handle.get_conversation_len().await,
                2,
                "later flushes must be no-ops"
            );
        })
        .await;
}

/// An empty slot is a no-op — the common case, since the flush runs at every
/// loop start and idle transition regardless of whether anything changed.
#[tokio::test]
async fn flush_without_pending_revision_is_noop() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _gateway_rx) = build_actor().await;
            assert!(actor.pending_project_instructions.lock().is_none());

            actor.flush_pending_project_instructions().await;

            assert_eq!(actor.chat_state_handle.get_conversation_len().await, 0);
        })
        .await;
}

/// Successive edits before a flush coalesce to the newest revision. Replaying
/// every intermediate state would spend context on superseded text.
#[tokio::test]
async fn queued_revisions_coalesce_to_the_newest() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _gateway_rx) = build_actor().await;

            *actor.pending_project_instructions.lock() =
                Some(ConversationItem::project_instructions_update("v2"));
            *actor.pending_project_instructions.lock() =
                Some(ConversationItem::project_instructions_update("v3"));

            actor.flush_pending_project_instructions().await;

            let conv = actor.chat_state_handle.get_conversation().await;
            assert_eq!(conv.len(), 1, "only the newest revision is appended");
            assert_eq!(conv[0].text_content(), "v3");
        })
        .await;
}

/// The real reload path, driven while a turn holds the `Ref<Agent>`, must not
/// panic — and must not lose the revision.
///
/// This is the end-to-end regression for the reported bug: editing `AGENTS.md`
/// during a turn aborted the leader (the turn died and the pager reconnected).
/// `reload_project_instructions` now publishes `prompt_context` with
/// `try_borrow_mut` and parks the files when the agent is busy.
///
/// The cwd is repointed at a tempdir holding a real `AGENTS.md` so the reload
/// reaches the `prompt_context` write — with no instructions file it returns
/// early and would not exercise the borrow at all.
#[tokio::test]
async fn reload_while_turn_holds_borrow_neither_panics_nor_loses_the_revision() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let dir = tempfile::TempDir::new().expect("tempdir");
            std::fs::write(dir.path().join("AGENTS.md"), "revised body\n")
                .expect("write AGENTS.md");

            let (mut actor, _gateway_rx) = build_actor().await;
            // Point the session at the tempdir so discovery finds the file.
            // `Arc::get_mut` succeeds here: the actor has no other owner yet.
            std::sync::Arc::get_mut(&mut actor)
                .expect("sole owner before the test starts")
                .session_info
                .cwd = dir.path().to_string_lossy().into_owned();

            // A turn in flight holds the agent borrow for its whole body.
            let turn_guard = actor.agent.borrow();

            // The reload re-reads from disk and tries to publish into
            // `prompt_context` while the turn still holds the borrow. That
            // write is what used to panic.
            let queued = actor.reload_project_instructions(dir.path()).await;

            // The borrow is still held and nothing panicked.
            assert!(
                actor.agent.try_borrow_mut().is_err(),
                "the in-flight turn must still own the borrow"
            );

            // The revision was queued for the turn boundary...
            assert!(
                queued,
                "the changed AGENTS.md must produce a revision even mid-turn"
            );
            assert!(
                actor.pending_project_instructions.lock().is_some(),
                "a queued revision must survive until the turn boundary"
            );
            // ...and the `prompt_context` write was parked, not dropped.
            assert!(
                actor.pending_agents_md_files.lock().is_some(),
                "a write that could not run must be stashed for the next boundary"
            );

            drop(turn_guard);

            // The boundary applies whatever was deferred, without panicking.
            actor.flush_pending_project_instructions().await;
            assert!(
                actor.pending_agents_md_files.lock().is_none(),
                "the flush must drain any deferred prompt_context write"
            );
            let stored = actor
                .agent
                .borrow()
                .prompt_context()
                .agents_md_files
                .clone();
            assert_eq!(
                stored.len(),
                1,
                "the deferred write must reach prompt_context at the boundary"
            );
            assert!(
                stored[0].content.contains("revised body"),
                "the boundary must publish the NEW instructions, got {:?}",
                stored[0].content
            );
        })
        .await;
}

/// A reload that lands while a turn holds the `Ref<Agent>` must NOT panic.
///
/// The regression: `reload_project_instructions` used `borrow_mut` to publish
/// the new files into `prompt_context`, but a running turn holds a `Ref<Agent>`
/// across its own awaits, so the write raised `BorrowMutError`. The crate is
/// built with `panic = "abort"`, so that aborted the leader — the user saw the
/// turn cut and the pager reconnect. A hot-reload must never be able to kill
/// the process.
///
/// Holding a `Ref` here reproduces the turn's borrow exactly: the fix defers
/// the write instead of forcing it.
#[tokio::test]
async fn reload_defers_prompt_context_write_while_agent_is_borrowed() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _gateway_rx) = build_actor().await;

            let new_files = vec![alnair_agent::prompt::agents_md::AgentConfigFile {
                file_name: "AGENTS.md".to_string(),
                file_path: "/repo/AGENTS.md".to_string(),
                content: "revised body".to_string(),
            }];

            // Emulate a turn in flight: the agent borrow is held across the
            // reload's attempt to write.
            let turn_guard = actor.agent.borrow();
            assert!(
                actor.agent.try_borrow_mut().is_err(),
                "precondition: the agent must be borrowed by the in-flight turn"
            );

            // This is the write the reload performs. It must not panic.
            match actor.agent.try_borrow_mut() {
                Ok(mut agent) => agent.replace_agents_md(new_files.clone()),
                Err(_) => *actor.pending_agents_md_files.lock() = Some(new_files.clone()),
            }

            // The deferred write is parked, not lost — the reloader dedupes on
            // content hash, so a dropped write would never be retried.
            assert!(
                actor.pending_agents_md_files.lock().is_some(),
                "a write that could not run must be stashed for the next boundary"
            );
            assert!(
                actor
                    .agent
                    .borrow()
                    .prompt_context()
                    .agents_md_files
                    .is_empty(),
                "the borrow must still be free of the write while the turn runs"
            );

            drop(turn_guard);

            // The next turn boundary applies it.
            actor.flush_pending_project_instructions().await;

            assert!(
                actor.pending_agents_md_files.lock().is_none(),
                "the flush must drain the stash"
            );
            let stored = actor
                .agent
                .borrow()
                .prompt_context()
                .agents_md_files
                .clone();
            assert_eq!(
                stored.len(),
                1,
                "the deferred write must reach prompt_context at the boundary"
            );
            assert_eq!(stored[0].content, "revised body");
        })
        .await;
}

/// The flush applies a deferred `prompt_context` write even when no conversation
/// revision is queued, so `compaction` and the permission classifier stop
/// reading the stale instructions as soon as the turn ends.
#[tokio::test]
async fn flush_applies_deferred_files_without_a_queued_revision() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _gateway_rx) = build_actor().await;
            assert!(actor.pending_project_instructions.lock().is_none());

            *actor.pending_agents_md_files.lock() =
                Some(vec![alnair_agent::prompt::agents_md::AgentConfigFile {
                    file_name: "AGENTS.md".to_string(),
                    file_path: "/repo/AGENTS.md".to_string(),
                    content: "deferred body".to_string(),
                }]);

            actor.flush_pending_project_instructions().await;

            assert!(actor.pending_agents_md_files.lock().is_none());
            let stored = actor
                .agent
                .borrow()
                .prompt_context()
                .agents_md_files
                .clone();
            assert_eq!(stored.len(), 1);
            assert_eq!(stored[0].content, "deferred body");
            // No revision was queued, so the conversation stays untouched.
            assert_eq!(actor.chat_state_handle.get_conversation_len().await, 0);
        })
        .await;
}
