use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer_opt};
use tokio::sync::mpsc;

const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(1000);

/// A [`notify::Watcher`] that drops `EventKind::Access` before it reaches the
/// debouncer, breaking the MCP/skills reload storm.
///
/// `notify`'s inotify backend emits an `Access` event on every *read*, and the
/// leader re-reads the files it watches on each reload — so unfiltered, a
/// reload's own reads schedule the next reload, a ~1/sec self-sustaining loop.
/// Dropping `Access` is safe: writes still emit `Modify`/`Create` and chmod
/// emits `Modify(Metadata)`; only reads are `Access`-only.
pub struct AccessFilteredWatcher(notify::RecommendedWatcher);

impl notify::Watcher for AccessFilteredWatcher {
    fn new<F: notify::EventHandler>(
        mut event_handler: F,
        config: notify::Config,
    ) -> notify::Result<Self>
    where
        Self: Sized,
    {
        let inner = notify::RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| match &res {
                Ok(event) if matches!(event.kind, notify::EventKind::Access(_)) => {}
                _ => event_handler.handle_event(res),
            },
            config,
        )?;
        Ok(Self(inner))
    }

    fn watch(&mut self, path: &Path, recursive_mode: RecursiveMode) -> notify::Result<()> {
        self.0.watch(path, recursive_mode)
    }

    fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        self.0.unwatch(path)
    }

    fn configure(&mut self, option: notify::Config) -> notify::Result<bool> {
        self.0.configure(option)
    }

    fn kind() -> notify::WatcherKind
    where
        Self: Sized,
    {
        notify::RecommendedWatcher::kind()
    }
}

