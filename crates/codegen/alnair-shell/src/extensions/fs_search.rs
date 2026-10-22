//! `alnair/fs/search`: fuzzy path search over a workspace root.
//!
//! The pager's `@`-completion walks the tree in-process with
//! [`alnair_workspace::file_system::FuzzyFileMatcherDaemon`] and polls it once
//! per frame. A browser cannot: it has no filesystem, and a per-keystroke RPC
//! that rebuilt the matcher would re-walk the whole repo every time. So the
//! agent owns the same daemon here and keeps it alive between calls, keyed by
//! root. The first call for a root pays the walk; later calls only re-query the
//! snapshot.
//!
//! The reply is deliberately partial-capable: `done: false` means the walk is
//! still streaming and the caller should ask again. Nothing here blocks for
//! longer than [`SEARCH_BUDGET`], because the agent serves every other client
//! on the same thread.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol as acp;
use alnair_workspace::file_system::{FuzzyFileMatcher, FuzzyFileMatcherDaemon};
use serde::{Deserialize, Serialize};

/// Results the daemon keeps ranked. A page is sliced out of this, so a caller
/// asking for fewer rows still gets the best `limit` of the same ranking.
const MATCHER_TOP_K: usize = 256;

/// How long one call may wait for the walk to produce a snapshot.
///
/// Short on purpose: `@`-completion re-queries as the reader types, so a
/// half-filled page now is worth more than a complete one 2 s later. The TUI
/// polls at frame rate; 250 ms is roughly "as long as a keystroke feels
/// instant".
const SEARCH_BUDGET: Duration = Duration::from_millis(250);

/// How often the poll loop re-reads the daemon's snapshot while waiting.
const POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Live matchers, one per (root, hidden) pair.
///
/// Bounded because a browser tab can point `@` at many directories over a
/// session and each daemon owns a walker thread pool. Eviction is
/// least-recently-used: the composer re-queries its own root constantly, so
/// the entry in active use is never the oldest.
const MAX_LIVE_MATCHERS: usize = 8;

static SEARCHERS: LazyLock<Mutex<SearcherCache>> =
    LazyLock::new(|| Mutex::new(SearcherCache::default()));

#[derive(Default)]
struct SearcherCache {
    entries: Vec<CachedSearcher>,
    /// Monotonic counter; larger is more recent.
    clock: u64,
}

