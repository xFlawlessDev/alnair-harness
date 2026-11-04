//! Backend-agnostic trait for memory search and retrieval.
//!
//! `MemoryBackend` is defined in `alnair-tools` to keep the tool crate
//! backend-agnostic. The concrete implementation (`MemoryIndex`) lives in
//! `alnair-shell`.
//!
//! All methods are `&self` (read-only). Write operations (record_access,
//! memory flush writes) go through the session actor directly.

/// Tracing target for memory system events.
///
/// Use `tracing::info!(target: MEMORY_LOG_TARGET, ...)` in `alnair-tools`.
/// Mirrors `alnair_shell::session::memory_log::TARGET`.
pub const MEMORY_LOG_TARGET: &str = "xai_memory";

/// Staleness threshold (days): show a note suggesting verification.
const STALE_NOTE_DAYS: f64 = 1.0;
/// Staleness threshold (days): show a strong stale warning.
const VERY_STALE_DAYS: f64 = 7.0;

/// Format a staleness warning for a memory search result.
///
/// Session-scoped chunks older than [`STALE_NOTE_DAYS`] get a note;
/// those older than [`VERY_STALE_DAYS`] get a stronger warning.
/// Global and workspace entries are curated/evergreen — no warning emitted.
/// Returns an empty string for fresh, evergreen, or unknown-age results.
pub fn format_staleness_note(source: &str, created_at: Option<i64>) -> String {
    if matches!(source, "global" | "workspace") {
        return String::new();
    }
    let Some(created) = created_at else {
        return String::new();
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let age_days = ((now - created) as f64 / 86400.0).max(0.0);

    if age_days > VERY_STALE_DAYS {
        format!(
            "**Stale ({}):** Verify current state before relying on this.\n",
            format_age(age_days)
        )
    } else if age_days > STALE_NOTE_DAYS {
        format!(
            "**Note ({}):** Verify this is still current.\n",
            format_age(age_days)
        )
    } else {
        String::new()
    }
}

fn format_age(days: f64) -> String {
    if days < 1.0 {
        let hours = (days * 24.0).round() as u64;
        format!("{hours}h ago")
    } else if days < 7.0 {
        let d = days.floor() as u64;
        if d == 1 {
            "1 day ago".to_string()
        } else {
            format!("{d} days ago")
        }
    } else {
        let weeks = (days / 7.0).round() as u64;
        if weeks == 1 {
            "1 week ago".to_string()
        } else {
            format!("{weeks} weeks ago")
        }
    }
}

/// A single search result from memory.
#[derive(Debug, Clone)]
pub struct MemorySearchResult {
    /// Unique chunk identifier (e.g., `"/path/to/file.md:0"`).
    pub chunk_id: String,
    /// Source file path.
    pub path: String,
    /// 0-based start line in the source file.
    pub start_line: usize,
    /// 0-based end line (exclusive) in the source file.
    pub end_line: usize,
    /// Relevance score (higher = more relevant).
    pub score: f64,
    /// Text snippet from the chunk.
    pub snippet: String,
    /// Source scope: `"global"`, `"workspace"`, or `"session"`.
    pub source: String,
    /// Unix timestamp (seconds) when the chunk was created.
    /// `None` for backends that don't track creation time.
    pub created_at: Option<i64>,
}

/// Backend-agnostic interface for memory queries.
///
/// Implementations must be `Send + Sync` to be stored in `Arc<dyn MemoryBackend>`
/// on `SessionContext`. All methods are `&self` — no mutation through the trait.
///
/// `search` is async because hybrid search may need to call an embedding API
/// to vectorize the query for KNN lookup.
#[async_trait::async_trait]
pub trait MemoryBackend: Send + Sync {
    /// Search memory for chunks matching a query string.
    ///
    /// Returns up to `max_results` results with score >= `min_score`.
    /// Uses hybrid search (FTS5 + vector KNN) when embeddings are available,
    /// falling back to FTS-only otherwise.
    async fn search(
        &self,
        query: &str,
        max_results: usize,
        min_score: f64,
    ) -> Result<Vec<MemorySearchResult>, Box<dyn std::error::Error + Send + Sync>>;

    /// Read a memory file by path, optionally returning a range of lines.
    fn get(
        &self,
        path: &str,
        from: Option<usize>,
        lines: Option<usize>,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>>;

    /// Return the total number of indexed chunks.
    fn total_chunks(&self) -> Result<usize, Box<dyn std::error::Error + Send + Sync>>;

    /// Configured default for `max_results` in search queries.
    ///
    /// Lets `[memory.search].max_results` be honoured at the tool boundary when
    /// the `memory_search` caller supplies no explicit value. Backends that do
    /// not override this get `6`.
    fn default_search_max_results(&self) -> usize {
        6
    }

    /// Configured default for `min_score` in search queries.
    ///
    /// Lets `[memory.search].min_score` be honoured at the tool boundary when
    /// the caller supplies no explicit threshold. Backends that do not override
    /// this get `0.0` (accept all results).
    fn default_search_min_score(&self) -> f64 {
        0.0
    }
}

/// Where a durable memory note is written.
///
/// A mirror of `alnair_memory::storage::MemoryScope`: `alnair-tools` cannot
/// depend on `alnair-memory` (that crate already depends on this one), so the
/// write trait is expressed in this crate's vocabulary and the backend impl
/// converts. Keep the variants in lockstep — the conversion is exhaustive, so a
/// new variant on either side is a compile error rather than a silent drop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MemoryWriteScope {
    /// Workspace-scoped `MEMORY.md` — specific to one project. The default,
    /// because a project decision stored globally leaks into unrelated repos.
    #[default]
    Workspace,
    /// Global `MEMORY.md` — shared across every workspace.
    Global,
}

impl MemoryWriteScope {
    /// The `scope` wire value accepted by the `memory_store` tool.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Global => "global",
        }
    }

    /// Parse a tool-supplied scope. Unknown values are rejected rather than
    /// defaulted: silently writing to the wrong scope is unrecoverable (the
    /// note lands in a file the user does not expect to look at).
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "workspace" => Some(Self::Workspace),
            "global" => Some(Self::Global),
            _ => None,
        }
    }
}