/// `new_debouncer` equivalent that builds the debouncer on top of
/// [`AccessFilteredWatcher`] instead of the raw `RecommendedWatcher`.
fn new_filtered_debouncer<F: notify_debouncer_mini::DebounceEventHandler>(
    timeout: Duration,
    event_handler: F,
) -> Result<Debouncer<AccessFilteredWatcher>, notify::Error> {
    let config = notify_debouncer_mini::Config::default().with_timeout(timeout);
    new_debouncer_opt::<F, AccessFilteredWatcher>(config, event_handler)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigChangeEvent {
    AuthChanged,
    GlobalConfigChanged,
    /// `~/.alnair/models_cache.json` changed — the on-disk `/v1/models`
    /// catalog cache was rewritten, possibly by **another** alnair process
    /// sharing the same `~/.alnair` (the writer may also be this process;
    /// the [`ModelsManager`](crate::agent::models::ModelsManager) dedupes
    /// by content before applying).
    ModelsCacheChanged,
    ProjectConfigChanged {
        path: PathBuf,
    },
    /// A project-scoped MCP config file changed
    /// (`<cwd>/.mcp.json` or `<cwd>/.claude.json` where `<cwd>` is a
    /// project root, **not** `$HOME`). Project `<cwd>` is derived
    /// from `path.parent()` by the reloader.
    McpConfigChanged {
        path: PathBuf,
    },
    /// The user's **home-level** `~/.claude.json` changed. Distinct
    /// from [`Self::McpConfigChanged`] because `~/.claude.json` is
    /// loaded for **every** session regardless of cwd (see
    /// `load_claude_json_mcp_servers_as_configs`), so the reload
    /// must broadcast through the legacy unit
    /// [`super::reloader::ConfigUpdate::McpServersChanged`] arm —
    /// routing it through `ProjectMcpServersChanged { cwd: $HOME }`
    /// would silently skip sessions whose cwd doesn't sit under
    /// `$HOME`.
    HomeClaudeJsonChanged,
    /// A project-instructions file (`AGENTS.md`, `CLAUDE.md`, …) or a rules
    /// file under `.alnair/rules`/`.claude/rules`/`.cursor/rules` changed.
    ///
    /// The project root is derived from `path` by the reloader, which then
    /// fans out to sessions whose discovery chain covers it. Detection alone
    /// is not enough to dispatch — the reloader also content-hashes the whole
    /// discovery set, so an mtime-only touch (or an edit to a vendor surface
    /// the session's compat config has disabled) never re-injects anything.
    AgentInstructionsChanged {
        path: PathBuf,
    },
}

/// Watches `~/.alnair/` for `auth.json`, `config.toml`, and `models_cache.json`
/// changes, plus any extra paths (project `.alnair/config.toml`, `.mcp.json`,
/// etc.) provided at startup.
///
/// Uses `notify-debouncer-mini` for built-in debounce that coalesces rapid
/// editor writes (including write-then-rename patterns).
///
/// Self-write suppression is intentionally omitted. When the agent writes
/// `auth.json` or `config.toml`, the watcher will fire and the
/// [`ConfigReloader`](super::reloader::ConfigReloader) will re-read the file.
/// The reloader's own content-based deduplication (auth key hash, toml value
/// comparison) skips the update when nothing actually changed, so the
/// redundant read is harmless. This avoids a class of bugs where an
/// optimistic suppression window accidentally swallows writes from external
/// processes (e.g. `alnair login` in another terminal).
///
/// Adds two **non-recursive** watches per `cwd` argument:
/// `<cwd>/` (catches `.mcp.json` and `.claude.json` at the project root) and
/// `<cwd>/.alnair/` (catches `<cwd>/.alnair/config.toml`). Recursing on `<cwd>`
/// would walk `node_modules/`, `target/`, `.git/`, etc. and blow through
/// `fs.inotify.max_user_watches` on large repos. Use [`Self::watch_path`]
/// to register additional cwds at runtime when new sessions open in
/// not-yet-watched directories.
pub struct ConfigFileWatcher {
    debouncer: Debouncer<AccessFilteredWatcher>,
    /// Project cwds currently registered (via [`Self::start`]'s `cwd`
    /// argument or [`Self::watch_path`]). Tracked so that
    /// (a) [`Self::watch_path`] is idempotent at our layer instead of
    /// relying on `notify`'s internal de-dup, and
    /// (b) [`Self::unwatch_path`] can drop the OS watches for a cwd
    /// that is no longer needed, bounding inotify-watch accumulation
    /// as sessions churn across directories.
    watched_cwds: HashSet<PathBuf>,
    /// Refcounts for the **shared** ancestor directories of the cwd→git-root
    /// chain (see [`ancestor_chain`]). Two sessions opened in different
    /// subdirectories of one repo register the same repo root, so a plain
    /// `HashSet` would let the first [`Self::unwatch_path`] tear the watch down
    /// while the other session still needs it. Only the 0→1 and 1→0
    /// transitions touch the OS watcher.
    ancestor_watch_refs: HashMap<PathBuf, usize>,
}

impl ConfigFileWatcher {
    /// Start watching. Returns `None` if the OS watcher fails to initialize.
    ///
    /// `cwd`, when `Some`, adds two non-recursive watches: `<cwd>/` and
    /// `<cwd>/.alnair/`. Use [`Self::watch_path`] later to register additional
    /// project cwds for sessions that open in not-yet-watched
    /// directories.
    pub fn start(
        alnair_home: &Path,
        extra_paths: &[PathBuf],
        cwd: Option<&Path>,
        debounce: Option<Duration>,
    ) -> Option<(Self, mpsc::UnboundedReceiver<ConfigChangeEvent>)> {
        let debounce = debounce.unwrap_or(DEFAULT_DEBOUNCE);
        let (tx, rx) = mpsc::unbounded_channel();
        let alnair_home_buf = alnair_home.to_path_buf();
        // `~/.claude.json` is consumed by **every**
        // session (see `load_claude_json_mcp_servers_as_configs`), so
        // a write to it must broadcast through the unit
        // `McpServersChanged` arm — NOT through the per-cwd
        // `ProjectMcpServersChanged { cwd: $HOME }` arm, which
        // `cwd_matches` would silently filter for sessions outside
        // `$HOME`. We snapshot `$HOME` here so the closure can
        // discriminate `<home>/.claude.json` from a project-level
        // `<cwd>/.claude.json` purely by path.
        //
        // Canonicalize `$HOME` ONCE up front. `notify`
        // backends may deliver canonicalized event paths (e.g. macOS
        // FSEvents resolves symlinks, returning `/private/var/...`
        // where `dirs::home_dir()` returned `/var/...`), so a raw byte
        // compare against an un-canonicalized `$HOME` would mis-route
        // `~/.claude.json` to the per-cwd path. The per-event side is
        // canonicalized in `parent_is_dir`.
        let user_home_buf: Option<PathBuf> =
            dirs::home_dir().map(|h| dunce::canonicalize(&h).unwrap_or(h));

        let mut debouncer = new_filtered_debouncer(debounce, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };

            let mut batch_events: Vec<ConfigChangeEvent> = Vec::new();
            for event in events {
                let path = &event.path;
                let name = path.file_name().and_then(|n| n.to_str());
                let parent = path.parent();

                let change = match name {
                    Some("auth.json") if parent == Some(alnair_home_buf.as_path()) => {
                        Some(ConfigChangeEvent::AuthChanged)
                    }
                    Some("config.toml") if parent == Some(alnair_home_buf.as_path()) => {
                        Some(ConfigChangeEvent::GlobalConfigChanged)
                    }
                    Some("models_cache.json") if parent == Some(alnair_home_buf.as_path()) => {
                        Some(ConfigChangeEvent::ModelsCacheChanged)
                    }
                    Some("config.toml") => {
                        Some(ConfigChangeEvent::ProjectConfigChanged { path: path.clone() })
                    }
                    // `~/.claude.json` routes through
                    // the dedicated home-level variant so the
                    // reloader can broadcast. Project-level
                    // `<cwd>/.claude.json` (and any `.mcp.json`)
                    // continues to be a per-cwd reload.
                    Some(".claude.json")
                        if user_home_buf
                            .as_deref()
                            .is_some_and(|h| parent_is_dir(parent, h)) =>
                    {
                        Some(ConfigChangeEvent::HomeClaudeJsonChanged)
                    }
                    Some(".mcp.json") | Some(".claude.json") => {
                        Some(ConfigChangeEvent::McpConfigChanged { path: path.clone() })
                    }
                    // Checked AFTER the `.claude.json`/`.mcp.json` arms (those
                    // are exact filenames and cannot collide) but BEFORE the
                    // catch-all: `AGENTS.md` at any watched level is a
                    // project-instructions change, including the repo-root and
                    // intermediate-directory copies reached by the ancestor
                    // watches.
                    _ if is_agent_instructions_path(path) => {
                        Some(ConfigChangeEvent::AgentInstructionsChanged { path: path.clone() })
                    }
                    _ => None,
                };

                if let Some(evt) = change
                    && !batch_events.contains(&evt)
                {
                    batch_events.push(evt);
                }
            }
            for evt in batch_events {
                let _ = tx.send(evt);
            }
        })
        .map_err(|e| tracing::warn!(error = %e, "failed to create config file watcher"))
        .ok()?;

        debouncer
            .watcher()
            .watch(alnair_home, RecursiveMode::NonRecursive)
            .map_err(|e| {
                tracing::warn!(
                    path = %alnair_home.display(),
                    error = %e,
                    "failed to watch alnair home directory"
                )
            })
            .ok()?;

        for p in extra_paths {
            if let Some(parent) = p.parent() {
                let _ = debouncer
                    .watcher()
                    .watch(parent, RecursiveMode::NonRecursive);
            }
        }

        // Add the two narrow non-recursive cwd watches. Both are non-fatal —
        // a missing directory just means the corresponding files don't
        // exist yet and will be picked up by `watch_path` on the next
        // session that opens in this cwd.
        //
        // When the leader's own cwd is also covered by
        // `extra_paths` (e.g. `find_project_configs(cwd)` already
        // includes `<cwd>/.alnair/config.toml` so the loop above
        // watches `<cwd>/.alnair/`), the call below installs a
        // duplicate watch on the same directory. `notify` dedupes
        // silently in its `RecommendedWatcher` (last-write-wins for
        // the recursion mode), so this is cosmetic — both
        // additions remain non-recursive, no event amplification.
        let mut watched_cwds = HashSet::new();
        let mut ancestor_watch_refs = HashMap::new();
        if let Some(cwd) = cwd {
            watch_cwd_dirs(&mut debouncer, cwd);
            watch_ancestors(&mut debouncer, &mut ancestor_watch_refs, cwd);
            watched_cwds.insert(cwd.to_path_buf());
        }

        tracing::info!(
            alnair_home = %alnair_home.display(),
            extra_paths = extra_paths.len(),
            cwd = ?cwd,
            ancestor_watches = ancestor_watch_refs.len(),
            debounce_ms = debounce.as_millis(),
            "config file watcher started"
        );

        Some((
            Self {
                debouncer,
                watched_cwds,
                ancestor_watch_refs,
            },
            rx,
        ))
    }

    /// Register `<cwd>/` and `<cwd>/.alnair/` as **non-recursive** watch
    /// targets, in addition to whatever was passed to [`Self::start`].
    ///
    /// Intended for the session-open path: when a session opens in a cwd
    /// the leader hasn't seen before, calling this method ensures edits to
    /// `<cwd>/.mcp.json` and `<cwd>/.alnair/config.toml` trigger a
    /// [`ConfigChangeEvent`] (and downstream [`ConfigUpdate::
    /// ProjectMcpServersChanged`](super::reloader::ConfigUpdate::
    /// ProjectMcpServersChanged)) within the debounce window.
    ///
    /// **Non-recursive by design.** Watching `<cwd>` recursively would
    /// walk `node_modules/`, `target/`, `.git/`, etc. and easily exhaust
    /// the per-user inotify quota (`fs.inotify.max_user_watches`,
    /// commonly 8192 by default) on a large repo. If `notify` cannot register the watch (e.g.
    /// the directory doesn't exist yet, or the OS quota is reached) the
    /// error is logged and swallowed — the leader continues to rely on
    /// the user-triggered refresh as the fallback.
    pub fn watch_path(&mut self, cwd: &Path) {
        // Idempotent at our layer: skip the redundant
        // `notify` watch-add when this cwd is already registered, so
        // re-opening sessions in the same directory doesn't churn the
        // OS watcher. `notify` de-dups internally too, but tracking the
        // set here also enables `unwatch_path`.
        if self.watched_cwds.contains(cwd) {
            return;
        }
        watch_cwd_dirs(&mut self.debouncer, cwd);
        watch_ancestors(&mut self.debouncer, &mut self.ancestor_watch_refs, cwd);
        self.watched_cwds.insert(cwd.to_path_buf());
    }

    /// Remove the two non-recursive watches (`<cwd>/` and
    /// `<cwd>/.alnair/`) registered for `cwd` via
    /// [`Self::start`] / [`Self::watch_path`].
    ///
    /// Best-effort and idempotent: a `cwd` that was never registered
    /// (or already unwatched) is a no-op. Intended for the
    /// session-teardown path so a long-lived leader that opens sessions
    /// across many directories doesn't accumulate inotify watches for
    /// cwds with no live sessions. **Callers must ref-count**: only
    /// unwatch once the *last* session sharing this cwd closes —
    /// `ConfigFileWatcher` tracks distinct cwds, not session counts.
    pub fn unwatch_path(&mut self, cwd: &Path) {
        if !self.watched_cwds.remove(cwd) {
            return;
        }
        unwatch_cwd_dirs(&mut self.debouncer, cwd);
        unwatch_ancestors(&mut self.debouncer, &mut self.ancestor_watch_refs, cwd);
    }
}

