# Alnair web harness

A browser view of the Alnair agent runtime: SvelteKit, Tailwind v4, and
shadcn-svelte components composed into the [AI Elements](https://www.shadcn-svelte.com/docs/ai-elements)
patterns. It is meant as an alternative to the TUI for people who prefer a
browser, not as a second window beside it.

The default transport connects to the shared agent leader through `alnair web`.
Use `?fixtures=1` for scripted transcripts that exercise the same reducer.
See [the web server guide](../docs/WEB.md) for serving, authentication and the
leader bridge, and [the feature audit](../docs/WEB-COVERAGE-AUDIT.md) for remaining
feature gaps.

```sh
npm install
npm run build
# Start `alnair web` in another terminal, then run the HMR client:
npm run dev
# Obtain a fresh link for the HMR origin (debug binaries only):
alnair web pair --url http://localhost:5173
```

| Script                  | What it does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `npm run dev`           | Vite dev server with HMR                                          |
| `npm run build`         | Production build                                                  |
| `npm run preview`       | Serve the production build                                        |
| `npm run check`         | `svelte-check` — types and Svelte diagnostics, zero errors        |
| `npm run lint`          | Prettier check plus ESLint                                        |
| `npm run format`        | Prettier write                                                    |
| `npm test`              | Vitest — the reducer, segmenting, and formatting                  |
| `npm run test:graph-ui` | Headless Chromium smoke test for graph controls and node progress |

## The wire

Alnair speaks the Agent Client Protocol over JSON-RPC. The web client is an ACP
**client**, so the transport is a socket carrying `session/update` notifications
and answering the agent's reverse requests. IPC is not an option: a browser
cannot open a Unix socket or a Windows named pipe, and ACP is bidirectional —
the agent calls back for permissions and file reads.

Two type modules describe it, both transcribed from the Rust source rather than
guessed:

| Module         | Source of truth                                                           |
| -------------- | ------------------------------------------------------------------------- |
| `types/acp.ts` | `agent-client-protocol-schema` 0.11.4 (`client.rs`, `tool_call.rs`, …)    |
| `types/ext.ts` | `alnair-shell/src/extensions/notification.rs` and the `alnair/*` handlers |

One detail is easy to get wrong and is worth stating: **ACP structs are
camelCase, Alnair's extension updates are snake_case.** serde's `rename_all` on
an enum renames the variants, not their payload fields, so `graph_updated`
carries `total_nodes` and `tokens_spent` while `tool_call` carries `toolCallId`.
`types/ext.ts` follows the Rust names for that reason.

## The seam

Components never touch the wire. They read one interface, `SessionStore` in
`src/lib/harness/session-store.svelte.ts`. Behind it sit two implementations:
`FixtureTransport` and `WebSocketTransport`, both feeding the same reducer.

```
wire frame ──▶ reducer.ts ──▶ Acc ──▶ SessionStore ──▶ components
```

`reducer.ts` is the only module that knows what a frame looks like. It is pure
and synchronous, so every rule below is unit-tested without a DOM.

```ts
interface SessionStore {
	readonly workspace: WorkspaceInfo;
	readonly sessions: Session[];
	readonly turns: Turn[];
	readonly models: ModelOption[];
	readonly graph: GraphState | undefined;
	readonly context: ContextUsage;
	readonly activeSessionId: string;
	readonly activeSession: Session;
	readonly model: string;
	readonly effort: string;
	readonly busy: boolean;
	readonly permission: PermissionRequest | undefined;
	readonly plan: PlanArtifact | undefined;
	readonly todos: TodoItem[];
	readonly commands: AvailableCommand[];

	selectSession(id: string): void;
	setModel(id: string): void;
	setEffort(effort: string): void;
	send(text: string): void;
	cancel(): void;
	clear(): void;
	answerPermission(optionId: string): void;
}
```

### View model ← wire

Every field below is produced by something the agent actually sends. Nothing is
invented; where the wire carries less, the UI shows less.

| View model        | Wire source                                                                    |
| ----------------- | ------------------------------------------------------------------------------ |
| `Turn`            | one `session/prompt` exchange, closed by its response                          |
| `TurnStatus`      | `StopReason` (`cancelled`, `refusal`, …)                                       |
| `TextPart`        | `agent_message_chunk`                                                          |
| `ReasoningPart`   | `agent_thought_chunk`                                                          |
| `FileReadPart`    | `tool_call` kind `read` + a text block                                         |
| `ImageReadPart`   | `tool_call` kind `read` + an image block                                       |
| `FileEditPart`    | `tool_call` + a `diff` with `oldText`                                          |
| `FileWritePart`   | `tool_call` + a `diff` without `oldText` (a new file)                          |
| `TerminalPart`    | `tool_call` kind `execute`, or `task_backgrounded` / `task_completed`          |
| `SubagentPart`    | `subagent_spawned` → `subagent_progress` → `subagent_finished`                 |
| `PermissionPart`  | `pending_interaction` with `kind: permission`                                  |
| `SystemPart`      | a `user_message_chunk` that is wholly a `<tag>…</tag>` envelope                |
| `QuestionPart`    | the `alnair/ask_user_question` reverse request                                 |
| `NoticePart`      | `retry_state`, `auto_compact_*`, `auto_recovery_*`, `model_*`, `session_recap` |
| `TodoItem`        | the ACP `plan` update (which `todo_write` produces)                            |
| `PlanArtifact`    | the `alnair/exit_plan_mode` reverse request                                    |
| `GraphState`      | `graph_updated` — counts, not a DAG                                            |
| `ContextUsage`    | `auto_compact_*` and `model_changed`                                           |
| `Session`         | an `alnair/session/list` row                                                   |
| `WorkspaceGroup`  | those rows regrouped by `repoName`                                             |
| `ComposerContext` | the active session's checkout and the agent's access mode                      |

### What the UI deliberately does not show

Four parts existed in the first pass and are gone, because nothing on the wire
produces them: a `plan` row (the plan is an artifact, not a transcript part), a
`tests` row (test results arrive as ordinary tool output), a `sources` row (web
search returns tool content), and a `checkpoint` row (checkpoints are session
state). Two were added because the wire has them: the permission card and the
one-line system notice.

The graph panel renders counts, the current node, and the budget — which is what
`graph_updated` carries. It does not draw a DAG, because the wire does not send
one.

## Fixtures

`src/lib/harness/fixtures.ts` holds scripted turns, each a list of frames with
delays. `FixtureTransport` replays them on a timer, so the UI exercises
streaming rather than a single state flip.

| Turn           | Covers                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `foundation`   | reasoning, plan, bash, text read, image read, edit, write, subagent, graph badge, plan approval |
| `permission`   | a parked `request_permission` mid-turn                                                          |
| `question`     | a parked `ask_user_question` with two questions, one of them multi-select                       |
| `planQuestion` | the same request in plan mode, with the two interview exits                                     |
| `cancelled`    | a backgrounded task, a monitor line, `StopReason::Cancelled`                                    |
| `failed`       | `retry_state` retrying → failed                                                                 |
| `compaction`   | `auto_compact_started` → `auto_compact_completed`                                               |

The initial transcripts fold several of them so the first paint shows a
completed turn, a cancelled one, one parked on a permission request, and two
parked on questionnaires (one in plan mode) — the states the header and the
composer have to distinguish.

## Layout

```
src/
  routes/
    +layout.svelte        ModeWatcher + store provider
    +page.svelte          three-pane shell, permission banner
    layout.css            design tokens, fonts, base layer
  lib/
    harness/
      types/acp.ts        the ACP wire, as emitted
      types/ext.ts        Alnair's extension updates
      types.ts            the view model
      reducer.ts          wire → view model, pure
      commands.ts         which advertised slash commands the browser may show
      attachments.ts      pasted images / long text → ACP prompt blocks
      system-notes.ts     `<system-reminder>` envelopes, and why they are not prompts
      workspaces.ts       flat session rows → workspace groups
      fixtures.ts         scripted transcripts
      session-store.svelte.ts  the store and the fixture transport
      ws-transport.ts     JSON-RPC over the leader's WebSocket bridge
      mock.ts             session rows, catalog, initial transcript
    components/
      chrome/             sidebar, thread header, plan + todo popovers
      thread/             thread, turn, work summary, one row per part kind
      composer/           prompt card, attachments, pickers, checkout row
      settings/           the settings dialog
      inspector/          right rail (files, source control) + bottom drawer
                          (Monaco editor, xterm terminal)
      ui/                 shadcn-svelte components (vendored)
    editor.ts             Monaco, loaded on first panel open
    clipboard.ts          copy + download, secure-context-safe
    highlighter.ts        Shiki, loaded per language
```

## Design tokens

`src/routes/layout.css` carries the whole palette; components only ever use the
token utilities, never raw hex.

- **paper** (light) is white with an achromatic gray chrome ramp.

  | Hex       | Role                                          |
  | --------- | --------------------------------------------- |
  | `#ffffff` | ground — page, thread, popovers               |
  | `#fafafa` | raised surface — sidebar, inspector, composer |
  | `#f4f4f4` | card and hover surface                        |
  | `#e5e5e5` | border                                        |
  | `#d4d4d4` | strong border, focus ring                     |
  | `#7a8c3e` | brand olive: live work, selection             |

  `ink-tertiary` is `#757575` rather than a lighter gray so small meta text
  keeps 4.5:1 on white.

- **well** (dark) is black with an achromatic gray ramp and one lime accent.

  | Hex       | Role                                          |
  | --------- | --------------------------------------------- |
  | `#000000` | ground — page, thread, sidebar                |
  | `#0a0a0a` | raised surface — sidebar, inspector, composer |
  | `#141414` | card and hover surface                        |
  | `#262626` | border                                        |
  | `#3d3d3d` | strong border, focus ring                     |
  | `#A7D129` | the only chroma on the surface                |

  The ramp is deliberately **achromatic**: a green-tinted neutral makes a dark
  UI read as murky across a long session, and it competes with the accents.

Agent-turn accents stay **colourful** in both modes, following the TUI themes in
`crates/codegen/alnair-pager-render/src/theme/`.

| Token       | Meaning          | Light     | Dark      |
| ----------- | ---------------- | --------- | --------- |
| `assistant` | agent reply      | `#7d4bc6` | `#bb9af7` |
| `thinking`  | reasoning rows   | `#7d4bc6` | `#bb9af7` |
| `tool`      | tool rows        | `#626262` | `#a3a3a3` |
| `system`    | subagents, links | `#2f64d2` | `#7aa2f7` |
| `success`   | success          | `#378e23` | `#9ece6a` |
| `error`     | failures         | `#cd3048` | `#f7768e` |
| `plan`      | plan affordances | `#a8780a` | `#ffdb8d` |
| `verify`    | diffs            | `#7850a0` | `#bb9af7` |
| `running`   | live work        | `#0f87a2` | `#7dcfff` |

The app mark is `src/lib/assets/logo-white.svg`, inlined in
`components/chrome/logo.svelte` on `currentColor` so it themes.
`src/lib/assets/favicon.svg` is the same art on the black ground. Fonts are
self-hosted in `static/fonts/`; nothing loads from a CDN.

## Component notes

- **The sidebar nests.** `alnair/session/list` returns one flat row per
  conversation, each naming its repo (`repoName`, which the agent derives from
  the cwd). `workspaces.ts` regroups those rows so the sidebar shows the shape
  the runtime actually has: a workspace, with its conversations underneath.
  Groups stay in alphabetical order — clicking a conversation never reorders
  the list — and the current workspace is marked rather than moved. Neither the
  sidebar nor the header repeats the branch; that belongs to the composer's
  checkout row. The sidebar's footer holds the settings button.
- **Settings** live in a dialog behind that button, with categories and search.
  The browser owns its registry in `harness/settings.ts`; appearance and input
  preferences persist in localStorage. Permission mode is a runtime control:
  both the dialog and the composer send the same mode change to the agent.
  Terminal-only settings are absent. The theme control lives here.
- **The composer is one card.** The field sits on top, a control row under it
  (`+`, access, then model · effort · context · send), and a checkout row
  attached below. The access menu offers the runtime's three
  `PermissionMode`s — Ask first, Auto, Full access — and stays in step with the
  same setting in the dialog.
- **A finished turn folds its work away.** Forty trace rows between a question
  and its answer make a long thread unreadable, so everything before the LAST
  text part collapses into one line — `Worked for 1m 04s · 12 calls · 3 files
edited` — and expanding it restores the original trace. A turn with no text
  answer keeps everything open: folding it would leave an empty screen and a
  button. The duration is measured from the PROMPT, not from the first token,
  which is why a quick tool-only turn no longer reports `0s`.
- **The composer takes files.** A pasted image goes on the wire as an ACP
  `ImageContent`; a long paste (≥1,200 characters or ≥24 lines) goes as a
  `Resource` with the text inline, the same `<file_contents>` path the TUI's
  paste takes. `+` opens a real file input, and `Backspace` on an empty draft
  removes the last chip.
- **The inspector is a rail plus a drawer.** The rail holds lists — files the
  thread touched, and the working tree from `alnair/git/status` — because a
  click on a file is a request to edit it. The editor and the terminal live in
  a bottom drawer opened with ``Ctrl+` ``, the shape VS Code and `alnair-ai`
  both use: the editor is multi-tab Monaco over `alnair/fs/*`, the terminal is
  a real PTY through `alnair/terminal/pty/*` rendered by xterm.
- **The `/` menu is filtered.** The agent advertises one catalog to every
  client; `commands.ts` denies the pager's own local commands (`/model`,
  `/clear`, `/rewind`, `/theme`, …), which never reach ACP and would be dead
  rows here. It is a denylist, so a skill or a future builtin appears without
  editing anything.
- **Trace** is the backbone. Every step is a `Trace.Root` line, so they share one
  shape and one status vocabulary. `groupParts()` batches consecutive steps into
  one `Trace.Root` and breaks the run at text, notices, and permission cards.
- **File rows** show the actual numbered lines. `file-edit` builds its own grid
  (old number, new number, sign, text) because `CodeBlock`'s gutter is a single
  column; it highlights the after-side text in one pass so a multi-line
  construct stays intact, and removed lines render plain.
- **The header** carries two popovers. _Todo_ reads the ACP `plan` update and
  shows `done/total`. _Plan_ appears only while an `exit_plan_mode` request is
  parked, and renders the artifact's markdown; focus moves to the scroll
  container so it opens at the top instead of jumping to a code block's copy
  button.
- **Subagent dialogs refresh while open.** The store reads the child's transcript
  and `alnair/subagent/get` snapshot again one second after each read completes.
  Closing the dialog, choosing another child, or switching parent sessions stops
  the refresh and ignores late responses. Failed reads keep the last transcript
  visible and retry; unchanged transcripts keep their existing rendered state.
- **Plan approval** also opens a panel above the composer, where the reader can
  review the Markdown and approve, reject, or leave plan mode. The answer goes
  to the parked reverse request. An `interaction_resolved` for that call closes
  the panel when another client answered first.
- **Extension failures** can arrive inside a successful JSON-RPC response as
  `{ result: null, error }`. The transport rejects those before a mutation can
  report success. A non-null partial result with a warning remains usable.
- **Graph** opens a workspace from the header, even before a graph exists.
  It shows a dependency diagram, filterable nodes, node objectives/status and
  counters, worker/verifier activity and transcripts, discoveries and history.
  Start, pause, resume with extra budget, stop-turn and confirmed clear use the
  runtime's existing semantics. Full snapshots are read from `alnair/graph/get`
  every two seconds while open; badge counts never stand in for topology.
- **Permission** has exactly one set of buttons, in the banner above the
  composer. The in-thread card is a marker, not a control: two sets for one
  request invites answering it twice. An ANSWERED request collapses to one
  quiet line — it is history, the tool already ran, and a boxed block there
  out-shouts the result underneath it.
- **An injected `<system-reminder>` is not a prompt.** The shell stores it as a
  synthetic USER message, so it arrives on the user rail; `system-notes.ts`
  recognises a message that is wholly one wrapper and the reducer gives it a
  `system` part. It renders as a folded row naming the mechanism, never as a
  bubble on the right.
- **A thought becomes "Thought" when the next part arrives.** There is no
  `thought_completed` on the wire, so the reducer settles a running reasoning
  part at the next non-reasoning part — otherwise the row kept a spinner and
  said "Thinking" over a finished thought for the rest of the turn.
- **Questions** follow the same rule. The panel above the composer shows one
  question at a time, with Back and Next between them and a tick per question;
  the draft survives the move, so an earlier answer can be revised after seeing
  a later one. Each question is a list of choices plus a freeform line, and the
  buttons follow the request's `mode` (`default`: Accept/Cancel; `plan`: also
  Chat about this and Skip interview). The answers are shaped exactly as the
  agent parses them: unanswered questions omitted, multi-select as one element
  per label, a freeform-only answer as the literal `Other` with the text in
  `annotations`, and `preview` echoed only for single-select picks.
- **Bubble** has one extra variant, `paper`, for the person's turn, because the
  component paints its child through variant selectors.
- **Markdown** renders through `svelte-streamdown` with a theme re-pointed at our
  tokens; fenced code routes to `CodeBlock`. `markdown-lazy.svelte` keeps it off
  the first paint.

## What is not here yet

- Prompt queue/interjection controls (`alnair/queue/*`).
- Session fork, rewind, repair and transcript full-text search controls.
- MCP, provider login, skills, plugins, hooks and background-task management
  panels. Their tool output can still appear in the transcript.
- Standalone goal, scheduler and memory event views.
- A browser E2E suite against a live leader. `test:graph-ui` and
  `test:terminal-ui` exercise graph controls and terminal startup/input/cleanup
  in an installed Chromium browser with mocked leader responses; unit tests
  cover the store, reducer and transport.
