//! Codebase index adapter behind the `codebase_search` / `codebase_context`
//! tools.
//!
//! The trait lives in `alnair-tools` ([`alnair_tools::types::codebase_backend`])
//! so the tool crate stays index-agnostic; this module is the one place that
//! knows both sides. It lives in `alnair-workspace` rather than a crate of its
//! own because that crate already depends on `alnair-tools` and
//! `alnair-codebase-graph` and already owns [`CodebaseIndexManager`] — a new
//! crate would add a workspace member and a dependency edge to hold one
//! adapter.
//!
//! ## Laziness
//!
//! Constructing a backend does nothing. The index actor is spawned on the first
//! [`CodebaseBackendImpl::ensure`], so a session that never asks a structural
//! question never pays for an index. This mirrors the editor's code-navigation
//! path, which also starts lazily on the first request, and it is what keeps
//! `codebase_search` free for a user who never calls it.
//!
//! ## Blocking
//!
//! The queries are `async` and answer through the actor's channel; only
//! `get_coverage` blocks, so it is the only call wrapped in `spawn_blocking`.
//! Snippet reads touch the filesystem and are wrapped too.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use alnair_codebase_graph::{IndexManagerHandle, SymbolQuery};
use alnair_tools::implementations::secrets;
use alnair_tools::types::codebase_backend::{
    CodebaseBackend, CodebaseError, CodebaseHit, CodebaseHitKind, CodebaseMatchKind,
    CodebaseSearchOutcome, CodebaseSnippet, CodebaseStatus, CodebaseSymbol,
};

use super::codebase_index::CodebaseIndexManager;

/// Occurrences reported per symbol before the rest are counted only.
///
/// A symbol like `assert` has tens of thousands of use sites; rendering them all
/// would spend the whole context window on one answer. Four shows the shape of
/// usage without flooding.
const HITS_PER_SYMBOL: usize = 4;

/// Adapter from [`CodebaseIndexManager`] to the tool-facing
/// [`CodebaseBackend`] trait.
pub struct CodebaseBackendImpl {
    /// Shared with the agent, so a session that uses both this tool and the
    /// editor's code navigation backs one index, not two.
    manager: Arc<parking_lot::Mutex<CodebaseIndexManager>>,
    /// Index root: the git root when there is one, else the session cwd.
    root: PathBuf,
    /// Strong reference that keeps the actor alive. `CodebaseIndexManager` holds
    /// only a `Weak`, so without this the index would be reaped between calls.
    handle: OnceLock<Arc<IndexManagerHandle>>,
    /// Language ids the graph can parse, captured once. Reported to the caller
    /// so an empty answer can be attributed to coverage rather than absence.
    languages: Vec<String>,
    /// Where state transitions are reported, if anyone is listening.
    ///
    /// A plain channel rather than a direct call so this crate keeps no
    /// dependency on the shell's notification vocabulary: the shell drains it
    /// on its own task and decides how to put it on the wire.
    status_sink: Option<tokio::sync::mpsc::UnboundedSender<CodebaseStatus>>,
}

impl CodebaseBackendImpl {
    /// Build a backend for `root` sharing `manager`'s index set.
    ///
    /// Cheap: no index is started until the first query.
    pub fn new(manager: Arc<parking_lot::Mutex<CodebaseIndexManager>>, root: PathBuf) -> Self {
        // Lowercase ids, because the model compares them with the extension
        // names it already reasons about (`rust`, `typescript`). The registry's
        // own spelling is a display name (`Rust`, `Typescript`) that would read
        // as a proper noun in a "we do not index `svelte`" message.
        let languages = alnair_codebase_graph::LanguageRegistry::new()
            .all_configs()
            .iter()
            .map(|config| config.primary_language_id().to_lowercase())
            .collect();
        Self {
            manager,
            root,
            handle: OnceLock::new(),
            languages,
            status_sink: None,
        }
    }

    /// Report state transitions to `sink`.
    ///
    /// Optional by design: the tools work identically without it, and a test or
    /// a headless caller has no pager to inform. The sink is drained by the
    /// shell on its own task.
    pub fn with_status_sink(
        mut self,
        sink: tokio::sync::mpsc::UnboundedSender<CodebaseStatus>,
    ) -> Self {
        self.status_sink = Some(sink);
        self
    }

    /// Push a state transition, ignoring "nobody is listening".
    ///
    /// A closed sink means the pager went away; the index keeps working, so
    /// this must never be a hard error.
    fn report(&self, status: CodebaseStatus) {
        if let Some(sink) = &self.status_sink {
            let _ = sink.send(status);
        }
    }

