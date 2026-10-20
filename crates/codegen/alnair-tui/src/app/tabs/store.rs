//! Cross-process tab state in `~/.alnair/run/pager_tabs.json`.
//!
//! Two pagers share one leader, so they must agree on the strip. The file is
//! the agreement: each writer takes an exclusive lock, reads, mutates, and
//! commits atomically, so the last writer never clobbers a concurrent one.
//!
//! ## Why `run/`
//!
//! `run/` is one of the `HOME_STATE_DIRS` subtrees that stays writable when the
//! strict sandbox profile is active (`alnair-sandbox/src/paths.rs`). Tab state
//! is disposable, but it must not silently stop persisting for a sandboxed
//! process, so it lives beside the leader socket rather than under a new
//! directory.
//!
//! This is **not** `config.toml`: it must never go through `config_write_dest`
//! and never follow a symlink. Writing is gated on a resolvable user home, so a
//! launch that resolves `alnair_home()` to the project's own `./.alnair` (no
//! home directory) simply does not persist tabs instead of writing into a repo.
//!
//! ## Concurrency contract
//!
//! - Writers: `open_lock_file` (`create(true).truncate(false)`) → `lock_exclusive`
//!   → read → mutate → tmp write → [`replace_file`] → unlock. The lock is held
//!   across the WHOLE read-modify-write, matching
//!   `session/storage/summary_write.rs::apply_patch_locked`. Truncating the lock
//!   inode would let two handles lock different files.
//! - Readers: no lock. A writer always commits atomically, so a reader sees
//!   either the previous or the next complete document.
//! - A missing file is `NotFound` → empty, never an error. On Windows
//!   [`replace_file`] deletes the destination before renaming, so a poller can
//!   legitimately observe absence for a few milliseconds; treating that as
//!   corruption would blank the strip for no reason.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use super::TabEntry;

const DATA_FILENAME: &str = "pager_tabs.json";
const LOCK_FILENAME: &str = "pager_tabs.json.lock";
const TMP_FILENAME: &str = "pager_tabs.json.tmp";
const VERSION: u32 = 1;

/// Which sessions the strip lists.
///
/// Stored **inside** the file, not only in config: two clients must agree on the
/// interpretation even if one of them changes its config mid-session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TabScope {
    /// One list across every session the leader hosts (default).
    #[default]
    Global,
    /// One list per working directory.
    Cwd,
}

impl TabScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Cwd => "cwd",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "global" => Some(Self::Global),
            "cwd" => Some(Self::Cwd),
            _ => None,
        }
    }
}

/// One scope's tab list as persisted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedTabs {
    #[serde(default)]
    pub tabs: Vec<TabEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<usize>,
}

/// The whole file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabState {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub scope: TabScope,
    #[serde(default)]
    pub global: PersistedTabs,
    #[serde(default)]
    pub cwd: std::collections::BTreeMap<String, PersistedTabs>,
}

fn default_version() -> u32 {
    VERSION
}

impl Default for TabState {
    fn default() -> Self {
        Self {
            version: VERSION,
            scope: TabScope::Global,
            global: PersistedTabs::default(),
            cwd: std::collections::BTreeMap::new(),
        }
    }
}

impl TabState {
    /// The list for `scope`, keyed by `cwd_key` when the scope is per-directory.
    pub fn list(&self, scope: TabScope, cwd_key: &str) -> &PersistedTabs {
        match scope {
            TabScope::Global => &self.global,
            TabScope::Cwd => self.cwd.get(cwd_key).unwrap_or(&EMPTY),
        }
    }

    /// Mutable access, inserting an empty entry for a new cwd.
    pub fn list_mut(&mut self, scope: TabScope, cwd_key: &str) -> &mut PersistedTabs {
        match scope {
            TabScope::Global => &mut self.global,
            TabScope::Cwd => self.cwd.entry(cwd_key.to_string()).or_default(),
        }
    }
}

static EMPTY: PersistedTabs = PersistedTabs {
    tabs: Vec::new(),
    active: None,
};

/// `~/.alnair/run`, or `None` when there is no real user home.
///
/// Without a resolvable user home, `alnair_home()` is the project's own
/// `./.alnair`; writing tab state there would put machine-local layout into a
/// repository, so persistence simply switches off.
pub fn store_root() -> Option<PathBuf> {
    alnair_config::user_alnair_home().map(|home| home.join("run"))
}

/// Read the whole file. Missing → default. A parse failure warns and returns
/// the default, leaving the file untouched (it may be from a newer version).
pub fn load() -> TabState {
    match store_root() {
        Some(root) => load_in(&root),
        None => TabState::default(),
    }
}

pub fn load_in(root: &Path) -> TabState {
    let path = root.join(DATA_FILENAME);
    match fs::read(&path) {
        Ok(bytes) if bytes.is_empty() => TabState::default(),
        Ok(bytes) => match serde_json::from_slice::<TabState>(&bytes) {
            Ok(state) => state,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "pager_tabs.json is unreadable; starting with an empty tab list (file left in place)"
                );
                TabState::default()
            }
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => TabState::default(),
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "failed to read pager_tabs.json");
            TabState::default()
        }
    }
}

/// Read-modify-write under an exclusive lock.
///
/// The closure gets the freshly-read state and mutates it in place; whatever it
/// leaves behind is committed atomically. Returns `None` when there is no store
/// root (see [`store_root`]).
pub fn update<F>(mutate: F) -> io::Result<Option<()>>
where
    F: FnOnce(&mut TabState),
{
    match store_root() {
        Some(root) => update_in(&root, mutate).map(Some),
        None => Ok(None),
    }
}

pub fn update_in<F>(root: &Path, mutate: F) -> io::Result<()>
where
    F: FnOnce(&mut TabState),
{
    fs::create_dir_all(root)?;
    let lock_path = root.join(LOCK_FILENAME);
    let data_path = root.join(DATA_FILENAME);
    let tmp_path = root.join(TMP_FILENAME);

    let lock = open_lock_file(&lock_path)?;
    lock.lock_exclusive()?;
    let mut state = load_in(root);
    mutate(&mut state);
    let result = write_atomic(&tmp_path, &data_path, &state);
    let _ = lock.unlock();
    result
}

fn open_lock_file(path: &Path) -> io::Result<File> {
    // `truncate(false)` matters: truncating the lock inode lets two handles end
    // up locking different files and silently defeats the whole scheme.
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

fn write_atomic(tmp_path: &Path, data_path: &Path, state: &TabState) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(state)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(tmp_path, &json)?;
    // The ONE atomic-replace commit step (tmp + rename, Windows-safe).
    alnair_shell::util::fs::replace_file(tmp_path, data_path)
}

/// Cheap staleness probe for the draw tick: `(mtime, len)` of the data file.
///
/// `None` when the file is absent — which is also a legitimate transient state
/// on Windows while `replace_file` swaps, so callers must treat it as "no
/// change" rather than "the file is gone".
pub fn stamp(root: &Path) -> Option<(std::time::SystemTime, u64)> {
    let meta = fs::metadata(root.join(DATA_FILENAME)).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}
