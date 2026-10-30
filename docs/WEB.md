# The web UI

`alnair web` serves a browser client for the **shared leader**, so the TUI and
the browser render the same session state: an agent turn streaming in the
terminal streams in the browser too, and a permission card parked in one can be
answered from the other.

```sh
npm --prefix web run build     # once, or after changing web/
alnair web                     # http://127.0.0.1:2420/
alnair web --bind 127.0.0.1:0 --open
```

| Flag | Default | Meaning |
|---|---|---|
| `--bind` | `127.0.0.1:2420` | Listen address. `:0` picks a free port and prints it. |
| `--pid` | none | Target a specific leader (same idea as `alnair leader info --pid`). |
| `--socket` | none | Target an explicit leader socket path. |
| `--open` | off | Open the default browser once listening. |

## Architecture

```
        ┌──────────────── Leader (auto-spawned, --no-exit-on-disconnect)
        │   session_subscribers · session_driver · interaction_requests
        └───────▲──────────────────────────▲
                │ IPC (UDS / named pipe)   │ IPC
                │                          │
             TUI (ClientId 1)        alnair web (ClientId 2..N)
                                          ▲
                                          │ HTTP: static UI
                                          │ WS:   one JSON-RPC per text frame
                                       Browser
```

Each WebSocket gets **its own `LeaderClient`**, so the leader does all the
synchronisation work:

- a live turn's deltas are broadcast to every subscriber (`session_subscribers`),
  which is why the browser sees the same stream as the TUI;
- exactly one client per session is the *driver* — reverse requests that must
  not be duplicated (`fs/read`, scheduled-task injections) go there only;
- `session/load` replay is buffered against live frames and deduped by
  `eventId`, so attaching mid-turn yields each chunk once;
- parked permission/question/plan requests are cached and replayed to a client
  that attaches later, and the first answer wins across surfaces.

The bridge in `crates/codegen/alnair-web` is therefore a byte pump. It parses
nothing except `alnair/leader_reconnected`.

### Why not `alnair agent serve`

`agent::server` creates its own `MvpAgent` (separate state) and keeps a single
`relay_dest` that each new connection overwrites, so only the newest client
receives live deltas. It is a standalone agent, not a view of the leader.

## Serving

The SvelteKit build is embedded in the binary with `rust-embed`, so Alnair
stays a single file. Debug builds read `web/build/` from disk, which means
`npm run build` is picked up without a Rust rebuild.

| Path | Behaviour |
|---|---|
| `GET /ws` | WebSocket upgrade (cookie + `Origin` required) |
| `GET /api/session` | Sets the auth cookie; returns version, leader target, `webBuilt` |
| `POST /api/pick-directory` | Native folder dialog (cookie + `Origin` required) |
| `GET /healthz` | `ok`, no auth — for scripts |
| `GET /*` | Embedded asset; miss **with** an extension → 404; miss **without** → `index.html` |

`index.html` is `no-cache`; everything under `_app/immutable/` is
`max-age=31536000, immutable`.

### Auth

`GET /` and `/api/session` set `alnair_web=<random>` with
`HttpOnly; SameSite=Strict`. `/ws` requires **both** that cookie and an `Origin`
matching the bound address.

The `Origin` check is not redundant: a WebSocket upgrade is not subject to CORS
preflight, so without it any page open in the same browser could connect to
`127.0.0.1` and drive the agent (DNS rebinding included). `SameSite=Strict`
covers the cookie half of the same attack.

Restarting `alnair web` rotates the token, so a stale tab gets 403 until it is
reloaded. That fails closed on purpose.

## Development

**Embedded** (no Vite): `npm --prefix web run build`, then `cargo run -- web`.
Debug builds read from disk, so re-running the build is enough.

