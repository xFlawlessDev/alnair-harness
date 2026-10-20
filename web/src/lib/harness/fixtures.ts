/**
 * Scripted wire transcripts.
 *
 * Every entry here is what the agent actually puts on the connection, in
 * order: `session/update` and `_alnair/session/update` notifications, then the
 * `session/prompt` response that closes the turn. The mock transport replays
 * them verbatim, so the reducer is exercised by the real shapes rather than by
 * hand-built view models.
 *
 * Shapes come from `agent-client-protocol-schema` 0.11.4 and
 * `alnair-shell/src/extensions/notification.rs`. When a fixture and the Rust
 * side disagree, the Rust side wins and the fixture is the bug.
 */

import type {
	ContentBlock,
	JsonRpcNotification,
	StopReason,
	ToolCallStatus,
	ToolKind
} from './types/acp.js';

/** One scripted frame. `delay` is milliseconds from the previous frame. */
export interface WireStep {
	delay: number;
	method: string;
	params: Record<string, unknown>;
}

export interface ScriptedTurn {
	/** The text the user sends; `send()` emits the prompt with it. */
	prompt: string;
	stopReason: StopReason;
	steps: WireStep[];
}

/* ------------------------------------------------------------- constructors */

const SESSION_UPDATE = 'session/update';
const EXT_UPDATE = '_alnair/session/update';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });

const base = (sessionId: string) => ({ session_id: sessionId });

/** A `session/update` carrying one ACP update. */
export function acpUpdate(sessionId: string, update: Record<string, unknown>, delay = 0): WireStep {
	return {
		delay,
		method: SESSION_UPDATE,
		params: { sessionId, update }
	};
}

/** An `_alnair/session/update` carrying one Alnair update. */
export function extUpdate(sessionId: string, update: Record<string, unknown>, delay = 0): WireStep {
	return {
		delay,
		method: EXT_UPDATE,
		params: { ...base(sessionId), update }
	};
}

export const agentChunk = (sessionId: string, value: string, delay = 0) =>
	acpUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: text(value) }, delay);

export const thoughtChunk = (sessionId: string, value: string, delay = 0) =>
	acpUpdate(sessionId, { sessionUpdate: 'agent_thought_chunk', content: text(value) }, delay);

export const userChunk = (sessionId: string, value: string, delay = 0) =>
	acpUpdate(sessionId, { sessionUpdate: 'user_message_chunk', content: text(value) }, delay);

export interface ToolCallInit {
	toolCallId: string;
	title: string;
	kind: ToolKind;
	status?: ToolCallStatus;
	locations?: { path: string; line?: number }[];
	rawInput?: unknown;
	content?: Record<string, unknown>[];
	_meta?: Record<string, unknown>;
}

export function toolCall(sessionId: string, init: ToolCallInit, delay = 0): WireStep {
	return acpUpdate(
		sessionId,
		{
			sessionUpdate: 'tool_call',
			toolCallId: init.toolCallId,
			title: init.title,
			kind: init.kind,
			status: init.status ?? 'pending',
			...(init.locations ? { locations: init.locations } : {}),
			...(init.rawInput !== undefined ? { rawInput: init.rawInput } : {}),
			...(init.content ? { content: init.content } : {}),
			...(init._meta ? { _meta: init._meta } : {})
		},
		delay
	);
}

export const toolUpdate = (
	sessionId: string,
	toolCallId: string,
	fields: Record<string, unknown>,
	delay = 0
): WireStep =>
	acpUpdate(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, ...fields }, delay);

/** A finished tool: the status plus whatever content the agent produced. */
export const toolDone = (
	sessionId: string,
	toolCallId: string,
	content: Record<string, unknown>[],
	status: ToolCallStatus = 'completed',
	delay = 0
): WireStep => toolUpdate(sessionId, toolCallId, { status, content }, delay);

export const textResult = (value: string) => ({ type: 'content', content: text(value) });

export const diffResult = (path: string, oldText: string | undefined, newText: string) => ({
	type: 'diff',
	path,
	...(oldText !== undefined ? { oldText } : {}),
	newText
});

export const planUpdate = (
	sessionId: string,
	entries: { content: string; priority: 'high' | 'medium' | 'low'; status: string }[],
	delay = 0
): WireStep => acpUpdate(sessionId, { sessionUpdate: 'plan', entries }, delay);

