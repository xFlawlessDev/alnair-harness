import type {
	ContextUsage,
	FileEditPart,
	FileReadPart,
	FileWritePart,
	GraphState,
	ImageReadPart,
	ModelOption,
	PlanDocument,
	Session,
	TodoItem,
	Turn,
	WorkspaceInfo
} from './types.js';

/** Fixed clock so screenshots and hydration stay stable. */
export const MOCK_NOW = new Date('2026-10-20T09:41:12Z');

const t = (minutesAgo: number) => new Date(MOCK_NOW.getTime() - minutesAgo * 60_000).toISOString();

export const workspace: WorkspaceInfo = {
	name: 'alnair-cli',
	path: '~/dev/alnair-cli',
	branch: 'feat/web-harness',
	ahead: 2,
	behind: 0,
	dirty: true
};

export const sessions: Session[] = [
	{
		id: 's-graph',
		title: 'Graph mode: web harness foundation',
		cwd: '~/dev/alnair-cli',
		branch: 'feat/web-harness',
		model: 'kimi-k2-turbo-preview',
		status: 'running',
		updatedAt: t(0),
		tokens: 184_320
	},
	{
		id: 's-auth',
		title: 'Refresh OAuth tokens on 401',
		cwd: '~/dev/alnair-cli',
		branch: 'fix/oauth-refresh',
		model: 'claude-sonnet-4-5',
		status: 'idle',
		updatedAt: t(96),
		tokens: 92_104
	},
	{
		id: 's-mcp',
		title: 'Streamable HTTP cancel path',
		cwd: '~/dev/alnair-cli',
		branch: 'fix/mcp-cancel',
		model: 'gpt-6-astra',
		status: 'attention',
		updatedAt: t(1_320),
		tokens: 411_882,
		unread: true
	},
	{
		id: 's-docs',
		title: 'Rewrite terminal setup guide',
		cwd: '~/dev/alnair-docs',
		branch: 'main',
		model: 'kimi-k2-turbo-preview',
		status: 'idle',
		updatedAt: t(2_880),
		tokens: 24_506
	},
	{
		id: 's-perf',
		title: 'PTY baseline for 120×40',
		cwd: '~/dev/alnair-cli',
		branch: 'perf/pty-baseline',
		model: 'grok-4-fast',
		status: 'idle',
		updatedAt: t(4_140),
		tokens: 133_990
	}
];

export const models: ModelOption[] = [
	{
		id: 'kimi-k2-turbo-preview',
		label: 'Kimi K2 Turbo',
		provider: 'Kimi Code',
		efforts: ['none', 'low', 'medium', 'high', 'max'],
		contextWindow: 262_144
	},
	{
		id: 'claude-sonnet-4-5',
		label: 'Claude Sonnet 4.5',
		provider: 'Claude Pro/Max',
		efforts: ['low', 'medium', 'high'],
		contextWindow: 200_000
	},
	{
		id: 'gpt-6-astra',
		label: 'GPT-6 Astra',
		provider: 'ChatGPT',
		efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
		contextWindow: 272_000
	},
	{
		id: 'grok-4-fast',
		label: 'Grok 4 Fast',
		provider: 'xAI',
		efforts: ['low', 'high'],
		contextWindow: 131_072
	}
];

export const contextUsage: ContextUsage = {
	used: 61_440,
	limit: 262_144,
	segments: [
		{ label: 'System', tokens: 9_180 },
		{ label: 'Tools', tokens: 12_460 },
		{ label: 'History', tokens: 27_800 },
		{ label: 'Files', tokens: 12_000 }
	]
};

export const graph: GraphState = {
	id: 'g-2026-10-20-web-harness',
	objective: 'Build the web UI foundation on shadcn-svelte AI Elements with mocked harness data',
	planVersion: 2,
	status: 'running',
	concurrency: 3,
	nodes: [
		{
			id: 'gn-theme',
			title: 'Port the Alnair palette into shadcn tokens',
			status: 'achieved',
			dependsOn: [],
			budgetUsed: 0.62
		},
		{
			id: 'gn-types',
			title: 'Define the harness view model',
			status: 'achieved',
			dependsOn: [],
			budgetUsed: 0.4
		},
		{
			id: 'gn-thread',
			title: 'Build the turn thread',
			status: 'running',
			dependsOn: ['gn-theme', 'gn-types'],
			budgetUsed: 0.71
		},
		{
			id: 'gn-composer',
			title: 'Build the composer',
			status: 'running',
			dependsOn: ['gn-types'],
			budgetUsed: 0.33
		},
		{
			id: 'gn-inspector',
			title: 'Build the inspector panel',
			status: 'ready',
			dependsOn: ['gn-theme'],
			budgetUsed: 0
		},
		{
			id: 'gn-mock',
			title: 'Mock the session store',
			status: 'running',
			dependsOn: ['gn-types'],
			budgetUsed: 0.55
		},
		{
			id: 'gn-verify',
			title: 'Verify: typecheck and build',
			status: 'pending',
			dependsOn: ['gn-thread', 'gn-composer', 'gn-inspector', 'gn-mock']
		}
	]
};