**HMR**: run `npm --prefix web run dev` (`:5173`) and let it proxy to the
server. `web/vite.config.ts` already forwards `/api` and `/ws` to
`ALNAIR_WEB_BACKEND` (default `http://127.0.0.1:2420`), so the dev page reaches
the same leader the embedded build does — without the proxy, `/api/*` answers
404 from Vite and `/ws` never upgrades, which makes "add a workspace" and every
other server-side action fail only in development.

The dev origin is accepted by the `Origin` check **only** in debug builds.

### Fixtures

`?fixtures=1` swaps the socket transport for the scripted transcripts in
`web/src/lib/harness/fixtures.ts`. Those cover states the live agent rarely
produces on demand (a parked questionnaire, an exhausted retry).

## Client-side rules worth knowing

- **Extension methods go out `_`-prefixed with FLAT params.** `alnair/*` calls
  must be sent as `_alnair/<name>` with the handler's own fields directly in
  `params` — NOT nested as `{ method, params }`. The ACP decoder strips the `_`
  prefix and hands the whole `params` object to the handler, so nesting leaves
  it with no fields at all. Verified against a live leader: `_alnair/fs/list`
  with a flat `{ path }` returns the listing; the nested form is rejected with
  `invalid params: missing field 'path'`. A plain `alnair/<name>` request is
  answered **"Method not found"**. ACP methods (`initialize`, `session/load`,
  `session/prompt`) are sent normally.

  This hid for a while because a method that ignores unknown fields — the
  roster — answers either way, and `session/info` with an unusable id silently
  falls back to the *first resident* session. A probe that picks the second
  session catches it; one that picks the first does not.
- **Extension responses come back in two shapes.** Handlers built with
  `to_ext_response` answer `ExtMethodResult { result, error }`; the ones written
  with `to_raw_response` (`session/updates`, `commands/list`) write the payload
  straight into the response. `unwrapExt` discriminates on the presence of a
  `result` key. Reading only the envelope turns every stored transcript into
  `undefined`.
- **The extension rail is not nested either.** `_alnair/session/update` carries
  `{ sessionId, update, _meta }` at the top of `params`, exactly like
  `session/update`; the `_` is only the gateway's extension marker. The store
  routes to the extension decoder by the method NAME, so the transport must pass
  it through verbatim. `alnair/session_notification` is the live one-shot rail
  (a model switch from another client) and is routed the same way.
- **The model switch is `session/set_model`.** The camelCase `session/setModel`
  is answered "Method not found". The effort rides in `_meta.reasoningEffort`.
- **`session/load` needs the session's own cwd.** The agent resolves the session
  directory from `(id, cwd)` and rejects a relative or empty path outright
  ("Path is not absolute"), so the roster's `cwd` must travel with the load.
- **Field spelling differs by surface.** The roster (`alnair/sessions/list`)
  and `alnair/session/info` come back **camelCase** (`sessionId`,
  `lastChangeUnixMs`, `usagePct`, `usageCategories`), while Alnair's extension
  *updates* on the stream are snake_case. `wire.ts` accepts both spellings
  rather than betting on one.
- **`reasoningEfforts` is a list of objects**, not strings:
  `[{ id, value, label, description, default }]`. The accepted set comes from
  `reasoningEfforts`; `reasoningEffort` is the current selection and must not be
  read as the set.
- **`activity: "dormant"`** is a session read from disk with no resident actor.
  Only `working` means a turn is running.
- **Permission mode: only `yolo` is on the wire.** `RosterEntry.yolo` is the one
  permission bit reported for an existing session; `auto` lives inside the
  session actor and has no read method, and the load response's
  `_meta.yoloMode`/`autoMode` are injected into `session/new` only (so they
  describe a session this client just created). A session the TUI put in `auto`
  therefore reads as `ask` here — the most restrictive of the three, which is
  the safe direction to be wrong in. A missing `yolo` key means UNKNOWN, not
  `false`: a thin `sessions/changed` delta must not clear an always-approve
  session.
