# Alnair web harness

A browser view of the Alnair agent runtime: SvelteKit, Tailwind v4, and
shadcn-svelte components composed into the [AI Elements](https://www.shadcn-svelte.com/docs/ai-elements)
patterns.

**Everything here is mock data.** There is no wiring to the Rust harness yet —
the goal of this pass was the UI foundation, so the thread, the trace rows, the
composer, and the inspector all render one scripted session from
`src/lib/harness/mock.ts`.

```sh
npm install
npm run dev
```

| Script            | What it does                                               |
| ----------------- | ---------------------------------------------------------- |
| `npm run dev`     | Vite dev server with HMR                                   |
| `npm run build`   | Production build                                           |
| `npm run preview` | Serve the production build                                 |
| `npm run check`   | `svelte-check` — types and Svelte diagnostics, zero errors |
| `npm run lint`    | Prettier check plus ESLint                                 |
| `npm run format`  | Prettier write                                             |
| `npm test`        | Vitest (pure logic only; no DOM)                           |

## The seam

Components never touch transport. They read one interface,
`SessionStore` in `src/lib/harness/session-store.svelte.ts`:

```ts
interface SessionStore {
	readonly workspace: WorkspaceInfo;
	readonly sessions: Session[];
	readonly turns: Turn[];
	readonly models: ModelOption[];
	readonly graph: GraphState;
	readonly context: ContextUsage;
	readonly activeSessionId: string;
	readonly activeSession: Session;
	readonly model: string;
	readonly effort: string;
	readonly busy: boolean;

	selectSession(id: string): void;
	setModel(id: string): void;
	setEffort(effort: string): void;
	send(text: string): void;
	cancel(): void;
	clear(): void;
}
```

`MockSessionStore` implements it today; `provideSessionStore()` in
`src/lib/harness/context.ts` puts one instance on Svelte's component context and
`useSessionStore()` reads it. Wiring the harness means writing a second
implementation over ACP session updates and swapping the one line in
`src/routes/+layout.svelte` — no component changes.

`src/lib/harness/types.ts` is the view model, deliberately **not** the ACP types.
The adapter's job is to map protocol events onto it:

| View model     | Comes from                                      |
| -------------- | ----------------------------------------------- |
| `Turn`         | one prompt/response exchange                    |
| `TurnPart`     | a message chunk, tool call, plan, or checkpoint |
| `TodoItem`     | the agent's todo list for the turn              |
| `PlanDocument` | the plan file the agent is working from         |
| `GraphState`   | `GraphUpdated` notifications                    |
| `ContextUsage` | token accounting for the session                |
| `Session`      | the session list (`session/list`)               |

## Layout

```
src/
  routes/
    +layout.svelte        ModeWatcher + store provider
    +page.svelte          three-pane shell
    layout.css            design tokens, fonts, base layer
  lib/
    harness/              types, mock data, store, formatting
    components/
      chrome/             sidebar, thread header, graph chip, logo, theme toggle
      thread/             thread, turn, markdown, and one row per part kind
      composer/           input group, model picker, context meter
      inspector/          graph panel, files panel, activity stats
      ui/                 shadcn-svelte components (vendored)
    highlighter.ts        Shiki, loaded per language
```

## Design tokens

`src/routes/layout.css` carries the whole palette; components only ever use the
token utilities, never raw hex. Two surfaces:

- **paper** (light) is white with a neutral gray chrome ramp; the olive / sage /
  terra brand accents are the only chroma on the surface.

  | Hex       | Role                                          |
  | --------- | --------------------------------------------- |
  | `#ffffff` | ground — page, thread, popovers               |
  | `#fafafa` | raised surface — sidebar, inspector, composer |
  | `#f4f4f4` | card and hover surface                        |
  | `#e5e5e5` | border                                        |
  | `#d4d4d4` | strong border, focus ring                     |
  | `#7a8c3e` | brand olive: live work, selection             |

  Like dark mode, the gray ramp is achromatic — the warm cream of the landing
  site was dropped so the two themes share one neutral skeleton. `ink-tertiary`
  is `#757575` rather than a lighter gray so small meta text keeps 4.5:1 on
  white.

- **well** (dark) is black with a neutral gray chrome ramp and one lime accent:

  | Hex       | Role                                                 |
  | --------- | ---------------------------------------------------- |
  | `#000000` | ground — page, thread, sidebar                       |
  | `#0a0a0a` | raised surface — sidebar, inspector, composer        |
  | `#141414` | card and hover surface                               |
  | `#262626` | border                                               |
  | `#3d3d3d` | strong border, focus ring                            |
  | `#A7D129` | the only chroma on the surface: live work, selection |

  The gray ramp is deliberately **achromatic**. A green-tinted neutral makes a
  dark UI read as murky and strains the eye across a long session; keeping the
  chrome gray also lets the one lime accent stand out instead of competing with
  a dozen muddy olive neighbours.

Agent-turn accents stay **colourful** in both modes: they follow the TUI themes
in `crates/codegen/alnair-pager-render/src/theme/` (AlnairDay / AlnairNight), so
a row that is violet in the terminal is violet in the browser. Dark mode uses
the night hues — one hue per step is what makes a long trace scannable.

| Token       | Meaning                   | Light     | Dark      |
| ----------- | ------------------------- | --------- | --------- |
| `assistant` | agent reply               | `#7d4bc6` | `#bb9af7` |
| `thinking`  | reasoning rows            | `#7d4bc6` | `#bb9af7` |
| `tool`      | tool rows                 | `#626262` | `#a3a3a3` |
| `system`    | subagents, sources, links | `#2f64d2` | `#7aa2f7` |
| `success`   | passing tests             | `#378e23` | `#9ece6a` |
| `error`     | failures                  | `#cd3048` | `#f7768e` |
| `plan`      | plan rows                 | `#a8780a` | `#ffdb8d` |
| `verify`    | diffs, checkpoints        | `#7850a0` | `#bb9af7` |
| `running`   | live work                 | `#0f87a2` | `#7dcfff` |

The app mark is `src/lib/assets/logo-white.svg`, inlined in
`components/chrome/logo.svelte` and painted on `currentColor` so it themes.
`src/lib/assets/favicon.svg` is the same art on the black ground.

Fonts are self-hosted (`static/fonts/`, Geist Sans + Geist Mono) so the app makes
no external requests. There is no telemetry and nothing loads from a CDN.

## Component notes

- **Trace** is the backbone. Every step — reasoning, tool, file, terminal, plan,
  subagent, tests, sources, diff, error — is a `Trace.Root` line, so they share
  one shape, one status vocabulary (`pending` / `running` / `error`), and the
  continuous rule between steps. `groupParts()` in
  `components/thread/segments.ts` batches consecutive steps into one `Trace.Root`
  and breaks the run at text and checkpoints.

### File tool rows

A `write` or `read` part is not rendered as generic tool JSON. Each one has its
own row, and each shows the **actual numbered lines** the agent saw or wrote:

| Part         | Row                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `file-read`  | `Read <dir>/<file>` · line range (`1–19 of 218`) · `CodeBlock` with line numbers starting at the real offset             |
| `file-write` | `Wrote`/`Overwrote <file>` · `+N` for a new file · full content, numbered; `hiddenLines` renders a "N more lines" footer |
| `file-edit`  | `Edited <file>` · `+N / −N` · per-hunk diff with **two number columns** (old and new)                                    |
| `image-read` | `Read image <file>` · `720×400` · preview on a checkerboard with a metadata caption (`mime · size · bytes`)              |

`file-edit` cannot use `CodeBlock.Content`'s built-in gutter, which is a single
column. It builds the grid itself (old number, new number, sign, text) and
highlights the after-side text in one pass, so a multi-line construct stays
intact; removed lines have no place in that text and render plain, relying on
the tint and the `−` to read as removed.

### Header

The header carries two popovers that read the same store the thread does:

- **Plan** — appears only when the session has a `PlanDocument`; the trigger
  shows the plan title, and the popover renders the plan's markdown (headings,
  lists, tables, fenced code) with its path and age. Focus is moved to the
  scroll container rather than the first focusable element, so the popover opens
  at the top instead of jumping to a code block's copy button.
- **Todo** — always present; the trigger shows `done/total` and the active item,
  the popover lists every item with its status and optional detail.
- **Message Scroller** owns the scroll behavior: the person's turn is the
  `scrollAnchor`, `autoScroll` follows a streaming reply, and the floating button
  appears only when there is something below.
- **Bubble** has one extra variant, `paper`, for the person's turn. The variant
  exists because the component paints its child through variant selectors, so an
  extra class on `Bubble.Content` loses.
- **Markdown** renders through `svelte-streamdown` with a theme re-pointed at our
  tokens, and fenced code routes to `CodeBlock` so code gets line numbers and a
  copy button. `markdown-lazy.svelte` splits it out of the first paint.
- **The graph chip** and the inspector's graph panel read the same `GraphState`.
  One state source, two renderers — the same rule the pager follows for
  `GraphUpdated`.

## What is not here yet

- No harness connection, no persistence, no auth. The store is in memory and
  resets on reload.
- No responsive drawer for the session list below `md`; it is hidden instead.
- Tool and terminal output are plain text; ANSI coloring is wired in
  `highlighter.ts` but no mock part exercises it yet.
- The inspector's file list is derived from the transcript rather than from
  checkpoints, which is a stand-in until the adapter exposes real file state.