export const commandsUpdate = (
	sessionId: string,
	commands: { name: string; description: string; input?: { hint: string } }[],
	delay = 0
): WireStep =>
	acpUpdate(
		sessionId,
		{ sessionUpdate: 'available_commands_update', availableCommands: commands },
		delay
	);

/* ------------------------------------------------------------------- turns */

const S = 's-graph';

/**
 * The artifact an `alnair/exit_plan_mode` request carries. Markdown, because
 * that is what the agent writes and what the popover renders.
 */
export const PLAN_MARKDOWN = `# Restyle pass

The TUI already has a colour vocabulary for every step; the web UI should reuse
it rather than invent a second one.

## Steps

1. Map \`Trace\` statuses onto the TUI accents
2. Give terminal output the code surface
3. Drive the graph chip from graph state

## Constraint

> One state source, two renderers. The chip and the inspector panel read the
> same \`graph_updated\` payload — never a second copy of the status.

\`\`\`ts
const achieved = graph.achieved;
const total = graph.total;
\`\`\`

| Status    | Accent        |
| --------- | ------------- |
| running   | \`running\`     |
| error     | \`error\`       |
| achieved  | \`success\`     |
`;

const FOUNDATION_TEXT = `The foundation is in place. Every component reads the view model, and the seam to the harness is a single store.

**What landed**
- \`web/src/lib/harness/types/\` — the ACP wire and Alnair's extensions, transcribed from the Rust schema.
- A reducer that folds wire updates into the view model.
- Fixtures that replay real transcripts, so the mock exercises the same path the socket will.

Next: point the transport at \`alnair agent serve\` and delete the fixtures.`;

/**
 * The showcase turn: reasoning, a plan, a bash call that backgrounds, four file
 * tools (read text, read image, edit, write), a subagent, and a checkpoint.
 */