const diff = `diff --git a/web/src/lib/components/thread/turn.svelte b/web/src/lib/components/thread/turn.svelte
new file mode 100644
--- /dev/null
+++ b/web/src/lib/components/thread/turn.svelte
@@ -0,0 +1,24 @@
+<script lang="ts">
+  import * as Message from '#lib/components/ui/message/index.js';
+  import * as Trace from '#lib/components/ui/trace/index.js';
+
+  let { turn }: { turn: Turn } = $props();
+</script>
+
+<Message.Root>
+  <Message.Content class="gap-3">
+    {#each turn.parts as part (part.id)}
+      {#if part.kind === 'reasoning'}
+        <Trace.Root>…</Trace.Root>
+      {:else if part.kind === 'text'}
+        <p>{part.text}</p>
+      {/if}
+    {/each}
+  </Message.Content>
+</Message.Root>`;

const readLines = (text: string, start = 1) =>
	text.split('\n').map((line, index) => ({ n: start + index, text: line }));

const TYPES_SOURCE = `export type TurnRole = 'user' | 'assistant' | 'system';

export type PartStatus = 'pending' | 'running' | 'complete' | 'error';

export interface TextPart {
	kind: 'text';
	id: string;
	text: string;
}

export interface ToolPart {
	kind: 'tool';
	id: string;
	name: string;
	summary: string;
	input?: string;
	output?: string;
	status: PartStatus;
}`;

const sessionStoreSource = `export interface SessionStore {
	readonly workspace: WorkspaceInfo;
	readonly sessions: Session[];
	readonly turns: Turn[];
	readonly models: ModelOption[];
	readonly activeSessionId: string;
	readonly busy: boolean;

	selectSession(id: string): void;
	send(text: string): void;
	cancel(): void;
}`;

const readPart: FileReadPart = {
	kind: 'file-read',
	id: 't2-p3a',
	path: 'web/src/lib/harness/types.ts',
	language: 'ts',
	lines: readLines(TYPES_SOURCE),
	totalLines: 218,
	status: 'complete',
	durationMs: 140
};

const imagePart: ImageReadPart = {
	kind: 'image-read',
	id: 't2-p3b',
	path: 'web/static/mock/graph-dag.png',
	src: '/mock/graph-dag.png',
	mime: 'image/png',
	width: 720,
	height: 400,
	bytes: 17_170,
	status: 'complete',
	durationMs: 210
};

const editPart: FileEditPart = {
	kind: 'file-edit',
	id: 't2-p3c',
	path: 'web/src/lib/harness/session-store.svelte.ts',
	language: 'ts',
	additions: 3,
	deletions: 1,
	status: 'complete',
	durationMs: 260,
	hunks: [
		{
			id: 'h1',
			header: '@@ -1,4 +1,6 @@',
			lines: [
				{ kind: 'context', oldNumber: 1, newNumber: 1, text: 'export interface SessionStore {' },
				{
					kind: 'context',
					oldNumber: 2,
					newNumber: 2,
					text: '\treadonly workspace: WorkspaceInfo;'
				},
				{ kind: 'remove', oldNumber: 3, text: '\treadonly turns: Turn[];' },
				{
					kind: 'add',
					newNumber: 3,
					text: '\treadonly turns: Turn[];'
				},
				{
					kind: 'add',
					newNumber: 4,
					text: '\treadonly todos: TodoItem[];'
				},
				{
					kind: 'add',
					newNumber: 5,
					text: '\treadonly plan: PlanDocument | null;'
				},
				{ kind: 'context', oldNumber: 4, newNumber: 6, text: '' }
			]
		},
		{
			id: 'h2',
			header: '@@ -14,3 +16,4 @@',
			lines: [
				{ kind: 'context', oldNumber: 14, newNumber: 16, text: '\tcancel(): void;' },
				{ kind: 'context', oldNumber: 15, newNumber: 17, text: '}' },
				{ kind: 'context', oldNumber: 16, newNumber: 18, text: '' },
				{ kind: 'add', newNumber: 19, text: '// plan and todos ride the same store' }
			]
		}
	]
};

