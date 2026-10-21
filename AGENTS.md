# Alnair — agent/developer notes

Single source of truth for how this repository is organized and the
constraints every change must respect. Update this file whenever the tech
stack or product direction changes.

## What this is

Alnair is an unofficial Kimi Code CLI community build: a hard fork of
xai-org/grok-build (Apache-2.0, Rust) re-targeted at the Kimi Code
subscription API and the Moonshot open platform. It coexists with the
official `kimi` CLI: binary `alnair`, config dir `~/.alnair`
(`ALNAIR_SHARE_DIR` override), keyring service `alnair`, env prefix `ALNAIR_*`.
Never read or write `~/.kimi` (except the explicit one-time read-only
import) or any `KIMI_*` env var.

Upstream sync record (update on every sync): fork baseline is upstream
snapshot `8adf901` (2026-07-16, ≈v0.2.102); bug fixes evaluated and
selectively ported through upstream `77cd7eb` (2026-08-25, ≈v1.0.10) in
the 0.1.13 cycle, through `3794978` (2026-09-09, ≈v1.0.24) in the 0.1.15
cycle, through `a28ee2b` (2026-09-17, ≈v1.0.35) in the 0.1.16 cycle, and
through `2bdd1d6` (2026-09-29, ≈v1.0.45) in the 0.1.19 cycle.
The local release is 0.1.20; it adds custom providers declared by base
URL (`[platforms.<name>]`, see CUSTOM PROVIDERS below).
Every upstream reference comes from the local clone at `./grok-build`
(gitignored, never committed): `git -C grok-build pull` before a sync,
then read upstream code and history there, not from the web.
Upstream is daily "Synced from monorepo" snapshots —
the commit BODIES carry per-change bullet lists, and
`crates/codegen/xai-grok-shell/changelogs/` maps releases to dates;
start any future sync from those two, not from raw diffs.

Known limitations left by the 0.1.15 sync (fix before relying on them):
the Windows frame writer writes through `std::io::stderr`, so a console
that stops reading still blocks exit-path prints behind std's stderr lock
(unix silences fd 2 after a timed-out writer join); the bwrap command
builder re-checks `Path::exists("/data")` and can omit the devbox bind on
a stat error that the profile classification treated as present.

Known limitation left by the 0.1.16 sync: `notifications/cancelled` for a
timed-out MCP call cannot reach a streamable-HTTP server that answers
`tools/call` with a plain JSON body. rmcp 2.2.0's HTTP worker awaits each
POST in turn, so the cancel queues behind the hung call;
`servers/cancel_aware.rs` waits 500 ms, warns, and the transport reset
then drops the connection. stdio and SSE-mode servers get the cancel.
The cure is rmcp 3.x (upstream runs 3.2), a major bump not yet taken.