export const foundationTurn: ScriptedTurn = {
	prompt:
		'Build the web harness foundation. SvelteKit + shadcn-svelte AI Elements, mocked data only — no harness wiring yet.',
	stopReason: 'end_turn',
	steps: [
		userChunk(
			S,
			'Build the web harness foundation. SvelteKit + shadcn-svelte AI Elements, mocked data only — no harness wiring yet.'
		),
		thoughtChunk(
			S,
			'The harness already speaks ACP, so the UI should render a view model rather than wire types — otherwise every protocol bump rewrites components. ',
			420
		),
		thoughtChunk(
			S,
			"I'll transcribe the wire first, then fold it through one reducer, then point the mock at real transcripts.",
			380
		),
		planUpdate(
			S,
			[
				{
					content: 'Transcribe the ACP wire and Alnair extensions',
					priority: 'high',
					status: 'completed'
				},
				{
					content: 'Fold wire updates into the view model',
					priority: 'high',
					status: 'in_progress'
				},
				{ content: 'Replay real transcripts in the mock', priority: 'medium', status: 'pending' },
				{ content: 'Point the transport at agent serve', priority: 'medium', status: 'pending' }
			],
			240
		),
		toolCall(
			S,
			{
				toolCallId: 'call_scaffold',
				title: 'Execute `npx sv create web`',
				kind: 'execute',
				status: 'in_progress',
				rawInput: {
					command: 'npx sv create web --template minimal --types ts --add tailwindcss',
					description: 'Scaffold the SvelteKit app'
				}
			},
			300
		),
		toolDone(
			S,
			'call_scaffold',
			[
				textResult(`Welcome to the Svelte CLI!

Project created
Successfully setup add-ons: tailwindcss, prettier, eslint

You're all set!`)
			],
			'completed',
			1_800
		),
		toolCall(
			S,
			{
				toolCallId: 'call_read',
				title: 'Read `web/src/lib/harness/types/acp.ts`',
				kind: 'read',
				status: 'in_progress',
				locations: [{ path: 'web/src/lib/harness/types/acp.ts', line: 1 }],
				rawInput: { path: 'web/src/lib/harness/types/acp.ts' }
			},
			260
		),
		toolDone(
			S,
			'call_read',
			[
				textResult(`export interface TextContent {
	type: 'text';
	text: string;
	annotations?: Annotations;
	_meta?: Record<string, unknown>;
}

export interface ImageContent {
	type: 'image';
	/** Base64, no \`data:\` prefix. */
	data: string;
	mimeType: string;
	uri?: string;
}`)
			],
			'completed',
			140
		),
		toolCall(
			S,
			{
				toolCallId: 'call_image',
				title: 'Read `web/static/mock/graph-dag.png`',
				kind: 'read',
				status: 'in_progress',
				locations: [{ path: 'web/static/mock/graph-dag.png' }],
				rawInput: { path: 'web/static/mock/graph-dag.png' }
			},
			220
		),
		toolDone(
			S,
			'call_image',
			[
				{
					type: 'content',
					content: {
						type: 'image',
						data: '__FIXTURE_IMAGE_DATA__',
						mimeType: 'image/png',
						uri: 'web/static/mock/graph-dag.png',
						_meta: { width: 720, height: 400, bytes: 17_170 }
					}
				}
			],
			'completed',
			210
		),
		toolCall(
			S,
			{
				toolCallId: 'call_edit',
				title: 'Edit `web/src/lib/harness/session-store.svelte.ts`',
				kind: 'edit',
				status: 'in_progress',
				locations: [{ path: 'web/src/lib/harness/session-store.svelte.ts' }],
				rawInput: {
					file_path: 'web/src/lib/harness/session-store.svelte.ts',
					old_string: '\treadonly turns: Turn[];',
					new_string:
						'\treadonly turns: Turn[];\n\treadonly todos: TodoItem[];\n\treadonly plan: PlanDocument | null;'
				},
				_meta: { old_line: 3, new_line: 3 }
			},
			300
		),
		toolDone(
			S,
			'call_edit',
			[
				diffResult(
					'web/src/lib/harness/session-store.svelte.ts',
					`export interface SessionStore {
	readonly workspace: WorkspaceInfo;
	readonly turns: Turn[];
	readonly busy: boolean;
}`,
					`export interface SessionStore {
	readonly workspace: WorkspaceInfo;
	readonly turns: Turn[];
	readonly todos: TodoItem[];
	readonly plan: PlanArtifact | null;
}`
				)
			],
			'completed',
			260
		),
		toolCall(
			S,
			{
				toolCallId: 'call_write',
				title: 'Write `web/src/lib/harness/fixtures.ts`',
				kind: 'edit',
				status: 'in_progress',
				locations: [{ path: 'web/src/lib/harness/fixtures.ts' }],
				rawInput: { file_path: 'web/src/lib/harness/fixtures.ts' }
			},
			200
		),
		toolDone(
			S,
			'call_write',
			[
				diffResult(
					'web/src/lib/harness/fixtures.ts',
					undefined,
					`import type { WireStep } from './types/acp.js';

/** Replayed verbatim by the mock transport. */
export const steps: WireStep[] = [];
`
				)
			],
			'completed',
			180
		),
		extUpdate(
			S,
			{
				sessionUpdate: 'subagent_spawned',
				subagent_id: 'sub-1',
				parent_session_id: S,
				child_session_id: 's-graph-sub-1',
				subagent_type: 'explore',
				description: 'Audit the TUI palette for web-safe accents',
				effective_context_source: 'new',
				model: 'kimi-k2-turbo-preview'
			},
			300
		),
		extUpdate(
			S,
			{
				sessionUpdate: 'subagent_progress',
				subagent_id: 'sub-1',
				parent_session_id: S,
				child_session_id: 's-graph-sub-1',
				duration_ms: 4_200,
				turn_count: 2,
				tool_call_count: 3,
				tokens_used: 18_400,
				context_window_tokens: 262_144,
				context_usage_pct: 7,
				tools_used: ['read_file', 'grep'],
				error_count: 0
			},
			1_400
		),
		extUpdate(
			S,
			{
				sessionUpdate: 'subagent_finished',
				subagent_id: 'sub-1',
				child_session_id: 's-graph-sub-1',
				status: 'completed',
				tool_calls: 3,
				turns: 2,
				duration_ms: 6_100,
				tokens_used: 21_900,
				output:
					'Night accents are TokyoNight Night; day accents are the same hues deepened. Keep the theme accents for turn semantics and the site palette for chrome.',
				will_wake: false
			},
			900
		),
		extUpdate(
			S,
			{
				sessionUpdate: 'graph_updated',
				graph_id: 'g-2026-10-20-web-harness',
				objective:
					'Build the web UI foundation on shadcn-svelte AI Elements with mocked harness data',
				status: 'active',
				phase: 'executing',
				plan_version: 2,
				total_nodes: 7,
				achieved_nodes: 2,
				failed_nodes: 0,
				running_nodes: 1,
				current_node: 'gn-thread',
				current_node_title: 'Build the turn thread',
				token_budget: 900_000,
				tokens_spent: 184_320,
				last_event: 'gn-thread round 1 started'
			},
			400
		),
		/**
		 * `alnair/exit_plan_mode` is a reverse request, not a notification: the
		 * agent blocks on it while the user reviews the artifact. The store
		 * surfaces it in the header and answers it; the transcript never sees it.
		 */
		{
			delay: 200,
			method: 'alnair/exit_plan_mode',
			params: {
				sessionId: S,
				toolCallId: 'call_exit_plan',
				planContent: PLAN_MARKDOWN
			}
		},
		planUpdate(
			S,
			[
				{
					content: 'Transcribe the ACP wire and Alnair extensions',
					priority: 'high',
					status: 'completed'
				},
				{ content: 'Fold wire updates into the view model', priority: 'high', status: 'completed' },
				{ content: 'Replay real transcripts in the mock', priority: 'medium', status: 'completed' },
				{ content: 'Point the transport at agent serve', priority: 'medium', status: 'pending' }
			],
			300
		),
		agentChunk(S, FOUNDATION_TEXT, 420),
		extUpdate(
			S,
			{
				sessionUpdate: 'turn_completed',
				prompt_id: 'p-1',
				stop_reason: 'end_turn',
				usage: {
					totals: { input_tokens: 41_200, output_tokens: 2_180, cached_read_tokens: 12_000 }
				}
			},
			120
		)
	]
};