const writePart: FileWritePart = {
	kind: 'file-write',
	id: 't2-p3d',
	path: 'web/src/lib/harness/session-store.svelte.ts',
	language: 'ts',
	lines: readLines(sessionStoreSource),
	created: true,
	status: 'complete',
	durationMs: 180
};

export const turns: Turn[] = [
	{
		id: 't1',
		role: 'user',
		status: 'complete',
		at: t(14),
		parts: [
			{
				kind: 'text',
				id: 't1-p1',
				text: 'Build the web harness foundation. SvelteKit + shadcn-svelte AI Elements, mocked data only — no harness wiring yet.'
			}
		]
	},
	{
		id: 't2',
		role: 'assistant',
		status: 'complete',
		at: t(13),
		model: 'Kimi K2 Turbo',
		effort: 'high',
		durationMs: 41_200,
		parts: [
			{
				kind: 'reasoning',
				id: 't2-p1',
				status: 'complete',
				durationMs: 6_400,
				text: "The harness already speaks ACP, so the UI should render a view model rather than wire types — otherwise every protocol bump rewrites components. I'll start from the palette that's already in the TUI themes, then lay out the shell: sidebar, thread, inspector."
			},
			{
				kind: 'plan',
				id: 't2-p2',
				title: 'Foundation plan',
				steps: [
					{
						id: 'st1',
						title: 'Port AlnairDay / AlnairNight palettes into shadcn tokens',
						status: 'complete'
					},
					{ id: 'st2', title: 'Install the AI Elements component set', status: 'complete' },
					{ id: 'st3', title: 'Model the turn view model and mock a session', status: 'complete' },
					{ id: 'st4', title: 'Build the shell, thread, and composer', status: 'complete' },
					{ id: 'st5', title: 'Document the seam where the harness plugs in', status: 'complete' }
				]
			},
			{
				kind: 'terminal',
				id: 't2-p3',
				command: 'npx sv create web --template minimal --types ts --add tailwindcss',
				cwd: '~/dev/alnair-cli',
				status: 'complete',
				durationMs: 1_800,
				exitCode: 0,
				output: `┌  Welcome to the Svelte CLI!
│
◆  Project created
│
◆  Successfully setup add-ons: tailwindcss, prettier, eslint
│
└  You're all set!`
			},
			{
				kind: 'tool',
				id: 't2-p4',
				name: 'write',
				summary: 'web/src/lib/harness/types.ts',
				status: 'complete',
				durationMs: 320,
				input: 'web/src/lib/harness/types.ts',
				output: '+ 218 lines'
			},
			readPart,
			editPart,
			writePart,
			imagePart,
			{
				kind: 'subagent',
				id: 't2-p5',
				title: 'Audit the TUI palette for web-safe accents',
				agent: 'explore',
				model: 'Kimi K2 Turbo',
				status: 'complete',
				steps: [
					{ id: 'sa1', label: 'Read alnairday.rs', status: 'complete' },
					{ id: 'sa2', label: 'Read alnairnight.rs', status: 'complete' },
					{ id: 'sa3', label: 'Cross-check alnaircli.dev tokens', status: 'complete' }
				],
				result:
					'Night accents are TokyoNight Night; day accents are the same hues deepened. The landing site is a separate warm-paper palette. Both are worth keeping: the site palette for chrome, the theme accents for turn semantics.'
			},
			{
				kind: 'diff',
				id: 't2-p6',
				path: 'web/src/lib/components/thread/turn.svelte',
				additions: 24,
				deletions: 0,
				patch: diff
			},
			{
				kind: 'tests',
				id: 't2-p7',
				title: 'Foundation checks',
				command: 'npm run check && npm run build',
				status: 'complete',
				suites: [
					{
						id: 'ts1',
						name: 'svelte-check',
						status: 'passed',
						cases: [
							{ name: 'src/lib/harness/types.ts', status: 'passed', durationMs: 412 },
							{ name: 'src/lib/components/thread', status: 'passed', durationMs: 1_204 }
						]
					},
					{
						id: 'ts2',
						name: 'vite build',
						status: 'passed',
						cases: [
							{ name: 'client bundle', status: 'passed', durationMs: 3_900 },
							{ name: 'server bundle', status: 'passed', durationMs: 1_100 }
						]
					}
				]
			},
			{
				kind: 'sources',
				id: 't2-p8',
				title: 'References',
				sources: [
					{
						id: 'src1',
						title: 'AI Elements',
						url: 'https://www.shadcn-svelte.com/docs/ai-elements',
						host: 'shadcn-svelte.com',
						snippet: 'Patterns for agentic interfaces, built from shadcn-svelte components.'
					},
					{
						id: 'src2',
						title: 'Trace',
						url: 'https://www.shadcn-svelte.com/docs/components/trace',
						host: 'shadcn-svelte.com'
					},
					{
						id: 'src3',
						title: 'Message Scroller',
						url: 'https://www.shadcn-svelte.com/docs/components/message-scroller',
						host: 'shadcn-svelte.com'
					}
				]
			},
			{
				kind: 'checkpoint',
				id: 't2-p9',
				label: 'Foundation committed',
				detail: '8 files · 1,412 insertions · 0 deletions'
			},
			{
				kind: 'text',
				id: 't2-p10',
				text: `The foundation is in place: SvelteKit, Tailwind v4, and the shadcn-svelte component set behind the AI Elements patterns.

**What exists now**
- \`web/src/lib/harness/types.ts\` — the view model every component renders.
- \`web/src/lib/harness/mock.ts\` — one scripted session with a full turn: reasoning, plan, terminal, tool, subagent, diff, tests, sources.
- A three-pane shell: session list, thread, inspector.

Everything is mock data. The seam for the real harness is a single \`SessionStore\` interface, so wiring it later means writing one adapter, not touching the components.`
			}
		]
	},
	{
		id: 't3',
		role: 'user',
		status: 'complete',
		at: t(2),
		parts: [
			{
				kind: 'text',
				id: 't3-p1',
				text: 'Now restyle the tool and terminal rows so they read like the TUI, and show me how the graph status chip behaves while a node is running.'
			}
		]
	},
	{
		id: 't4',
		role: 'assistant',
		status: 'streaming',
		at: t(1),
		model: 'Kimi K2 Turbo',
		effort: 'high',
		parts: [
			{
				kind: 'reasoning',
				id: 't4-p1',
				status: 'running',
				text: 'The TUI colors tool rows with accent_tool (a dim gray) and terminals with the command color. The AI Elements Trace already has status semantics — running, error, pending — so the accents should ride those rather than adding a parallel vocabulary. For the graph chip, the pager derives it from GraphUpdated, so the web chip should do the same: one state source, two renderers.'
			},
			{
				kind: 'plan',
				id: 't4-p2',
				title: 'Restyle pass',
				steps: [
					{ id: 'r1', title: 'Map Trace statuses onto TUI accents', status: 'running' },
					{ id: 'r2', title: 'Give terminal output the code surface', status: 'pending' },
					{ id: 'r3', title: 'Drive the graph chip from graph state', status: 'pending' }
				]
			},
			{
				kind: 'tool',
				id: 't4-p3',
				name: 'grep',
				summary: 'accent_tool in alnair-pager-render',
				status: 'running',
				input: 'pattern: accent_tool'
			}
		]
	}
];

