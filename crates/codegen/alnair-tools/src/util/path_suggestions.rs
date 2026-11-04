//! Path-not-found enrichment hints for tool error messages.
//!
//! Enriches "does not exist" errors from `list_dir`, `read_file`,
//! `search_replace`, and `grep` with actionable hints.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Ceiling for the single blocking-thread filesystem probe.
const HINT_TIMEOUT: Duration = Duration::from_millis(100);
/// Max similar-name suggestions
const MAX_SIMILAR: usize = 3;
/// Reduces noise from single-character names that would match on too many entries
const MIN_LEAF_LEN: usize = 2;
/// Minimum stem length for reverse substring matching (query contains entry).
/// Prevents short stems from over-matching.
const MIN_REVERSE_STEM_LEN: usize = 4;

/// Enrichment hints for a path that was not found.
#[derive(Debug, Clone)]
pub struct PathNotFoundHint {
    /// A corrected path from "dropped repo folder" detection.
    ///
    /// **Display space, always forward-slashed.** This is the spelling the model
    /// is meant to retype, not a handle to the filesystem: it comes from
    /// joining the *display* cwd with the corrected relative part, and no caller
    /// may use it to open a file. Building it with `Path::join` would make the
    /// separator depend on the host, so a Windows remap of
    /// `/home/user/project` plus `src` produced `/home/user/project\src` —
    /// a path that is neither valid on the host nor readable as the POSIX shape
    /// the model reasons about.
    pub suggestion: Option<PathBuf>,
    /// Up to [`MAX_SIMILAR`] entries from the parent directory whose names
    /// are case-insensitive substring matches of the missing leaf.
    pub similar: Vec<PathBuf>,
    /// Always-present CWD note for model re-orientation.
    pub cwd_note: String,
}

impl fmt::Display for PathNotFoundHint {
    /// Formats as a suffix to append after `"Error: {path} does not exist."`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(ref s) = self.suggestion {
            write!(f, " Did you mean {}?", s.display())?;
        } else if !self.similar.is_empty() {
            let names: Vec<&str> = self
                .similar
                .iter()
                .filter_map(|p| p.file_name().and_then(|n| n.to_str()))
                .collect();
            write!(
                f,
                "\nSimilar entries in parent directory: {}",
                names.join(", ")
            )?;
        }

        write!(f, "\n{}", self.cwd_note)
    }
}

/// Build hints for a path-not-found error.
///
/// `path` is the resolved (real) filesystem path that failed.
/// `display_cwd` is the model-facing working directory (for the CWD note).
#[tracing::instrument(name = "fs.path_not_found_hint", skip_all)]
pub async fn path_not_found_hint(path: &Path, cwd: &Path, display_cwd: &Path) -> PathNotFoundHint {
    let cwd_note = format!(
        "Note: your current working directory is {}",
        display_cwd.display()
    );

    // All filesystem probing runs in a single spawn_blocking.
    let path_owned = path.to_path_buf();
    let cwd_owned = cwd.to_path_buf();

    let result = tokio::time::timeout(
        HINT_TIMEOUT,
        tokio::task::spawn_blocking(move || collect_hints(&path_owned, &cwd_owned)),
    )
    .await;

    let (suggestion, similar) = match result {
        Ok(Ok(val)) => val,
        _ => (None, Vec::new()),
    };

    // Remap resolved worktree path to display space so the model never
    // sees internal paths (e.g. /worktree/abc-123/...).
    let suggestion = suggestion.map(|corrected| match corrected.strip_prefix(cwd) {
        Ok(rel) => join_display_path(display_cwd, rel),
        Err(_) => {
            tracing::warn!(
                corrected = %corrected.display(),
                cwd = %cwd.display(),
                "corrected path not under cwd; falling back to corrected path"
            );
            corrected
        }
    });

    PathNotFoundHint {
        suggestion,
        similar,
        cwd_note,
    }
}