Evaluated in the 0.1.19 window and left for a later cycle: headless `-p`
interrupt handling (upstream `SignalStreams` plus a headless signals module; Alnair's
`headless.rs` installs no handler, so SIGINT kills the run without session
cleanup), the subagent "Cancelling" overlay that outlives the child turn (needs
upstream's child-turn finalizer and its prompt-id bookkeeping), the honest
answer for a `spawn_subagent` call cancelled by send-now (a chat-state answers
channel), the effort picker preselecting the model's default effort and
accepting menu labels (tied to upstream's `ModelChoice` refactor), and every MCP
change that rides rmcp 3.x (`bearer_token_file`, argument coercion, elicitation
notes). The rmcp and tree-sitter major bumps stay open.

Evaluated in the 0.1.16 window and left for a later cycle: MCP qualified
tool names past 64 chars (first prove the name never reaches a provider
function list), the auto-update guard for a binary still in use (needs
per-OS process scans), the DA1 fence around the kitty keyboard pop (needs
a design against the 0.1.15 teardown), MCP servers on protocol 2026-07-28
(rmcp 3.x again), and `pager.toml`, whose writer in
`alnair-pager-render/src/appearance/config.rs` still ends in a bare
`fs::rename` and replaces a symlink.

## Hard constraints

- **Zero egress**: only `auth.kimi.com`, `api.kimi.com`, `api.moonshot.cn`,
  `api.moonshot.ai`, GitHub Releases (`api.github.com` for the self-updater,
  `github.com` for asset downloads), user-configured MCP servers, credentialed
  provider endpoints, and `models.dev` (metadata refresh, ONLY when an enabled
  platform's `/models` lacks it — `wire_serves_metadata=false`, never
  Kimi/Moonshot, `ALNAIR_MODELS_DEV_URL=0` disables). No telemetry, no analytics,
  ever. `crates/codegen/alnair-env` is the single home of first-party endpoints.
- **One SSRF policy**: `ssrf::is_blocked_for_host` gates every model/settings
  URL (`web_fetch` + hooks), per redirect hop. Never write a second copy.
- **Toolchain**: Rust 1.97.0 (rust-toolchain.toml), edition 2024.
- **Gates** (all must stay green):
  `cargo check --workspace --all-targets`,
  `cargo clippy --workspace --all-targets` (zero warnings),
  `cargo fmt --all --check`, `cargo deny check advisories`.
  The web harness has its own, run from `web/`: `npm run check`,
  `npm run lint`, `npm test`.
- **Observability is local**: `alnair-log` (unified session log, `--debug`
  firehose, subsystem file logs, opt-in instrumentation) writes under
  `~/.alnair` only. Its zero-network property is a contract.
- **Atomic file replace goes through `util::fs::replace_file`** (tmp+rename
  commit step; async callers wrap in `spawn_blocking`). Never inline a bare
  `fs::rename` replace: Windows `MoveFileExW(REPLACE_EXISTING)` fails with a
  sharing violation while AV/indexer/cloud-sync holds the destination open —
  the "persists on macOS, silently doesn't on Windows" class (a /model
  switch that never stuck). Plain rename stays correct only for true moves
  whose destination doesn't pre-exist (worktree-pool markers, corrupt-file
  backups). Write failures must at least `warn!` — never `let _ =`.
- **config.toml writers resolve their destination through
  `util::config::config_write_dest` before they name the tmp file.** A
  symlinked `~/.alnair/config.toml` (dotfiles) keeps its link: the tmp sits
  beside the referent and replaces it. Only that one path is followed, and
  only while `user_alnair_home()` resolves (with no home, `alnair_home()` is the
  project's own `./.alnair`). A project `.alnair/config.toml` is
  repo-controlled, and following its symlink would overwrite whatever file
  a hostile repo points it at; there the link itself is replaced.
  Credential and managed stores never follow symlinks.
- The root `Cargo.toml` is hand-maintained (upstream's generator is not in
  this repo). Members sorted; versions inherited from
  `workspace.package.version` — the single source of truth for the release
  version (`alnair_version::VERSION` derives from it; the release workflow
  gates the `v*` tag against it).

## Layout

- `crates/codegen/` — the bulk of the application (62 `alnair-*` crates).
  Key ones: `alnair-bin` (binary `alnair`), `alnair-tui` (full-screen TUI +
  headless `-p` mode + `acp`/`mcp` commands), `alnair-shell` (agent runtime,
  leader-follower IPC, sessions), `alnair-sampler` (inference client;
  ChatCompletions/Responses/Messages backends), `alnair-auth` (credentials),
  `alnair-config` (config layering, `~/.alnair` paths), `alnair-env` (endpoints),
  `alnair-tools` (tool implementations incl. codex/opencode ports — see its
  THIRD_PARTY_NOTICES.md), `alnair-workspace` (FS/VCS/exec/permissions,
  checkpoint/worktree), `alnair-log` (local observability).
- `crates/common/`, `crates/build/`, `prod/mc/` — shared libs, proto build,
  proxy wire types (the latter to be redefined against Kimi in M1).
- `web/` — the browser harness: SvelteKit + Tailwind v4 + shadcn-svelte, composed
  into the AI Elements patterns. Its own `README.md` is the source of truth for
  the palette, the `SessionStore` seam, and what is still mocked. It is a
  separate npm project (never part of the Cargo workspace or its gates); it
  makes no external requests — fonts are self-hosted, nothing loads from a CDN.
- `third_party/` — vendored Mermaid rendering stack (untouched policy).
- `bin/protoc` — dotslash launcher used by proto codegen.

## Storage discipline

- Tests that touch the filesystem MUST use `tempfile::TempDir` (drop
  cleans up) — never bare `std::env::temp_dir()` + `create_dir_all`,
  which leaks directories into the OS temp root forever.
- `target/` grows past 150GB across repeated full-workspace builds
  (incremental is already off); run `cargo clean` when it exceeds
  ~50GB and at milestone boundaries.
- Graph node worktrees are removed right after a successful merge-back;
  only FAILED nodes keep theirs for postmortem.

## Multi-terminal UX

The pager defaults to leader mode: `resolve_use_leader` takes an
`unset_default` parameter, the pager passes `true`, and `alnair agent` passes
`false` so the editor/stdio path keeps `stdio_direct_update_eligible`. An
explicit `[cli] use_leader` still wins in both directions, and `--no-leader`
still never evicts a running leader.

A bare launch (no resume, no initial prompt, no `--worktree`, not minimal,
under a leader) arms `AppView::startup_auto_attach`; the first
`TaskResult::RosterLoaded` calls `take_startup_auto_attach_choice`, which is
the ONE decision point. `session_startup::pick_auto_attach` matches the
**canonicalized cwd exactly** — one leader serves every repo, so that match is
the only thing keeping them apart — and keeps `Working`/`NeedsInput` rows
(`session/load` is join-not-steal, so an attach becomes a viewer). The
`viewer` status chip and the one-shot notice are how the user learns a turn
is being driven elsewhere. A load failure for the auto-attach agent returns to
Welcome with a toast; every other load failure keeps its error block.

### Session tabs (F2)

The strip is client state over a shared file, not agent state. `TabEntry` keys
on `session_id` (stable across processes), never `AgentId`, and carries the
session's **own cwd** — a global strip spans repositories, so `+` creates in
the focused tab's directory and the `repo ⎇ branch` label appears only when the
strip holds more than one. The strip offers `[ × ]` (close the active tab —
never the session) and `[ + ]` (create one) as clickable chips; the close chip
is omitted when no tab is active rather than painted as a dead button.

**A session earns its tab when its id is bound, not when it becomes the view.**
`switch_to_agent` is the single funnel for `ActiveView::Agent`, but a
brand-new session has no id there — `AgentSession::session_id` stays `None`
until the shell answers `CreateSession`. So every post-bind handler
(`handle_session_created`, `handle_worktree_session_created`,
`handle_session_restored`, both fork paths) calls
`tabs::register_agent_tab`. Without that second registration a `/new`,
Ctrl+N, fork, or dashboard-dispatched session never reached the strip while a
resumed session (id known up front) always did. A bind arriving for a session
that is not in front adds the chip **without** moving the cursor — a dashboard
dispatch leaves the dashboard foregrounded, and stealing the active chip there
would claim the user is looking at something they are not.

`~/.alnair/run/pager_tabs.json` follows `active_sessions.rs`: a `_in(root, …)`
seam for tests, `lock_exclusive` held across the whole read-modify-write,
`replace_file` for the commit, readers lock-free. `NotFound` reads as empty —
on Windows `replace_file` deletes the destination before renaming, so absence is
a normal transient state and must never be treated as corruption. `scope` lives
inside the file so two clients cannot disagree mid-session; the file wins over
config. `cancelled_tabs` is in-process only: the lock already makes
cross-process resurrection impossible.

### The directory picker is app-level

`views::location_picker` owns the path-completion modal, and it answers only
"which directory?". The **caller** supplies a `LocationPickerPurpose` and
decides what the answer becomes, because three different outcomes share one
modal:

| Purpose | Opened by | Enter does |
|---|---|---|
| `Dashboard` | `Ctrl+L`, `/cd`, the header label | retarget the dashboard's dispatch cwd |
| `NewSession` | `/new`, the strip's `+` | create a session in that directory |
| `PagerCwd` | `Ctrl+L` on Welcome | move the pager, create nothing |

`AppView::location_picker` hosts the non-dashboard purposes (routed before the
view dispatch, painted after the view body so it overlays whatever is in
front); `DashboardState::location_picker` keeps its own copy because that one
is an overlay on a view it owns. Do not fold them together — the dashboard's
picker is reset on dashboard-open and carries the dispatch worktree toggle,
which has no meaning on the other two surfaces.

`/new` asks; `/clear` does not. `/clear`'s name promises "start over *here*",
so it keeps the in-place path. Creating from the picker deliberately does
**not** move the process cwd: a global strip spans repositories, and
re-rooting the pager would silently change where unrelated later actions
resolve relative paths — `/cd` stays the explicit way to move it.

The Welcome screen's menu rows come from `views::welcome::welcome_menu_items`,
shared by the renderer and the input handler. That is what keeps an inserted
row from being painted with one meaning and dispatched with another.

Tab chords are context-gated for the same reason `Ctrl+.` is: without the kitty
keyboard protocol `Ctrl+Tab` arrives as a plain CR, which is `FocusPrompt` /
`FocusScrollback`. `Ctrl+PageUp/Down` is the primary everywhere; the `Ctrl+Tab`
variants are added only when `kitty_skip_reason()` is `None`.

The unread marker is server-authoritative. `Summary.viewed_at` merges
monotonically, and `SummaryPatch::record_view` **skips the `updated_at` bump** —
`last_change_unix_ms()` falls back to `updated_at`, so treating a read as
activity would re-sort the roster (and the strip) on every focus. `●` is
computed as `last_change_unix_ms > viewed_at` and rendered only on inactive
tabs; a session with no watermark reads as unread once and self-corrects.

### Terminal pane (F3, sub-phase 3a + 3b)

The pane is an interactive PTY, not a mirror: it owns its own shell (separate
from the agent's bash tool), forwards keystrokes, pastes and resizes, and
replays the server's ring buffer on reopen. The pane is lazy — no shell spawns
until ``Ctrl+` `` — and hiding it only clears `terminal_open`: the PTY keeps
running. `PtyClose` fires only when the view goes away, in
`remove_agent_and_cleanup` (the single view-drop chokepoint, which RETURNS the
close effect). `ExitSession` must never kill the PTY: it only switches to
Welcome and keeps the agent.

**Key routing** (`agent_view/terminal_input.rs`). Two escape hatches, then
everything belongs to the program: `Ctrl+Q` leaves the pane, the toggle chord
works from inside it, and `Ctrl+C`/`Esc` reach the shell — stealing `Ctrl+C`
for cancel-turn would make the pane useless, and `vim` needs `Esc`. The encoder
(`app/terminal_pane/keys.rs`) takes the emulator's LIVE `TerminalModes` because
arrows are `ESC O A` under `DECCKM` (application cursor) and `ESC [ A`
otherwise; pastes are bracketed only when the program asked. `KeyModifiers` is
a bitflag, so `key!` cannot express it — use `KeyShortcut::new`.

**Resize** is NOT dispatched as an `Effect`: `draw` owns the frame cadence, so
the draw site records `pending_pty_resize` and `AppView::draw_inner` sends the
debounced size after the frame (every intermediate frame of a drag overwrites
it, which is the debounce). Input, by contrast, IS an `Effect` — as a
fire-and-forget notification, never a request, or every keystroke pays a round
trip.

**One pane per client.** `pty_session::load` overwrites the PTY's
`target_client_id`, so a second pager loading the same PTY would steal the
output stream from the first. Each pager therefore creates its own PTY, and 3b
still sends no `_meta.clientId` (single-client routing already returns output
here). Real per-client ids matter only in 3c, which must also close the leader
routing gap: `alnair/terminal/pty/notification` carries `terminalId`, NOT
`sessionId`, so `last_active_client` routing can misdeliver with two pagers.
Do NOT add it to `is_machine_wide_broadcast_notification` — that would send
every pane's bytes to every client.

The screen emulator lives in `alnair-terminal-screen`, extracted verbatim from
`ptyctl` (which re-exports it). `screen::visible_rows` is the renderer-facing
readback: `alacritty_terminal`'s colour types stop at that boundary, so the
pager maps `ScreenColor` to `ratatui::style::Color` and never imports the
emulator's internals.

The pane rect is carved out of `AgentViewLayout::scrollback` **at the draw
site** (`views::terminal_pane::split_scrollback`), never as a constraint in
`AgentViewLayout::compute`: that function takes 17 arguments and ~30 geometry
tests pin its output. `PaneAreas::terminal` is stamped onto the layout's
`pane_areas()` afterwards, because a dozen overlay paths reassign it and only
the draw site knows where the pane went. The pane stays hidden on a short
terminal (`SHORT_TERMINAL_ROWS`), in minimal mode, and while a subagent is
fullscreen. A `isReplay` frame **resets the emulator** before feeding; without
that a reopen would append the whole ring buffer to what the pane already
showed.

## Terminal keyboard

`Shift+Enter` inserts a newline in the prompt wherever the terminal can
report the modifier, and `kitty_skip_reason` decides where that is —
`shift_enter_unavailable` matches on it rather than keeping a second brand
list, because the two drifted once and the UI advertised a chord that never
arrived. Two skips still deliver the modifier: Apple Terminal, where
`route_enter` polls CoreGraphics, and Windows Terminal, where the console
key record carries SHIFT with no protocol at all (a bare ConHost is only
optimistically refined to Windows Terminal, so it keeps advertising
Alt+Enter). Everywhere else — VTE, xterm.js, JediTerm, screen, tmux below
3.3, tmux with `extended-keys off` — the byte on the wire is a plain CR and
no client-side trick recovers it: crossterm 0.28 parses kitty `CSI 13;2u`
but not xterm's `CSI 27;2;13~`, so `modifyOtherKeys` buys nothing. NO VTE
release carries the protocol (checked at tag 0.82.0:
`_vte_keymap_GDK_Return` encodes only Alt); a version cutoff for it is a
bug, not a feature. `/terminal-setup` owns the per-terminal recipe.

## Config hot-reload

`ConfigFileWatcher` (notify + 1s debounce) feeds `ConfigReloader`, which diffs
and emits `ConfigUpdate`. Two transports consume that stream, both in
`agent/app.rs`:

| Transport | Dispatcher | Used by |
|---|---|---|
| ACP request line injected into the inbound simplex | `run_config_update_dispatch` | `run_leader`, `run_stdio_agent` |
| Direct `MvpAgent::dispatch_internal` over the `Rc` | `run_config_update_dispatch_direct` | in-process TUI spawn (`alnair-tui/src/acp/spawn.rs`) |

The in-process transport has **no inbound simplex** — `spawn_agent_thread_direct`
hands RPC straight to the agent — so stream injection is not available there.
Both dispatchers must gain any new arm together; a reload kind that only works
under a leader is a bug.

**AGENTS.md / CLAUDE.md / rules `*.md` are watched as
`ConfigChangeEvent::AgentInstructionsChanged`.** `is_agent_instructions_path`
matches a deliberate *superset* (every compat `agent_filenames()` entry plus
`*.md` in `<vendor>/rules`), because the watcher is leader-global with no
per-session compat resolved — a false positive costs one content-hash compare,
a false negative is permanent. Dedupe is the reloader's `hash_agent_instructions`,
which hashes what discovery would actually read.

`watch_cwd_dirs` also registers the **ancestor chain** cwd→git root, refcounted
in `ancestor_watch_refs` because two sessions in one repo share it. Discovery
walks upward, so a repo-root `AGENTS.md` is part of a session opened in
`repo/crates/x/` and must be observed there.

`SkillsFileWatcher` mirrors that split with `watch_cwd`/`unwatch_cwd`, driven
from the leader's cwd drain: `start` resolves its dirs from the *process* cwd,
but one leader serves every repo, so a session opened elsewhere would otherwise
have no skills watch. Dirs `start` installed are `initial_dirs` — counted by
`watch_cwd` but never re-watched or released, since they belong to the process.

The revision is **appended, never substituted**: `SyntheticReason::
ProjectInstructionsUpdate` is its own variant precisely so
`conversation_has_project_instructions` keeps answering "the spawn-time block is
present". Reusing `ProjectInstructions` would make the spawn/resume guard skip
the update at every call site and break its documented never-replaced
invariant. `reload_project_instructions` compares stored **content**, not the
rendered reminder — `AgentBuilder` rewrites `file_path` to the display cwd, so a
path-sensitive compare would re-inject on every event. Flush happens at the two
`flush_pending_skill_reminders` sites (loop start, idle); the pending slot is an
`Option` so a save-storm coalesces to the newest revision instead of replaying
every intermediate state.

`agents_md_files` is not an input to `PromptContext::render`/`placeholders`, so
`Agent::replace_agents_md` cannot disturb the KV-cache prefix. Do not move it
into the rendered prompt.

## Test seams

Cross-crate test hooks are behind the `test-support` cargo feature
(alnair-workspace, alnair-pager-render, alnair-config, alnair-tui), enabled via
dependents' `[dev-dependencies]`. Don't expose new test seams as plain
`#[cfg(test)]` items across crate boundaries.

**`dirs::home_dir()` ignores `HOME` on Windows** (it reads the
`FOLDERID_Profile` Known Folder), and so does `std::env::home_dir()` — a
verified probe on the 1.97 toolchain returns the real profile with `HOME`
pointed elsewhere. Any test that needs "this tempdir is home" therefore cannot
use an env guard; it injects the home instead:
`RepoDirChain::resolve_with_home`, `is_config_path_auto_trusted_with_home`,
`refresh_local_installs_with_home`, and
`alnair_workspace::trust::HomeOverride` (the RAII, process-global,
`serial`-only seam behind `is_home_dir`). `HomeOverride` is test-builds-only on
purpose: an environment hook would be fail-open, since "this is home" is the
TRUSTED verdict for the folder-trust gate.

`Theme::current()` quantizes through `color_support`, whose level is a
write-once `OnceLock`. `cache::pin_theme()` therefore cannot rely on
`color_support::set` — once anything resolves the level (and an ambient
`NO_COLOR=1` decides `None`), the set is a no-op and EVERY theme color becomes
`Color::Reset`, silently emptying any assertion that distinguishes two colors.
`pin_theme` uses the `force_for_test` seam instead; a test needing a specific
level must do the same.

**Never sleep to sequence a test.** A fixed sleep is either too short (a
loaded runner schedules the other side late) or wastefully long, and on Windows
it is the usual cause of a suite that passes alone and fails in a sweep.
Coordinate on the event instead: an `Arc<AtomicBool>` done-flag when the test
owns both sides (`join()` is not an option where the handle must survive), a
content poll rather than an existence check when a child writes a file, and a
ready-marker handshake when a separate process must reach a state (the lock
tests in `active_sessions` write the marker only after `$f.Lock(...)` returns).
Every such wait carries a ceiling so a real hang fails with a message instead
of blocking the run.

A macro that emits `canonicalize` (rust-embed's derive does, to resolve its
`#[folder]`) trips the repo-wide `disallowed-methods` ban from inside its own
expansion, and an item-level `#[allow]` does not reach a generated item. Put
the allow on a module wrapping the derive, and say in a comment why the
canonicalized path never reaches runtime path handling.

## Graph mode (`/graph`, post-0.1.x — plan.md in the parent dir)

A deterministic DAG scheduler layered over the goal engine: `/graph
<objective>` decomposes the objective into nodes (graph planner subagent
→ Agentproof-style static gate in `graph_plan.rs`), then executes each
node as one ordinary goal — the agentic loop lives INSIDE the node; the
edges stay deterministic Rust. The harness appends a terminal
`gn-final` verification node depending on every planner node.

- Enabled by default (`ALNAIR_GRAPH=0` is the off-switch; the G0 gray
  release is over); availability additionally requires the goal harness
  (`BuiltinGate::Graph`).
- Key modules (alnair-shell): `session/graph_tracker.rs` (pure state
  machine; reuses `GoalStatus`/`GoalPhase`/`GoalPauseReason`),
  `session/graph_plan.rs` (planner-JSON contract + validation + fnv id
  canonicalization), `session/graph_planner.rs` (planner runner, reuses
  the goal planner spawn plumbing),
  `session/acp_session_impl/graph.rs` (orchestration seam).
- Seam points: `handle_prompt` intercepts GraphSet/GraphResume; the
  in-turn loop's `EndTurn` arm calls `run_graph_round_end()` to advance
  nodes within the same turn; goal auto-pauses cascade to the graph in
  `auto_pause_goal_if_active_inner`; node goals are armed with the
  REMAINING graph budget so `enforce_goal_token_budget` cascades trips.
- Persistence: `PersistenceMsg::GraphModeState(Option<..>)` →
  `<session_dir>/graph/state.json` (`None` tombstones after clear);
  immutable per-version baselines `graph/graph.baseline.v{N}.json`;
  per-node goal artifacts archived to `graph/<node_id>/`. Restore
  demotes `Active`→`UserPaused` and `Running`→`Ready` (re-run is safe:
  the verifier gates completion).
- `/goal` and `/graph` are mutually exclusive while the graph owns the
  engine; e2e suite: `acp_session_tests/graph/graph_e2e_tests.rs`.
- Parallel fan-out (G1): with `ALNAIR_GRAPH_CONCURRENCY > 1` (default 3,
  clamp [1,8]) and ≥2 `Ready` nodes, `drive_graph` runs batches via
  `acp_session_impl/graph_workers.rs` — per node a bounded
  worker↔verifier subagent loop (`ALNAIR_GRAPH_NODE_ROUNDS`, default 3;
  `general-purpose` children; worktree isolation on round 1, resume
  keeps context+worktree on later rounds; `NODE_RESULT:` /
  `NODE_VERDICT:` terminal contracts parsed fail-closed), then
  SEQUENTIAL merge-back via `alnair_workspace::worktree::apply_worktree`
  (`ApplyMode::Merge`); a conflict fails the node and blocks its
  dependents while other chains continue. `gn-final` always runs
  serially on the full goal engine. Concurrency=1 is byte-identical to
  the serial G0 path. Ceiling: a worker round exceeding the foreground
  subagent await budget (600s) is cancelled and retried via resume.
- G2: `BudgetLimited` is resumable — a budget trip demotes in-flight
  nodes to `Ready` (resource stop, not a verdict) and
  `/graph resume --budget <tokens>` re-arms with fresh headroom. The
  pager shows a graph status chip driven by the `GraphUpdated` wire
  variant (`extensions/notification.rs`), emitted from the single
  `persist_graph_state` chokepoint (checkpoint ⇔ badge tick); old
  pagers degrade via `#[serde(other)] Unknown`. PTY scenarios:
  `graph_slash_presession{,_disabled}.yaml`.
- G3: dynamic replan. `DISCOVERED: <text>` line markers (fence-stripped,
  placeholder-filtered) from workers/verifiers/the serial node's final
  text queue as `pending_discoveries`; at each dispatch boundary
  `maybe_replan_graph` (`acp_session_impl/graph_replan.rs`) runs a
  replanner subagent producing an APPEND-ONLY appendix
  (`validate_replan`: existing-id deps allowed, edges onto `gn-final`
  rejected — they would cycle after the final-gating extension),
  bumps `plan_version`, freezes `graph.baseline.v{N}.json`, and regates
  `gn-final` (Ready→Waiting). Bounded by `ALNAIR_GRAPH_REPLAN_CAP`
  (default 3, 0 = off); past the cap — and after the final node has
  achieved — discoveries drain to history only. Replan failure degrades
  (history + notice); it never pauses a working graph.
- G4: the graph follows the repo. Every checkpoint projects to
  `.alnair/graph.jsonl` at the git root (`session/graph_project.rs`,
  header line + one node per line, atomic write); single writer via an
  fs2 flock sidecar; other instances get read-only `/graph status`.
  Fresh sessions revive via `/graph resume` (load UNDER the lock,
  from_snapshot demotions apply). All lock-then-mutate sites
  identity-check the projected `graph_id`; alnair never commits the file.
- G5: `/graph show` renders box-drawing DAG art
  (`session/graph_render.rs`, Sugiyama-lite: longest-path layers, dummy
  pass-throughs, barycenter ordering, bus lanes). Wider than 120 cols
  degrades to the status tree.
- G6: plan-boundary topology optimizer
  (`acp_session_impl/graph_optimize.rs`; `ALNAIR_GRAPH_OPTIMIZER=0`
  disables). Restricted ops (`remove_dep`/`reorder`/`merge`/`split`)
  validated by `graph_plan::apply_optimization`: pending-only targets,
  immutable nodes byte-identical in the result, terminal gate rebuilt,
  whole-graph acyclicity. Applied passes bump `plan_version` and share
  the replan cap; `{"ops": []}` is a respected free no-op; failures
  degrade.

## Swarm (`agent_swarm` tool + `/swarm` mode)

Cheap, unstructured fan-out — the one thing `/graph` does not offer. One
`prompt_template` containing `{{item}}` is expanded over an `items` list
into up to `MAX_AGENT_SWARM_MEMBERS` (128) ordinary subagents, run to
completion, and returned as ONE aggregate. Ported from kimi-code; entirely
client-side, no backend surface.

- Engine (`alnair-tools/.../alnair/agent_swarm/`): `plan.rs` validates and
  expands (every fault is reported BEFORE a member starts; expanded
  prompts must be pairwise distinct), `schedule.rs` is the launch ramp as
  pure arithmetic (5 immediate, then 1 per 700ms; capacity shrinks on a
  provider rate limit and recovers after a quiet window;
  `ALNAIR_AGENT_SWARM_MAX_CONCURRENCY` caps it and a malformed value is a
  hard error), `run.rs` drives it against the EXISTING single-spawn
  `SubagentBackend`, `tool.rs` is the tool.
- `SwarmMemberOutcome::Backgrounded` is load-bearing: a member that
  outlives the 600s foreground budget is detached by the coordinator and
  KEEPS RUNNING. It is never reported `Failed` and never offered for
  resume — relaunching its item would put a second agent on the same
  files. Members share the caller's tree with NO isolation; the
  distinct-prompt rule is the only thing keeping them apart.
- `InFlightGuard` (run.rs) cancels live members when the runner's future
  is dropped. Send-now cancels the turn WITHOUT cancelling subagents and
  aborts the task; the dropped receivers read as "parent gone" and each
  child re-attaches itself. There is no cooperative path to use instead —
  `alnair_tool_runtime::Cancellation` is constructed nowhere.
- Both retries (`MAX_RATE_LIMIT_RETRIES`) and wall clock
  (`MAX_SWARM_RUNTIME`) are bounded: the swarm blocks the caller's turn,
  so every wait needs a ceiling. Stragglers at the deadline are reported
  as still-running WITH their ids.
- Underneath every fan-out (swarm, graph, raw Task) sits the
  session-scoped spawn bound: `handle_subagent_request` holds one permit
  from the parent session's semaphore for the whole child run
  (alnair-tools `task/admission`: 32 default via
  `ALNAIR_MAX_CONCURRENT_SUBAGENTS`, queue|fail via
  `ALNAIR_SUBAGENT_LIMIT_BEHAVIOR`), so wide fan-outs queue instead of
  exhausting file descriptors.
- `ToolKind::AgentSwarm` is its own variant because `TemplateRenderer`'s
  `by_kind` map holds ONE tool name per kind — sharing `Task` would
  silently redirect `${{ tools.by_kind.task }}` in other tools' prompts.
  It gates exactly as `Task` does (`capability.rs`), and `builder.rs`
  strips it wherever `task` is stripped. `MAX_SUBAGENT_DEPTH` stays 1:
  upstream's unlimited nesting is a hazard, not a feature.
- `/swarm | /swarm on|off | /swarm <task>` (`BuiltinGate::Swarm` = the
  tool is in the toolset) arms a doctrine reminder via the existing
  `push_system_reminder`. Two triggers only: `Manual` persists until
  switched off, `Task` auto-expires at turn end via `SwarmTurnGuard` — a
  DROP guard, because a user interrupt aborts the turn future and never
  reaches post-loop code. `enter` is a total no-op while armed so the
  `/swarm <task>` shorthand cannot downgrade a standing `/swarm on`.
- The mode is deliberately NOT persisted (unlike `/goal` and `/graph`,
  which strand real work if lost): it is a prompt hint whose recovery is
  retyping one command. The injected doctrine IS durable, so an explicit
  `/swarm off` retracts UNCONDITIONALLY — a resumed or compacted session
  can read as "off" with the instruction still in context.

## Provider registry & API-key auth (post-0.1.3 expansion)

- The platform registry is compiled-in spec rows in `alnair-models`
  (`PlatformSpec`; adding a platform = enum variant + `ALL` entry + `spec()`
  arm + row; registry tests enforce completeness/uniqueness/row shape).
- API-key resolution precedence, per platform: platform env var(s) >
  `auth.json` scope named by the platform id (`moonshot-cn`, …) >
  legacy `[platforms.<id>]` in config.toml (read-only fallback).
- The TUI login picker persists pasted keys to `auth.json` (platform-id
  scope, `api_key` mode) — never to config.toml. The keyring holds ONLY the
  OAuth session scope; platform keys are file-only.
- Auth method ids over ACP equal the platform ids; interactive picker rows
  are built generically from advertised methods (`AuthMethodKind::
  ApiKeyPlatform`), so new registry rows appear in the picker with no TUI
  changes.
- Every OAuth picker row carries ITS OWN method id (`PendingMenuItem::Login
  { method_id }` → `Action::LoginWith`); an unknown id fails closed. The
  id-less `Action::Login` (auto-login, 401 re-auth) resolves the first
  interactive method. `/login` opens the picker (`Action::OpenLoginPicker`),
  never a flow directly; mid-session its last row is Cancel, not Quit.
- `_meta.connected` on an advertised method is DISPLAY state (green badge on
  the picker): stamped at `initialize()` from stored credentials
  (`connected_method_ids` + `stamp_connected_meta`), kept fresh TUI-side
  after in-session logins (`auth_in_flight_method` → `AuthComplete`). It is
  never an authorization input.
- Refreshable-OAuth providers beyond Kimi Code use a GENERIC path, NOT Kimi's
  bespoke wire. A `uses_oauth` platform carrying `oauth: Some(&OAuthConfig)`
  (client id / auth host / start+token paths / `token_host` / `scope` /
  `scope_key` / optional extra device field / `flow` / `token_body`) drives a
  scope-keyed `AuthManager::new_oauth_provider` +
  `refresh::GenericDeviceRefresher` (selected by `build_refresher` via
  `oauth_config_for_scope_key`; the refresher dispatches the refresh body by
  `token_body`: form → `auth::oauth_device`, JSON → `auth::oauth_pkce`,
  `GithubCopilotExchange` → `auth::github_copilot` copilot-token re-mint). Kimi
  Code keeps `oauth: None` and its bespoke path unchanged. The interactive
  login is dispatched by `OAuthConfig.flow` (in `run_oauth_provider_flow`):
  - `OAuthFlow::DeviceCode` → `auth::oauth_device` (RFC-8628 device-code, plain
    alnair UA, no X-Msh headers). Provider: `xai-grok` (`scope_key oauth/xai`,
    base `api.x.ai/v1`, form token body, same wire as the API-key `xai` row).
  - `OAuthFlow::PkceLocalhost { redirect_port, redirect_path }` →
    `auth::oauth_pkce` (authorization-code + PKCE S256,
    `127.0.0.1:redirect_port{redirect_path}` loopback with STRICT `state`
    validation + manual-paste fallback, authorize host possibly ≠ token host).
    The `token_body` selects the login dialect: `Json` = claude (`state ==
    verifier`, JSON exchange carrying `state`), `Form` = codex (fresh-random
    `state`, FORM exchange without `state` via `exchange_code_form`).
    `OAuthConfig.authorize_extra` appends provider-only authorize params (empty
    for all but codex). Providers:
    - `claude-pro-max` (`scope_key oauth/claude-pro-max`, port 53692
      `/callback`, JSON body, base `api.anthropic.com/v1`, Anthropic Messages +
      listing wire reached with an OAuth `sk-ant-oat…` Bearer). Its Messages
      requests take the OAuth adaptation — `anthropic-beta claude-code-…,oauth-…`
      + `claude-cli` UA + `x-app cli` + the required "You are Claude Code…"
      system prefix — gated on `SamplerConfig.anthropic_oauth` (claude-pro-max
      only), so API-key `anthropic`/`minimax` Messages requests stay
      byte-identical. Its `/v1/models` listing rides the same Bearer +
      oauth-beta headers. THINKING REPLAY (`prune_replayed_thinking`,
      all Messages requests): Anthropic validates every replayed
      `thinking` block (signature model-bound, non-empty required), so
      only the final assistant message's signed thinking is replayed and
      only while its tool loop is open (request ends on the tool
      results); everything else — unsigned cross-backend history, `tco_*`
      Responses blobs, stale-model blocks — is stripped, or the request
      400s "Invalid `signature` in `thinking` block".
- CROSS-PROVIDER REPLAY POLICY (Pi `transform-messages` pattern): the
  conversation history is provider-agnostic and sessions switch
  models/backends mid-history, so EACH wire builder owns emitting only
  items valid for its target — never patch downstream except in the
  per-backend body adapters. Concretely: the Responses input drops
  Reasoning items without a native `rs_*` id (foreign capture is id "")
  and provenance-gates whole turns via `transform_items_for_responses`
  (`AssistantItem.model_id` vs the request model: foreign Reasoning
  dropped, foreign BackendToolCall demoted to its `text_summary`);
  the codex adapter additionally drops bare `rs_*` references (stateless
  backend); tool-call ids pass through ONE shared ASCII
  `sanitize_tool_call_id` symmetrically on call+result on BOTH the
  Messages and Responses legs; Messages image sources go through
  `parse_base64_image_data_uri` (raster whitelist, no `data:` url
  sources) and empty user turns get a placeholder. Dangling tool calls
  are already repaired item-level by `repair_dangling_tool_calls` on the
  actor's build path. When a provider wire bug surfaces, fix the CLASS
  across all three builders in the same pass — three sequential
  single-provider fixes (thinking signature → codex system role → codex
  reasoning id) motivated this policy.
- ChatCompletions dialect selection: registry platforms declare
  `chat_compat` explicitly; BYOK/custom entries default to `Passthrough`
  (vanilla OpenAI semantics) EXCEPT entries pointed at the house/Kimi
  coding endpoint, which keep the `Kimi` dialect (base-url detection —
  Pi-style quirk sniffing). `ChatCompat::Mistral` = StrictOpenAi plus the
  exactly-nine-`[a-zA-Z0-9]` tool-call id normalizer
  (`normalize_mistral_tool_call_ids`, deterministic FNV-1a→base36, one
  map for call+result; persisted `mistral` values resolve here). Chat
  tool messages are TEXT-ONLY: tool-result images batch into one
  synthetic user message after the consecutive tool-result run
  (`conversation_to_chat_messages`).
    - `openai-codex` (ChatGPT Plus/Pro, `scope_key oauth/openai-codex`, port
      1455 `/auth/callback`, FORM body, authorize+token host `auth.openai.com`,
      client `app_EMoam…`, scope `openid profile email offline_access`, the 3
      authorize-extra params `id_token_add_organizations`/
      `codex_cli_simplified_flow`/`originator=codex_cli_rs`). Refresh is a plain
      `refresh_token` FORM grant (the generic refresher's `Form` path →
      `auth::oauth_device`). The minted `access_token` is a JWT; login FAILS
      FAST unless it carries the `["https://api.openai.com/auth"]
      ["chatgpt_account_id"]` claim (`chatgpt_account_id_from_jwt`) — that
      account id is NOT persisted but re-derived STATELESSLY from the current
      bearer at every request. INFERENCE reuses the EXISTING Responses wire
      against base `chatgpt.com/backend-api/codex` (→ `{base}/responses`) with
      a Codex-gated adaptation (`SamplerConfig.openai_codex` /
      `PlatformId::sends_codex_responses_headers()`): headers
      `chatgpt-account-id` (per-request from the JWT), `originator codex_cli_rs`,
      `OpenAI-Beta responses=experimental`, a codex `User-Agent`; `store:false`
      is the shared Responses default. BODY adaptation
      (`adapt_body_for_codex_backend`, same gate): the backend 400s
      `role:system` input ("System messages are not allowed") — system items
      are hoisted into the top-level `instructions` field — and stateless
      reasoning replay requires `include:["reasoning.encrypted_content"]`.
      API-key `openai` Responses requests carry NONE of this
      (byte-identical, pinned by a control wire test). `reasoning.effort`
      carries the thinking level. NO websocket, NO base_instructions.
      CATALOG is HARDCODED (`PlatformId::hardcoded_catalog` →
      `openai_codex_wire_models`, mapped through the SAME
      `platform_wire_model_to_entry` output): the 8 `visibility=list` &&
      `supported_in_api=true` models the backend served on 2026-09-29
      (`gpt-6.1-sol`, `gpt-6-astra/sol/luna`, `gpt-5.6-sol/terra/luna`,
      `gpt-5.5`, ctx 272000, per-model efforts) — NO live `/models` fetch, NO codex-CLI / `~/.codex`
      dependency; the hidden `gpt-reserve` and `codex-auto-review` are
      EXCLUDED. Refresh the table by reading
      `GET {base}/models?client_version=<a current codex release>` with a
      ChatGPT bearer: an old `client_version` is answered with a truncated
      list, so a stale version reads as "the model does not exist".
      `CODEX_USER_AGENT` (`codex_cli_rs/0.159.0`) moves with the release used
      for that read.
  - `OAuthFlow::GithubDeviceCopilot` → `auth::github_copilot` (TWO-STAGE).
    Provider: `github-copilot` (`scope_key oauth/github-copilot`, base
    `api.individual.githubcopilot.com`, ChatCompletions wire). Stage 1 is an
    RFC-8628 device flow on `github.com` (client `Iv1.b507a08c87ecfe98`, scope
    `read:user`) whose errors ride a `200` body (not `4xx`) — it mints the
    DURABLE github token. Stage 2 (`GET api.github.com/copilot_internal/v2/token`
    with `copilot_exchange` + editor headers) re-mints the SHORT-LIVED copilot
    token. Persisted as `KimiAuth.key = copilot token`, `refresh_token = github
    token`, `expires_at = copilot expiry`; the "refresh" is a copilot-token
    RE-MINT (GET, not a `refresh_token` grant). Every `/models` listing AND
    `/chat/completions` request carries the VS Code editor-identity headers
    (`User-Agent GitHubCopilotChat/…`, `Editor-Version`, `Editor-Plugin-Version`,
    `Copilot-Integration-Id`; `+X-GitHub-Api-Version` on `/models`, `+X-Initiator
    user` on inference) — gated on `SamplerConfig.github_copilot` /
    `PlatformId::sends_copilot_editor_headers()` so every other ChatCompletions
    provider stays byte-identical. WIRE-COMPAT SCOPE: Alnair is one-wire-per-
    platform, so the catalog is FILTERED (`parse_github_copilot_listing`) to the
    openai-completions-served models — keep iff `model_picker_enabled` &&
    `policy.state != "disabled"` && `tool_calls != false` AND the id is NOT a
    `claude-(haiku|sonnet|opus)-[45]` (anthropic-messages) or `gpt-5/oswe/mai-`
    (responses-only) model. Those excluded models need per-model wire routing
    (deferred, documented debt), NOT included lest they fail at inference.
    KNOWN LIMITATION: Alnair does NOT port Pi's per-model policy-acceptance step
    (`POST {base}/models/{id}/policy {state:"enabled"}`). A kept model whose
    Copilot policy is unconfigured can list yet `403` at inference until the user
    enables it once in GitHub's UI — a deliberate omission (it mutates account
    state and is unverifiable without a live Copilot account), not a silent gap.
  These are INTERACTIVE login rows advertised right after `kimi-code`
  (`AuthMethodKind::OAuthPlatform`, in `PlatformId::ALL` order: `xai-grok`,
  `claude-pro-max`, `github-copilot`, `openai-codex`). The catalog fetch resolves each such platform's OWN session
  token (`resolve_generic_oauth_tokens`, refreshed on expiry) and routes
  `platform.oauth().is_some()` → `platform.base_url()` (kimi-code alone →
  `proxy_url()`). Tokens/codes/verifiers are NEVER logged.
- CUSTOM PROVIDERS (0.1.19): `[platforms.<name>]` with `base_url` and `api =
  "openai" | "anthropic"` declares a provider outside the closed registry.
  `alnair-models/src/custom.rs` owns the validated type (name `[a-z0-9][a-z0-9_-]{0,31}`,
  never a registry id; base URL `http(s)://host[/path]`, no userinfo, query or
  fragment); `alnair-shell/src/agent/custom_providers/` owns the rest. Key order:
  auth.json scope `<name>`, then the table's `api_key`; a key is REQUIRED (a
  keyless declaration is inert). Wires: openai = `/chat/completions`, Bearer,
  `GET {base}/models`; anthropic = `/messages`, `x-api-key`,
  `GET {base}/models?limit=1000`. Catalog keys are `<name>/<model>`; the entry's
  `description` carries the provider name for the picker. Entries reach the disk
  cache without a key; `stamp_credentials` stamps `api_key` in memory, only onto
  entries still on the provider's own host, and `drop_orphans` removes fetched
  entries of a provider that is gone or keyless BEFORE the prefetched map replaces
  the catalog (a stale unkeyed entry would fall through to the house key).
  CREDENTIAL RULE: `EndpointsConfig.custom_provider_bases` (derived from
  `[platforms.*]` in `Config::new_from_toml_cfg` and `from_config_value`, never
  serialized) makes `CredentialAuthority::is_session_coding_endpoint` false for a
  declared base, loopback included — without it an Ollama-style provider on
  localhost classifies `Primary` and the Kimi bearer replaces its key. Every
  authority is built from the models manager's config, so the field reaches all of
  them. Turns and subagents read `auth_scheme` and BYOK status from the LIVE
  catalog entry (`auth_facts_of`), not from a disk reload: fetched entries never
  live on disk, and the reload sent fetched Messages models out with `Bearer`
  instead of `x-api-key` (this also repaired `anthropic` and `minimax`).
  Login: picker rows `custom-openai` / `custom-anthropic` are not loginable
  (`AuthMethodKind::Unknown`); the TUI asks base URL, name (default from the
  host), key, then opens a MODEL-SELECTION screen (`custom_entry.rs`
  `CustomSelectState`, welcome `AuthMode::CustomProviderSelect`): the listing
  fetch (`fetch_listing_for_login`) runs concurrently with the manual-id input
  — both visible at once, failure shows its reason — space toggles fetched
  rows, enter adds a typed id or finishes (a finish pressed mid-fetch waits for
  it: `finish_requested`), and the chosen ids persist as `[platforms.<name>]
  models = [...]` via `save_custom_provider`. The listing fetch probes
  `{base}/v1` once when `{base}/models` 404s or answers unparsable (a WAF
  challenge is HTTP 200 HTML) and the base has no `/vN` tail, adopting the
  probed base for the saved definition; anthropic-wire listings that 401 on
  `x-api-key` retry once with `Bearer` (relays gate `GET /models` on Bearer
  while `/messages` takes `x-api-key`); listing errors never quote response
  content (line/column only — a reflected body could carry the key). Catalog
  assembly honors the allowlist in `selection.rs`: `synthesize_selected` (BEFORE
  `[model.*]` overrides, so an override composes with a synthesized entry)
  builds wire-default entries for selected ids the listing never served, and
  `filter_unselected` (AFTER overrides) is authoritative in the provider's
  namespace — even a `[model."name/x"]` entry for an unselected id is dropped.
  Provider-owned entries never take donor `api_backend` inheritance in
  `resolve_model_list` (the declared wire wins); no `models` key = the whole
  listing (the declarative path). `authenticate("custom:<name>")` then
  validates `GET {base}/models` (401/403 = rejected key, other non-2xx and network
  errors surface). Limits: context window 256K unless the listing serves
  `context_length` (Anthropic: `max_input_tokens`); no models.dev enrichment; a
  failed key check leaves the saved definition (login again with the same name to
  overwrite); no delete UI, edit config.toml and auth.json.
- A stored subscription-OAuth session IS a catalog fetch source. Every
  fetch-PLAN decision that cannot afford real token resolution — the startup
  prefetch arming gate, `on_auth_changed`'s wipe guard
  (`should_wipe_catalog_on_auth_change`), and cache-origin computation — uses
  the sync presence probes `models_fetch::stored_oauth_platforms` /
  `stored_oauth_token_stubs` (auth.json scope scan; names only, no bearers).
  All three must see the SAME enabled-platform set the real fetch enables, or
  a claude-pro-max-only user boots onto the bundled Kimi table with an empty
  picker. Managed catalog entries stamp `meta.provider` (platform display
  name) for the client's `/model` picker; the picker itself lists the fetched
  catalog, which is by construction the credentialed providers' models.
- INFERENCE-AUTH CHOKEPOINT (security): `auth::credential_authority::CredentialAuthority`
  is the ONE authority answering "WHICH credential — if any — may ride this
  request?". It holds the session's effective `EndpointsConfig` and
  its primary `AuthManager` PRIVATELY and answers only
  `(platform, base_url)` questions: `credential_class` → `CredentialClass::{Pooled,
  Primary, None}` (the outer term of `auth_method::session_token_auth_gate`),
  `manager_for` (the governing manager
  for refresh / 401 recovery), `credential_for` (the request's `api_key`) and
  `bearer_resolver_for` (the aux/summary/session resolver). Do NOT re-derive this
  rule anywhere else — three rounds of leaks came from exactly that.
  The rule: a subscription-OAuth platform rides ITS OWN pooled `AuthManager` (so
  it keeps a live `bearer_resolver` and mid-session refresh despite a
  non-first-party base URL) and ONLY at its own `platform.base_url()` — a
  `[model."claude-pro-max/x"]` override keeps `info.id` but can point `base_url`
  anywhere. `kimi-code` and a platform-less model (a bare slug / `[model.*]`
  entry) ride the PRIMARY session, and ONLY at the session's own effective coding
  endpoint: `EndpointsConfig::proxy_url()` (which prefers `[endpoints]
  coding_api_base_url` from **config.toml** — what the managed-config sync writes
  — over `ALNAIR_CODE_BASE_URL`), `models_base_url`, loopback, or the compiled
  production endpoint. Never a blanket allow: BYOK is `has_own_credentials()`,
  which probes `std::env::var` at call time, so a `[model.*]` block with an unset
  `env_key` classifies `NotByok`. Every API-key registry platform rides NOTHING.
  STRUCTURAL ENFORCEMENT: the authority is the only producer of
  `SessionCredential`, an opaque type with no production constructor, and every
  API that stamps a session bearer onto a request (`resolve_credentials`,
  `resolve_aux_model_sampling_config`, `try_resolve_model_credentials`,
  `resolve_chat_state_auth_type`) takes
  `Option<&SessionCredential>` rather than `Option<&str>` — a new call site
  cannot express the leak. `stamp_session_local_sampler_fields` likewise takes the
  aux `bearer_resolver` explicitly instead of copying the session's and relying on
  the caller to re-point it, and `sampler_turn::aux_bearer_resolver_for` is the
  ONE definition of the aux/summary resolver rule (the session actor and
  `MvpAgent::build_summary_client` both call it; a private second copy is how the
  summary client stayed ungated after M3). NEVER HAND-CARRY A CREDENTIAL TO A
  GUARD (C1): "may **a** session credential ride here" is `true` for
  a subscription-OAuth platform at its own host — where the credential that may
  ride is that platform's POOLED token, never the primary. Ask
  `credential_for(platform, base_url)` and stamp what it returns, so the question
  and the credential are the same object; where you cannot (a credential the
  authority does not own), MATCH on `credential_class` rather than reach for a
  boolean. There is deliberately no second, similarly-named predicate to pick
  wrongly. The shared `sampling_config.api_key`
  (the subagent baseline and the unresolved-model fallback) has exactly TWO
  production writers, both guarded by the authority:
  `MvpAgent::stamp_session_credential` (the `cached_token` / `kimi.com/oidc`
  login handlers and the `new_session` / `load_session` seed), which asks
  `credential_for`; and the `xai.api_key` handler in `acp_agent.rs`, which stamps
  the house `ALNAIR_API_KEY` read from the environment — a credential the authority
  does not own — only when `credential_class` is `Primary`, the class the house
  key rides and the one every OAuth platform's own host is NOT.
- MODEL→PLATFORM LOOKUP (security): `SamplingConfig::model` is the BARE routing
  slug, and duplicate slugs across platforms are BY DESIGN — an API-key platform
  and its subscription-OAuth twin list identical ids (`xai`/`xai-grok`,
  `anthropic`/`claude-pro-max`, `openai`/`openai-codex`), with the API-key
  platform FIRST in `PlatformId::ALL`. The auth layer therefore resolves the
  platform from the catalog KEY the picker selected, held PER SESSION in
  `SessionActor::selected_catalog_key` (seeded at spawn by
  `agent::models::selected_catalog_key_for_spawn`, rewritten by `SetSessionModel`,
  CLEARED by `OverrideModelName` when the rename makes it stale), via
  `agent::models::entry_for_slug`/`platform_for_slug`.
  NEVER `ModelsManager::current_model_id()`: that cell is process-global,
  last-writer-wins across concurrent sessions, and Leader mode never writes it at
  all (`agent/handlers/model_switch.rs`). The shared `MvpAgent::sampling_config`
  is BUILT from that cell — but ONCE, at startup, and never rebuilt, while the
  cell moves on every non-Leader switch. Its guards therefore read
  `MvpAgent::sampling_config_platform`, the platform captured WITH the config by
  the same `ModelsManager::sampling_config()` call, never a fresh lookup against
  the live cell: once the two drift, re-resolving the config's bare slug falls
  through to `resolve_catalog_key`'s `.rev()` scan, answers the API-key twin, and
  a post-expiry `alnair login` silently leaves the EXPIRED bearer in the config
  that seeds every subagent (H-a). REFUSE RATHER THAN GUESS (H-b):
  when the per-session key does not name the slug, `platform_for_slug` returns
  `None` for a slug that collides across platforms rather than trusting
  `resolve_catalog_key`'s `.rev()` last match — which is the subscription-OAuth
  twin, so the guess hands an API-key session the pooled bearer that REPLACES its
  own key on the wire. `None` then routes purely by the ENDPOINT, which for an
  OAuth host means no credential, no resolver and no adaptation.
  Anything else (aux models, subagent
  overrides) falls back to the picker's own `resolve_catalog_key`, and
  `config::find_model_by_id`'s slug scan takes the LAST match so the two can
  never disagree. Resolving the wrong twin costs the OAuth platform its live
  `bearer_resolver` (unrecoverable 401 ~1h in), its Messages adaptation and its
  Copilot/Codex identity headers — and hands the API-key twin's session a pooled
  OAuth bearer stamped over the user's own key.
- CATALOG VISIBILITY: `platform_wire_model_to_entry` stamps
  `supported_in_api = platform != KimiCode`. `ModelInfo::visible_for_auth`
  reads only the PRIMARY manager's auth mode, so gating the other OAuth
  platforms on it would hide every model from a user who signed in with ONLY a
  Claude Pro/Max, ChatGPT, Copilot, or Grok subscription. Only `kimi-code`
  rides the primary session, so only it may be gated on it.
- Model metadata (context window, thinking levels) comes from the provider
  wire when served; metadata-poor listings are enriched from models.dev
  (`alnair-models/src/enrichment.rs` — bundled raw snapshot regenerated by
  `scripts/gen_enrichment_snapshot.py`, single Rust transform
  `parse_api_json` for bundled + runtime refresh; 24h cache
  `~/.alnair/models_dev_cache.json`). Wire values always win; enrichment
  never invents model availability. Canonical reasoning efforts:
  none/minimal/low/medium/high/xhigh/max (`max` split from `xhigh` 2026-07;
  the Codex backend advertises an `ultra` tier above `max` that alnair has no
  level for; Kimi wire spells its top tier `max`, kimi_compat renames).
  config.toml accepts any letter case: `ReasoningEffort` deserializes
  through `FromStr`.

## Milestones (PRD §8.3)

- M0 (done): rename, deletions (voice/telemetry/announcements/marketplace/
  relay-gateway), toolchain, gates.
- M1: Kimi device-flow auth (F1), Moonshot API-key channel (F2), inference
  via ChatCompletions (F3), dynamic model sync (F4). The auth stack in
  `alnair-shell/src/auth` + `alnair-auth` gets rewritten here; transitional
  grok.com references live only there and in `alnair-sampler`/proxy types.
- M2: server-side search/fetch (F5), command parity with kimi-cli 1.49.0
  (F6), one-time `~/.kimi/config.toml` import (F7), F9 smoke list, perf CI.
- M3: GitHub Releases distribution, install scripts, self-update (F8).