export const suggestions = [
	'Explain the graph planner contract',
	'Add a cancel button to the composer',
	'Show the diff of the last checkpoint',
	'Why is gn-verify still pending?'
];

/** The agent's todo list for the running turn. */
export const todos: TodoItem[] = [
	{
		id: 'td1',
		title: 'Read the pager theme module',
		status: 'complete',
		detail: 'alnair-pager-render/src/theme/'
	},
	{
		id: 'td2',
		title: 'Restyle tool rows on Trace statuses',
		status: 'running',
		detail: 'map pending / running / error'
	},
	{
		id: 'td3',
		title: 'Give terminal output the code surface',
		status: 'pending'
	},
	{
		id: 'td4',
		title: 'Drive the graph chip from graph state',
		status: 'pending'
	}
];

const PLAN_MARKDOWN = `# Restyle pass

The TUI already has a colour vocabulary for every step; the web UI should reuse
it rather than invent a second one.

## Steps

1. Map \`Trace\` statuses onto the TUI accents
   - \`running\` → \`accent_running\`
   - \`error\` → \`accent_error\`
   - resting → \`accent_tool\`
2. Give terminal output the code surface
3. Drive the graph chip from graph state

## Constraint

> One state source, two renderers. The chip and the inspector panel must read the
> same \`GraphState\` — never a second copy of the status.

\`\`\`ts
const achieved = graph.nodes.filter((n) => n.status === 'achieved').length;
\`\`\`

| Status    | Accent        |
| --------- | ------------- |
| running   | \`running\`     |
| error     | \`error\`       |
| achieved  | \`success\`     |
`;

/** The plan document the agent wrote for the current objective. */
export const planDocument: PlanDocument = {
	title: 'Restyle pass',
	path: '.alnair/plans/restyle-pass.md',
	updatedAt: t(3),
	markdown: PLAN_MARKDOWN
};