/// Component-aware "is `parent` the directory `dir`?" that tolerates
/// symlink / canonicalization differences between a `notify`-delivered
/// event path and a `dirs::home_dir()`-style reference. `dir` is
/// expected to be already canonicalized (see `ConfigFileWatcher::start`).
fn parent_is_dir(parent: Option<&Path>, dir: &Path) -> bool {
    let Some(parent) = parent else {
        return false;
    };
    parent == dir || dunce::canonicalize(parent).is_ok_and(|p| p == dir)
}

/// Add the two non-recursive watches for a project root.
///
/// Both watches are best-effort and log-and-continue on failure (missing
/// directory, quota exhausted, permission denied, etc.) — the caller has
/// no reasonable recovery path beyond the existing user-triggered refresh.
///
/// **Known limitation:** if `<cwd>/.alnair/` does not yet
/// exist at session-open time, the `.alnair/` watch fails ENOENT and is
/// swallowed at `debug!`. A later `mkdir <cwd>/.alnair/` followed by a
/// write to `<cwd>/.alnair/config.toml` will NOT be observed — the
/// `<cwd>/` watch is non-recursive, so subdirectory creation isn't
/// surfaced as a watch-add trigger. Users hitting this case must hit
/// the explicit refresh button. A robust fix (re-attempt on parent-
/// directory create) is out of scope here.
fn watch_cwd_dirs(debouncer: &mut Debouncer<AccessFilteredWatcher>, cwd: &Path) {
    if let Err(e) = debouncer.watcher().watch(cwd, RecursiveMode::NonRecursive) {
        log_watch_error(&e, "failed to watch project cwd (non-recursive)");
    }
    let alnair_dir = cwd.join(".alnair");
    if let Err(e) = debouncer
        .watcher()
        .watch(&alnair_dir, RecursiveMode::NonRecursive)
    {
        log_watch_error(
            &e,
            "failed to watch project .alnair directory (non-recursive)",
        );
    }
}

/// Directories **above** `cwd` up to (and including) the git root.
///
/// Project-instruction discovery walks this same chain
/// (`read_agents_config_with_options`), so an `AGENTS.md` in an intermediate
/// directory — `repo/AGENTS.md` for a session opened in `repo/crates/x/` — is
/// part of the session's instructions even though it sits outside the two
/// watches [`watch_cwd_dirs`] installs. Without these watches an edit there
/// would never surface.
///
/// Uses [`RepoDirChain::resolve`] rather than re-walking by hand so the stop
/// conditions match discovery exactly, including its "a dotfiles repo at
/// `$HOME` is not a project root" rule. Excludes `cwd` itself (already watched)
/// and is bounded by repo depth, not tree size, so it cannot exhaust the
/// inotify quota the way a recursive watch would. Outside a git repo the chain
/// is just `[cwd]`, leaving nothing to add.
fn ancestor_chain(cwd: &Path) -> Vec<PathBuf> {
    let mut dirs = alnair_agent::repo::RepoDirChain::resolve(cwd).dirs;
    // `dirs` is cwd-first; drop the entry for `cwd` itself.
    if dirs.first().is_some_and(|d| d == cwd) {
        dirs.remove(0);
    }
    dirs
}

/// Register the ancestor chain for `cwd`, bumping each directory's refcount.
/// Only the 0→1 transition installs an OS watch.
fn watch_ancestors(
    debouncer: &mut Debouncer<AccessFilteredWatcher>,
    refs: &mut HashMap<PathBuf, usize>,
    cwd: &Path,
) {
    for dir in ancestor_chain(cwd) {
        let count = refs.entry(dir.clone()).or_insert(0);
        *count += 1;
        if *count == 1
            && let Err(e) = debouncer.watcher().watch(&dir, RecursiveMode::NonRecursive)
        {
            log_watch_error(&e, "failed to watch ancestor directory for AGENTS.md");
        }
    }
}

/// Release the ancestor chain for `cwd`, dropping the OS watch only when the
/// last referencing cwd goes away.
fn unwatch_ancestors(
    debouncer: &mut Debouncer<AccessFilteredWatcher>,
    refs: &mut HashMap<PathBuf, usize>,
    cwd: &Path,
) {
    for dir in ancestor_chain(cwd) {
        let Some(count) = refs.get_mut(&dir) else {
            continue;
        };
        *count -= 1;
        if *count > 0 {
            continue;
        }
        refs.remove(&dir);
        if let Err(e) = debouncer.watcher().unwatch(&dir) {
            tracing::debug!(error = %e, path = %dir.display(), "failed to unwatch ancestor directory");
        }
    }
}

/// Remove the two non-recursive watches added by [`watch_cwd_dirs`].
/// Best-effort: a `WatchNotFound` (never watched / already removed) is
/// expected and logged at `debug!`.
fn unwatch_cwd_dirs(debouncer: &mut Debouncer<AccessFilteredWatcher>, cwd: &Path) {
    if let Err(e) = debouncer.watcher().unwatch(cwd) {
        tracing::debug!(error = %e, "failed to unwatch project cwd");
    }
    let alnair_dir = cwd.join(".alnair");
    if let Err(e) = debouncer.watcher().unwatch(&alnair_dir) {
        tracing::debug!(error = %e, "failed to unwatch project .alnair directory");
    }
}

/// Log a `notify` watch failure, distinguishing the benign
/// "directory doesn't exist yet" case (logged at `debug!` — it's
/// expected for a freshly-opened session whose `<cwd>/.alnair/` hasn't
/// been created) from genuinely actionable failures like
/// `fs.inotify.max_user_watches` exhaustion or permission denied
/// (logged at `warn!` — these mean live edits will be silently
/// missed). Don't swallow every error at the same level.
fn log_watch_error(err: &notify::Error, msg: &str) {
    let not_found = matches!(err.kind, notify::ErrorKind::PathNotFound)
        || matches!(&err.kind, notify::ErrorKind::Io(io) if io.kind() == std::io::ErrorKind::NotFound);
    if not_found {
        tracing::debug!(error = %err, "{msg} (path not found)");
    } else {
        tracing::warn!(error = %err, "{msg}");
    }
}

