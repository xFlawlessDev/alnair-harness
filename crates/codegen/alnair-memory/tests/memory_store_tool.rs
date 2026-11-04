//! End-to-end tests for `memory_store`: registry finalize → `Resources` →
//! tool dispatch → durable file → a *different* backend retrieving the note.
//!
//! Every other memory test calls `MemoryBackendImpl` directly. That leaves the
//! one seam `memory_store` actually depends on untested: pulling
//! `Arc<dyn MemoryWriteBackend>` out of `Resources`. If `finalize` forgets to
//! insert it, the tool answers "Memory is not enabled" no matter how correct
//! the backend is — a silent failure no unit test would catch.
//!
//! These live in `alnair-memory` rather than `alnair-tools` because the real
//! backend (and SQLite) is needed to prove the note survives the round trip;
//! `alnair-tools` deliberately does not depend on this crate.

use std::sync::Arc;

use alnair_memory::{
    EndpointScopedCredentials, MemoryBackendImpl, MemoryBackendParams, MemoryStorage,
};
use alnair_tools::bridge::ToolBridge;
use alnair_tools::registry::types::{SessionContext, ToolConfig, ToolServerConfig};
use alnair_tools::types::memory_backend::{MemoryBackend, MemoryWriteBackend};
use tempfile::TempDir;

fn storage_for(tmp: &TempDir) -> MemoryStorage {
    let global = tmp.path().join("memory");
    let workspace = global.join("test_ws");
    MemoryStorage::with_paths(global, workspace)
}

fn params_for(session_id: &str) -> MemoryBackendParams {
    MemoryBackendParams {
        session_id: session_id.to_string(),
        embed_config: None,
        embed_base_url: String::new(),
        embed_api_key: None,
        search_config: alnair_config_types::MemorySearchConfig::default(),
        watcher: None,
        stale_claim_secs: 60,
        search_source: "tool",
        embedding_credentials: EndpointScopedCredentials::none(),
    }
}

/// A session context wired the way the shell wires it, with both memory halves
/// pointing at one concrete backend.
fn context_with_memory(
    tmp: &TempDir,
    read: Option<Arc<dyn MemoryBackend>>,
    write: Option<Arc<dyn MemoryWriteBackend>>,
) -> SessionContext {
    SessionContext {
        backend: Arc::new(alnair_tools::computer::local::LocalTerminalBackend::new()),
        fs: Arc::new(alnair_tools::computer::local::LocalFs),
        cwd: tmp.path().to_path_buf(),
        session_folder: tmp.path().join("session"),
        session_env: Arc::new(std::collections::HashMap::new()),
        notification_handle: alnair_tools::notification::ToolNotificationHandle::noop(),
        owner_session_id: None,
        parent_scheduler_handle: None,
        skills: vec![],
        state_path: tmp.path().join("state.json"),
        memory_backend: read,
        memory_write_backend: write,
        web_search_config: alnair_tools::implementations::web_search::WebSearchConfig::default(),
        web_fetch_config: alnair_tools::implementations::alnair::web_fetch::WebFetchConfig::default(
        ),
        web_target: None,
        lsp: None,
        app_builder_deployer_config:
            alnair_tools::implementations::alnair::deploy_app::AppBuilderDeployerConfig::default(),
        api_key_provider: None,
        attribution_callback: None,
        system_reminder_tag: alnair_tools::reminders::DEFAULT_REMINDER_TAG,
    }
}

/// Build a bridge exposing exactly one tool, so the assertion cannot be
/// satisfied by some other tool's output.
///
/// The bridge — not the raw toolset — is what the shell toggles: its methods
/// delegate to the same `Arc<FinalizedToolset>` it hands out via `toolset()`.
async fn bridge_with(ctx: SessionContext, tool_id: &str) -> ToolBridge {
    let config = ToolServerConfig {
        tools: vec![ToolConfig {
            id: tool_id.to_string(),
            params: None,
            name_override: None,
            params_name_overrides: None,
            description_override: None,
            behavior_version: None,
            kind: None,
        }],
        behavior_preset: None,
    };
    ToolBridge::finalize_builder(ToolBridge::get_builder(), config, ctx)
        .await
        .expect("finalize must succeed")
}

