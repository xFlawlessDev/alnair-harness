//! Backend-agnostic trait for structural code search.
//!
//! Defined in `alnair-tools` so the tool crate stays independent of any index
//! implementation: the concrete adapter lives in `alnair-workspace`, which
//! already owns the codebase index lifecycle and depends on both this crate and
//! `alnair-codebase-graph`. The dependency direction is therefore
//! `workspace → tools` and `workspace → graph`, and neither of those has to
//! learn about the other.
//!
//! ## Why a trait object rather than a compile-time fork
//!
//! The feature is off by default, a workspace may not be a git repository, and
//! the first query is what starts the index. Making the backend an *optional
//! resource* keeps "codebase indexing is unavailable" a runtime fact the tool
//! reports, instead of a registration-time fork that would double every
//! toolset snapshot and every `/memory`-style toggle.

use std::path::Path;

/// What an index currently holds.
///
/// `indexed: false` means no index exists for this workspace *yet*; a search is
/// what starts one. It does not mean the workspace is unindexable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodebaseStatus {
    /// Whether an index is loaded for this workspace.
    pub indexed: bool,
    /// Files in the index.
    pub files: usize,
    /// Symbol definitions in the index.
    pub definitions: usize,
    /// Symbol references in the index.
    pub references: usize,
    /// Language ids the index can parse (`go`, `rust`, `typescript`, …).
    ///
    /// This is the honest half of "why did my search miss?". A file whose
    /// language is absent from this list is invisible to the index, so the
    /// answer to "does this symbol exist?" is "not in an indexed language",
    /// not "no".
    pub languages: Vec<String>,
}

impl CodebaseStatus {
    /// Whether the index can read files of `language_id`.
    pub fn covers_language(&self, language_id: &str) -> bool {
        self.languages.iter().any(|l| l == language_id)
    }
}

/// What kind of site a hit points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodebaseHitKind {
    /// The symbol is declared here.
    Definition,
    /// The symbol is used here.
    Reference,
}

impl CodebaseHitKind {
    /// Wire spelling used in tool output.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Definition => "definition",
            Self::Reference => "reference",
        }
    }
}

/// How a symbol's name matched the query. Ordered worst-to-best so a plain
/// comparison ranks the strongest match first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CodebaseMatchKind {
    /// The query appears somewhere inside the name.
    Substring,
    /// The name starts with the query.
    Prefix,
    /// The name is the query.
    Exact,
}

impl CodebaseMatchKind {
    /// Wire spelling used in tool output.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Substring => "substring",
            Self::Prefix => "prefix",
            Self::Exact => "exact",
        }
    }
}

/// A ranked symbol candidate.
#[derive(Debug, Clone, PartialEq)]
pub struct CodebaseSymbol {
    /// Symbol name as it appears in source.
    pub name: String,
    /// How the name matched the query.
    pub kind: CodebaseMatchKind,
    /// Number of declaration sites.
    pub definitions: usize,
    /// Number of use sites.
    pub references: usize,
}

/// A single located occurrence of a symbol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodebaseHit {
    /// Path relative to the index root.
    pub path: String,
    /// 1-indexed line.
    pub line: usize,
    /// The symbol at that line.
    pub symbol: String,
    /// Whether this is a declaration or a use.
    pub kind: CodebaseHitKind,
}

/// The result of one search call.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CodebaseSearchOutcome {
    /// Ranked symbols, best first.
    pub symbols: Vec<CodebaseSymbol>,
    /// Located occurrences for the returned symbols, in the same order.
    pub hits: Vec<CodebaseHit>,
    /// Total occurrences matched before the cap was applied.
    pub total_hits: usize,
    /// True when `hits` is shorter than `total_hits`, i.e. the answer is
    /// partial. A caller that sees this must not treat the list as exhaustive.
    pub truncated: bool,
    /// Index state at query time.
    pub status: CodebaseStatus,
}

/// A bounded slice of a file around a location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodebaseSnippet {
    /// Path relative to the index root.
    pub path: String,
    /// 1-indexed first line of the slice.
    pub start_line: usize,
    /// 1-indexed last line of the slice.
    pub end_line: usize,
    /// The slice. Any line that looks like a credential is replaced by a
    /// marker, never returned.
    pub text: String,
    /// True when the window ran past the end of the file or the byte budget, so
    /// `text` is shorter than the caller asked for.
    pub truncated: bool,
    /// Lines replaced by a redaction marker.
    ///
    /// Reported so a gap in the code is never mistaken for missing code: a
    /// silent hole would read as "the file does not contain that", which is the
    /// opposite of what happened.
    pub redacted_lines: usize,
}

