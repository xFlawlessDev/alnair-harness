//! Structural codebase tools.
//!
//! - `codebase_search` — find symbols by name fragment and locate their sites
//! - `codebase_context` — read a bounded window around a location
//!
//! Both are read-only and both go through [`CodebaseBackend`], so they work
//! identically whether the index was started by these tools or by the editor's
//! code navigation.
//!
//! [`CodebaseBackend`]: crate::types::codebase_backend::CodebaseBackend

pub mod context_tool;
pub mod search_tool;
pub mod types;

pub use context_tool::CodebaseContextImpl;
pub use search_tool::CodebaseSearchImpl;

/// Registered name of the `codebase_search` tool.
pub const CODEBASE_SEARCH_TOOL_NAME: &str = "codebase_search";

/// Registered name of the `codebase_context` tool.
pub const CODEBASE_CONTEXT_TOOL_NAME: &str = "codebase_context";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_constants_match_registered_ids() {
        assert_eq!(CODEBASE_SEARCH_TOOL_NAME, "codebase_search");
        assert_eq!(CODEBASE_CONTEXT_TOOL_NAME, "codebase_context");
        assert_eq!(
            alnair_tool_runtime::Tool::id(&CodebaseSearchImpl).to_string(),
            CODEBASE_SEARCH_TOOL_NAME
        );
        assert_eq!(
            alnair_tool_runtime::Tool::id(&CodebaseContextImpl).to_string(),
            CODEBASE_CONTEXT_TOOL_NAME
        );
    }

    /// The names are tool ids on the wire; a collision would make the registry
    /// silently drop one of them.
    #[test]
    fn tool_names_are_distinct() {
        assert_ne!(CODEBASE_SEARCH_TOOL_NAME, CODEBASE_CONTEXT_TOOL_NAME);
    }

    /// Both tools only read. A future snippet renderer must not change that:
    /// the permission layer and subagent capability modes both key off it.
    #[test]
    fn both_tools_are_read_only() {
        assert!(
            alnair_tool_runtime::Tool::capabilities(&CodebaseSearchImpl).is_read_only,
            "codebase_search must be read-only"
        );
        assert!(
            alnair_tool_runtime::Tool::capabilities(&CodebaseContextImpl).is_read_only,
            "codebase_context must be read-only"
        );
    }
}