fn text_of(result: &alnair_tools::types::output::ToolRunResult) -> String {
    result.prompt_text.clone()
}

/// The full journey: the model calls `memory_store` through the registry, the
/// note lands in the workspace `MEMORY.md`, and a *second* session's backend
/// finds it with `memory_search`. This is the only test that exercises the
/// registry seam, the real filesystem and the real SQLite index together.
#[tokio::test]
async fn store_through_registry_is_retrievable_by_a_later_session() {
    let tmp = TempDir::new().unwrap();
    alnair_memory::init_sqlite_vec();
    let storage = storage_for(&tmp);
    let backend = Arc::new(MemoryBackendImpl::from_session_params(
        storage.clone(),
        &params_for("writer"),
    ));

    let read: Arc<dyn MemoryBackend> = backend.clone();
    let write: Arc<dyn MemoryWriteBackend> = backend;
    let bridge = bridge_with(
        context_with_memory(&tmp, Some(read), Some(write)),
        "Alnair:memory_store",
    )
    .await;

    let result = bridge
        .toolset()
        .call(
            "memory_store",
            serde_json::json!({
                "content": "Gotcha: dirs::home_dir ignores HOME on Windows"
            }),
            "call-1",
            None,
        )
        .await
        .expect("memory_store must not fail");
    let text = text_of(&result);
    assert!(
        text.contains("Stored"),
        "the tool must confirm the write, got: {text}"
    );
    assert!(
        !text.contains("Memory is not enabled"),
        "the backend was not reachable through Resources: {text}"
    );

    // The file is the durable artifact.
    let written = std::fs::read_to_string(storage.workspace_memory_file()).unwrap();
    assert!(
        written.contains("home_dir"),
        "note missing from MEMORY.md: {written}"
    );

    // A later session opens the same directory and must find it.
    let later = MemoryBackendImpl::from_session_params(storage, &params_for("reader"));
    let hits = later.search("dirs home_dir Windows", 5, 0.0).await.unwrap();
    assert!(
        !hits.is_empty(),
        "a later session must retrieve a note written through the tool"
    );
}

/// Without a write backend the tool must answer its actionable "not enabled"
/// message rather than panicking or silently succeeding. This is the state a
/// session is in when memory is off, or when only the read half is wired.
#[tokio::test]
async fn store_without_a_write_backend_reports_memory_disabled() {
    let tmp = TempDir::new().unwrap();
    alnair_memory::init_sqlite_vec();
    let bridge = bridge_with(context_with_memory(&tmp, None, None), "Alnair:memory_store").await;

    let result = bridge
        .toolset()
        .call(
            "memory_store",
            serde_json::json!({ "content": "a note" }),
            "call-1",
            None,
        )
        .await
        .expect("the tool must answer, not error");
    let text = text_of(&result);
    assert!(
        text.contains("not enabled"),
        "expected the actionable 'not enabled' message, got: {text}"
    );
    // It must say how to fix it.
    assert!(
        text.contains("ALNAIR_MEMORY") || text.contains("[memory]"),
        "the message must say how to enable memory, got: {text}"
    );
}

/// The tool layer refuses before touching disk, so a rejected note leaves no
/// trace. Driven through the registry because that is where the model's call
/// actually arrives.
#[tokio::test]
async fn store_rejects_a_secret_without_writing_anything() {
    let tmp = TempDir::new().unwrap();
    alnair_memory::init_sqlite_vec();
    let storage = storage_for(&tmp);
    let backend = Arc::new(MemoryBackendImpl::from_session_params(
        storage.clone(),
        &params_for("writer"),
    ));
    let read: Arc<dyn MemoryBackend> = backend.clone();
    let write: Arc<dyn MemoryWriteBackend> = backend;
    let bridge = bridge_with(
        context_with_memory(&tmp, Some(read), Some(write)),
        "Alnair:memory_store",
    )
    .await;

    let secret = "ghp_1234567890abcdefghijABCDEFGHIJ012345";
    let result = bridge
        .toolset()
        .call(
            "memory_store",
            serde_json::json!({ "content": format!("token is {secret}") }),
            "call-1",
            None,
        )
        .await
        .expect("the tool must answer, not error");
    let text = text_of(&result);

    assert!(text.contains("refused"), "expected a refusal, got: {text}");
    assert!(
        !text.contains(secret),
        "the refusal leaked the secret: {text}"
    );
    assert!(
        !storage.workspace_memory_file().exists(),
        "a refused note must not create the file"
    );
}