- **User turns come from `user_message_chunk` on replay, and from the optimistic
  turn on a live send.** Both exist, so `Acc.optimisticUserTurn` marks which is
  in force: while set, the agent's echo of the prompt is swallowed; otherwise
  the chunks build the bubble. Chunks join one turn until any other update
  arrives, and a new prompt closes the previous assistant turn — otherwise a
  replayed answer lands in the turn BEFORE the question and the conversation
  reads backwards.
- **Reconnect dedup.** The leader dedups only *within* one `session/load`. Across
  loads the client must drop frames at or below its `eventId` watermark, or a
  reconnect doubles the transcript. `web/src/lib/harness/dedup.ts` implements the
  rule and `session-store.svelte.ts` applies it; unsequenced notifications always
  apply.
- **Replay resets.** `session/load` starts a replay window that clears the
  accumulator, because the replay is authoritative.
- **Attaching is subscribing.** `selectSession` must send `session/load`; a
  client that only changes its local index never receives that session's stream.
- **No client-side terminal or FS.** The browser advertises
  `terminal: false, fs: {readTextFile: false, writeTextFile: false}` so the agent
  uses its own. Claiming them routes tool calls to a client that cannot serve
  them, and the call hangs.
- **The composer's `@` menu is two RPCs.** `alnair/fs/list` answers one
  directory (the drill-down), and `alnair/fs/search` ranks the whole tree (the
  typed query). The pager runs the same fuzzy matcher in-process; a browser
  cannot, so the agent keeps one walker per root and re-queries its snapshot.
  Listing paths are absolute and are re-rooted at the workspace before they
  become mention tokens, because the agent's tools resolve relative paths.
- **No fixture state on a live page.** A transport that implements `connect`
  drives a real agent, so `HarnessStore` starts in `phase: 'connecting'` with
  every scripted value cleared and the page paints a skeleton. Seeding the
  fixtures "until data arrives" shows a conversation the user never had.
- **`_meta["alnair/tool"]` is the only reliable tool identity.** Every one of
  Alnair's own tools reaches the wire with ACP `kind: "other"`, and the title is
  model-authored. The canonical envelope — `{ name, kind, label, read_only,
  input }` — is what distinguishes a subagent spawn (`kind: "task"`) from a
  questionnaire (`kind: "ask_user"`) from an ordinary call. Reading only `kind`
  renders both as "other Tool: …", which is exactly what happened before
  `toolMetaOf` existed. The envelope is merged across updates by the agent, so a
  later update that omits `_meta` keeps the earlier identity.
- **A subagent spawn has no tool row.** `subagent_spawned` / `_progress` /
  `_finished` build the card; the tool call that triggered it would duplicate it
  with a worse row. The reducer projects zero parts for `kind: "task"` and
  REMOVES any row a preceding identity-less announcement created — the
  announcement arrives before the identity is stamped, so a naive append leaves
  a stale "other Tool: spawn_subagent" beside the card.
- **A questionnaire is a card, not a tool row.** `kind: "ask_user"` projects a
  `question` part keyed `ask-<toolCallId>`, the same id `questionFromRequest`
  uses, so the live reverse request refines the replay-built card instead of
  adding a second one. Both `interaction_resolved` and the call's own completion
  mark it resolved.
- **The `/` menu is filtered, and the filter is a DENYLIST.** The agent
  advertises one catalog for every client (`available_commands` in
  `alnair-shell/src/session/slash_commands.rs`), and those entries work here:
  each answers through `send_slash_command_output`, so its text lands in the
  transcript. The pager's own commands never reach ACP — `/model`, `/clear`,
  `/rewind`, `/theme`, `/vim-mode`, `/terminal-setup` and the rest of
  `alnair-tui/src/slash/commands/` — and typing one here sends text the shell
  parses as unknown, so the model answers it as prose. `commands.ts` denies
  them by name (and by alias, because the dropdown inserts `/<name>`) and
  allows everything else: an allowlist would hide every future builtin and
  every installed skill until someone remembered to add it.