/**
 * A permission prompt: the agent blocks mid-turn until the user answers.
 * The `pending_interaction` frame is what makes the header show "needs input".
 */
export const permissionTurn: ScriptedTurn = {
	prompt: 'Rewrite the terminal setup guide so it covers Windows Terminal and VTE.',
	stopReason: 'end_turn',
	steps: [
		userChunk(S, 'Rewrite the terminal setup guide so it covers Windows Terminal and VTE.'),
		thoughtChunk(
			S,
			'The guide lives under the user-guide tree. Reading it first, then editing in place.',
			320
		),
		toolCall(
			S,
			{
				toolCallId: 'call_guide',
				title: 'Read `docs/user-guide/18-terminal-setup.md`',
				kind: 'read',
				status: 'completed',
				locations: [{ path: 'docs/user-guide/18-terminal-setup.md' }],
				content: [textResult('...')]
			},
			260
		),
		toolCall(
			S,
			{
				toolCallId: 'call_patch',
				title: 'Edit `docs/user-guide/18-terminal-setup.md`',
				kind: 'edit',
				status: 'pending',
				locations: [{ path: 'docs/user-guide/18-terminal-setup.md' }],
				rawInput: { file_path: 'docs/user-guide/18-terminal-setup.md' }
			},
			0
		),
		// The agent announces the call, then parks on the permission request.
		extUpdate(
			S,
			{ sessionUpdate: 'pending_interaction', tool_call_id: 'call_patch', kind: 'permission' },
			220
		),
		// The client answers here; the transport resumes the script.
		extUpdate(S, { sessionUpdate: 'interaction_resolved', tool_call_id: 'call_patch' }, 900),
		toolDone(
			S,
			'call_patch',
			[
				diffResult(
					'docs/user-guide/18-terminal-setup.md',
					'# Terminal setup\n\nOnly xterm.js is covered here.',
					'# Terminal setup\n\nCovered: Windows Terminal, VTE (GNOME, Tilix), xterm.js.\nShift+Enter needs a terminal that reports the modifier; the table below says which do.'
				)
			],
			'completed',
			400
		),
		agentChunk(S, 'Rewrote the guide and added the modifier table.', 360),
		extUpdate(
			S,
			{ sessionUpdate: 'turn_completed', prompt_id: 'p-2', stop_reason: 'end_turn' },
			120
		)
	]
};

/**
 * A cancelled turn: the user stops the run. The agent emits no further text,
 * and the prompt response carries `cancelled` rather than `end_turn`.
 */