/// An unknown scope is rejected rather than defaulted: silently writing to the
/// wrong file is unrecoverable for the user.
#[tokio::test]
async fn store_rejects_an_unknown_scope() {
    let tmp = TempDir::new().unwrap();
    alnair_memory::init_sqlite_vec();
    let storage = storage_for(&tmp);
    let backend = Arc::new(MemoryBackendImpl::from_session_params(
        storage.clone(),
        &params_for("writer"),
    ));
    let read: Arc<dyn MemoryBackend> = backend.clone();
    let write: Arc<dyn MemoryWriteBackend> = backend;
    let bridge = bridge_with(
        context_with_memory(&tmp, Some(read), Some(write)),
        "Alnair:memory_store",
    )
    .await;

    let result = bridge
        .toolset()
        .call(
            "memory_store",
            serde_json::json!({ "content": "a note", "scope": "project" }),
            "call-1",
            None,
        )
        .await
        .expect("the tool must answer, not error");
    let text = text_of(&result);
    assert!(
        text.contains("unknown scope"),
        "expected an unknown-scope refusal, got: {text}"
    );
    assert!(
        !storage.workspace_memory_file().exists(),
        "nothing must be written for an unknown scope"
    );
}

// ---------------------------------------------------------------------------
// The `/memory on|off` toggle path
// ---------------------------------------------------------------------------
//
// `/memory on|off` registers and unregisters the three memory tools at runtime
// through the bridge, a *second* surface beside the declarative push in
// `AgentBuilder`. Only the declarative one is covered elsewhere, and that is the
// combination that fails quietly: the tool is present at spawn, then vanishes
// for good after one toggle.

/// Mirrors `SessionActor::register_memory_tools`: the same three tools, the same
/// names, registered the same way. If that method gains or loses a tool, this
/// helper must follow — the point is to pin the *set* the toggle installs.
async fn register_memory_tools_like_the_shell(bridge: &ToolBridge) {
    use alnair_tools::implementations::memory::{
        MEMORY_GET_TOOL_NAME, MEMORY_SEARCH_TOOL_NAME, MEMORY_STORE_TOOL_NAME,
    };
    bridge
        .register_mcp_tools(
            MEMORY_SEARCH_TOOL_NAME.to_owned(),
            alnair_tools::implementations::memory::search_tool::MemorySearchImpl,
            None,
        )
        .await
        .expect("register memory_search");
    bridge
        .register_mcp_tools(
            MEMORY_GET_TOOL_NAME.to_owned(),
            alnair_tools::implementations::memory::get_tool::MemoryGetImpl,
            None,
        )
        .await
        .expect("register memory_get");
    bridge
        .register_mcp_tools(
            MEMORY_STORE_TOOL_NAME.to_owned(),
            alnair_tools::implementations::memory::store_tool::MemoryStoreImpl,
            None,
        )
        .await
        .expect("register memory_store");
}

fn memory_tool_names(toolset: &alnair_tools::registry::types::FinalizedToolset) -> Vec<String> {
    let mut names: Vec<String> = toolset
        .tool_definitions()
        .into_iter()
        .map(|d| d.function.name)
        .filter(|n| n.starts_with("memory_"))
        .collect();
    names.sort();
    names
}