- **A turn's duration is measured from its PROMPT.** The assistant turn is
  created by its first part, which lands after the model has been thinking, so
  timing from `at` lost the wait and a tool-only turn reported `0s`. The
  reducer carries `Acc.promptStartedAt` (set by `openUserTurn` and by a replayed
  `user_message_chunk`) and stamps it as the turn's `startedAt`; `closeTurn`
  measures from there. A turn the next prompt supersedes is settled with the
  same anchor, so a transcript that lost its trailing `turn_completed` still
  shows a duration instead of nothing.
- **A finished turn folds its work away, and the answer stays.** `splitFinalWork`
  takes the LAST non-empty text part as the answer and everything before it as
  work; the collapsed header is `Worked for 1m 04s · 12 calls · 3 files edited`
  and expanding it restores the original trace. A turn with no text answer
  (cancelled, or ended on a tool call) keeps everything expanded — folding it
  would leave an empty screen and a button. The split lives in `segments.ts`
  because it is the same question as "where does the trace end", which the
  grouping already answers.
- **A resolved permission card is one quiet line.** It is history: the decision
  was made, the tool ran, and the result is the row underneath. Only the LIVE
  request keeps the bordered block and the sentence explaining what to do.
- **The composer takes attachments, and they are prompt BLOCKS.** A pasted
  image becomes an ACP `ImageContent`; a long paste (≥1,200 chars or ≥24 lines)
  becomes a `Resource` with the text inline, which the agent renders as
  `<file_contents>` — the same path the TUI's paste takes. `promptBlocks` puts
  the text block FIRST and the attachments after it, so `[Image #1]` in the
  sentence points at a picture that has already arrived. A pasted path stays
  text: the agent resolves it itself.
- **The inspector is four panes over real state.** Files come from the
  transcript, the editor reads through `alnair/fs/read_file`, source control
  through `alnair/git/status`, and commands are the session's own tool output.
  Monaco is imported dynamically (`#lib/editor.ts`) so a session that never
  opens the panel downloads none of it, and its worker is wired through
  `MonacoEnvironment.getWorker` — without that the first parse throws rather
  than degrading.
- **The terminal pane is read-only, on purpose.** `pty/notification` carries a
  `terminalId` and no session id, so the leader routes its output to
  `last_active_client`; with the TUI attached that is the terminal, not this
  page. A shell here would show another surface's output some of the time and
  none the rest.
- **"Add a workspace" cannot dead-end.** The native dialog is the good path, but
  it is legitimately unavailable sometimes: a headless server has no desktop,
  `picker::OPEN` allows one dialog at a time, and a release build refuses the
  dev origin. A refusal opens a typed-path dialog instead of doing nothing —
  which is what the button used to do. Right-clicking `+` skips the dialog
  entirely, for a reader who already knows the path.
- **A recap is requested, then streamed.** `alnair/recap` answers once the
  command is QUEUED; the text arrives later as a `session_recap` update and the
  reducer folds it into the transcript as a notice. `recapText` reads that notice
  rather than keeping a second copy, so a reload cannot disagree with the thread.
- **A session opens; it does not replay.** A transcript arrives as hundreds of
  `session/update` notifications, and folding each one on arrival made opening
  a conversation look like watching it be rebuilt turn by turn. Frames that
  arrive during the replay window are COLLECTED (`replayBuffers`) and folded in
  one pass when the load ends — one accumulator write instead of one render per
  chunk. `admit` still runs per frame, so the watermark that stops a reconnect
  from doubling the transcript is unchanged. `openSession` flushes too, for a
  transport that resolves without a `session/load:result` marker.
- **The roster delta is `_`-prefixed on the wire.** The leader forwards agent
  notifications as `_alnair/sessions/changed` (see
  `is_machine_wide_broadcast_notification`, which normalizes for the same
  reason). Matching only the bare name dropped every delta at the "no
  sessionId" check, which is why a new session appeared only after a reload.