/// Join a relative path onto a display-space base with `/` separators.
///
/// `Path::join` would use the host separator, so a Windows run remapping
/// `/home/user/project` plus `src` yields `/home/user/project\src`: mixed,
/// invalid on the host, and unreadable as the POSIX shape the model works in.
/// The result here is display text — the model is meant to retype it — so the
/// separator is a presentation choice, and `/` is the one every model reads.
///
/// Components are joined one at a time because the base may itself be a
/// multi-component relative path; string concatenation would get the separator
/// between base and tail right but not inside the tail.
fn join_display_path(base: &Path, tail: &Path) -> PathBuf {
    let mut out = base.to_string_lossy().replace('\\', "/");

    for component in tail.components() {
        // Only normal components belong in a display path; `.` is noise and a
        // `..` here would mean the correction escaped the cwd, which
        // `try_suggest_under_cwd` has already ruled out.
        let std::path::Component::Normal(part) = component else {
            continue;
        };
        if !out.ends_with('/') {
            out.push('/');
        }
        out.push_str(&part.to_string_lossy());
    }

    PathBuf::from(out)
}

/// Format a path-not-found error message.
///
/// When `hints_enabled` is `false`, returns a bare error string.
/// When `true`, appends CWD note, "did you mean?" correction, or similar-name
/// suggestions via [`path_not_found_hint`].
///
/// `display_path` is the model-facing path (for the error message).
/// `resolved_path` is the real filesystem path (for hint lookups).
pub async fn format_not_found_error(
    display_path: &Path,
    resolved_path: &Path,
    cwd: &Path,
    display_cwd: &Path,
    hints_enabled: bool,
) -> String {
    let base = format!("Error: {} does not exist.", display_path.display());
    if !hints_enabled {
        return base;
    }
    let hint = path_not_found_hint(resolved_path, cwd, display_cwd).await;
    format!("{base}{hint}")
}

/// Returns `(suggestion, similar)` where `suggestion` is a corrected path from
/// "dropped repo folder" detection (raw, not yet remapped to display space) and
/// `similar` is a list of substring-matched sibling entries.
fn collect_hints(path: &Path, cwd: &Path) -> (Option<PathBuf>, Vec<PathBuf>) {
    if let Some(corrected) = try_suggest_under_cwd(path, cwd) {
        return (Some(corrected), Vec::new());
    }
    (None, find_similar_entries(path))
}

/// Detect the "dropped repo folder" pattern.
///
/// If the model asks for `/parent/foo` but cwd is `/parent/repo`, check
/// whether `/parent/repo/foo` exists. Only fires when the requested path
/// is under cwd's parent but not already under cwd.
fn try_suggest_under_cwd(path: &Path, cwd: &Path) -> Option<PathBuf> {
    if !path.is_absolute() || path.starts_with(cwd) {
        return None;
    }

    let cwd_parent = cwd.parent()?;
    let rel_from_parent = path.strip_prefix(cwd_parent).ok()?;

    // Guard against existing paths outside of repo.
    if let Some(std::path::Component::Normal(first)) = rel_from_parent.components().next() {
        let sibling = cwd_parent.join(first);
        if sibling != cwd && sibling.exists() {
            return None;
        }
    }

    let candidate = cwd.join(rel_from_parent);
    candidate.exists().then_some(candidate)
}