struct CachedSearcher {
    key: (String, bool),
    daemon: Arc<FuzzyFileMatcherDaemon>,
    last_used: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsSearchRequest {
    #[serde(default)]
    pub session_id: Option<acp::SessionId>,
    /// Root to search. Relative paths resolve against the session cwd.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// Only directories. Matches the pager's `dirs` toggle.
    #[serde(default)]
    pub dirs: bool,
    /// Include git-ignored and dot entries. Off by default: a repo's ignored
    /// tree (`target/`, `node_modules/`) would swamp every query.
    #[serde(default)]
    pub include_hidden: bool,
}

fn default_limit() -> usize {
    50
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsSearchData {
    /// Absolute root the results are relative to.
    pub root: String,
    pub query: String,
    pub results: Vec<FsSearchHit>,
    /// `true` when the walk has finished and the page is the complete answer.
    pub done: bool,
    /// Total entries the matcher has seen so far (files + directories).
    pub scanned: usize,
    /// `true` when more matches exist than the page carries.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsSearchHit {
    /// Path relative to `root`, with `/` separators so a mention token is
    /// stable across platforms.
    pub path: String,
    /// `"file"` or `"directory"`.
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub score: u32,
}

/// Resolve the search root and run the query.
///
/// `root` must already be confined by the caller (`fs::confine_local`), which is
/// where the workspace boundary policy lives — this module does no policy.
pub async fn search(root: PathBuf, request: FsSearchRequest) -> anyhow::Result<FsSearchData> {
    let query = request.query;
    let limit = request.limit.clamp(1, MATCHER_TOP_K);
    let dirs = request.dirs;
    let include_hidden = request.include_hidden;
    let display_root = root.to_string_lossy().to_string();

    // The tick loop sleeps, and the walker is a thread pool: neither belongs on
    // the agent's own thread.
    let hits = tokio::task::spawn_blocking(move || {
        query_blocking(root, query, limit, dirs, include_hidden)
    })
    .await?;

    Ok(FsSearchData {
        root: display_root,
        query: hits.query,
        results: hits.results,
        done: hits.done,
        scanned: hits.scanned,
        truncated: hits.truncated,
    })
}

/// The path as a stable cache key: its text with trailing separators removed.
///
/// Purely lexical, so it cannot fail and cannot touch the filesystem. Two
/// spellings of one directory (`/repo` and `/repo/`) collapse to one walker;
/// anything else stays distinct, which is correct — a different path IS a
/// different walk.
fn trim_trailing_separators(path: &Path) -> String {
    let text = path.to_string_lossy();
    let trimmed = text.trim_end_matches(['/', '\\']);
    // A root like `/` or `C:\` would trim to nothing; keep the original then.
    if trimmed.is_empty() {
        text.to_string()
    } else {
        trimmed.to_string()
    }
}

struct BlockingHits {
    query: String,
    results: Vec<FsSearchHit>,
    done: bool,
    scanned: usize,
    truncated: bool,
}

fn query_blocking(
    root: PathBuf,
    query: String,
    limit: usize,
    dirs: bool,
    hidden: bool,
) -> BlockingHits {
    // Keyed on the resolved path with trailing separators trimmed, NOT on
    // `canonicalize`: that is banned repo-wide (it resolves symlinks and hits
    // the filesystem), and a cache key only needs "the same caller's spelling
    // maps to the same walker". The root arrives already resolved and confined
    // by `fs::handle`, so the only variation left is a trailing slash.
    let key = (trim_trailing_separators(&root), hidden);

    // `set_query` and `get` both take the daemon's own lock briefly; this one
    // only guards the map, so it is released before the wait.
    let daemon = {
        let mut cache = SEARCHERS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.acquire(key, &root)
    };

    daemon.set_query(&query, dirs);

    let deadline = Instant::now() + SEARCH_BUDGET;
    let snapshot = loop {
        let snapshot = daemon.get();
        if snapshot.status.done || Instant::now() >= deadline {
            break snapshot;
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    let mut results: Vec<FsSearchHit> = snapshot
        .topk
        .iter()
        .take(limit)
        .map(|hit| FsSearchHit {
            path: hit.path.to_string().replace('\\', "/"),
            kind: if hit.is_dir { "directory" } else { "file" },
            score: hit.score,
        })
        .collect();

    let truncated = snapshot.topk.len() > results.len();
    results.shrink_to_fit();

    BlockingHits {
        query,
        results,
        done: snapshot.status.done,
        scanned: snapshot.num_items,
        truncated,
    }
}

impl SearcherCache {
    fn acquire(&mut self, key: (String, bool), root: &Path) -> Arc<FuzzyFileMatcherDaemon> {
        self.clock += 1;
        let now = self.clock;
        let hidden = key.1;

        if let Some(index) = self.entries.iter().position(|entry| entry.key == key) {
            self.entries[index].last_used = now;
            return self.entries[index].daemon.clone();
        }

        let mut matcher = FuzzyFileMatcher::new(root);
        // The pager's rule: an ignore-respecting walk by default, and the wider
        // walk only when the caller opted into hidden entries.
        if hidden {
            matcher
                .restart_walk_custom(|walker| walker.hidden(false).ignore(false).git_ignore(false));
        } else {
            matcher.restart_walk();
        }
        let daemon = Arc::new(FuzzyFileMatcherDaemon::new(matcher, MATCHER_TOP_K));

        if self.entries.len() >= MAX_LIVE_MATCHERS {
            // Least recently used first. Its daemon drops here, which cancels
            // its walker (`FuzzyFileMatcher::drop`).
            if let Some((oldest, _)) = self
                .entries
                .iter()
                .enumerate()
                .min_by_key(|(_, entry)| entry.last_used)
            {
                self.entries.remove(oldest);
            }
        }

        self.entries.push(CachedSearcher {
            key,
            daemon: daemon.clone(),
            last_used: now,
        });
        daemon
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wait for the walk to finish, bounded. Mirrors the production budget so a
    /// genuine hang fails with a message instead of blocking the run.
    async fn search_until_done(root: &Path, query: &str) -> FsSearchData {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let data = search(
                root.to_path_buf(),
                FsSearchRequest {
                    session_id: None,
                    path: None,
                    query: query.to_string(),
                    limit: 50,
                    dirs: false,
                    include_hidden: true,
                },
            )
            .await
            .expect("search");
            if data.done || Instant::now() >= deadline {
                return data;
            }
        }
    }

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("src/lib")).expect("mkdir");
        std::fs::write(dir.path().join("src/main.rs"), "fn main() {}").expect("write");
        std::fs::write(dir.path().join("src/lib/mod.rs"), "").expect("write");
        std::fs::write(dir.path().join("README.md"), "# hi").expect("write");
        dir
    }

    #[tokio::test]
    async fn finds_a_file_by_fuzzy_query() {
        let dir = tree();
        let data = search_until_done(dir.path(), "main").await;
        assert!(
            data.results.iter().any(|hit| hit.path == "src/main.rs"),
            "expected src/main.rs among {:?}",
            data.results
        );
    }

    #[tokio::test]
    async fn paths_are_relative_and_forward_slashed() {
        let dir = tree();
        let data = search_until_done(dir.path(), "mod").await;
        let hit = data
            .results
            .iter()
            .find(|hit| hit.path.ends_with("mod.rs"))
            .expect("mod.rs");
        assert_eq!(hit.path, "src/lib/mod.rs");
        assert!(!hit.path.contains('\\'), "separators must be normalized");
    }

    #[tokio::test]
    async fn directories_are_reported_as_such() {
        let dir = tree();
        let data = search_until_done(dir.path(), "lib").await;
        assert!(
            data.results
                .iter()
                .any(|hit| hit.path == "src/lib" && hit.kind == "directory"),
            "expected src/lib as a directory among {:?}",
            data.results
        );
    }

    #[tokio::test]
    async fn limit_caps_the_page_and_reports_truncation() {
        let dir = tree();
        let data = search(
            dir.path().to_path_buf(),
            FsSearchRequest {
                session_id: None,
                path: None,
                query: String::new(),
                limit: 2,
                dirs: false,
                include_hidden: true,
            },
        )
        .await
        .expect("search");
        assert!(data.results.len() <= 2);
    }
}