- **`<system-reminder>` is system chrome, not a prompt.** The shell stores
  injected context as a synthetic USER message
  (`ConversationItem::system_reminder` → `push_user_message`), so it arrives on
  the `user_message_chunk` rail and a naive client draws a background-task
  notification as a bubble the reader typed. `system-notes.ts` recognises a
  message that is WHOLLY one `<tag>…</tag>` wrapper (anchored both ends, so a
  prompt that merely quotes the tag stays a prompt) and the reducer turns it
  into a `system` part with the wrapper's name. It is checked BEFORE the
  optimistic-echo guard: that guard swallows every user chunk until the turn
  closes, which would eat a mid-turn reminder into `streamedUserText` and lose
  it entirely.
- **A thought ends when the next thing starts.** The wire has no
  `thought_completed`; a reasoning part that only listened for one stayed
  `running` for the rest of the turn and left a spinner and "Thinking" over a
  finished thought. `pushPart` settles every running reasoning part whenever a
  non-reasoning part arrives (text, tool call, notice, subagent), and
  `closeTurn` settles the rest. The row also falls back on its own: a thought
  inside a closed turn reads `Thought` whatever its own status says.
- **Copy goes through `#lib/clipboard.ts`.** `navigator.clipboard` is
  `undefined` outside a secure context, so the old bare call threw a
  `TypeError` inside the click handler — before any `.catch` could run — and
  the button did nothing at all. `copyText` tries the async API, falls back to
  a hidden textarea plus `execCommand('copy')`, and reports whether it landed so
  the icon can say "failed" instead of pretending. Downloads are the same
  module: a blob URL behind an `<a download>`, with `safeFilename` keeping the
  name openable on every OS.
- **The bottom panel is a drawer, not a rail.** The workspace editor and the
  interactive terminal live in `inspector/bottom-drawer.svelte`, opened with
  ``Ctrl+` `` (``Ctrl+Shift+` `` goes straight to the editor), resizable by
  dragging its top edge, and fullscreen-able. Both need the thread's full
  width; neither fits a 288px column. The editor is a real multi-tab workspace
  editor (tree, dirty dots, Ctrl/Cmd+S through `alnair/fs/write_file`), and the
  terminal is a real PTY through `alnair/terminal/pty/*` rendered by xterm —
  not a mirror of the agent's tool output.
- **The right rail is lists only.** Files the thread touched, and the working
  tree. Clicking a file opens it in the drawer's editor.
- **A table's toolbar is ours, not the library's.** Streamdown's
  `TableDownload.svelte` revokes the blob URL in the same task as the click
  (cancelling the download in some browsers) and copies through
  `navigator.clipboard` directly (which throws outside a secure context, so
  `--bind 0.0.0.0` got a dead button). `thread/markdown-table.svelte` replaces
  the `table` snippet and goes through `#lib/clipboard.ts`, keeping the same
  four formats.
- **Preferences live in `localStorage`, validated by the registry.**
  `harness/preferences.ts` owns three keys under `alnair.web.` — settings,
  layout (rail, drawer, tab, height), hidden workspaces. Every read is fallible
  (a partitioned context throws on access) and every stored value is coerced
  against its `SettingMeta.kind`, so an older build's data degrades to the
  default instead of reaching a component as an unexpected type. `loadLayout`
  returns `undefined` rather than a default object, because the rail's
  first-paint value comes from the viewport: "no preference" and "preferred
  closed" must be distinguishable.
- **Every setting in the dialog does something.** They were all inert before —
  twelve controls that wrote to an object nothing read. `view-prefs.ts` is the
  one place the registry's vocabulary (`show_thinking`) meets the thread's
  (`thinking`), and a missing key resolves to the registry's own default rather
  than to `false`, which is what keeps a store that has not restored yet from
  hiding reasoning or unfolding every diff.
- **Both drawer panes stay mounted.** Switching tabs used to swap the rendered
  snippet, which unmounted the other pane: the terminal's teardown closed its
  PTY (killing the shell) and the editor lost every tab and unsaved buffer. The
  drawer hides one and shows the other, and the terminal spawns lazily on first
  show — opening the panel on the editor tab must not start a shell.