/// Watches skill directories (`~/.alnair/skills/`, `<repo>/.alnair/skills/`, etc.)
/// for new, modified, or removed `SKILL.md` files.
///
/// When a change is detected the receiver gets a `()` signal. The caller is
/// responsible for triggering a skill re-advertisement to connected clients.
pub struct SkillsFileWatcher {
    debouncer: Debouncer<AccessFilteredWatcher>,
    /// Dirs registered by [`Self::watch_cwd`], refcounted per directory so
    /// [`Self::unwatch_cwd`] only drops the OS watch when the last session
    /// referencing it goes away.
    ///
    /// Holds **only** session-registered dirs. The dirs [`Self::start`]
    /// installed belong to the process itself (the leader's own cwd) and are
    /// never released — mixing them in here made the count start at 1 and
    /// never reach 0, so the last `unwatch_cwd` left the watch installed.
    watched_dirs: HashMap<PathBuf, usize>,
    /// Dirs [`Self::start`] already installed; `watch_cwd` must not add a
    /// second OS watch for them, but must still count the session so a later
    /// `unwatch_cwd` is balanced.
    initial_dirs: HashSet<PathBuf>,
    alnair_home: PathBuf,
}

const SKILLS_DEBOUNCE: Duration = Duration::from_secs(2);

/// True if an event path is a skill/command change worth reloading: a
/// `SKILL.md`, anything under `skills/`, or a `*.md` inside `commands/`.
/// Mirrors discovery (`find_skill_paths`/`find_command_paths`).
fn is_skill_change_path(p: &Path) -> bool {
    p.file_name().is_some_and(|n| n == "SKILL.md")
        || p.ancestors()
            .any(|a| a.file_name().is_some_and(|n| n == "skills"))
        || (p.extension().is_some_and(|e| e == "md")
            && p.parent()
                .is_some_and(|par| par.file_name().is_some_and(|n| n == "commands")))
}

/// True if an event path is a project-instructions change worth reloading.
///
/// Accepts the **conservative superset** of what discovery may read: every
/// filename in [`CompatConfig::agent_filenames`](alnair_tools::types::compat::CompatConfig::agent_filenames),
/// plus any `*.md` directly inside a rules directory. Watching a superset is
/// deliberate and follows the `SkillsFileWatcher` precedent: this watcher is
/// leader-global and has no per-session compat resolved, so gating vendor
/// surfaces here could permanently miss an edit if a toggle later flips.
///
/// A file that discovery would not actually read yields an unchanged content
/// hash downstream ([`super::reloader`]), which suppresses the dispatch. That
/// makes a false positive here cheap and a false negative permanent — hence
/// the superset.
fn is_agent_instructions_path(p: &Path) -> bool {
    let name = p.file_name().and_then(|n| n.to_str());
    // Filenames are compared case-sensitively, exactly as discovery does
    // (`find_agent_files` joins the name and stats it), so `agents.md` on a
    // case-sensitive filesystem is genuinely not a match.
    const AGENT_FILENAMES: &[&str] = &[
        "Agents.md",
        "Claude.md",
        "CLAUDE.md",
        "CLAUDE.local.md",
        "AGENT.md",
        "AGENTS.md",
    ];
    if name.is_some_and(|n| AGENT_FILENAMES.contains(&n)) {
        return true;
    }
    // `.claude/CLAUDE.md` and `.claude/CLAUDE.local.md` are matched by the
    // filename arm above; the parent-dir check below covers the rules dirs.
    let is_md = p.extension().is_some_and(|e| e == "md");
    is_md
        && p.parent().is_some_and(|par| {
            matches!(par.file_name().and_then(|n| n.to_str()), Some("rules"))
                && par
                    .parent()
                    .and_then(|gp| gp.file_name())
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| matches!(n, ".alnair" | ".claude" | ".cursor"))
        })
}

/// True for a global/home-level config dir that must never be watched
/// recursively: `alnair_home` (`~/.alnair`, or `$ALNAIR_SHARE_DIR`) or a known vendor dir
/// directly under `$HOME` ([`HOME_VENDOR_DIRS`]).
///
/// These hold large non-skill trees — `~/.alnair` alone has `worktrees/`,
/// `sessions/`, `logs/`, `upload_queue/` — so recursing them exhausted the
/// inotify quota (~780k watches on a devbox) and, since each worktree is a full
/// checkout, fired skill reloads on ordinary repo activity. They get scoped
/// watches instead ([`watch_skill_subdirs`]); project/repo dirs — and
/// user-supplied `[skills].paths` entries, which discovery walks in full — stay
/// recursive. Matching only these specific names (not "any dir whose parent is
/// `$HOME`") is what keeps a `[skills].paths = ["~/my-skills"]` fully watched.
fn is_global_config_dir(dir: &Path, alnair_home: &Path) -> bool {
    #[allow(deprecated)]
    let home = std::env::home_dir();
    is_global_config_dir_impl(dir, alnair_home, home.as_deref())
}

/// Vendor config dir names that sit directly under `$HOME` and carry large
/// non-skill trees. Kept in sync with the home-level dirs added by
/// `collect_skill_config_dirs`.
const HOME_VENDOR_DIRS: &[&str] = &[".alnair", ".agents", ".claude", ".cursor"];

/// Testable core of [`is_global_config_dir`] with `$HOME` injected.
fn is_global_config_dir_impl(dir: &Path, alnair_home: &Path, home: Option<&Path>) -> bool {
    let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    if canon(dir) == canon(alnair_home) {
        return true;
    }
    let Some(home) = home else { return false };
    if dir.parent().map(canon) != Some(canon(home)) {
        return false;
    }
    dir.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| HOME_VENDOR_DIRS.contains(&n))
}

/// Watch only a config dir's skill subtrees — `<dir>/skills` recursively and
/// `<dir>/commands` flat — never the dir root (see [`is_global_config_dir`]).
/// Returns the number of watches registered; a missing subdir is skipped (for
/// `~/.alnair` these exist at startup; later creation is caught on restart).
fn watch_skill_subdirs(
    debouncer: &mut Debouncer<AccessFilteredWatcher>,
    config_dir: &Path,
) -> usize {
    let mut watched = 0;
    for (subdir, mode) in [
        ("skills", RecursiveMode::Recursive),
        ("commands", RecursiveMode::NonRecursive),
    ] {
        let dir = config_dir.join(subdir);
        if dir.is_dir() {
            match debouncer.watcher().watch(&dir, mode) {
                Ok(()) => watched += 1,
                Err(e) => log_watch_error(&e, "failed to watch skill subdir"),
            }
        }
    }
    watched
}

