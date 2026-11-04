//! Pager-facing codebase-index status.
//!
//! The tool backend reports state transitions on a channel it owns
//! ([`CodebaseBackendImpl::with_status_sink`]); this module drains that channel
//! and puts each change on the wire as
//! [`SessionUpdate::CodebaseIndexUpdated`].
//!
//! The channel exists so `alnair-workspace` — which owns the index — does not
//! have to know the shell's notification vocabulary. It also keeps the
//! reporting *edge-triggered*: a transition is sent when it happens, not on a
//! timer, because the pager is drawing a report ("is the index usable, and how
//! big is it?") rather than a spinner.
//!
//! [`CodebaseBackendImpl::with_status_sink`]:
//! alnair_workspace::file_system::CodebaseBackendImpl::with_status_sink

use alnair_tools::types::codebase_backend::CodebaseStatus;

use crate::extensions::notification::SessionUpdate;
use crate::session::acp_session::SessionActor;

/// Wire `state` for a status the backend just reported.
///
/// Three states, matching what the chip can usefully say:
///
/// - `ready` — the index can answer. Counts are meaningful.
/// - `building` — the actor is starting and cannot answer yet. This is the
///   zero-file shape, which is why `files` and `indexed` are both checked:
///   a ready index over an empty repository is a legitimate `ready` with zero
///   files, and conflating the two would make the chip say "indexing…" forever
///   on an empty repo.
/// - `unavailable` — the actor answered with nothing, so it is not coming up.
fn state_for(status: &CodebaseStatus) -> &'static str {
    if status.indexed {
        "ready"
    } else if status.files == 0 && status.definitions == 0 {
        "building"
    } else {
        "unavailable"
    }
}

/// Build the pager-facing notification for one status report.
pub(crate) fn build_codebase_index_updated(status: &CodebaseStatus) -> SessionUpdate {
    let state = state_for(status);
    SessionUpdate::CodebaseIndexUpdated {
        state: state.to_owned(),
        files: status.files as u32,
        definitions: status.definitions as u32,
        languages: status.languages.clone(),
        reason: (state == "unavailable").then(|| "index_unavailable".to_owned()),
    }
}

/// Build the tombstone that tells the pager to drop its chip.
///
/// Used when the index is not offered at all (`codebase_indexing = false`, or
/// the workspace is not a git repository), so a session that never had a chip
/// does not acquire a permanent "off" marker either.
pub(crate) fn build_codebase_index_cleared() -> SessionUpdate {
    SessionUpdate::CodebaseIndexUpdated {
        state: "cleared".to_owned(),
        files: 0,
        definitions: 0,
        languages: Vec::new(),
        reason: None,
    }
}

impl SessionActor {
    /// Drain the backend's status channel for the lifetime of the session,
    /// forwarding each transition to the pager.
    ///
    /// Spawned once at spawn time. Returns immediately; the task exits when the
    /// sender is dropped (the backend is dropped with the agent).
    pub(crate) fn spawn_codebase_status_reporter(
        self: &std::sync::Arc<Self>,
        mut rx: tokio::sync::mpsc::UnboundedReceiver<CodebaseStatus>,
    ) {
        let session = std::sync::Arc::downgrade(self);
        tokio::task::spawn_local(async move {
            while let Some(status) = rx.recv().await {
                let Some(session) = session.upgrade() else {
                    break;
                };
                session
                    .send_xai_notification(build_codebase_index_updated(&status))
                    .await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(indexed: bool, files: usize, definitions: usize) -> CodebaseStatus {
        CodebaseStatus {
            indexed,
            files,
            definitions,
            references: 0,
            languages: vec!["rust".into()],
        }
    }

    #[test]
    fn a_started_index_is_ready_with_its_counts() {
        let update = build_codebase_index_updated(&status(true, 2_237, 95_768));
        match update {
            SessionUpdate::CodebaseIndexUpdated {
                state,
                files,
                definitions,
                languages,
                reason,
            } => {
                assert_eq!(state, "ready");
                assert_eq!(files, 2_237);
                assert_eq!(definitions, 95_768);
                assert_eq!(languages, vec!["rust".to_string()]);
                assert!(reason.is_none(), "a ready index has nothing to explain");
            }
            other => panic!("expected CodebaseIndexUpdated, got {other:?}"),
        }
    }

    /// The zero-file shape is `building`, not `ready`: this is the report sent
    /// before the actor has answered.
    #[test]
    fn a_not_yet_indexed_status_is_building() {
        let update = build_codebase_index_updated(&status(false, 0, 0));
        match update {
            SessionUpdate::CodebaseIndexUpdated { state, files, .. } => {
                assert_eq!(state, "building");
                assert_eq!(files, 0);
            }
            other => panic!("expected CodebaseIndexUpdated, got {other:?}"),
        }
    }

    /// An empty repository still reaches `ready`; the distinction from
    /// `building` is `indexed`, not the file count. Without this an empty repo
    /// would show "indexing…" forever.
    #[test]
    fn an_empty_but_indexed_repository_is_ready() {
        let update = build_codebase_index_updated(&status(true, 0, 0));
        match update {
            SessionUpdate::CodebaseIndexUpdated { state, .. } => assert_eq!(state, "ready"),
            other => panic!("expected CodebaseIndexUpdated, got {other:?}"),
        }
    }

    /// An index that is neither indexed nor empty cannot have been built: the
    /// actor answered with nothing, so the chip must say so rather than spin.
    #[test]
    fn an_answered_empty_index_is_unavailable() {
        let update = build_codebase_index_updated(&status(false, 12, 40));
        match update {
            SessionUpdate::CodebaseIndexUpdated { state, reason, .. } => {
                assert_eq!(state, "unavailable");
                assert!(reason.is_some(), "an unavailable index must explain itself");
            }
            other => panic!("expected CodebaseIndexUpdated, got {other:?}"),
        }
    }

    #[test]
    fn the_cleared_tombstone_carries_no_counts() {
        match build_codebase_index_cleared() {
            SessionUpdate::CodebaseIndexUpdated {
                state,
                files,
                definitions,
                languages,
                reason,
            } => {
                assert_eq!(state, "cleared");
                assert_eq!(files, 0);
                assert_eq!(definitions, 0);
                assert!(languages.is_empty());
                assert!(reason.is_none());
            }
            other => panic!("expected CodebaseIndexUpdated, got {other:?}"),
        }
    }
}