/// Result of a successful [`MemoryWriteBackend::append`].
#[derive(Debug, Clone)]
pub struct AppendOutcome {
    /// Absolute path of the `MEMORY.md` that received the note.
    pub path: String,
    /// Bytes appended (after normalization).
    pub bytes_written: usize,
    /// Whether the note is already searchable. `false` means the markdown write
    /// succeeded but the inline reindex did not, so retrieval will catch up on
    /// the next search or watcher tick. The note is durable either way.
    pub indexed: bool,
}

/// Write half of the memory backend.
///
/// Deliberately separate from [`MemoryBackend`]: that trait is documented as
/// read-only and is handed to the first-turn injection and post-compaction
/// recovery paths, which must not be able to mutate durable state. A caller
/// holding only `Arc<dyn MemoryBackend>` therefore cannot write by
/// construction.
#[async_trait::async_trait]
pub trait MemoryWriteBackend: Send + Sync {
    /// Append `content` to the durable `MEMORY.md` for `scope`, then index it.
    ///
    /// Implementations must not echo `content` back in errors.
    async fn append(
        &self,
        scope: MemoryWriteScope,
        content: &str,
    ) -> Result<AppendOutcome, Box<dyn std::error::Error + Send + Sync>>;

    /// Whether a consolidation pass currently owns the memory files.
    ///
    /// `memory_store` refuses while this is `true`: appending into a file that
    /// dream is about to rewrite loses the note. Defaults to `false` for
    /// backends that have no consolidation step.
    fn is_consolidating(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now_secs() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    #[test]
    fn staleness_global_is_evergreen() {
        let ts = Some(now_secs() - 86400 * 30);
        assert!(format_staleness_note("global", ts).is_empty());
    }

    #[test]
    fn staleness_workspace_is_evergreen() {
        let ts = Some(now_secs() - 86400 * 30);
        assert!(format_staleness_note("workspace", ts).is_empty());
    }

    #[test]
    fn staleness_none_created_at_is_empty() {
        assert!(format_staleness_note("session", None).is_empty());
    }

    #[test]
    fn staleness_fresh_is_empty() {
        let ts = Some(now_secs() - 3600);
        assert!(format_staleness_note("session", ts).is_empty());
    }

    #[test]
    fn staleness_note_for_moderately_old() {
        let ts = Some(now_secs() - 86400 * 2);
        let note = format_staleness_note("session", ts);
        assert!(note.starts_with("**Note ("), "expected Note, got: {note}");
        assert!(
            note.contains("2 days ago"),
            "expected '2 days ago', got: {note}"
        );
    }

    #[test]
    fn staleness_warning_for_very_old() {
        let ts = Some(now_secs() - 86400 * 10);
        let note = format_staleness_note("session", ts);
        assert!(note.starts_with("**Stale ("), "expected Stale, got: {note}");
        assert!(note.contains("week"), "expected weeks unit, got: {note}");
    }

    // MemoryWriteScope

    /// The tool's wire spelling and the enum must agree in both directions, or a
    /// stored note lands in a scope the model did not ask for.
    #[test]
    fn write_scope_round_trips_through_its_wire_spelling() {
        for scope in [MemoryWriteScope::Workspace, MemoryWriteScope::Global] {
            assert_eq!(
                MemoryWriteScope::parse(scope.as_str()),
                Some(scope),
                "{scope:?} must parse back from its own as_str()"
            );
        }
    }

    #[test]
    fn write_scope_defaults_to_workspace() {
        // Global memory is shared across every repository, so the default must
        // never be Global: a project decision would leak into unrelated repos.
        assert_eq!(MemoryWriteScope::default(), MemoryWriteScope::Workspace);
    }

    #[test]
    fn write_scope_rejects_unknown_values() {
        for bad in ["", "Global", "WORKSPACE", "project", "session"] {
            assert_eq!(
                MemoryWriteScope::parse(bad),
                None,
                "{bad:?} must be rejected, not defaulted"
            );
        }
    }

    #[test]
    fn format_age_hours() {
        assert_eq!(format_age(0.5), "12h ago");
    }

    #[test]
    fn format_age_one_day() {
        assert_eq!(format_age(1.0), "1 day ago");
    }

    #[test]
    fn format_age_several_days() {
        assert_eq!(format_age(3.0), "3 days ago");
    }

    #[test]
    fn format_age_one_week() {
        assert_eq!(format_age(7.0), "1 week ago");
    }

    #[test]
    fn format_age_weeks() {
        assert_eq!(format_age(14.0), "2 weeks ago");
    }

    #[test]
    fn staleness_note_at_exact_one_day() {
        let ts = Some(now_secs() - 86400);
        let note = format_staleness_note("session", ts);
        assert!(
            note.is_empty(),
            "exactly 1 day should be fresh (> not >=), got: {note}"
        );
    }

    #[test]
    fn staleness_fresh_just_under_one_day() {
        // 0.99 days = 85536 seconds
        let ts = Some(now_secs() - 85536);
        assert!(
            format_staleness_note("session", ts).is_empty(),
            "0.99 days should be fresh"
        );
    }

    #[test]
    fn staleness_stale_at_exact_seven_days() {
        let ts = Some(now_secs() - 86400 * 7);
        let note = format_staleness_note("session", ts);
        assert!(
            note.starts_with("**Note ("),
            "exactly 7 days should trigger Note (> not >=), got: {note}"
        );
    }

    #[test]
    fn staleness_note_just_under_seven_days() {
        // 6.99 days = 603936 seconds
        let ts = Some(now_secs() - 603936);
        let note = format_staleness_note("session", ts);
        assert!(
            note.starts_with("**Note ("),
            "6.99 days should be Note not Stale, got: {note}"
        );
    }

    #[test]
    fn staleness_future_created_at_is_empty() {
        let ts = Some(now_secs() + 3600);
        assert!(
            format_staleness_note("session", ts).is_empty(),
            "future timestamp should produce no warning"
        );
    }
}