impl SkillsFileWatcher {
    /// Start watching skill directories. Returns `None` if the OS watcher
    /// fails to initialize or no directories exist to watch.
    ///
    /// Uses [`collect_skill_config_dirs`](alnair_agent::prompt::skills::collect_skill_config_dirs)
    /// as the canonical directory source so the watcher covers the same
    /// locations as skill discovery.
    pub fn start(
        cwd: Option<&Path>,
        monorepo_user_dir: Option<&Path>,
        config_paths: &[String],
    ) -> Option<(Self, mpsc::UnboundedReceiver<()>)> {
        let (tx, rx) = mpsc::unbounded_channel();

        let mut debouncer =
            new_filtered_debouncer(SKILLS_DEBOUNCE, move |res: DebounceEventResult| {
                let Ok(events) = res else { return };
                if events.iter().any(|e| is_skill_change_path(&e.path)) {
                    let _ = tx.send(());
                }
            })
            .map_err(|e| tracing::warn!(error = %e, "failed to create skills file watcher"))
            .ok()?;

        let alnair_home = alnair_tools::util::alnair_home::alnair_home();
        // Watch the full superset of vendor dirs (all-on compat). This watcher
        // is leader-global (no per-session compat resolved here); the actual
        // per-session discovery gating happens downstream, so watching a
        // currently-disabled vendor dir is harmless (a change just re-runs the
        // gated discovery) and avoids ever missing a watch if a toggle flips.
        let dirs_to_watch = alnair_agent::prompt::skills::collect_skill_config_dirs(
            cwd,
            monorepo_user_dir,
            &alnair_home,
            config_paths,
            alnair_tools::types::compat::CompatConfig::default(),
        );

        let mut watched = 0;
        for dir in &dirs_to_watch {
            if is_global_config_dir(dir, &alnair_home) {
                // Home dir: watch skill subtrees only, never the root
                // (worktrees/, sessions/, logs/ — see `is_global_config_dir`).
                watched += watch_skill_subdirs(&mut debouncer, dir);
            } else {
                // Project/repo dir: bounded, so recurse to catch new `skills/`
                // dirs created mid-session as well as edits to existing files.
                match debouncer.watcher().watch(dir, RecursiveMode::Recursive) {
                    Ok(()) => watched += 1,
                    Err(e) => log_watch_error(&e, "failed to watch directory for skill changes"),
                }
            }
        }

        if watched == 0 {
            tracing::debug!("no config directories found to watch for skills");
            return None;
        }

        tracing::info!(dirs = watched, "skills file watcher started");

        // Dirs `start` installed belong to the process, not to a session: they
        // are recorded so `watch_cwd` can skip a duplicate OS watch, but they
        // are NOT refcounted (see the field docs).
        let mut initial_dirs = HashSet::new();
        for dir in dirs_to_watch {
            initial_dirs.insert(dir);
        }

        Some((
            Self {
                debouncer,
                watched_dirs: HashMap::new(),
                initial_dirs,
                alnair_home,
            },
            rx,
        ))
    }

    /// Register the skill config dirs for an additional session cwd.
    ///
    /// One leader serves every repo (the tab strip spans repositories), but
    /// `start` resolves its directory set once from the *process* cwd. A session
    /// opened in a different repo therefore had no watch on
    /// `<other-repo>/.alnair/skills`, and adding a skill there needed a restart.
    ///
    /// Refcounted per directory: two sessions in sibling subdirectories of one
    /// repo resolve the same `<repo>/.alnair`, so only the 0→1 transition
    /// touches the OS watcher and only the 1→0 transition removes it. Dirs that
    /// `start` already installed are counted but never re-watched or released.
    ///
    /// **Non-fatal.** A cwd with no config dirs, a missing directory, or an
    /// exhausted inotify quota all log and continue — the session still works,
    /// it just falls back to the explicit reload.
    pub fn watch_cwd(&mut self, cwd: &Path) {
        let dirs = alnair_agent::prompt::skills::collect_skill_config_dirs(
            Some(cwd),
            alnair_agent::prompt::workspace_user::optional_workspace_user_dir().as_deref(),
            &self.alnair_home,
            &[],
            alnair_tools::types::compat::CompatConfig::default(),
        );

        for dir in dirs {
            let count = self.watched_dirs.entry(dir.clone()).or_insert(0);
            *count += 1;
            if *count > 1 || self.initial_dirs.contains(&dir) {
                continue;
            }
            if is_global_config_dir(&dir, &self.alnair_home) {
                watch_skill_subdirs(&mut self.debouncer, &dir);
            } else if let Err(e) = self
                .debouncer
                .watcher()
                .watch(&dir, RecursiveMode::Recursive)
            {
                log_watch_error(&e, "failed to watch session cwd for skill changes");
            }
        }
    }

