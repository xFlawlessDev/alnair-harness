//! Input/output types for the codebase tools.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Input for the `codebase_search` tool.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct CodebaseSearchInput {
    /// A symbol name or fragment of one. Matched case-insensitively against
    /// declared symbol names: exact names first, then names that start with it,
    /// then names that contain it.
    ///
    /// Prefer a distinctive fragment over a common word. `render_tab_strip`
    /// finds one thing; `render` finds every rendering helper in the repository.
    pub query: String,
    /// Maximum number of results. Defaults to 20, capped at 100.
    #[serde(default)]
    pub limit: Option<usize>,
    /// Restrict to files whose path starts with this prefix, relative to the
    /// workspace root (for example `crates/codegen/alnair-tui/`).
    #[serde(default)]
    pub path_prefix: Option<String>,
    /// Also report use sites, not only declarations.
    ///
    /// Defaults to false: most questions are "where is this defined?", and a
    /// heavily used symbol has thousands of call sites that would crowd out
    /// every other result.
    #[serde(default)]
    pub include_references: bool,
}

/// Output schema for `codebase_search` (used for JSON Schema generation only).
#[derive(Debug, JsonSchema)]
pub struct CodebaseSearchOutput {
    /// Ranked results as markdown text.
    pub results: String,
}

/// Input for the `codebase_context` tool.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct CodebaseContextInput {
    /// Absolute path to the file, or a path relative to the workspace root.
    ///
    /// This is the `path` field of a `codebase_search` result, so the usual flow
    /// is search then read — but any file in the workspace works.
    pub path: String,
    /// 1-indexed line to centre the window on. Defaults to 1.
    #[serde(default)]
    pub line: Option<usize>,
    /// Number of lines to return. Defaults to 40, capped at 200.
    #[serde(default)]
    pub lines: Option<usize>,
}

/// Output schema for `codebase_context` (used for JSON Schema generation only).
#[derive(Debug, JsonSchema)]
pub struct CodebaseContextOutput {
    /// The file slice, with its path and line range.
    pub content: String,
}
