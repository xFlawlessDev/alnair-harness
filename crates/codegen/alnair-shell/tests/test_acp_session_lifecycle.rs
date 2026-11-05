//! ACP v1 session-lifecycle surface: `session/list`, `session/close` and
//! `session/set_config_option`.
//!
//! These go through a real `alnair agent stdio` process rather than calling the
//! agent in-process, because what broke before was the wire contract — the
//! methods were simply absent, and `initialize` advertised capabilities the
//! agent could not serve.
//!
//! Run locally:
//! ```bash
//! cargo test -p alnair-shell --test test_acp_session_lifecycle -- --ignored
//! ```

use alnair_test_support::*;
use std::future::Future;

async fn with_local_set<F, Fut>(f: F)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ()>,
{
    tokio::task::LocalSet::new().run_until(f()).await;
}

/// A freshly created session must be discoverable through `session/list`
/// filtered to its own working directory — this is what a generic client uses
/// to find a session it was never attached to.
#[tokio::test]
#[ignore]
async fn session_list_reports_a_newly_created_session() {
    with_local_set(|| async {
        let server = MockInferenceServer::start()
            .await
            .expect("start mock server");
        let workdir = git_workdir();
        let client = AlnairStdioClient::spawn(&server, workdir.path()).await;
        client.initialize_with_timeout().await;
        let session_id = client.create_session_with_timeout(workdir.path()).await;

        let listed = client
            .list_sessions_with_timeout(Some(workdir.path()))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "session/list failed: {e:?}\nstderr:\n{}",
                    stderr_tail(&client.stderr(), 2000)
                )
            });

        let entry = listed
            .sessions
            .iter()
            .find(|s| s.session_id == session_id)
            .unwrap_or_else(|| {
                let ids: Vec<_> = listed
                    .sessions
                    .iter()
                    .map(|s| s.session_id.0.to_string())
                    .collect();
                panic!(
                    "session {} missing from session/list ({ids:?})",
                    session_id.0
                )
            });

        // Protocol fields must be usable on their own: a client that knows
        // nothing about `alnair/*` renders a row from these.
        assert!(
            entry.updated_at.is_some(),
            "session/list rows must carry updatedAt"
        );
        assert_eq!(
            entry.cwd,
            workdir.path(),
            "listed cwd must be the session's own working directory"
        );
        let meta = entry.meta.as_ref().expect("roster facts ride _meta");
        assert_eq!(
            meta.get("resident"),
            Some(&serde_json::json!(true)),
            "a session created by this agent is resident"
        );
    })
    .await;
}

/// `session/list` filtered to an unrelated directory must not leak sessions
/// from another repo — one leader serves every repository.
#[tokio::test]
#[ignore]
async fn session_list_cwd_filter_excludes_other_repositories() {
    with_local_set(|| async {
        let server = MockInferenceServer::start()
            .await
            .expect("start mock server");
        let workdir = git_workdir();
        let other = git_workdir();
        let client = AlnairStdioClient::spawn(&server, workdir.path()).await;
        client.initialize_with_timeout().await;
        let session_id = client.create_session_with_timeout(workdir.path()).await;

        let listed = client
            .list_sessions_with_timeout(Some(other.path()))
            .await
            .expect("session/list failed");
        assert!(
            listed.sessions.iter().all(|s| s.session_id != session_id),
            "session from {} leaked into a listing filtered to {}",
            workdir.path().display(),
            other.path().display()
        );
    })
    .await;
}

/// Closing a session releases the agent-side actor, and the transcript stays
/// loadable: close is not delete.
///
/// Deliberately no prompt. On this machine the spawned agent resolves the
/// bundled catalog's default model and any turn leaves for the real endpoint
/// (the pre-existing lifecycle tests fail the same way), so a turn here would
/// test the network, not `session/close`. The session is still persisted by
/// `session/new`, which is all this contract needs.
#[tokio::test]
#[ignore]
async fn session_close_releases_the_actor_but_keeps_the_transcript() {
    with_local_set(|| async {
        let server = MockInferenceServer::start()
            .await
            .expect("start mock server");
        let workdir = git_workdir();
        let client = AlnairStdioClient::spawn(&server, workdir.path()).await;
        client.initialize_with_timeout().await;
        let session_id = client.create_session_with_timeout(workdir.path()).await;

        client
            .close_session_with_timeout(&session_id)
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "session/close failed: {e:?}\nstderr:\n{}",
                    stderr_tail(&client.stderr(), 2000)
                )
            });

        let after = client
            .list_sessions_with_timeout(Some(workdir.path()))
            .await
            .expect("session/list failed after close");
        let entry = after
            .sessions
            .iter()
            .find(|s| s.session_id == session_id)
            .expect("a closed session keeps its on-disk row");
        let meta = entry.meta.as_ref().expect("roster facts ride _meta");
        assert_eq!(
            meta.get("resident"),
            Some(&serde_json::json!(false)),
            "a closed session must no longer be resident, but must still be listed"
        );

        // The transcript survived: it reloads with its history intact.
        let loaded = client
            .load_session_with_timeout(&session_id, workdir.path())
            .await;
        assert!(
            loaded.meta.is_some(),
            "session/load after close must succeed with session metadata"
        );

        // Closing again is a no-op, not an error: a client retrying after a
        // reconnect must not be punished.
        client
            .close_session_with_timeout(&session_id)
            .await
            .expect("session/close must be idempotent");
    })
    .await;
}

/// Closing an id this agent never hosted succeeds rather than erroring, so a
/// reconnecting client can close unconditionally.
#[tokio::test]
#[ignore]
async fn session_close_of_an_unknown_id_is_a_no_op() {
    with_local_set(|| async {
        let server = MockInferenceServer::start()
            .await
            .expect("start mock server");
        let workdir = git_workdir();
        let client = AlnairStdioClient::spawn(&server, workdir.path()).await;
        client.initialize_with_timeout().await;

        let unknown = agent_client_protocol::SessionId::new(
            "00000000-0000-4000-8000-000000000000".to_string(),
        );
        client
            .close_session_with_timeout(&unknown)
            .await
            .expect("closing an unhosted session must succeed");
    })
    .await;
}

/// An unknown config option id is answered as not-found rather than accepted,
/// so a client learns it guessed a method the agent never registered.
#[tokio::test]
#[ignore]
async fn unknown_config_option_is_rejected() {
    with_local_set(|| async {
        let server = MockInferenceServer::start()
            .await
            .expect("start mock server");
        let workdir = git_workdir();
        let client = AlnairStdioClient::spawn(&server, workdir.path()).await;
        client.initialize_with_timeout().await;
        let session_id = client.create_session_with_timeout(workdir.path()).await;

        let result = client
            .set_config_option_with_timeout(&session_id, "not_a_real_option", "high")
            .await;
        assert!(
            result.is_err(),
            "an unregistered config option must fail, not silently succeed"
        );
    })
    .await;
}