    /// Report a status for an index that already exists, without starting one.
    ///
    /// Returns the reported status, or `None` when this workspace has no live
    /// index. That is the normal state for a repo nobody has searched yet, and
    /// staying silent there matters: this runs at spawn time for every session,
    /// and eagerly building an index for a session that will never ask a
    /// structural question is exactly the cost the lazy start exists to avoid.
    ///
    /// The case this exists for: several sessions in one repository share a
    /// single index (`CodebaseIndexManager` is keyed by git root). A session
    /// that never calls `codebase_search` still *has* a warm index — from a
    /// sibling session in the same process — and a footer that stays empty
    /// reads as "the feature is unavailable" when it is in fact ready.
    pub fn report_existing_status(&self) -> Option<CodebaseStatus> {
        let handle = match self.handle.get() {
            Some(handle) => Arc::clone(handle),
            // Only consult the manager; `get` never spawns, so this cannot turn
            // a passive status read into a first-use start.
            None => self.manager.lock().get(&self.root)?,
        };
        let stats = handle.get_stats()?;
        let status = CodebaseStatus {
            indexed: true,
            files: stats.files,
            definitions: stats.definitions,
            references: stats.references,
            languages: self.languages.clone(),
        };
        self.report(status.clone());
        Some(status)
    }

    /// The index handle, starting the actor on first use.
    fn handle(&self) -> Arc<IndexManagerHandle> {
        self.handle
            .get_or_init(|| {
                let (handle, newly_started) = self.manager.lock().get_or_create(self.root.clone());
                if newly_started {
                    tracing::info!(
                        root = %self.root.display(),
                        event = "codebase_tool_index_started",
                        "codebase tools: started the index on first use"
                    );
                    // `building` is reported from the caller, which runs on the
                    // runtime and can wait for readiness — see `ensure`.
                }
                handle
            })
            .clone()
    }

    fn base_status(&self) -> CodebaseStatus {
        CodebaseStatus {
            languages: self.languages.clone(),
            ..Default::default()
        }
    }
}

#[async_trait::async_trait]
impl CodebaseBackend for CodebaseBackendImpl {
    fn root(&self) -> &Path {
        &self.root
    }

    fn status(&self) -> CodebaseStatus {
        // Non-starting on purpose: reporting status must not be the call that
        // pays for an index.
        let Some(handle) = self.handle.get() else {
            return self.base_status();
        };
        match handle.get_stats() {
            Some(stats) => CodebaseStatus {
                indexed: true,
                files: stats.files,
                definitions: stats.definitions,
                references: stats.references,
                languages: self.languages.clone(),
            },
            None => self.base_status(),
        }
    }

    async fn ensure(&self) -> Result<CodebaseStatus, CodebaseError> {
        let starting = self.handle.get().is_none();
        let handle = self.handle();
        let languages = self.languages.clone();

        // Only announce `building` when this call is what starts the actor; a
        // session that re-ensures an already-warm index would otherwise flash
        // the chip on every query.
        if starting {
            self.report(CodebaseStatus {
                languages: languages.clone(),
                ..Default::default()
            });
        }

        // `get_stats` blocks until the actor finishes its initial build or cache
        // load, which is seconds on a cold repository. Off the runtime.
        let status = tokio::task::spawn_blocking(move || match handle.get_stats() {
            Some(stats) => CodebaseStatus {
                indexed: true,
                files: stats.files,
                definitions: stats.definitions,
                references: stats.references,
                languages,
            },
            None => CodebaseStatus {
                languages,
                ..Default::default()
            },
        })
        .await
        .map_err(|error| CodebaseError::IndexUnavailable(error.to_string()))?;

        // Report the settled state — `ready` with real counts, or the
        // unavailable shape when the actor answered with nothing.
        self.report(status.clone());
        Ok(status)
    }