    /// Release the skill watches registered for `cwd` via [`Self::watch_cwd`].
    ///
    /// **Callers must ref-count**: only call this once the *last* session
    /// sharing the cwd closes.
    pub fn unwatch_cwd(&mut self, cwd: &Path) {
        let dirs = alnair_agent::prompt::skills::collect_skill_config_dirs(
            Some(cwd),
            alnair_agent::prompt::workspace_user::optional_workspace_user_dir().as_deref(),
            &self.alnair_home,
            &[],
            alnair_tools::types::compat::CompatConfig::default(),
        );

        for dir in dirs {
            let Some(count) = self.watched_dirs.get_mut(&dir) else {
                continue;
            };
            *count -= 1;
            if *count > 0 {
                continue;
            }
            self.watched_dirs.remove(&dir);
            // Process-owned dirs stay installed for the process lifetime.
            if self.initial_dirs.contains(&dir) {
                continue;
            }
            if is_global_config_dir(&dir, &self.alnair_home) {
                for sub in ["skills", "commands"] {
                    let _ = self.debouncer.watcher().unwatch(&dir.join(sub));
                }
            } else if let Err(e) = self.debouncer.watcher().unwatch(&dir) {
                tracing::debug!(
                    error = %e, path = %dir.display(),
                    "failed to unwatch session cwd for skill changes"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn wait_ms(ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    /// `is_global_config_dir` must scope down only alnair_home and the known
    /// vendor dirs under `$HOME` — NOT arbitrary `[skills].paths` entries such
    /// as `~/my-skills`, whose skills discovery walks in full and so must stay
    /// recursively watched.
    #[test]
    fn is_global_config_dir_matches_only_alnair_home_and_vendor_dirs() {
        let home = TempDir::new().unwrap();
        let home = home.path();
        let alnair_home = home.join(".alnair");

        let g = |dir: &Path| is_global_config_dir_impl(dir, &alnair_home, Some(home));

        // alnair_home and vendor dirs directly under $HOME: scoped (global).
        assert!(g(&alnair_home));
        assert!(g(&home.join(".claude")));
        assert!(g(&home.join(".cursor")));
        assert!(g(&home.join(".agents")));

        // A user [skills].paths entry under $HOME: NOT global (stays recursive).
        assert!(!g(&home.join("my-skills")));
        assert!(!g(&home.join(".config")));
        // A project/repo config dir (parent isn't $HOME): NOT global.
        assert!(!g(&home.join("repo").join(".alnair")));
    }

    /// Regression for the ~/.alnair inotify-exhaustion / worktree-noise bug: a
    /// `SKILL.md` under a sibling subtree (e.g. `~/.alnair/worktrees/`) must not
    /// drive a reload, while a real `<dir>/skills/**/SKILL.md` change still does.
    #[test]
    #[cfg(target_os = "linux")]
    fn skills_watcher_scopes_to_subdirs_not_dir_root() {
        let tmp = TempDir::new().unwrap();
        let global = tmp.path();

        // Real global skill under <dir>/skills/.
        let alpha = global.join("skills").join("alpha");
        fs::create_dir_all(&alpha).unwrap();
        fs::write(alpha.join("SKILL.md"), "# alpha").unwrap();

        // A SKILL.md buried in a worktree checkout under the (unwatched) root.
        let wt_skill = global
            .join("worktrees")
            .join("wt1")
            .join(".alnair")
            .join("skills")
            .join("beta");
        fs::create_dir_all(&wt_skill).unwrap();
        fs::write(wt_skill.join("SKILL.md"), "# beta").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut debouncer = new_filtered_debouncer(
            Duration::from_millis(50),
            move |res: DebounceEventResult| {
                let Ok(events) = res else { return };
                if events.iter().any(|e| is_skill_change_path(&e.path)) {
                    let _ = tx.send(());
                }
            },
        )
        .expect("debouncer should build");

        let watched = watch_skill_subdirs(&mut debouncer, global);
        assert!(watched >= 1, "should watch the <dir>/skills subdir");
        wait_ms(150);
        // drain startup noise
        while rx.try_recv().is_ok() {}

        // Editing a SKILL.md under the unwatched worktrees/ subtree must NOT fire.
        fs::write(wt_skill.join("SKILL.md"), "# beta v2").unwrap();
        wait_ms(250);
        assert!(
            rx.try_recv().is_err(),
            "changes under an unwatched sibling subtree (worktrees/) must not \
             trigger a skills reload — proves the dir root is not watched"
        );

        // Editing the real skill under <dir>/skills must still fire.
        fs::write(alpha.join("SKILL.md"), "# alpha v2").unwrap();
        wait_ms(250);
        assert!(
            rx.try_recv().is_ok(),
            "changes under <dir>/skills must trigger a skills reload"
        );
    }

    /// One leader serves every repo, but `start` resolves its dirs from the
    /// *process* cwd. `watch_cwd` must add a second repo's skills dirs so a
    /// session opened elsewhere still hot-reloads skills — and must refcount
    /// them, or the first session to close would tear the watch out from under
    /// its siblings.
    #[test]
    fn skills_watch_cwd_is_refcounted() {
        let alnair_home = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        git2::Repository::init(repo.path()).unwrap();
        let a = repo.path().join("a");
        let b = repo.path().join("b");
        let skills = repo.path().join(".alnair").join("skills").join("alpha");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::create_dir_all(&skills).unwrap();
        fs::write(skills.join("SKILL.md"), "# alpha").unwrap();

        let (mut watcher, _rx) = SkillsFileWatcher::start(Some(a.as_path()), None, &[])
            .expect("skills watcher should start");

        // Both sibling sessions resolve the same <repo>/.alnair.
        watcher.watch_cwd(&a);
        watcher.watch_cwd(&b);

        let repo_alnair = repo.path().join(".alnair");
        let count_for_repo = |w: &SkillsFileWatcher| {
            w.watched_dirs
                .iter()
                .filter(|(p, _)| p.file_name() == repo_alnair.file_name())
                .map(|(_, c)| *c)
                .max()
                .unwrap_or(0)
        };
        assert_eq!(
            count_for_repo(&watcher),
            2,
            "both sessions must reference the shared <repo>/.alnair"
        );

        watcher.unwatch_cwd(&a);
        assert_eq!(
            count_for_repo(&watcher),
            1,
            "the shared repo dir must stay watched while a session still needs it"
        );

        watcher.unwatch_cwd(&b);
        assert!(
            !watcher
                .watched_dirs
                .iter()
                .any(|(p, _)| p.file_name() == repo_alnair.file_name()),
            "the last unwatch releases the shared dir"
        );
    }

    /// Dirs `start` installed belong to the process. A session opening in the
    /// same cwd must not install a second OS watch, and closing must not
    /// release the process's own watch — that is the bug an earlier
    /// "seed the refcount from start" version had: the count never reached 0.
    #[test]
    fn skills_watch_cwd_does_not_release_process_owned_dirs() {
        let alnair_home = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        git2::Repository::init(repo.path()).unwrap();
        let skills = repo.path().join(".alnair").join("skills").join("alpha");
        fs::create_dir_all(&skills).unwrap();
        fs::write(skills.join("SKILL.md"), "# alpha").unwrap();

        let (mut watcher, _rx) =
            SkillsFileWatcher::start(Some(repo.path()), None, &[]).expect("watcher should start");

        let repo_alnair = repo.path().join(".alnair");
        assert!(
            watcher.initial_dirs.contains(&repo_alnair),
            "start must record the dirs it owns"
        );

        watcher.watch_cwd(repo.path());
        watcher.unwatch_cwd(repo.path());

        assert!(
            watcher.initial_dirs.contains(&repo_alnair),
            "a session closing must not release a process-owned watch"
        );
    }

    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "flaky on macOS: FSEvents does not reliably deliver events in test harness"
    )]
    fn watcher_detects_auth_json_change() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("auth.json"), "{}").unwrap();

        let (_w, mut rx) =
            ConfigFileWatcher::start(tmp.path(), &[], None, Some(Duration::from_millis(50)))
                .expect("watcher should start");

        fs::write(tmp.path().join("auth.json"), r#"{"new":"token"}"#).unwrap();
        wait_ms(300);

        let mut found = false;
        while let Ok(evt) = rx.try_recv() {
            if evt == ConfigChangeEvent::AuthChanged {
                found = true;
            }
        }
        assert!(found, "should detect auth.json change");
    }

    /// Regression test for the MCP/skills reload storm (feedback loop):
    /// merely *reading* a watched config file must NOT produce a
    /// `ConfigChangeEvent`. Linux inotify delivers `IN_OPEN`/`IN_ACCESS`
    /// for reads, `notify` subscribes to `OPEN`, and `notify-debouncer-mini`
    /// forwards every kind — so without [`AccessFilteredWatcher`] each
    /// leader-initiated reload's own re-reads of `config.toml` would
    /// schedule the next debounce tick and re-fire forever. A write
    /// afterwards must still be detected (the filter only drops `Access`).
    #[test]
    #[cfg(target_os = "linux")]
    fn watcher_ignores_reads_of_watched_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("config.toml"), "a = 1").unwrap();
        fs::write(tmp.path().join("auth.json"), "{}").unwrap();

        let (_w, mut rx) =
            ConfigFileWatcher::start(tmp.path(), &[], None, Some(Duration::from_millis(50)))
                .expect("watcher should start");
        wait_ms(150);
        // drain any startup noise
        while rx.try_recv().is_ok() {}

        // Simulate what the leader does on every reload: read the watched
        // files. Repeatedly, to defeat any incidental coalescing.
        for _ in 0..5 {
            let _ = fs::read(tmp.path().join("config.toml")).unwrap();
            let _ = fs::read(tmp.path().join("auth.json")).unwrap();
            wait_ms(20);
        }
        wait_ms(300);

        let mut read_events = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            read_events.push(evt);
        }
        assert!(
            read_events.is_empty(),
            "reads of watched files must not emit config-change events \
             (reload-storm feedback loop); got {read_events:?}"
        );