/// `/memory off` must remove all three, including `memory_store`. Leaving the
/// write tool behind after the user disabled memory would let the model keep
/// writing to a store it was told is off.
#[tokio::test]
async fn toggling_memory_off_removes_all_three_tools() {
    let tmp = TempDir::new().unwrap();
    alnair_memory::init_sqlite_vec();
    let storage = storage_for(&tmp);
    let backend = Arc::new(MemoryBackendImpl::from_session_params(
        storage.clone(),
        &params_for("toggle"),
    ));
    let read: Arc<dyn MemoryBackend> = backend.clone();
    let write: Arc<dyn MemoryWriteBackend> = backend;

    // Start from a set with no memory tools, the state of a session spawned with
    // memory off.
    let bridge = bridge_with(
        context_with_memory(&tmp, Some(read), Some(write)),
        "Alnair:read_file",
    )
    .await;
    assert!(
        memory_tool_names(&bridge.toolset()).is_empty(),
        "precondition: a session spawned without memory tools has none"
    );

    // `/memory on`
    register_memory_tools_like_the_shell(&bridge).await;
    assert_eq!(
        memory_tool_names(&bridge.toolset()),
        vec!["memory_get", "memory_search", "memory_store"],
        "the toggle must install exactly the three memory tools"
    );

    // `/memory off`
    for name in ["memory_search", "memory_get", "memory_store"] {
        assert!(
            bridge.unregister_tool_by_name(name),
            "{name} must have been registered, so removing it must report success"
        );
    }
    assert!(
        memory_tool_names(&bridge.toolset()).is_empty(),
        "`/memory off` must leave no memory tool behind"
    );
}

/// A full on → off → on cycle must land on exactly the same set as the first
/// `on`. A registration path that leaks state (a stale entry, a duplicate) shows
/// up here and nowhere else.
#[tokio::test]
async fn an_on_off_on_cycle_restores_the_same_tool_set() {
    let tmp = TempDir::new().unwrap();
    alnair_memory::init_sqlite_vec();
    let storage = storage_for(&tmp);
    let backend = Arc::new(MemoryBackendImpl::from_session_params(
        storage.clone(),
        &params_for("toggle-cycle"),
    ));
    let read: Arc<dyn MemoryBackend> = backend.clone();
    let write: Arc<dyn MemoryWriteBackend> = backend;
    let bridge = bridge_with(
        context_with_memory(&tmp, Some(read), Some(write)),
        "Alnair:read_file",
    )
    .await;

    register_memory_tools_like_the_shell(&bridge).await;
    let first = memory_tool_names(&bridge.toolset());

    for name in ["memory_search", "memory_get", "memory_store"] {
        assert!(bridge.unregister_tool_by_name(name));
    }
    assert!(memory_tool_names(&bridge.toolset()).is_empty());

    register_memory_tools_like_the_shell(&bridge).await;
    assert_eq!(
        memory_tool_names(&bridge.toolset()),
        first,
        "a second `/memory on` must restore the exact set the first one installed"
    );
}

/// After `/memory on`, the write tool must actually work — not just appear. A
/// registration that forgets to insert the write backend into `Resources` would
/// pass a names-only assertion and fail here.
#[tokio::test]
async fn after_memory_is_enabled_the_write_tool_works() {
    let tmp = TempDir::new().unwrap();
    alnair_memory::init_sqlite_vec();
    let storage = storage_for(&tmp);
    let backend = Arc::new(MemoryBackendImpl::from_session_params(
        storage.clone(),
        &params_for("toggle-write"),
    ));
    let read: Arc<dyn MemoryBackend> = backend.clone();
    let write: Arc<dyn MemoryWriteBackend> = backend;
    let bridge = bridge_with(
        context_with_memory(&tmp, Some(read), Some(write)),
        "Alnair:read_file",
    )
    .await;

    register_memory_tools_like_the_shell(&bridge).await;
    let result = bridge
        .toolset()
        .call(
            "memory_store",
            serde_json::json!({ "content": "Recorded after /memory on" }),
            "call-1",
            None,
        )
        .await
        .expect("memory_store must run after the toggle");
    assert!(
        text_of(&result).contains("Stored"),
        "the tool must write after /memory on, got: {}",
        text_of(&result)
    );
    assert!(
        std::fs::read_to_string(storage.workspace_memory_file())
            .unwrap_or_default()
            .contains("Recorded after /memory on"),
        "the note must reach MEMORY.md"
    );
}