    async fn search(
        &self,
        query: &str,
        limit: usize,
        include_references: bool,
        path_prefix: Option<&str>,
    ) -> Result<CodebaseSearchOutcome, CodebaseError> {
        let handle = self.handle();

        let mut symbol_query = SymbolQuery::new(query)
            .with_limit(limit)
            .with_references(include_references)
            .with_sites_per_symbol(HITS_PER_SYMBOL);
        if let Some(prefix) = path_prefix {
            symbol_query = symbol_query.with_path_prefix(prefix);
        }

        let found = handle
            .search_symbols(symbol_query)
            .await
            .map_err(|error| CodebaseError::IndexUnavailable(error.to_string()))?;

        let coverage = self.coverage_of(&handle).await;

        let mut hits = Vec::new();
        for matched in &found.matches {
            for site in &matched.sites {
                hits.push(CodebaseHit {
                    path: site.path.clone(),
                    line: site.line,
                    symbol: matched.name.clone(),
                    kind: if site.is_definition {
                        CodebaseHitKind::Definition
                    } else {
                        CodebaseHitKind::Reference
                    },
                });
            }
        }

        // The per-symbol cap already limited what was collected, so `limit`
        // applies to the flattened list and the truncation flag must account
        // for both caps.
        let total_hits = found.total_sites;
        let truncated = found.is_truncated() || hits.len() > limit;
        hits.truncate(limit);

        Ok(CodebaseSearchOutcome {
            symbols: found
                .matches
                .into_iter()
                .map(|matched| CodebaseSymbol {
                    name: matched.name,
                    kind: match matched.kind {
                        alnair_codebase_graph::MatchKind::Exact => CodebaseMatchKind::Exact,
                        alnair_codebase_graph::MatchKind::Prefix => CodebaseMatchKind::Prefix,
                        alnair_codebase_graph::MatchKind::Substring => CodebaseMatchKind::Substring,
                    },
                    definitions: matched.definition_count,
                    references: matched.reference_count,
                })
                .collect(),
            hits,
            total_hits,
            truncated,
            status: coverage,
        })
    }

    async fn snippet(
        &self,
        path: &str,
        line: usize,
        max_lines: usize,
        max_bytes: usize,
    ) -> Result<Option<CodebaseSnippet>, CodebaseError> {
        let root = self.root.clone();
        let path = path.to_string();
        tokio::task::spawn_blocking(move || read_snippet(&root, &path, line, max_lines, max_bytes))
            .await
            .map_err(|error| CodebaseError::IndexUnavailable(error.to_string()))?
    }
}

impl CodebaseBackendImpl {
    /// Coverage for a search result, without failing the search if it is
    /// unavailable.
    ///
    /// A missing stats read means the actor is shutting down; the search itself
    /// already succeeded, so reporting "no coverage" is better than discarding
    /// a valid answer.
    async fn coverage_of(&self, handle: &Arc<IndexManagerHandle>) -> CodebaseStatus {
        let handle = handle.clone();
        let languages = self.languages.clone();
        tokio::task::spawn_blocking(move || match handle.get_stats() {
            Some(stats) => CodebaseStatus {
                indexed: true,
                files: stats.files,
                definitions: stats.definitions,
                references: stats.references,
                languages,
            },
            None => CodebaseStatus {
                languages,
                ..Default::default()
            },
        })
        .await
        .unwrap_or_else(|_| self.base_status())
    }
}

fn under_prefix(path: &str, prefix: Option<&str>) -> bool {
    match prefix {
        Some(prefix) => path.starts_with(prefix),
        None => true,
    }
}

/// Read `max_lines` starting at `line` from `path`, redacting credentials.
///
/// Returns `Ok(None)` when the file cannot be read — which includes a path that
/// resolves outside the index root. That check is not a security boundary (the
/// `read_file` tool can read anywhere the user can) but it keeps a relative
/// `../../etc/passwd` from silently working through a tool that claims to be
/// scoped to the workspace.
fn read_snippet(
    root: &Path,
    path: &str,
    line: usize,
    max_lines: usize,
    max_bytes: usize,
) -> Result<Option<CodebaseSnippet>, CodebaseError> {
    let resolved = resolve_under_root(root, path)?;
    let Ok(content) = std::fs::read_to_string(&resolved) else {
        return Ok(None);
    };

    let start = line.max(1);
    let mut text = String::new();
    let mut end = start;
    let mut truncated = false;
    for (offset, source_line) in content.split('\n').skip(start - 1).enumerate() {
        if offset >= max_lines {
            truncated = true;
            break;
        }
        if text.len() + source_line.len() + 1 > max_bytes {
            truncated = true;
            break;
        }
        if offset > 0 {
            text.push('\n');
        }
        text.push_str(source_line);
        end = start + offset;
    }

    let (text, redacted_lines) = secrets::redact_lines(&text);
    Ok(Some(CodebaseSnippet {
        path: path.to_string(),
        start_line: start,
        end_line: end.max(start),
        text,
        truncated,
        redacted_lines,
    }))
}

/// Resolve a model-supplied path against the index root, rejecting escapes.
fn resolve_under_root(root: &Path, path: &str) -> Result<PathBuf, CodebaseError> {
    let candidate = Path::new(path);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };

    // Lexical normalization only: `canonicalize` would resolve symlinks and make
    // a legitimate in-repo symlink look like an escape. `..` is the case that
    // matters, and it is resolvable without touching the filesystem.
    //
    // The check is a prefix test on the NORMALIZED paths rather than a running
    // depth counter. A counter has to decide where zero is — the filesystem
    // root, the index root, with or without the Windows drive prefix — and each
    // of those choices got this wrong: `..` never reached negative because the
    // ancestors padded the count. Normalizing both sides first and comparing
    // makes "did it leave the root?" the only question asked.
    let normalized_root = normalize_lexically(root);
    let normalized_joined = normalize_lexically(&joined);
    if !normalized_joined.starts_with(&normalized_root) {
        return Err(CodebaseError::PathOutsideRoot(path.to_string()));
    }
    Ok(joined)
}