export const cancelledTurn: ScriptedTurn = {
	prompt: 'Run the whole workspace test suite and fix whatever fails.',
	stopReason: 'cancelled',
	steps: [
		userChunk(S, 'Run the whole workspace test suite and fix whatever fails.'),
		thoughtChunk(
			S,
			'Cargo test across the workspace takes a while; start it in the background and watch.',
			300
		),
		toolCall(
			S,
			{
				toolCallId: 'call_test',
				title: 'Execute `cargo test --workspace`',
				kind: 'execute',
				status: 'in_progress',
				rawInput: { command: 'cargo test --workspace' }
			},
			240
		),
		extUpdate(
			S,
			{
				sessionUpdate: 'task_backgrounded',
				tool_call_id: 'call_test',
				task_id: 'task-91',
				command: 'cargo test --workspace',
				cwd: '/home/dev/alnair-cli',
				output_file: '/home/dev/.alnair/tasks/task-91.log',
				description: 'Run the workspace test suite'
			},
			1_200
		),
		extUpdate(
			S,
			{
				sessionUpdate: 'monitor_event',
				task_id: 'task-91',
				description: 'cargo test',
				event_text: '   Compiling alnair-shell v0.1.20'
			},
			700
		),
		toolUpdate(S, 'call_test', { status: 'failed' }, 500),
		extUpdate(
			S,
			{
				sessionUpdate: 'retry_state',
				type: 'exhausted',
				attempts: 2,
				reason: 'the run was cancelled by the user',
				is_rate_limited: false
			},
			160
		)
	]
};

/**
 * A questionnaire: the agent asks before committing to an approach. The
 * reverse request is not a transcript update, so the store renders it from the
 * live frame while the script waits for the answer.
 */
export const questionTurn: ScriptedTurn = {
	prompt: 'Which terminals should the setup guide cover?',
	stopReason: 'end_turn',
	steps: [
		userChunk(S, 'Which terminals should the setup guide cover?'),
		thoughtChunk(
			S,
			'The answer changes the shape of the guide, so ask before writing rather than guessing.',
			320
		),
		toolCall(
			S,
			{
				toolCallId: 'call_ask',
				title: 'Ask the user which terminals to cover',
				kind: 'think',
				status: 'pending'
			},
			240
		),
		{
			delay: 220,
			method: 'alnair/ask_user_question',
			params: {
				sessionId: S,
				toolCallId: 'call_ask',
				mode: 'default',
				questions: [
					{
						question: 'Which terminals should the guide cover first?',
						multiSelect: true,
						options: [
							{
								label: 'Windows Terminal',
								description: 'Ships Shift+Enter natively through the console key record.'
							},
							{
								label: 'VTE',
								description: 'GNOME Terminal, Tilix, and friends. No modifier on the wire.'
							},
							{
								label: 'xterm.js',
								description: 'The browser embed; reports the modifier over the protocol.'
							},
							{
								label: 'Apple Terminal',
								description: 'Needs the CoreGraphics poll to recover Shift+Enter.'
							}
						]
					},
					{
						question: 'Should the guide include a per-terminal troubleshooting table?',
						multiSelect: false,
						options: [
							{
								label: 'Yes, include it',
								description: 'One row per terminal with the chord that actually arrives.',
								preview: '| Terminal | Shift+Enter |\n| --- | --- |\n| Windows Terminal | yes |'
							},
							{
								label: 'No, keep it short',
								description: 'A paragraph and the setup steps only.'
							}
						]
					}
				]
			}
		},
		extUpdate(S, { sessionUpdate: 'interaction_resolved', tool_call_id: 'call_ask' }, 900),
		toolUpdate(S, 'call_ask', { status: 'completed' }, 200),
		agentChunk(S, 'Covered Windows Terminal, VTE, and xterm.js, with the table.', 360),
		extUpdate(
			S,
			{ sessionUpdate: 'turn_completed', prompt_id: 'p-3', stop_reason: 'end_turn' },
			120
		)
	]
};

/**
 * A plan-mode questionnaire: the same request, plus the two interview exits.
 */
export const planQuestionTurn: ScriptedTurn = {
	prompt: 'Ask me what the restyle should cover.',
	stopReason: 'end_turn',
	steps: [
		userChunk(S, 'Ask me what the restyle should cover.'),
		thoughtChunk(S, 'Plan mode: ask what to include before writing the plan file.', 300),
		toolCall(
			S,
			{
				toolCallId: 'call_ask_plan',
				title: 'Ask what the restyle should cover',
				kind: 'think',
				status: 'pending'
			},
			220
		),
		{
			delay: 200,
			method: 'alnair/ask_user_question',
			params: {
				sessionId: S,
				toolCallId: 'call_ask_plan',
				mode: 'plan',
				questions: [
					{
						question: 'Which surfaces should the restyle touch?',
						multiSelect: true,
						options: [
							{ label: 'Tool rows', description: 'Accent and spacing on the trace lines.' },
							{ label: 'Composer', description: 'Input group, model picker, send button.' },
							{ label: 'Inspector', description: 'Graph panel and file list.' }
						]
					}
				]
			}
		},
		extUpdate(S, { sessionUpdate: 'interaction_resolved', tool_call_id: 'call_ask_plan' }, 800),
		toolUpdate(S, 'call_ask_plan', { status: 'completed' }, 200),
		extUpdate(
			S,
			{ sessionUpdate: 'turn_completed', prompt_id: 'p-6', stop_reason: 'end_turn' },
			120
		)
	]
};

