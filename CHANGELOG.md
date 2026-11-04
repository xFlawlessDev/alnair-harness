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

## [0.1.6] — 2026-11-04

### Added

- **Structural code search.** `codebase_search` finds a symbol's declaration by
  name and `codebase_context` reads it back, so the agent no longer has to
  `grep` for an identifier it already knows and wade through comments, string
  literals and call sites. Both are backed by an index over the git root that
  starts lazily on the first call and is shared across sessions in the same
  repository. Lazy substring search would be useless on its own, so results are
  ranked: exact matches first, then prefix, then substring, with usage
  frequency ordering within a tier. An empty result says which languages the
  index could parse, so "not indexed" does not read as "does not exist" — and
  an FFI binding (`extern "C" { fn … }`) is now found like any other function.
- **The index stays current, and says where it is.** Every session that owns the
  codebase tools now feeds the index from filesystem events, and a session
  opened in a subdirectory watches the whole repository rather than its own
  subtree. The agent footer gains a `code` chip opposite the context meter:
  a spinner while the index builds, `code: <files>` once it can answer,
  `code: ready` when the count is known only from an earlier process's cache,
  and nothing at all in a session without an index. The index lives at the git
  root, so a fresh session in an already-indexed repository reports it as ready
  instead of starting a second one.
- **The model can write durable memory.** `memory_store` records a note in the
  workspace's memory mid-turn; until now the only ways in were `/flush`, the
  session-end hook and `/dream`, none of which the model drives. Writes are
  classified as edits, so a read-only subagent cannot poison future sessions,
  and the tool only appears when a write backend is present — the tool list is
  byte-identical for anyone who has not opted into memory. A note that looks
  like it carries a credential is refused rather than redacted, and the refusal
  never repeats the value.
- **A marketing site with the user guide.** `landing/` is a fully prerendered
  SvelteKit site in English and Indonesian, deployed separately from the binary.
  Its `/docs/` section is generated from the guide the binary embeds, so the
  published manual cannot drift from the shipped one. Pages carry canonical,
  hreflang and social metadata, plus a generated sitemap and structured data.

### Changed

- Note provenance: a note written to memory carries an HTML comment naming the
  session that stored it, invisible in rendered markdown but greppable when a
  claim needs tracing.
- Dependency refresh for the advisory gate. `zip` moved to 9 (one copy instead
  of 3 and 8), `pdf_oxide`/`office_oxide` to their current releases,
  `pulldown-cmark`, `tokio`, `zstd`, `libz-sys`, `ctutils` and `dark-light` were
  updated, and a yanked `async-executor` was replaced. `dark-light` 3 drops
  `async-std` and `ashpd`; its `detect()` contract is unchanged. The `zip` 9
  bump changed two call sites in `read_file` and the updater, where file names
  are now fallible.

### Fixed

- **Path suggestions keep their display form on Windows.** A corrected
  `path_not_found` hint joined the model-facing cwd with the host separator, so
  `/home/user/project` plus `src` became `/home/user/project\src` — neither a
  valid Windows path nor the POSIX shape the model would retype.
- **The workspace boundary check ignored `..`.** `resolve_under_root` counted
  path depth from the filesystem root, so an absolute path's own ancestors
  padded the count, `..` could never drive it negative, and the escape check
  never fired. It is now a prefix test on lexically normalized paths.
- **Credential redaction missed two shapes.** Word-boundary anchoring did not
  match `DB_PASSWORD=…` because `_` is a word character, the `.env` rule missed
  the same shape inside a source comment, and `github_pat_` tokens were not
  matched at all. The rules now live in one place shared by code search and
  memory writes.
- **A heading-only memory note was permanently unretrievable.** Such a note
  normalized to a bare heading, and the search pipeline drops heading-only
  chunks as scaffolding; the write path gives it a body.
- **The `tool_meta.schema.json` assertion depended on feature unification** —
  it compared rendered bytes, passed alone and failed in a full sweep. It now
  compares a key-sorted rendering.
- `landing/` passes its own lint: the Google Search Console verification stub
  is excluded from Prettier, since its bytes are the verification token.

## [0.1.5] — 2026-10-29

### Added

- **Scrolling session tabs.** The `F2` strip used to render only the chips that
  fit and silently drop the rest. It now renders a window over the tab list with
  `‹` / `›` edge markers that are clickable and participate in hit testing, and
  a mouse wheel over the strip row scrolls it. The window follows the active
  chip by default, so every activation brings its tab into view; an explicit
  scroll pins the window and steps from what the last frame actually painted.
  Reaching either end releases the pin.

### Changed

- **A session opened from the dashboard renders like any other session.** The
  extra `1/2 [‹][›] [Dashboard]` header band is gone, and with it the footer
  differences it justified: the overlay footer no longer prepends navigation
  hints, no longer suppresses the right-hand status line, and no longer
  re-points the shortcuts chip away from `Ctrl+X`. An attached session and a
  plain one now draw byte-identical frames.

### Fixed

- **Delete works on every session row.** Tying deletion to `TopLevel` rows meant
  only active and idle sessions could be deleted; sessions the dashboard lists
  from disk (shown as `Inactive`) were refused. Both row kinds share the same
  confirm window and the same transcript deletion, so a roster row can now be
  deleted. Subagent rows stay refused, since they belong to their parent's
  transcript.
- **Sessions no longer disappear from the dashboard.** Two filters — one hiding
  local sessions with no conversation, one hiding untitled roster entries — made
  a session created and closed without a first message unreachable: it existed
  on disk but no row named it, so it could not be reopened, renamed or deleted.
  Both filters are removed. An untitled session is labelled
  `New session #<id>` and stays listed.
- **Opening a session from the dashboard creates its tab.** Three paths skipped
  tab registration: attaching assigned the view directly, `switch_to_agent`
  returned early before registering when the target was already the active
  view, and a load that started from an unbound placeholder refreshed a chip
  that did not exist yet. All three now register, and a background bind adds the
  chip without moving the active one.

## [0.1.4] — 2026-10-26

### Changed

- **`web_search` and `web_fetch` follow the active provider.** Both tools now
  call the provider connection serving the session's current model —
  `POST {base}/search` with `{query, max_results, model}` and
  `POST {base}/web/fetch` with `{url}` — instead of being gated on a Kimi Code
  OAuth session. The endpoint is resolved per request, so a `/model` switch
  moves both tools to the new provider without a toolset rebuild. Kimi Code
  keeps its own wire on the same paths. A provider without `/search` leaves
  `web_search` unavailable with a clear message; `web_fetch` keeps its local
  pipeline as the fallback. The tool names, arguments and result shape are
  unchanged.

### Fixed

- `crates/codegen/alnair-bin/build.rs` is rustfmt-clean, so
  `cargo fmt --all --check` passes again.

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
