//! Memory tools for cross-session knowledge retrieval.
//!
//! - `memory_search` — search indexed memory for relevant chunks
//! - `memory_get` — read a specific memory file by path
//! - `memory_store` — append a durable note (the only model-facing write path)

pub mod get_tool;
pub mod policy;
pub mod search_tool;
pub mod store_tool;
pub mod types;

pub use get_tool::MemoryGetImpl;
pub use search_tool::MemorySearchImpl;
pub use store_tool::MemoryStoreImpl;

/// Registered name of the `memory_search` tool. Single source of truth
/// shared between the tool definition and gating callers (e.g. shell-side
/// slash-command availability checks).
pub const MEMORY_SEARCH_TOOL_NAME: &str = "memory_search";

pub const MEMORY_GET_TOOL_NAME: &str = "memory_get";

/// Registered name of the `memory_store` tool.
///
/// A write, unlike the other two: it is gated on the `MemoryStore` tool kind
/// (Edit class) and only registered when a write backend is present.
pub const MEMORY_STORE_TOOL_NAME: &str = "memory_store";

#[cfg(test)]
mod tests {
    use super::*;

    /// The constants are the wire identifier embedded in
    /// `AvailableCommandsUpdate._meta.tools` and matched by the shell's
    /// memory-gate predicate. A typo in either site silently disables
    /// `/flush` and `/dream`. Pin both halves.
    #[test]
    fn memory_tool_constants_match_registered_ids() {
        assert_eq!(MEMORY_SEARCH_TOOL_NAME, "memory_search");
        assert_eq!(MEMORY_GET_TOOL_NAME, "memory_get");
        assert_eq!(MEMORY_STORE_TOOL_NAME, "memory_store");
        assert_eq!(
            alnair_tool_runtime::Tool::id(&MemorySearchImpl).to_string(),
            MEMORY_SEARCH_TOOL_NAME
        );
        assert_eq!(
            alnair_tool_runtime::Tool::id(&MemoryGetImpl).to_string(),
            MEMORY_GET_TOOL_NAME
        );
        assert_eq!(
            alnair_tool_runtime::Tool::id(&MemoryStoreImpl).to_string(),
            MEMORY_STORE_TOOL_NAME
        );
    }

    /// The three names must stay distinct: they are tool ids on the wire, and a
    /// collision would make the registry silently drop one of them.
    #[test]
    fn memory_tool_names_are_distinct() {
        let names = [
            MEMORY_SEARCH_TOOL_NAME,
            MEMORY_GET_TOOL_NAME,
            MEMORY_STORE_TOOL_NAME,
        ];
        let unique: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(unique.len(), names.len(), "duplicate memory tool name");
    }
}