/// Resolve `.` and `..` without touching the filesystem.
///
/// `Component::ParentDir` is dropped by popping the last normal component, so
/// the result is comparable with `starts_with`. A `..` that would climb above
/// the path's own root is kept, which makes such a path fail a prefix test
/// rather than silently resolving to the parent.
fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, content: &str) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn a_snippet_starts_at_the_requested_line_and_is_numbered_from_it() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "f.txt", "one\ntwo\nthree\nfour\nfive");

        let snippet = read_snippet(dir.path(), "f.txt", 2, 2, 1024)
            .unwrap()
            .expect("file is readable");
        assert_eq!(snippet.start_line, 2);
        assert_eq!(snippet.end_line, 3);
        assert_eq!(snippet.text, "two\nthree");
        assert!(snippet.truncated, "four and five were dropped");
    }

    #[test]
    fn a_snippet_that_reaches_the_end_is_not_marked_truncated() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "f.txt", "one\ntwo");

        let snippet = read_snippet(dir.path(), "f.txt", 1, 10, 1024)
            .unwrap()
            .unwrap();
        assert!(!snippet.truncated);
        assert_eq!(snippet.text, "one\ntwo");
    }

    #[test]
    fn the_byte_cap_can_truncate_a_short_window() {
        let dir = tempfile::tempdir().unwrap();
        let long_line = "x".repeat(200);
        write(dir.path(), "f.txt", &format!("{long_line}\n{long_line}"));

        let snippet = read_snippet(dir.path(), "f.txt", 1, 10, 50)
            .unwrap()
            .unwrap();
        assert!(snippet.truncated);
        assert!(snippet.text.is_empty(), "no line fits in 50 bytes");
    }

    #[test]
    fn a_credential_line_is_redacted_not_returned() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "f.env",
            "SAFE=1\nDB_PASSWORD=hunter2hunter2hunter2\nAFTER=2",
        );

        let snippet = read_snippet(dir.path(), "f.env", 1, 10, 4096)
            .unwrap()
            .unwrap();
        assert_eq!(snippet.redacted_lines, 1);
        assert!(!snippet.text.contains("hunter2"));
        assert!(snippet.text.contains(secrets::REDACTION_MARKER));
        // The other lines survive, so the reader still sees the context.
        assert!(snippet.text.contains("SAFE=1"));
        assert!(snippet.text.contains("AFTER=2"));
    }

    #[test]
    fn a_missing_file_is_none_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            read_snippet(dir.path(), "nope.rs", 1, 10, 1024)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_relative_escape_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let error = resolve_under_root(dir.path(), "../outside.rs").unwrap_err();
        assert!(matches!(error, CodebaseError::PathOutsideRoot(_)));
    }

    /// The depth counter runs from the index root, so a `..` that climbs back
    /// into the root is allowed while one that leaves it is refused. Before the
    /// counter started at the root's own depth, the absolute path's ancestors
    /// padded it and *neither* case was ever detected.
    #[test]
    fn a_dotdot_that_stays_inside_the_root_is_allowed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        let resolved = resolve_under_root(dir.path(), "src/../lib.rs").unwrap();
        assert!(resolved.ends_with("lib.rs"));
    }

    #[test]
    fn a_dotdot_that_climbs_out_of_the_root_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        // Two levels up from `root/src` leaves the root.
        let error = resolve_under_root(dir.path(), "src/../../outside.rs").unwrap_err();
        assert!(matches!(error, CodebaseError::PathOutsideRoot(_)));
    }

    #[test]
    fn an_in_root_relative_path_resolves() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = resolve_under_root(dir.path(), "src/lib.rs").unwrap();
        assert!(resolved.ends_with(Path::new("src").join("lib.rs")));
    }

    #[test]
    fn an_absolute_path_inside_the_root_resolves() {
        let dir = tempfile::tempdir().unwrap();
        let inside = dir.path().join("src/lib.rs");
        let resolved = resolve_under_root(dir.path(), &inside.to_string_lossy()).unwrap();
        assert_eq!(resolved, inside);
    }

    #[test]
    fn a_prefix_filter_is_an_exact_prefix_test() {
        assert!(under_prefix("src/a.rs", Some("src/")));
        assert!(!under_prefix("tests/a.rs", Some("src/")));
        assert!(under_prefix("tests/a.rs", None));
    }
}