- **A narrow window can still reach its sessions.** The rail is `hidden md:flex`,
  so below 768px there was no way to switch session at all. `Dialog.Sheet` is a
  left-anchored slide-over hosting the same `SessionSidebar` (one component, not
  a second copy), opened from a header button that only renders below `md`.
- **The socket reports its health.** `connection` is `live`, `reconnecting` or
  `offline`; `connection-banner.svelte` renders the last two. A page that
  retries silently for ten seconds is indistinguishable from a frozen one, and
  the banner is what turns "wait" and "something is wrong" into different
  sentences.
- **The context meter streams; its breakdown does not.** Every persisted frame
  carries `_meta.totalTokens` — the same figure the TUI's context bar reads — so
  the ring and the percentage move live (`applyContextUsed`). The itemized rows
  (system prompt, tool definitions, turn and tool-call counters) exist only in
  `alnair/session/info`, so the panel re-reads it on open. `Overhead` absorbs
  the difference in between, which is honest: the agent does not itemize it.
- **`openSession` sets the active id before it attaches.** `receive` drops
  frames for any session that is not active, so a caller that attached without
  switching (a fresh `createSession`, the survivor after a delete) would open a
  replay window and throw the whole replay away — an empty transcript for a
  session that has history.
- **The checkout row is three reads.** `alnair/git/info` names the root and
  branch, `alnair/git/branches` fills the picker, `alnair/git/worktree/list`
  fills the checkout menu. All three resolve from the session's own cwd, so a
  session already inside a worktree sees that worktree's repo. Outside a repo
  every one of them errors and the row disappears rather than claiming a branch.
- **A remote-tracking ref cannot be checked out directly.** `checkoutBranch`
  strips the remote prefix and creates a local branch (`create: true`), which is
  what the TUI's own branch picker does.
- **Session CRUD is optimistic and rolls back.** Rename and delete apply to the
  store first (the sidebar is what the user is looking at) and restore the
  previous state when the agent refuses — a session still on disk must stay in
  the list. Delete also moves the view off the row before the request goes out,
  because `alnair/session/delete` shuts down any live actor for the id.
- **The turn-status row is derived, not pushed.** The browser has no tracker;
  `activity.ts` reads the last meaningful part of the open turn. An open turn
  with no parts yet is `Thinking` — exactly the case that used to render as an
  empty pane for the first seconds of a turn. `busy` is
  `localBusy || openTurnId !== undefined`, so a turn the TUI is driving shows
  its status here too.
- **Terminal output is normalized at the render boundary, and its colour is
  real.** `terminal-output.ts` collapses `\r` rewrites and, by default, strips
  escapes. `\r` alone moves the cursor; only an erase sequence clears a line,
  which is why a `\r`-terminated line keeps its text. The terminal panel asks
  for `terminalLines(output, true)` and renders the escapes through Shiki's
  `ansi` grammar, so `ls` marks directories, `git` colours a diff and a compiler
  reddens an error, exactly as they did in the shell.

  Two rules make that work. `outputText` prefers `rawOutput.output` (the byte
  array) over `output_for_prompt`, because the latter is ANSI-stripped AND
  carries an `exit: N` header the panel renders in its own footer - taking it
  lost every colour and printed the status twice. And ANSI is a **whole-block**
  language: its escapes are stateful, so a colour opened on one line applies to
  the next. Tokenizing per line reset that state at every newline and painted a
  multi-line green header block as one green line and the rest default-coloured.
  `useHighlightedCode(..., streaming = false)` is how a caller says its text is
  replaced rather than appended.
- **Highlighting is Shiki, not a second tokenizer.** `highlighter.ts` already
  owns theme selection (`github-light`/`github-dark` through `--shiki-*`
  variables), lazy grammar loading and the streaming grammar state; markdown
  code blocks, file reads and diffs all go through it. Adding `svelte-highlight`
  would mean a second highlighter, a second theme map and a second set of token
  shapes for the same rendering. When a language is missing, add it to the
  `languages` map there.