/// Errors a codebase backend can report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodebaseError {
    /// Indexing is disabled for this workspace (`[features] codebase_indexing`).
    Disabled,
    /// The workspace is not inside a git repository and config requires one.
    NotAGitRepository,
    /// The index actor stopped answering.
    IndexUnavailable(String),
    /// The requested path is not inside the index root.
    PathOutsideRoot(String),
}

impl std::fmt::Display for CodebaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(
                f,
                "codebase indexing is disabled for this workspace \
                 (`[features] codebase_indexing = false`)"
            ),
            Self::NotAGitRepository => write!(
                f,
                "codebase indexing needs a git repository; this workspace is not one"
            ),
            Self::IndexUnavailable(reason) => write!(f, "codebase index unavailable: {reason}"),
            Self::PathOutsideRoot(path) => {
                write!(f, "{path} is not inside the indexed workspace")
            }
        }
    }
}

impl std::error::Error for CodebaseError {}

/// Read-only structural search over a workspace's symbol index.
///
/// Every method takes `&self`: the index is owned by the process, not by the
/// session, and several sessions in one repository share it. Starting it is the
/// backend's job and happens lazily on the first call, so constructing a
/// backend costs nothing and a session that never asks a structural question
/// never pays for an index.
#[async_trait::async_trait]
pub trait CodebaseBackend: Send + Sync {
    /// Absolute root the index covers (usually the git root).
    fn root(&self) -> &Path;

    /// Current index state without starting one.
    fn status(&self) -> CodebaseStatus;

    /// Current index state, starting the index if this is the first call.
    ///
    /// Cheap once started. The tools call this before searching so that "empty
    /// result" can be told apart from "nothing indexed yet".
    async fn ensure(&self) -> Result<CodebaseStatus, CodebaseError>;

    /// Find symbols matching `query`, then locate their occurrences.
    ///
    /// `query` is matched against symbol names, case-insensitively: exact
    /// names first, then names starting with it, then names containing it. A
    /// query that matches nothing is an empty outcome, not an error —
    /// [`CodebaseSearchOutcome::status`] is what tells the caller whether the
    /// answer is trustworthy.
    ///
    /// `include_references` false restricts the answer to declaration sites,
    /// which is the common case and much smaller.
    ///
    /// `path_prefix`, when set, keeps only hits whose path starts with it. It is
    /// applied by the backend rather than the tool so the cap is spent on
    /// results the caller can actually see; filtering afterwards would truncate
    /// to `limit` first and then throw most of it away.
    async fn search(
        &self,
        query: &str,
        limit: usize,
        include_references: bool,
        path_prefix: Option<&str>,
    ) -> Result<CodebaseSearchOutcome, CodebaseError>;

    /// Read a bounded window of `path` starting at `line`.
    ///
    /// Returns `Ok(None)` when the file cannot be read. The window is capped by
    /// `max_lines` and `max_bytes`, and credential-shaped lines are replaced.
    async fn snippet(
        &self,
        path: &str,
        line: usize,
        max_lines: usize,
        max_bytes: usize,
    ) -> Result<Option<CodebaseSnippet>, CodebaseError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_kind_orders_worst_to_best() {
        // Ranking compares these directly, so the ordering is load-bearing.
        assert!(CodebaseMatchKind::Exact > CodebaseMatchKind::Prefix);
        assert!(CodebaseMatchKind::Prefix > CodebaseMatchKind::Substring);
    }

    #[test]
    fn hit_kind_has_a_stable_wire_spelling() {
        assert_eq!(CodebaseHitKind::Definition.as_str(), "definition");
        assert_eq!(CodebaseHitKind::Reference.as_str(), "reference");
    }

    #[test]
    fn match_kind_has_a_stable_wire_spelling() {
        assert_eq!(CodebaseMatchKind::Exact.as_str(), "exact");
        assert_eq!(CodebaseMatchKind::Prefix.as_str(), "prefix");
        assert_eq!(CodebaseMatchKind::Substring.as_str(), "substring");
    }

    #[test]
    fn errors_are_actionable() {
        assert!(
            CodebaseError::Disabled
                .to_string()
                .contains("codebase_indexing")
        );
        assert!(
            CodebaseError::NotAGitRepository
                .to_string()
                .contains("git repository")
        );
    }

    #[test]
    fn a_fresh_status_is_not_indexed() {
        let status = CodebaseStatus::default();
        assert!(!status.indexed);
        assert_eq!(status.files, 0);
    }

    #[test]
    fn language_coverage_is_answerable() {
        let status = CodebaseStatus {
            indexed: true,
            languages: vec!["rust".to_string(), "typescript".to_string()],
            ..Default::default()
        };
        assert!(status.covers_language("rust"));
        assert!(!status.covers_language("svelte"));
    }
}
