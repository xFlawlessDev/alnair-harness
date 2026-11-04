//! Input/output types for memory tools.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Input for the `memory_search` tool.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct MemorySearchInput {
    /// The search query string. Use specific technical terms rather than
    /// conversational language. Good: "authentication middleware patterns".
    /// Bad: "that thing we discussed about auth".
    pub query: String,
    /// Maximum number of results to return.
    ///
    /// When omitted the backend-configured value is used (typically 6 from
    /// `[memory.search].max_results`), so leaving this unset is preferred
    /// for normal queries.
    #[serde(default)]
    pub max_results: Option<usize>,
    /// Minimum relevance score threshold.
    ///
    /// When omitted the backend-configured value is used (typically 0.0 from
    /// `[memory.search].min_score`).
    #[serde(default)]
    pub min_score: Option<f64>,
}

/// Output schema for `memory_search` (used for JSON Schema generation only).
#[derive(Debug, JsonSchema)]
pub struct MemorySearchOutput {
    /// Formatted search results as markdown text.
    pub results: String,
}

/// Input for the `memory_get` tool.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct MemoryGetInput {
    /// Path to the memory file to read.
    pub path: String,
    /// 0-based start line (default: beginning of file).
    #[serde(default)]
    pub from: Option<usize>,
    /// Maximum number of lines to return (default: all).
    #[serde(default)]
    pub lines: Option<usize>,
}

/// Output schema for `memory_get` (used for JSON Schema generation only).
#[derive(Debug, JsonSchema)]
pub struct MemoryGetOutput {
    /// File content (optionally line-limited).
    pub content: String,
}

/// Input for the `memory_store` tool.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct MemoryStoreInput {
    /// The note to remember. One fact per call: a decision, a convention, a
    /// non-obvious gotcha, or where something lives.
    ///
    /// Write it so a future session can act on it without re-deriving the
    /// context — name the file, the symbol, or the command involved.
    pub content: String,
    /// Where to store it. `workspace` (default) is scoped to this project;
    /// `global` is shared across every project.
    ///
    /// Prefer `workspace`: a project-specific decision stored globally leaks
    /// into unrelated repositories.
    #[serde(default)]
    pub scope: Option<String>,
}

/// Output schema for `memory_store` (used for JSON Schema generation only).
#[derive(Debug, JsonSchema)]
pub struct MemoryStoreOutput {
    /// Confirmation naming the file that received the note.
    pub result: String,
}