## Verifying it against a live leader

Nine scripts, each answering a different question:

| Script | Question |
|---|---|
| `node scripts/web-verify.mjs http://127.0.0.1:2420` | Does every wire call the UI makes actually work? 14 assertions over the roster, load, models, context, commands, subagents and both file RPCs. |
| `node scripts/web-browser-test.mjs http://127.0.0.1:2420` | Does the page render and work? Drives headless Chrome/Edge over CDP: skeleton → UI, session CRUD menu, the checkout row, sessions, model menu, context meter, slash menu, `@` listing and search, tool-call rendering, a real prompt round-trip, the turn-status row and reply ordering. Writes `target/web-ui.png`. |
| `node scripts/web-tool-render-check.mjs http://127.0.0.1:2420 <sessionId>` | How was each tool call actually drawn? Dumps every trace row, the terminal panels' text, and counts of question and subagent cards. This is the check that catches a tool falling through to the generic "other Tool: …" row. Writes `target/web-tools.png`. |
| `node scripts/web-terminal-color-probe.mjs http://127.0.0.1:2420 <sessionId>` | Does a command's output keep its colour? Expands every trace row and reports, per panel, how many spans carry a Shiki colour and which computed colours appear. A capture with ANSI must show more than one. Writes `target/web-terminal-color.png`. |
| `node scripts/web-session-probe.mjs http://127.0.0.1:2420 <sessionId>` | What did `session/load` replay? Prints the load keys and frame counts, and writes `target/replay-frames.json`, which `web/src/lib/harness/replay-dump.test.ts` folds through the reducer. An empty transcript has two causes — the wire sent nothing, or the reducer dropped it — and only the dump tells them apart. |
| `node scripts/web-probe.mjs http://127.0.0.1:2420` | What does the wire actually say? Dumps raw shapes, including the flat-vs-nested ext envelope side by side. |
| `node scripts/web-admin-probe.mjs http://127.0.0.1:2420` | Do rename and delete actually reach disk? Creates a throwaway session, renames it, deletes it, and checks the directory and the roster. |
| `node scripts/web-delete-probe.mjs http://127.0.0.1:2420` | Does the sidebar's delete click work end to end? Drives the real menu, records the frames the page SENT, and reloads to prove the row does not come back. |
| `node scripts/web-delete-menu-probe.mjs http://127.0.0.1:2420` | Does the action menu stay open across a confirmation click? This is what caught the two-click delete arm that could never be completed. |

No Playwright or Puppeteer: the browser tests drive an installed Chrome/Edge
through Node's built-in `WebSocket`, so they add no dependency.

## Not provided, by design

| Item | Why |
|---|---|
| "The TUI is viewing session X" | Not on the wire. `alnair/sessions/changed` carries `activity`, not presence; `alnair/session/view` is a read watermark for unread badges. |
| Settings sync | `alnair/settings/update` is deliberately not broadcast (it carries auth/gate state) and is a notification, not a request/response RPC. The web dialog keeps its own registry. |
| A live terminal pane | `pty/notification` carries `terminalId`, not `sessionId`, so routing falls back to `last_active_client`; one PTY is owned by one client. Terminal tool output renders as text. |

If the TUI drives a turn and the browser sends a prompt to the same session, the
session actor serialises them FIFO (`pending_inputs`): the browser's prompt is
queued behind the running turn rather than rejected.

## Release builds

The web build must happen **before** the cargo build, or the binary embeds the
placeholder page:

```sh
npm --prefix web ci
npm --prefix web run build
```

`web/build/` is gitignored. `alnair-web/build.rs` writes a placeholder shell when
the folder is missing so `cargo check --workspace --all-targets` works on a
machine with no Node; the server reports it at startup and on `/api/session`.
