//! End-to-end coverage for the structural code-search tools.
//!
//! Everything here goes through `ToolBridge` + the real registry, so it exercises
//! the same path a model's tool call takes: resource injection, the tool's own
//! argument handling, the backend adapter, and the real `IndexManager` actor
//! over a real directory. A unit test of `search_symbols` would not catch a
//! missing `Resources` insert, which is the failure mode that makes a tool
//! report "not available" for a whole session.

use std::path::Path;
use std::sync::Arc;

use alnair_tools::bridge::ToolBridge;
use alnair_tools::registry::types::{SessionContext, ToolServerConfig};
use alnair_tools::types::codebase_backend::CodebaseBackend;
use alnair_workspace::file_system::{CodebaseBackendImpl, CodebaseIndexManager};
use tempfile::TempDir;

/// Write a file, creating parent directories.
fn write(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

/// A bridge whose resources carry `backend`, exposing exactly the two codebase
/// tools.
///
/// The tool list is explicit, mirroring what `AgentBuilder` produces when a
/// backend is present — so a tool missing from `ToolRegistryBuilder::register_all`
/// fails here rather than silently vanishing from a real session.
async fn bridge_with(tmp: &TempDir, backend: Option<Arc<dyn CodebaseBackend>>) -> ToolBridge {
    let ctx = SessionContext {
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
        memory_backend: None,
        memory_write_backend: None,
        codebase_backend: backend,
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
    };

    use alnair_tools::implementations::codebase::{
        CODEBASE_CONTEXT_TOOL_NAME, CODEBASE_SEARCH_TOOL_NAME,
    };
    let config = ToolServerConfig {
        tools: [
            ("Alnair", CODEBASE_SEARCH_TOOL_NAME),
            ("Alnair", CODEBASE_CONTEXT_TOOL_NAME),
        ]
        .into_iter()
        .map(
            |(namespace, name)| alnair_tools::registry::types::ToolConfig {
                id: format!("{namespace}:{name}"),
                params: None,
                name_override: None,
                params_name_overrides: None,
                description_override: None,
                behavior_version: None,
                kind: None,
            },
        )
        .collect(),
        behavior_preset: None,
    };

    ToolBridge::finalize_builder(ToolBridge::get_builder(), config, ctx)
        .await
        .expect("bridge finalizes")
}

/// Call a tool by its registered name and return its prompt text.
async fn call(bridge: &ToolBridge, name: &str, args: serde_json::Value) -> String {
    let toolset = bridge.toolset();
    let model_name = toolset
        .tool_name_for_kind(kind_for(name))
        .unwrap_or_else(|| panic!("{name} must be registered"));
    toolset
        .call(&model_name, args, "call-1", None)
        .await
        .unwrap_or_else(|error| panic!("{name} failed: {error}"))
        .prompt_text
}

fn kind_for(name: &str) -> alnair_tools::types::tool::ToolKind {
    match name {
        "codebase_search" => alnair_tools::types::tool::ToolKind::CodebaseSearch,
        "codebase_context" => alnair_tools::types::tool::ToolKind::CodebaseContext,
        other => panic!("unknown tool {other}"),
    }
}

/// Build a backend over a repository-shaped tempdir.
fn backend_over(root: &Path) -> Arc<dyn CodebaseBackend> {
    let manager = Arc::new(parking_lot::Mutex::new(CodebaseIndexManager::new()));
    Arc::new(CodebaseBackendImpl::new(manager, root.to_path_buf())) as Arc<dyn CodebaseBackend>
}

fn fixture() -> TempDir {
    let dir = TempDir::new().unwrap();
    write(
        dir.path(),
        "src/lib.rs",
        "pub fn render_tab_strip() {}\n\npub fn render_sidebar() {}\n",
    );
    write(
        dir.path(),
        "src/deep/nested/inner.rs",
        "pub fn render_tab_strip_inner() {}\n",
    );
    write(
        dir.path(),
        "tests/it.rs",
        "fn render_tab_strip_test() { render_tab_strip(); }\n",
    );
    dir
}

#[tokio::test(flavor = "current_thread")]
async fn a_search_finds_a_symbol_and_reports_where_it_is_declared() {
    let tmp = fixture();
    let bridge = bridge_with(&tmp, Some(backend_over(tmp.path()))).await;

    let text = call(
        &bridge,
        "codebase_search",
        serde_json::json!({ "query": "render_tab_strip" }),
    )
    .await;

    assert!(
        text.contains("### `render_tab_strip`"),
        "the exact symbol must be reported: {text}"
    );
    // Relative paths, because that is what the model can join with the root it
    // already knows.
    assert!(
        text.contains("src/lib.rs:"),
        "the definition path must be relative: {text}"
    );
    assert!(
        text.contains("(definition)"),
        "the hit must be labelled as a declaration: {text}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_search_finds_the_whole_family_and_ranks_the_exact_name_first() {
    let tmp = fixture();
    let bridge = bridge_with(&tmp, Some(backend_over(tmp.path()))).await;

    let text = call(
        &bridge,
        "codebase_search",
        serde_json::json!({ "query": "render_tab_strip" }),
    )
    .await;

    // The fragment must reach the prefixed and suffixed helpers.
    assert!(text.contains("### `render_tab_strip_inner`"), "{text}");
    assert!(text.contains("### `render_tab_strip_test`"), "{text}");

    // And the exact name must come before its longer relatives.
    let exact = text.find("### `render_tab_strip`").unwrap();
    let inner = text.find("### `render_tab_strip_inner`").unwrap();
    assert!(
        exact < inner,
        "the exact match must be listed first: {text}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_path_prefix_restricts_the_answer() {
    let tmp = fixture();
    let bridge = bridge_with(&tmp, Some(backend_over(tmp.path()))).await;

    let text = call(
        &bridge,
        "codebase_search",
        serde_json::json!({ "query": "render_tab_strip", "path_prefix": "tests/" }),
    )
    .await;

    assert!(text.contains("render_tab_strip_test"), "{text}");
    assert!(
        !text.contains("src/lib.rs:"),
        "the prefix must exclude src/: {text}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_query_that_matches_nothing_names_what_was_indexed() {
    let tmp = fixture();
    let bridge = bridge_with(&tmp, Some(backend_over(tmp.path()))).await;

    let text = call(
        &bridge,
        "codebase_search",
        serde_json::json!({ "query": "definitely_not_a_symbol" }),
    )
    .await;

    assert!(text.contains("No symbol matching"), "{text}");
    assert!(
        text.contains("rust"),
        "the covered languages must be named: {text}"
    );
    assert!(
        text.contains("grep"),
        "the answer must offer the text-search fallback: {text}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn an_empty_query_is_refused_rather_than_matching_everything() {
    let tmp = fixture();
    let bridge = bridge_with(&tmp, Some(backend_over(tmp.path()))).await;

    let text = call(
        &bridge,
        "codebase_search",
        serde_json::json!({ "query": "   " }),
    )
    .await;

    assert!(text.contains("refused"), "{text}");
    assert!(
        !text.contains("hit(s)"),
        "an empty query must not return the whole repository: {text}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_context_read_returns_the_window_around_a_line() {
    let tmp = fixture();
    let bridge = bridge_with(&tmp, Some(backend_over(tmp.path()))).await;

    let text = call(
        &bridge,
        "codebase_context",
        serde_json::json!({ "path": "src/lib.rs", "line": 1, "lines": 1 }),
    )
    .await;

    assert!(text.contains("src/lib.rs:1-1"), "{text}");
    assert!(
        text.contains("pub fn render_tab_strip()"),
        "the requested line must be returned: {text}"
    );
    assert!(
        !text.contains("render_sidebar"),
        "a 1-line window must not spill into the next symbol: {text}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_context_read_redacts_a_credential_line() {
    let tmp = TempDir::new().unwrap();
    write(
        tmp.path(),
        "src/config.rs",
        "pub const SAFE: &str = \"x\";\n// DB_PASSWORD=hunter2hunter2hunter2\n",
    );
    let bridge = bridge_with(&tmp, Some(backend_over(tmp.path()))).await;

    let text = call(
        &bridge,
        "codebase_context",
        serde_json::json!({ "path": "src/config.rs", "line": 1, "lines": 10 }),
    )
    .await;

    assert!(
        !text.contains("hunter2"),
        "the value must not appear: {text}"
    );
    assert!(
        text.contains("redacted"),
        "the gap must be labelled, not silent: {text}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_context_read_outside_the_root_is_refused() {
    let tmp = fixture();
    let bridge = bridge_with(&tmp, Some(backend_over(tmp.path()))).await;

    let text = call(
        &bridge,
        "codebase_context",
        serde_json::json!({ "path": "../../etc/passwd" }),
    )
    .await;

    // The tool renders a read failure rather than leaking an error type.
    assert!(
        text.contains("Could not read") || text.contains("outside"),
        "an escaping path must not be read: {text}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn without_a_backend_the_tools_say_so_and_point_at_grep() {
    let tmp = fixture();
    let bridge = bridge_with(&tmp, None).await;

    let search = call(
        &bridge,
        "codebase_search",
        serde_json::json!({ "query": "render_tab_strip" }),
    )
    .await;
    assert!(search.contains("not available"), "{search}");
    assert!(search.contains("grep"), "{search}");

    let context = call(
        &bridge,
        "codebase_context",
        serde_json::json!({ "path": "src/lib.rs" }),
    )
    .await;
    assert!(context.contains("not available"), "{context}");
    assert!(context.contains("read_file"), "{context}");
}

/// The index must survive across calls in one session: the second search must
/// not pay for a second build.
#[tokio::test(flavor = "current_thread")]
async fn the_second_search_reuses_the_index() {
    let tmp = fixture();
    let backend = backend_over(tmp.path());

    let first = backend.ensure().await.expect("the index starts");
    assert!(first.indexed);
    assert!(first.files >= 3, "every fixture file must be indexed");

    let second = backend.ensure().await.expect("the index is still there");
    assert_eq!(first.files, second.files);

    // The backend holds the only strong `Arc` on the actor across both calls;
    // a reaped index would report zero files here.
    assert!(
        second.definitions > 0,
        "the index must still hold definitions: {second:?}"
    );
}