/// Scan the parent directory for entries whose names are case-insensitive
/// substring matches of the missing leaf name.
fn find_similar_entries(path: &Path) -> Vec<PathBuf> {
    let parent = match path.parent() {
        Some(p) => p,
        None => return Vec::new(),
    };
    let base = match path.file_name().and_then(|n| n.to_str()) {
        Some(b) if b.len() >= MIN_LEAF_LEN => b.to_lowercase(),
        _ => return Vec::new(),
    };

    // Strip extension from the query leaf for stem-level comparison.
    let base_stem = Path::new(&base)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&base)
        .to_lowercase();

    let read_dir = match std::fs::read_dir(parent) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    let mut matches = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name == base {
            continue;
        }

        let name_stem = Path::new(&name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&name)
            .to_lowercase();

        // Find file matches that are substrings or reverse substrings up to MIN_REVERSE_STEM_LEN
        let forward = name_stem.contains(&base_stem);
        let reverse =
            !forward && name_stem.len() >= MIN_REVERSE_STEM_LEN && base_stem.contains(&name_stem);
        if forward || reverse {
            matches.push(entry.path());
            if matches.len() >= MAX_SIMILAR {
                break;
            }
        }
    }
    matches
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // Unit tests here cover internal invariants (guards, caps, priority,
    // Display formatting). Broader integration fixtures live in
    // tests/path_suggestions_production.rs.

    #[tokio::test]
    async fn cwd_note_always_present() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path();
        let missing = cwd.join("nonexistent");

        let hint = path_not_found_hint(&missing, cwd, cwd).await;

        assert!(hint.cwd_note.contains(&cwd.display().to_string()));
        assert!(hint.suggestion.is_none());
        assert!(hint.similar.is_empty());
    }

    #[tokio::test]
    async fn dropped_repo_folder_detected() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let target = repo.join("src");
        std::fs::create_dir_all(&target).unwrap();

        let bad_path = tmp.path().join("src");
        let hint = path_not_found_hint(&bad_path, &repo, &repo).await;

        assert_eq!(hint.suggestion.as_deref(), Some(target.as_path()));
    }

    #[tokio::test]
    async fn dropped_repo_folder_not_triggered_for_path_under_cwd() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_path_buf();
        let path = cwd.join("some_missing_file.rs");

        let hint = path_not_found_hint(&path, &cwd, &cwd).await;

        assert!(hint.suggestion.is_none());
    }

    #[tokio::test]
    async fn dropped_repo_folder_not_triggered_for_existing_sibling() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let repo_backup = tmp.path().join("repo_backup");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&repo_backup).unwrap();
        std::fs::create_dir_all(repo.join("repo_backup")).unwrap();
        std::fs::write(repo.join("repo_backup/config"), b"").unwrap();

        let bad_path = repo_backup.join("config");
        let hint = path_not_found_hint(&bad_path, &repo, &repo).await;

        assert!(
            hint.suggestion.is_none(),
            "should not suggest path under cwd when model targets an existing sibling"
        );
    }

    #[tokio::test]
    async fn suggestion_takes_priority_over_similar_scan() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::create_dir(tmp.path().join("src_old")).unwrap();

        let bad_path = tmp.path().join("src");
        let hint = path_not_found_hint(&bad_path, &repo, &repo).await;

        assert!(hint.suggestion.is_some());
        assert!(hint.similar.is_empty());
    }

    #[tokio::test]
    async fn similar_name_multi_match() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("helpers.rs"), b"").unwrap();
        std::fs::write(tmp.path().join("helper_test.rs"), b"").unwrap();

        let missing = tmp.path().join("helper");
        let hint = path_not_found_hint(&missing, tmp.path(), tmp.path()).await;

        let names: Vec<String> = hint
            .similar
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
            .collect();
        assert!(names.contains(&"helpers.rs".to_string()), "got: {names:?}");
        assert!(
            names.contains(&"helper_test.rs".to_string()),
            "got: {names:?}"
        );
    }

    #[tokio::test]
    async fn similar_name_cap_at_max() {
        let tmp = TempDir::new().unwrap();
        for i in 0..10 {
            std::fs::write(tmp.path().join(format!("test_{i}.rs")), b"").unwrap();
        }

        let missing = tmp.path().join("test");
        let hint = path_not_found_hint(&missing, tmp.path(), tmp.path()).await;

        assert_eq!(hint.similar.len(), MAX_SIMILAR);
    }

    #[tokio::test]
    async fn similar_name_short_entry_not_matched() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("he"), b"").unwrap();
        std::fs::write(tmp.path().join("rs"), b"").unwrap();

        let missing = tmp.path().join("helpers_test");
        let hint = path_not_found_hint(&missing, tmp.path(), tmp.path()).await;

        assert!(
            hint.similar.is_empty(),
            "short entries should not match: got {:?}",
            hint.similar
        );
    }

    #[test]
    fn display_with_suggestion() {
        let hint = PathNotFoundHint {
            suggestion: Some(PathBuf::from("/project/repo/src")),
            similar: Vec::new(),
            cwd_note: "Note: your current working directory is /project/repo".into(),
        };
        let output = hint.to_string();
        assert!(output.contains("Did you mean /project/repo/src?"));
        assert!(output.contains("Note: your current working directory is"));
    }

    #[test]
    fn display_with_similar() {
        let hint = PathNotFoundHint {
            suggestion: None,
            similar: vec![
                PathBuf::from("/project/helpers.rs"),
                PathBuf::from("/project/helper_test.rs"),
            ],
            cwd_note: "Note: your current working directory is /project".into(),
        };
        let output = hint.to_string();
        assert!(output.contains("Similar entries in parent directory:"));
        assert!(output.contains("helpers.rs"));
        assert!(output.contains("helper_test.rs"));
    }

    #[test]
    fn display_empty() {
        let hint = PathNotFoundHint {
            suggestion: None,
            similar: Vec::new(),
            cwd_note: "Note: your current working directory is /project".into(),
        };
        let output = hint.to_string();
        assert!(!output.contains("Did you mean"));
        assert!(!output.contains("Similar entries"));
        assert!(output.contains("Note: your current working directory is /project"));
    }

    // Display-space path joining

    /// The remapped suggestion must never mix separators, whatever the host.
    /// This is the invariant the integration test pins from one direction; here
    /// it is asserted directly so a regression names the cause.
    #[test]
    fn display_join_never_mixes_separators() {
        let tail = Path::new("src").join("main.rs");
        let joined = join_display_path(Path::new("/home/user/project"), &tail);
        let rendered = joined.to_string_lossy();
        assert_eq!(rendered, "/home/user/project/src/main.rs");
        assert!(
            !rendered.contains('\\'),
            "a display path must not carry a host separator: {rendered}"
        );
    }

    /// A base that already ends in a separator must not gain a second one.
    #[test]
    fn display_join_does_not_double_the_separator() {
        let joined = join_display_path(Path::new("/home/user/project/"), Path::new("src"));
        assert_eq!(joined.to_string_lossy(), "/home/user/project/src");
    }

    /// A multi-component tail must be joined component by component; string
    /// concatenation would leave the tail's own separators host-native.
    #[test]
    fn display_join_handles_a_multi_component_tail() {
        let tail = Path::new("crates").join("a").join("lib.rs");
        let joined = join_display_path(Path::new("/repo"), &tail);
        assert_eq!(joined.to_string_lossy(), "/repo/crates/a/lib.rs");
    }

    /// A Windows-style base is normalized too, so a remap onto a host-native
    /// display cwd still renders as POSIX.
    #[test]
    fn display_join_normalizes_a_backslashed_base() {
        let joined = join_display_path(Path::new(r"C:\Users\dev\project"), Path::new("src"));
        assert_eq!(joined.to_string_lossy(), "C:/Users/dev/project/src");
    }

    /// The whole remap, end to end: the resolved path must not leak and the
    /// result must be display-space with `/`.
    #[tokio::test]
    async fn dropped_folder_remap_yields_a_posix_display_path() {
        let tmp = TempDir::new().unwrap();
        let resolved_cwd = tmp.path().join("worktree").join("project");
        std::fs::create_dir_all(resolved_cwd.join("src")).unwrap();
        let display_cwd = PathBuf::from("/home/user/project");

        let resolved_missing = tmp.path().join("worktree").join("src");
        let hint = path_not_found_hint(&resolved_missing, &resolved_cwd, &display_cwd).await;

        let suggestion = hint
            .suggestion
            .expect("the dropped-folder pattern must fire")
            .to_string_lossy()
            .into_owned();
        assert_eq!(suggestion, "/home/user/project/src");
        assert!(!suggestion.contains("worktree"), "resolved path leaked");
    }
}
