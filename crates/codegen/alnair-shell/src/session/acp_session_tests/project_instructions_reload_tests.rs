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