/**
 * A provider failure: retries, then a terminal error. The agent never sends
 * `turn_completed`, so the UI must close the turn from the prompt response.
 */
export const failedTurn: ScriptedTurn = {
	prompt: 'Summarize the last 40 commits.',
	stopReason: 'end_turn',
	steps: [
		userChunk(S, 'Summarize the last 40 commits.'),
		extUpdate(
			S,
			{
				sessionUpdate: 'retry_state',
				type: 'retrying',
				attempt: 1,
				max_retries: 3,
				reason: 'HTTP 502 from the sampler'
			},
			300
		),
		extUpdate(
			S,
			{
				sessionUpdate: 'retry_state',
				type: 'retrying',
				attempt: 2,
				max_retries: 3,
				reason: 'HTTP 502 from the sampler'
			},
			900
		),
		extUpdate(
			S,
			{
				sessionUpdate: 'retry_state',
				type: 'failed',
				error_type: 'server',
				message: 'The sampler answered 502 three times; the turn was abandoned.'
			},
			1_400
		)
	]
};

/**
 * Compaction: the context window filled, so the agent summarized and carried on.
 */
export const compactionTurn: ScriptedTurn = {
	prompt: 'Keep going — the context is getting full.',
	stopReason: 'end_turn',
	steps: [
		userChunk(S, 'Keep going — the context is getting full.'),
		extUpdate(
			S,
			{
				sessionUpdate: 'auto_compact_started',
				tokens_used: 214_000,
				context_window: 262_144,
				percentage: 82,
				reason: 'context window above 80%'
			},
			260
		),
		extUpdate(
			S,
			{
				sessionUpdate: 'auto_compact_completed',
				tokens_before: 214_000,
				tokens_after: 61_000,
				elapsed_ms: 8_400,
				summary_preview: 'Compacted the wire transcription and the reducer discussion.'
			},
			2_400
		),
		agentChunk(S, 'Compacted the transcript and resumed from the summary.', 400),
		extUpdate(
			S,
			{ sessionUpdate: 'turn_completed', prompt_id: 'p-4', stop_reason: 'end_turn' },
			120
		)
	]
};

/** Every scripted turn, in the order the fixture session replays them. */
export const scriptedTurns: ScriptedTurn[] = [
	foundationTurn,
	permissionTurn,
	questionTurn,
	planQuestionTurn,
	cancelledTurn,
	failedTurn,
	compactionTurn
];

/** The canned reply `send()` uses for a prompt that has no script. */
export const fallbackTurn: ScriptedTurn = {
	prompt: '',
	stopReason: 'end_turn',
	steps: [
		thoughtChunk(S, 'No script for this prompt, so this is the fixture fallback.', 240),
		agentChunk(
			S,
			'This is fixture data. The transport has no script for that prompt, so it answered with the fallback turn. Point `ALNAIR_WEB_TRANSPORT=ws` at `alnair agent serve` to reach a real agent.',
			320
		)
	]
};

/* ------------------------------------------------------------------- helpers */

/** Pick the scripted turn for a prompt, falling back when none matches. */
export function turnForPrompt(prompt: string): ScriptedTurn {
	const needle = prompt.trim().toLowerCase();
	const match = scriptedTurns.find((turn) => turn.prompt.toLowerCase() === needle);
	return match ?? fallbackTurn;
}

/** A notification frame, shaped as it arrives on the socket. */
export function toNotification(step: WireStep): JsonRpcNotification {
	return { jsonrpc: '2.0', method: step.method, params: step.params };
}

/** The tool call ids a scripted turn leaves pending, for permission answers. */
export function pendingToolCallId(turn: ScriptedTurn): string | undefined {
	const pending = turn.steps.find(
		(step) =>
			(step.params.update as { sessionUpdate?: string })?.sessionUpdate === 'pending_interaction'
	);
	return (pending?.params.update as { tool_call_id?: string })?.tool_call_id;
}
