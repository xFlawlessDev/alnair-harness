//! Shared test utilities for the pager crate.
//!
//! Compiled only in `#[cfg(test)]` builds. Import via `crate::test_util`.
/// Minimal `AgentView` for unit tests outside the dispatch/handler modules
/// (which keep their own richer factories).
pub fn make_agent_view(session_id: Option<&str>, cwd: &str) -> crate::app::agent_view::AgentView {
    use crate::app::agent::{AgentId, AgentSession, AgentState};
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let session = AgentSession {
        id: AgentId(0),
        acp_tx: tx,
        session_id: session_id.map(agent_client_protocol::SessionId::new),
        models: crate::acp::model_state::ModelState::default(),
        state: AgentState::Idle,
        tracker: crate::acp::tracker::AcpUpdateTracker::new(),
        cwd: std::path::PathBuf::from(cwd),
        is_worktree: false,
        forked_from: None,
        pending_prompts: std::collections::VecDeque::new(),
        next_queue_id: 0,
        yolo_mode: false,
        auto_mode: false,
        prompt_history: Vec::new(),
        prompt_history_loading: false,
        loading_replay: false,
        restore_degree: None,
        rate_limited: false,
        model_incompatible: false,
        available_commands: Vec::new(),
        available_commands_generation: 0,
        available_tools: None,
        model_switch_pending: false,
        user_model_preference: None,
        deferred_model_switch: None,
        bg_tasks: std::collections::BTreeMap::new(),
        bg_tool_call_to_task: std::collections::HashMap::new(),
        scheduled_tasks: std::collections::HashMap::new(),
        in_flight_prompt: None,
        current_prompt_id: None,
        created_via_new: false,
    };
    crate::app::agent_view::AgentView::new(
        session,
        crate::scrollback::state::ScrollbackState::new(),
    )
}
/// RAII guard for temporarily overriding an environment variable.
///
/// Captures the original value on construction and restores it on drop.
/// Used by theme and persist tests to redirect `HOME`/`USERPROFILE` to
/// temp directories without affecting the real user config.
pub struct EnvVarGuard {
    key: &'static str,
    original: Option<std::ffi::OsString>,
}
impl EnvVarGuard {
    /// Override `key` to `value` (paths, URLs, flags — anything OsStr-able),
    /// returning a guard that restores the original on drop.
    pub fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let original = std::env::var_os(key);
        // SAFETY: single-threaded test execution for this guard's callers;
        // no concurrent env access races with the mutation.
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, original }
    }
}
impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        // SAFETY: single-threaded test execution; see `set` above.
        unsafe {
            if let Some(value) = &self.original {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
}

/// Rewrite a POSIX-style path literal into this host's native separators.
///
/// The product deliberately renders paths with the OS separator (a Windows
/// user expects `src\main.rs`), so assertions written against `src/main.rs`
/// only hold on Unix. Tests that care about the *shape* of a header — not the
/// separator policy — build the expected string through this helper so the
/// same assertion is meaningful on every platform.
///
/// A literal is written POSIX-style because `/` reads as a path in every
/// review; the conversion happens at the assertion, where the platform
/// dependence actually lives.
pub fn native(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}

/// An absolute directory that exists on every platform, for fixtures that must
/// build a real `file://` URL.
///
/// `url::Url::from_file_path` rejects a POSIX-looking path on Windows (there is
/// no drive letter), so a test that asserts on a link URL needs a root the host
/// considers absolute. A temp dir is used because it is also guaranteed to
/// exist and to be writable, which several of these fixtures need.
pub fn absolute_fixture_root() -> std::path::PathBuf {
    std::env::temp_dir().join("alnair-fixture").join("project")
}

/// A directory the workspace classifier treats as NOT a project, on any host.
///
/// `is_project_dir` excludes each platform's own scratch space (`/tmp` on
/// Unix, `%TEMP%` on Windows), so a hard-coded `/tmp` fixture is only
/// meaningful on Unix: on Windows it is not a real directory, the classifier
/// takes a different branch, and the assertion flips. This returns the host's
/// own scratch root, which every platform classifies the same way.
pub fn non_project_dir() -> std::path::PathBuf {
    std::env::temp_dir()
}

/// Create `<temp>/alnair-fixture/<rel>` and return its absolute path.
///
/// Scrollback linkification only produces a `file://` URL for a path that
/// RESOLVES to an existing file (`local_link_to_file_url` checks `is_file`), so
/// a test asserting on a link has to own a real file. Building the fixture from
/// the host temp root also keeps it absolute on Windows, where a POSIX literal
/// like `/Users/foo/project` is neither absolute nor present.
///
/// The directory is created under `std::env::temp_dir()` rather than a
/// `TempDir` because these fixtures are shared by helpers that build entries
/// before the test body; the OS reclaims it and the content is trivial.
pub fn fixture_path(rel: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join("alnair-fixture").join(rel);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, "fixture\n");
    path
}
