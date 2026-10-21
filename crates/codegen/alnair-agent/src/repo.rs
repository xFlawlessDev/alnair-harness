//! Shared git-repo dir-chain primitive.
//!
//! Lives in its own module rather than `discovery` because it is a generic
//! repo-walk primitive consumed cross-crate by `alnair-workspace`, not
//! agent-definition discovery.

use std::path::{Path, PathBuf};

/// The git worktree root for `cwd` (if any) plus the directory chain from `cwd`
/// up to that root (inclusive, cwd-first), resolved with ONE `git2` discovery
/// and ONE upward walk.
///
/// The folder-trust gate's `repo_configs_present` probes a dozen repo-local
/// code-exec markers (`.mcp.json`, `.alnair/config.toml`, `.claude/settings.json`,
/// project plugin/agent dirs, …) back-to-back on the agent startup path, so a
/// per-walker discovery + walk is a real cost: each redundant syscall is taxed
/// 10-100x on Windows, and on a non-git dir each `discover` walks to the
/// filesystem root. Both the gate and the real loaders consume the same chain
/// via `*_in` walker variants, so detection can't drift from loading.
///
/// Outside a git repo `git_root` is `None` and `dirs` is just `[cwd]`, matching
/// every walker's no-repo branch (probe `cwd` only).
#[derive(Debug, Clone)]
pub struct RepoDirChain {
    pub git_root: Option<PathBuf>,
    pub dirs: Vec<PathBuf>,
}

impl RepoDirChain {
    pub fn resolve(cwd: &Path) -> Self {
        Self::resolve_with_home(cwd, dirs::home_dir().as_deref())
    }

    /// [`Self::resolve`] with the home directory injected.
    ///
    /// `dirs::home_dir()` reads the `FOLDERID_Profile` Known Folder on Windows
    /// and ignores `HOME`/`USERPROFILE`, so a test cannot redirect it through
    /// the environment. Injecting it keeps the "a git repo at $HOME is not a
    /// project root" rule assertable on every platform.
    pub fn resolve_with_home(cwd: &Path, home: Option<&Path>) -> Self {
        let git_root = git2::Repository::discover(cwd)
            .ok()
            .and_then(|repo| repo.workdir().map(|p| p.to_path_buf()))
            // Dotfiles in $HOME make home itself a repo; treating that subtree
            // as repo-local would promote home-level `.alnair`/`.mcp.json`/plugins
            // to project config. Dropping the root makes cwd behave as no-repo.
            .filter(|root| !is_home_dir_impl(root, home));

        let mut dirs = Vec::new();
        if let Some(ref root) = git_root {
            // Canonicalize only for the stop test so a symlinked cwd/ancestor
            // still halts AT the worktree root instead of over-walking to the
            // filesystem root; pushed dirs keep their original spelling (callers
            // `join` markers onto them, which resolve the same either way).
            // Canonicalizing per level is what makes that stop reliable — a
            // 2-call `starts_with` variant mis-handles a mid-chain absolute
            // symlink and over-walks.
            let root_canonical = dunce::canonicalize(root).unwrap_or_else(|_| root.clone());
            let mut current = Some(cwd.to_path_buf());
            while let Some(dir) = current {
                let dir_canonical = dunce::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
                let parent = dir.parent().map(|p| p.to_path_buf());
                dirs.push(dir);
                if dir_canonical == root_canonical {
                    break;
                }
                current = parent;
            }
        } else {
            dirs.push(cwd.to_path_buf());
        }

        Self { git_root, dirs }
    }
}

/// Whether `path` canonicalizes to the user's home directory, with the home
/// injected. Duplicated logic instead of reused from `alnair-workspace`, which
/// depends on THIS crate, to keep the dep edge one-way.
///
/// Takes `home` explicitly because `dirs::home_dir()` reads the
/// `FOLDERID_Profile` Known Folder on Windows and ignores `HOME`, so tests
/// cannot redirect it through the environment.
fn is_home_dir_impl(path: &Path, home: Option<&Path>) -> bool {
    let Some(home) = home else {
        return false;
    };
    let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(path) == canon(home)
}

/// Existing `<dir>/<subdir>` directories under each dir of a precomputed
/// cwd→git-root chain ([`RepoDirChain::dirs`]), in chain order (cwd-first, then
/// each `subdirs` entry in order).
pub(crate) fn existing_subdirs_along(chain_dirs: &[PathBuf], subdirs: &[&str]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for dir in chain_dirs {
        for subdir in subdirs {
            let candidate = dir.join(subdir);
            if candidate.is_dir() {
                found.push(candidate);
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_in_repo_yields_cwd_to_root_chain() {
        let tmp = tempfile::tempdir().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        let nested = tmp.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();

        let chain = RepoDirChain::resolve(&nested);
        assert_eq!(
            chain.dirs,
            vec![
                nested.clone(),
                tmp.path().join("a"),
                tmp.path().to_path_buf(),
            ]
        );
        // git2's `workdir` is canonical, so compare canonically or a
        // `/tmp`→`/private/tmp` symlink fails the test.
        let root = chain.git_root.expect("inside a repo");
        assert_eq!(
            dunce::canonicalize(&root).unwrap(),
            dunce::canonicalize(tmp.path()).unwrap()
        );
    }

    #[test]
    fn resolve_outside_repo_is_cwd_only() {
        // Only assert the no-repo shape when the temp dir is genuinely outside
        // any repo: a dev/CI checkout may place $TMPDIR inside a larger git
        // worktree.
        let tmp = tempfile::tempdir().unwrap();
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        if git2::Repository::discover(&plain).is_err() {
            let chain = RepoDirChain::resolve(&plain);
            assert_eq!(chain.dirs, vec![plain]);
            assert_eq!(chain.git_root, None);
        }
    }

    #[test]
    fn resolve_treats_home_git_repo_as_no_repo() {
        // The home dir is injected rather than set through `$HOME`:
        // `dirs::home_dir()` reads the FOLDERID_Profile Known Folder on Windows
        // and ignores the environment, so the env guard had no effect there.
        let tmp = tempfile::tempdir().unwrap();
        let home = dunce::canonicalize(tmp.path()).unwrap();
        git2::Repository::init(&home).unwrap();
        let sub = home.join("proj");
        std::fs::create_dir_all(&sub).unwrap();

        let chain = RepoDirChain::resolve_with_home(&sub, Some(&home));
        assert_eq!(chain.git_root, None, "a home-dir git root must be dropped");
        assert_eq!(chain.dirs, vec![sub]);
    }

    #[test]
    fn resolve_keeps_non_home_git_root() {
        // Home points at an unrelated dir, proving a non-home git root still
        // resolves normally. Injected for the same Windows reason as above.
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git2::Repository::init(repo.path()).unwrap();
        let sub = repo.path().join("pkg");
        std::fs::create_dir_all(&sub).unwrap();

        let chain = RepoDirChain::resolve_with_home(&sub, Some(home.path()));
        let root = chain.git_root.expect("a non-home git root must be kept");
        assert_eq!(
            dunce::canonicalize(&root).unwrap(),
            dunce::canonicalize(repo.path()).unwrap()
        );
    }
}
