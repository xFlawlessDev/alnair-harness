# Changelog

All notable changes to Alnair are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Alnair is a fork of [Kigi-CLI](https://git.zacharyzhang.com/ZacharyZhang-NY/Kigi-CLI),
which is itself a fork of [xai-org/grok-build](https://github.com/xai-org/grok-build).
Changes inherited from either upstream are not listed here; this file records
what the Alnair fork adds, changes, or removes.

## [Unreleased]

Nothing yet.

## [0.1.3] — 2026-10-23

### Added

- **Offline installers for local builds.** `scripts/install-local.sh` and
  `scripts/install-local.ps1` install a locally built release archive without
  network access. They verify `SHA256SUMS`, smoke-test the binary before
  replacing an installation, and use the same managed layout as the updater.
  See `docs/RELEASE.md` for usage.
- **Rich terminal chrome.** `[chrome] style = "rich" | "plain"` controls the
  appearance of the welcome screen, prompt, status line, shortcuts, and session
  tabs. Rich mode is the default; plain mode keeps the minimal presentation.
- **Windows application icon.** The `alnair` executable now carries the Alnair
  logo as a multi-resolution Windows icon.

### Changed

- The dashboard delete-session shortcut is now `Ctrl+Shift+Backspace`.
- Added the `winres` build dependency and updated locked dependencies for
  Windows icon resource compilation.

## [0.1.2] — 2026-10-23

The first release under the Alnair identity. Version 0.1.1 was a rename of the
Kigi tree; everything below is what the fork added on top of it.

### Added

- **Workspace lesson library.** The harness now records its own postmortems
  per workspace. When the goal strategist restructures a stuck goal, or a
  `/graph` node is archived after a retry, the note is distilled into a
  `LessonEntry` and appended to `~/.alnair/lessons/<slug>-<hash8>/LESSONS.md`.
  The next session in the same workspace starts with the three newest entries
  as a `<harness-lessons>` advisory block. Storage is keyed by
  `alnair_memory::storage::workspace_key`, the same key memory uses, and never
  lives inside the repository. An empty store injects nothing, so a workspace
  that has never produced a lesson sees no prompt change. Configured by
  `[lessons]` (`enabled`, `max_entries`, `inject_max`, `inject_max_chars`) and
  `ALNAIR_LESSONS=0`; the section hot-reloads.
- `/lessons` and `/lessons clear` — list or delete this workspace's captured
  lessons. Both are always available, independent of memory.
- **`alnair web`** — a browser client for the agent. Each WebSocket gets its own
  `LeaderClient` against the shared leader, so a live turn's deltas reach the
  TUI and the browser alike, with `event_seq` dedup for a mid-turn attach and
  a replayed modal cache. Ships as an embedded SvelteKit SPA (`rust-embed`) to
  keep the single-binary release. Authenticated by cookie **and** `Origin`,
  both required, because a WebSocket upgrade skips CORS preflight. Includes a
  native directory-picker endpoint (`POST /api/pick-directory`) for adding a
  workspace, since a browser cannot read an absolute path out of a directory
  handle.
- **Multi-terminal session UX.** The pager defaults to leader mode; a bare
  launch auto-attaches to a matching session when the canonicalized cwd matches
  exactly. A global session tab strip (F2) spans repositories, keys on
  `session_id`, and persists to `~/.alnair/run/pager_tabs.json`. A session
  earns its tab when its id is bound, not when it becomes the view.
- **Dashboard session CRUD** — rename (`Ctrl+R`), stop/close (`Ctrl+X`), delete
  (`Ctrl+Shift+D`), and new-in-a-directory (`Ctrl+Shift+N`). Stop and delete
  carry separate confirmation slots so an armed "close" cannot confirm a
  delete.
- **Interactive terminal pane (F3).** Owns its own PTY, separate from the
  agent's bash tool: forwards keystrokes, pastes and resizes, and replays a
  ring buffer on reopen. Lazy — no shell spawns until ``Ctrl+` ``. The screen
  emulator was extracted into the `alnair-terminal-screen` crate.
- **Config hot-reload.** A debounced watcher feeds a reloader that diffs and
  dispatches to two transports — ACP stream injection under a leader, and
  direct dispatch in the in-process TUI. Covers `[platforms.*]`, `[model.*]`,
  `[mcp_servers]`, `[skills]`, `[compat]`, `[ui]`, and `AGENTS.md` /
  `CLAUDE.md` / rules `*.md`.
- **`alnair connect`** — one provider picker that is also the only disconnect
  surface. A per-row `d` disconnects that scope without dropping the running
  session back to Welcome.

### Changed

- **Identity reset.** The project stopped presenting itself as a Kimi Code
  community build, and the release line was reset to 0.1.1.
- **README header** drops the "world's first CLI with built-in Graph
  Engineering" superlative in favour of a plain description, and gains a
  section on lessons.
- `alnair-memory` now exposes `workspace_key` and `is_ephemeral_workspace` as
  public functions (formerly the private `compute_workspace_hash` and
  `is_ephemeral_cwd`), so any subsystem keying durable state on a workspace
  shares one definition.
- `/logout` and `alnair logout` were removed. They could only ever clear the
  primary session scope while the name promised "sign out of everything",
  leaving every other provider's credential in `auth.json`.
- `/login` became `/connect`, and the picker's last row is Cancel mid-session
  rather than Quit.

### Fixed

- **Attribution.** `NOTICE` named only Grok Build and skipped Kigi-CLI, so it
  failed Apache-2.0 §4(c) and §4(d). Kigi's `NOTICE` is now reproduced verbatim
  and the §4(b) change notice lists what this fork actually adds. `LICENSE`
  line 1 still read `Copyright 2023-2026 SpaceXAI`, a Grok Build leftover; it
  now carries the Alnair contributors plus the X.AI Corp. attribution.
- The AGENTS.md hot-reload no longer aborts the leader. A reload landing
  mid-turn used `borrow_mut` on the agent `RefCell` and panicked
  `BorrowMutError`; with `panic = "abort"` that killed the leader, which the
  user saw as "edit AGENTS.md → turn dies → pager reconnecting". Files are now
  parked and applied at the turn boundary.
- The restricted PTY environment is identical to the unrestricted one, and the
  child network filter applies to interactive PTYs.
- The web sidebar's workspace and delete flows, tool rendering, and terminal
  colour.
- New sessions register as tabs, and the pager asks where before creating one.

### Removed

- Obsolete reference images from the repository.

### Known issues

- **`[memory]` does not hot-reload into a running session.** Its
  `ConfigUpdate` arm only logs, and the session actor snapshots
  `memory_config` at spawn, so a `[memory]` edit needs a new session. The
  documentation lists it as applying live. Recorded in
  `docs/FINDING-memory-hot-reload.md`; not fixed in this release.

## [0.1.1] — 2026-10-22

The rename. Not a functional release: the Kigi tree with crate, binary, config
directory and environment variables renamed to the `alnair-*` / `alnair` /
`~/.alnair` / `ALNAIR_*` forms.

## [0.1.0] — 2026-10-20

Initial import of the Kigi tree as Alnair.