        // Sanity: a real write is still observed through the filter.
        fs::write(tmp.path().join("config.toml"), "a = 2").unwrap();
        wait_ms(300);
        let mut found = false;
        while let Ok(evt) = rx.try_recv() {
            if evt == ConfigChangeEvent::GlobalConfigChanged {
                found = true;
            }
        }
        assert!(found, "a write must still be detected after read filtering");
    }

    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "flaky on macOS: FSEvents does not reliably deliver events in test harness"
    )]
    fn watcher_detects_config_toml_change() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("config.toml"), "").unwrap();

        let (_w, mut rx) =
            ConfigFileWatcher::start(tmp.path(), &[], None, Some(Duration::from_millis(50)))
                .expect("watcher should start");

        fs::write(tmp.path().join("config.toml"), "[ui]\ntheme = \"dark\"").unwrap();
        wait_ms(300);

        let mut found = false;
        while let Ok(evt) = rx.try_recv() {
            if evt == ConfigChangeEvent::GlobalConfigChanged {
                found = true;
            }
        }
        assert!(found, "should detect config.toml change");
    }

    /// A write to `<alnair_home>/models_cache.json` must surface as
    /// `ConfigChangeEvent::ModelsCacheChanged` so a long-running leader can
    /// hot-load a catalog fetched by another alnair process.
    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "flaky on macOS: FSEvents does not reliably deliver events in test harness"
    )]
    fn watcher_detects_models_cache_change() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("models_cache.json"), "{}").unwrap();

        let (_w, mut rx) =
            ConfigFileWatcher::start(tmp.path(), &[], None, Some(Duration::from_millis(50)))
                .expect("watcher should start");

        fs::write(
            tmp.path().join("models_cache.json"),
            r#"{"fetched_at":"2026-01-01T00:00:00Z","models":{}}"#,
        )
        .unwrap();
        wait_ms(300);

        let mut found = false;
        while let Ok(evt) = rx.try_recv() {
            if evt == ConfigChangeEvent::ModelsCacheChanged {
                found = true;
            }
        }
        assert!(found, "should detect models_cache.json change");
    }

    #[test]
    #[ignore = "flaky on CI: OS file watcher may fail to initialize"]
    fn watcher_ignores_unrelated_files() {
        let tmp = TempDir::new().unwrap();

        let (_w, mut rx) =
            ConfigFileWatcher::start(tmp.path(), &[], None, Some(Duration::from_millis(50)))
                .expect("watcher should start");

        fs::write(tmp.path().join("leader.log"), "log line").unwrap();
        fs::write(tmp.path().join("leader.lock"), "12345").unwrap();
        wait_ms(300);

        assert!(
            rx.try_recv().is_err(),
            "should not emit events for unrelated files"
        );
    }

    #[test]
    fn watcher_debounces_rapid_writes() {
        let tmp = TempDir::new().unwrap();

        // Use a long debounce (500ms) so all rapid writes (50ms total)
        // land in a single debounce window regardless of platform.
        let (_w, mut rx) =
            ConfigFileWatcher::start(tmp.path(), &[], None, Some(Duration::from_millis(500)))
                .expect("watcher should start");

        wait_ms(200);

        // 5 rapid writes — total ~50ms, well within the 500ms debounce window
        for i in 0..5 {
            fs::write(tmp.path().join("config.toml"), format!("version = {i}")).unwrap();
            wait_ms(10);
        }
        // Wait for the single debounce tick to fire
        wait_ms(800);

        let mut count = 0;
        while rx.try_recv().is_ok() {
            count += 1;
        }
        // All writes should coalesce into a small number of events
        // (1 per debounce tick, or a few if OS delivers events in
        // separate batches within the window).
        assert!(count >= 1, "expected at least 1 event, got {count}");
        assert!(count <= 3, "expected coalesced events (<=3), got {count}");
    }

    /// A write to `<cwd>/.alnair/config.toml` must surface as
    /// a `ConfigChangeEvent::ProjectConfigChanged` so the reloader emits
    /// `ConfigUpdate::ProjectMcpServersChanged { cwd }`. Uses a longer
    /// debounce and explicit poll loop so it survives the slower-than-
    /// usual FSEvents delivery on macOS CI.
    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "flaky on macOS: FSEvents does not reliably deliver events in test harness"
    )]
    fn project_cwd_toml_triggers_reload() {
        let alnair_home = TempDir::new().unwrap();
        let cwd = TempDir::new().unwrap();
        let project_alnair = cwd.path().join(".alnair");
        fs::create_dir_all(&project_alnair).unwrap();
        // Seed the file before the watcher starts so we observe the
        // modification rather than the creation event.
        fs::write(project_alnair.join("config.toml"), "").unwrap();

        let (_w, mut rx) = ConfigFileWatcher::start(
            alnair_home.path(),
            &[],
            Some(cwd.path()),
            Some(Duration::from_millis(100)),
        )
        .expect("watcher should start");

        fs::write(
            project_alnair.join("config.toml"),
            "[mcp_servers.x]\ncommand = \"/bin/true\"",
        )
        .unwrap();

        // Poll up to 2s for the event.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            if let Ok(evt) = rx.try_recv()
                && matches!(evt, ConfigChangeEvent::ProjectConfigChanged { .. })
            {
                found = true;
                break;
            }
            wait_ms(50);
        }
        assert!(
            found,
            "expected ProjectConfigChanged for <cwd>/.alnair/config.toml within 2s"
        );
    }

    /// A write to `<cwd>/.mcp.json` must surface as a
    /// `ConfigChangeEvent::McpConfigChanged` so the reloader can fan out
    /// a `ProjectMcpServersChanged { cwd }`. Same FSEvents caveat as
    /// [`project_cwd_toml_triggers_reload`].
    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "flaky on macOS: FSEvents does not reliably deliver events in test harness"
    )]
    fn project_mcp_json_triggers_reload() {
        let alnair_home = TempDir::new().unwrap();
        let cwd = TempDir::new().unwrap();
        fs::write(cwd.path().join(".mcp.json"), "{}").unwrap();

        let (_w, mut rx) = ConfigFileWatcher::start(
            alnair_home.path(),
            &[],
            Some(cwd.path()),
            Some(Duration::from_millis(100)),
        )
        .expect("watcher should start");

        fs::write(
            cwd.path().join(".mcp.json"),
            r#"{"mcpServers": {"x": {"command": "/bin/true"}}}"#,
        )
        .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            if let Ok(evt) = rx.try_recv()
                && matches!(evt, ConfigChangeEvent::McpConfigChanged { .. })
            {
                found = true;
                break;
            }
            wait_ms(50);
        }
        assert!(
            found,
            "expected McpConfigChanged for <cwd>/.mcp.json within 2s"
        );
    }

    /// The cwd watch is **non-recursive** by design. This writes a
    /// file that the watcher's name filter **would** route
    /// (`.mcp.json`) into a deeply nested subdir. If a future
    /// regression flips `RecursiveMode::NonRecursive` → `Recursive`,
    /// recursive notify would surface the write, the name filter would
    /// map it to `McpConfigChanged`, and the test would fail. The file
    /// name must match the filter (`.mcp.json`, not e.g. `file.txt`)
    /// or the filter drops it regardless of recursion mode, so this is
    /// the test that actually guards the constraint.
    #[test]
    #[ignore = "flaky on CI: OS file watcher may fail to initialize"]
    fn nested_subdir_change_does_not_trigger() {
        let alnair_home = TempDir::new().unwrap();
        let cwd = TempDir::new().unwrap();
        let nested = cwd.path().join("some").join("deep").join("nested");
        fs::create_dir_all(&nested).unwrap();

        let (_w, mut rx) = ConfigFileWatcher::start(
            alnair_home.path(),
            &[],
            Some(cwd.path()),
            Some(Duration::from_millis(100)),
        )
        .expect("watcher should start");

        // Write a file whose name DOES match the watcher filter —
        // under recursive mode this would surface
        // as a `ConfigChangeEvent`; under non-recursive mode no
        // event must reach `rx`.
        fs::write(
            nested.join(".mcp.json"),
            r#"{"mcpServers": {"x": {"command": "/bin/true"}}}"#,
        )
        .unwrap();
        wait_ms(500);

        assert!(
            rx.try_recv().is_err(),
            "non-recursive watch must not surface .mcp.json events from <cwd>/some/deep/nested/"
        );
    }

    /// [`ConfigFileWatcher::watch_path`] registered after
    /// `start` must light up `<new_cwd>/.alnair/config.toml` writes
    /// identically to a cwd passed in at `start`. Exercises the
    /// session-open registration path where the leader learns about a
    /// new project root after the watcher is already running.
    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "flaky on macOS: FSEvents does not reliably deliver events in test harness"
    )]
    fn watch_path_dynamic_registration() {
        let alnair_home = TempDir::new().unwrap();
        let new_cwd = TempDir::new().unwrap();
        let project_alnair = new_cwd.path().join(".alnair");
        fs::create_dir_all(&project_alnair).unwrap();
        fs::write(project_alnair.join("config.toml"), "").unwrap();

        let (mut watcher, mut rx) = ConfigFileWatcher::start(
            alnair_home.path(),
            &[],
            None,
            Some(Duration::from_millis(100)),
        )
        .expect("watcher should start");

        watcher.watch_path(new_cwd.path());

        fs::write(
            project_alnair.join("config.toml"),
            "[mcp_servers.y]\ncommand = \"/bin/true\"",
        )
        .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            if let Ok(evt) = rx.try_recv()
                && matches!(evt, ConfigChangeEvent::ProjectConfigChanged { .. })
            {
                found = true;
                break;
            }
            wait_ms(50);
        }
        assert!(
            found,
            "watch_path-registered cwd must surface ProjectConfigChanged within 2s"
        );
    }

    /// Bookkeeping-only (no OS event delivery, so deterministic on
    /// every platform): `watch_path` records the cwd in `watched_cwds`
    /// and is idempotent; `unwatch_path` removes it and is a no-op for
    /// an unknown cwd. Guards the set that backs `unwatch_path` and the
    /// `watch_path` de-dup.
    #[test]
    fn watch_and_unwatch_path_bookkeeping() {
        let alnair_home = TempDir::new().unwrap();
        let cwd = TempDir::new().unwrap();
        let Some((mut watcher, _rx)) = ConfigFileWatcher::start(
            alnair_home.path(),
            &[],
            None,
            Some(Duration::from_millis(100)),
        ) else {
            // OS watcher unavailable in this environment; nothing to assert.
            return;
        };
        let p = cwd.path();
        assert!(!watcher.watched_cwds.contains(p));

        watcher.watch_path(p);
        assert!(watcher.watched_cwds.contains(p));

        // Idempotent: a second registration doesn't duplicate the entry.
        watcher.watch_path(p);
        assert_eq!(
            watcher
                .watched_cwds
                .iter()
                .filter(|c| c.as_path() == p)
                .count(),
            1,
        );

        // Unwatch removes it; a second unwatch is a no-op.
        watcher.unwatch_path(p);
        assert!(!watcher.watched_cwds.contains(p));
        watcher.unwatch_path(p);
        assert!(!watcher.watched_cwds.contains(p));
    }

    /// The predicate must accept every filename discovery can read, plus rules
    /// `*.md`, and reject ordinary source files and skill files (those route
    /// through [`is_skill_change_path`] instead).
    #[test]
    fn is_agent_instructions_path_accepts_known_filenames() {
        for name in [
            "Agents.md",
            "Claude.md",
            "CLAUDE.md",
            "CLAUDE.local.md",
            "AGENT.md",
            "AGENTS.md",
        ] {
            assert!(
                is_agent_instructions_path(Path::new("/repo").join(name).as_path()),
                "{name} must be recognized as project instructions"
            );
        }

        for vendor in [".alnair", ".claude", ".cursor"] {
            let p = PathBuf::from("/repo")
                .join(vendor)
                .join("rules")
                .join("style.md");
            assert!(
                is_agent_instructions_path(&p),
                "{vendor}/rules/*.md must be recognized"
            );
        }

        for other in [
            "/repo/src/main.rs",
            "/repo/skills/x/SKILL.md",
            "/repo/README.md",
            "/repo/.claude/settings.json",
            "/repo/rules/style.md",
        ] {
            assert!(
                !is_agent_instructions_path(Path::new(other)),
                "{other} must not be treated as project instructions"
            );
        }
    }

    /// A write to `<cwd>/AGENTS.md` must surface as
    /// `AgentInstructionsChanged` — the detection half of the hot-reload path.
    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "flaky on macOS: FSEvents does not reliably deliver events in test harness"
    )]
    fn watcher_detects_agents_md_change() {
        let alnair_home = TempDir::new().unwrap();
        let cwd = TempDir::new().unwrap();
        fs::write(cwd.path().join("AGENTS.md"), "# v1").unwrap();

        let (_w, mut rx) = ConfigFileWatcher::start(
            alnair_home.path(),
            &[],
            Some(cwd.path()),
            Some(Duration::from_millis(100)),
        )
        .expect("watcher should start");

        fs::write(cwd.path().join("AGENTS.md"), "# v2").unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            if let Ok(evt) = rx.try_recv()
                && matches!(evt, ConfigChangeEvent::AgentInstructionsChanged { .. })
            {
                found = true;
                break;
            }
            wait_ms(50);
        }
        assert!(
            found,
            "expected AgentInstructionsChanged for <cwd>/AGENTS.md within 2s"
        );
    }

    /// Discovery walks cwd→git root, so an `AGENTS.md` in an ancestor
    /// directory is part of the session's instructions. The ancestor watches
    /// exist precisely so editing it is observed.
    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "flaky on macOS: FSEvents does not reliably deliver events in test harness"
    )]
    fn watcher_detects_ancestor_agents_md_change() {
        let alnair_home = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        git2::Repository::init(repo.path()).unwrap();
        let nested = repo.path().join("crates").join("inner");
        fs::create_dir_all(&nested).unwrap();
        fs::write(repo.path().join("AGENTS.md"), "# root v1").unwrap();

        let (_w, mut rx) = ConfigFileWatcher::start(
            alnair_home.path(),
            &[],
            Some(nested.as_path()),
            Some(Duration::from_millis(100)),
        )
        .expect("watcher should start");

        fs::write(repo.path().join("AGENTS.md"), "# root v2").unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            if let Ok(evt) = rx.try_recv()
                && matches!(evt, ConfigChangeEvent::AgentInstructionsChanged { .. })
            {
                found = true;
                break;
            }
            wait_ms(50);
        }
        assert!(
            found,
            "expected AgentInstructionsChanged for the repo-root AGENTS.md \
             when the session cwd is nested below it"
        );
    }

    /// Two sessions in one repo share the ancestor chain. The first
    /// `unwatch_path` must not tear the repo-root watch out from under the
    /// second.
    #[test]
    fn ancestor_watch_refcount_survives_sibling_unwatch() {
        let alnair_home = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        git2::Repository::init(repo.path()).unwrap();
        let a = repo.path().join("a");
        let b = repo.path().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();

        let (mut watcher, _rx) = ConfigFileWatcher::start(
            alnair_home.path(),
            &[],
            None,
            Some(Duration::from_millis(50)),
        )
        .expect("watcher should start");

        watcher.watch_path(&a);
        watcher.watch_path(&b);

        let root = dunce::canonicalize(repo.path()).unwrap();
        let count_for_root = || {
            watcher
                .ancestor_watch_refs
                .iter()
                .filter(|(p, _)| p.file_name() == root.file_name())
                .map(|(_, c)| *c)
                .max()
                .unwrap_or(0)
        };
        assert!(
            count_for_root() >= 2,
            "both sessions must reference the shared repo root"
        );

        watcher.unwatch_path(&a);
        assert!(
            watcher.ancestor_watch_refs.values().any(|c| *c >= 1),
            "the repo root must stay watched while one session still needs it"
        );

        watcher.unwatch_path(&b);
        assert!(
            watcher.ancestor_watch_refs.is_empty(),
            "the last unwatch must release every ancestor watch"
        );
    }
}
