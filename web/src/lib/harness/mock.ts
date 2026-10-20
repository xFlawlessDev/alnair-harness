/**
 * Fixture data for the harness, all of it derived from wire shapes.
 *
 * The transcripts are replayed through the same reducer the socket will use,
 * so what the UI shows here is what it will show against a real agent — minus
 * the agent. `session/list` rows are `AlnairSessionRow` objects, and the model
 * catalog mirrors the registry keys the picker receives.
 */

import {
	cancelledTurn,
	foundationTurn,
	permissionTurn,
	planQuestionTurn,
	questionTurn,
	PLAN_MARKDOWN,
	agentChunk,
	extUpdate,
	textResult,
	thoughtChunk,
	toolCall,
	toolDone,
	userChunk
} from './fixtures.js';
import type { ScriptedTurn, WireStep } from './fixtures.js';
import type { TranscriptEnvelope } from './types/acp.js';
import {
	closeTurn,
	emptyAcc,
	openUserTurn,
	questionFromRequest,
	reduceAcpUpdate,
	reduceExtUpdate
} from './reducer.js';
import type { Acc } from './reducer.js';
import type { ExtSessionUpdate } from './types/ext.js';
import type { AskUserQuestionRequest } from './types/ext.js';
import type { SessionUpdate } from './types/acp.js';
import type { AlnairSessionRow } from './types/ext.js';
import type {
	ContextUsage,
	FileEntry,
	ModelOption,
	PlanArtifact,
	Session,
	SlashCommand,
	SubagentSummary,
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

/**
 * Rows as `alnair/session/list` returns them. `summary` is the title the agent
 * generated; `numMessages` and the timestamps are what the list actually
 * carries.
 */
export const sessionRows: AlnairSessionRow[] = [
	{
		sessionId: 's-graph',
		summary: 'Web harness foundation',
		firstPrompt: 'Build the web harness foundation.',
		createdAt: t(96),
		updatedAt: t(1),
		cwd: '~/dev/alnair-cli',
		source: 'local',
		modelId: 'kimi-code/kimi-k2-turbo-preview',
		numMessages: 8,
		branch: 'feat/web-harness',
		repoName: 'alnair-cli',
		sessionKind: 'build',
		_meta: { 'alnair/session': { kind: 'build', facets: {} } }
	},
	{
		sessionId: 's-auth',
		summary: 'Terminal setup guide',
		firstPrompt: 'Which terminals should the setup guide cover?',
		createdAt: t(2_880),
		updatedAt: t(32),
		cwd: '~/dev/alnair-docs',
		source: 'local',
		modelId: 'kimi-code/kimi-k2-turbo-preview',
		numMessages: 4,
		branch: 'docs/terminal-setup',
		repoName: 'alnair-docs',
		sessionKind: 'build',
		_meta: { 'alnair/session': { kind: 'build', facets: {} } }
	},
	{
		sessionId: 's-mcp',
		summary: 'Streamable HTTP cancel path',
		firstPrompt: 'The cancel never reaches the MCP server.',
		createdAt: t(4_320),
		updatedAt: t(1_320),
		cwd: '~/dev/alnair-cli',
		source: 'both',
		modelId: 'openai-codex/gpt-6-astra',
		numMessages: 41,
		branch: 'fix/mcp-cancel',
		repoName: 'alnair-cli',
		sessionKind: 'build',
		_meta: { 'alnair/session': { kind: 'build', facets: {} } }
	},
	{
		sessionId: 's-docs',
		summary: 'Restyle scope interview',
		firstPrompt: 'Ask me what the restyle should cover.',
		createdAt: t(5_760),
		updatedAt: t(48),
		cwd: '~/dev/alnair-cli',
		source: 'local',
		modelId: 'kimi-code/kimi-k2-turbo-preview',
		numMessages: 2,
		branch: 'feat/web-harness',
		repoName: 'alnair-cli',
		sessionKind: 'build',
		_meta: { 'alnair/session': { kind: 'build', facets: {} } }
	},
	{
		sessionId: 's-perf',
		summary: 'PTY baseline for 120×40',
		firstPrompt: 'Measure the PTY at 120x40.',
		createdAt: t(8_640),
		updatedAt: t(4_140),
		cwd: '~/dev/alnair-cli',
		source: 'local',
		modelId: 'xai-grok/grok-4-fast',
		numMessages: 17,
		branch: 'perf/pty-baseline',
		repoName: 'alnair-cli',
		sessionKind: 'build',
		_meta: { 'alnair/session': { kind: 'build', facets: {} } }
	},
	{
		// A second repo, so the sidebar has more than one workspace to nest.
		sessionId: 's-site',
		summary: 'Landing page hero copy',
		firstPrompt: 'Tighten the hero copy on the landing page.',
		createdAt: t(11_520),
		updatedAt: t(240),
		cwd: '~/dev/alnair-site',
		source: 'local',
		modelId: 'claude-pro-max/claude-sonnet-4-5',
		numMessages: 12,
		branch: 'main',
		repoName: 'alnair-site',
		gitRootDir: '~/dev/alnair-site',
		sessionKind: 'build',
		_meta: { 'alnair/session': { kind: 'build', facets: {} } }
	},
	{
		// The same repo as the first four: one group, several conversations.
		sessionId: 's-ci',
		summary: 'Release workflow tag gate',
		firstPrompt: 'Why does the v* tag gate fail on a dirty tree?',
		createdAt: t(14_400),
		updatedAt: t(600),
		cwd: '~/dev/alnair-cli',
		source: 'both',
		modelId: 'kimi-code/kimi-k2-turbo-preview',
		numMessages: 9,
		branch: 'ci/tag-gate',
		repoName: 'alnair-cli',
		sessionKind: 'build',
		_meta: { 'alnair/session': { kind: 'build', facets: {} } }
	}
];

/** Project a wire row onto the view model. */
export function toSession(row: AlnairSessionRow, status: Session['status'] = 'idle'): Session {
	return {
		id: row.sessionId,
		title: row.summary,
		cwd: row.cwd,
		branch: row.branch,
		modelId: row.modelId,
		source: row.source,
		numMessages: row.numMessages,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		kind: row._meta?.['alnair/session']?.kind ?? row.sessionKind,
		// `repoName` is what the agent derives from the cwd; the group key.
		workspace: row.repoName ?? lastSegment(row.cwd),
		gitRootDir: row.gitRootDir,
		status
	};
}

const lastSegment = (path: string): string => {
	const trimmed = path.replace(/[\\/]+$/, '');
	const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	return index === -1 ? trimmed : trimmed.slice(index + 1);
};

export const sessions: Session[] = sessionRows.map((row) =>
	toSession(row, row.sessionId === 's-graph' ? 'attention' : 'idle')
);

/**
 * The catalog as the picker receives it: `<platform>/<model>`, with the
 * efforts each model accepts. Context windows come from the wire.
 */
export const models: ModelOption[] = [
	{
		id: 'kimi-code/kimi-k2-turbo-preview',
		label: 'Kimi K2 Turbo',
		provider: 'Kimi Code',
		efforts: ['none', 'low', 'medium', 'high', 'max'],
		contextWindow: 262_144
	},
	{
		id: 'claude-pro-max/claude-sonnet-4-5',
		label: 'Claude Sonnet 4.5',
		provider: 'Claude Pro/Max',
		efforts: ['low', 'medium', 'high'],
		contextWindow: 200_000
	},
	{
		id: 'openai-codex/gpt-6-astra',
		label: 'GPT-6 Astra',
		provider: 'ChatGPT',
		efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
		contextWindow: 272_000
	},
	{
		id: 'xai-grok/grok-4-fast',
		label: 'Grok 4 Fast',
		provider: 'xAI',
		efforts: ['low', 'high'],
		contextWindow: 131_072
	}
];

/**
 * The context snapshot as `alnair/session/info` returns it: exact totals, the
 * system prompt and tool-definition figures, an estimate for the conversation,
 * and the resolved auto-compact threshold.
 */
export const contextUsage: ContextUsage = {
	used: 61_440,
	limit: 262_144,
	percent: 23,
	systemPromptTokens: 4_200,
	toolDefinitionsTokens: 12_800,
	toolDefinitionsCount: 18,
	messageTokens: 40_300,
	messageCount: 96,
	turnCount: 7,
	toolCallCount: 34,
	compactionCount: 0,
	freeTokens: 200_704,
	autoCompactThresholdPercent: 85,
	categories: [
		{ label: 'Skills', tokens: 2_900, detail: '12 skills' },
		{ label: 'MCP servers', tokens: 1_240, detail: '2 servers' }
	]
};

/* ------------------------------------------------------------ transcripts */

/**
 * Fold one scripted turn onto an accumulator.
 *
 * Each turn is closed before the next one starts: a scripted turn that ends
 * without a `turn_completed` frame (the parked one) would otherwise keep its
 * assistant turn open, and the following turn's parts would land inside it.
 */
function foldTurn(acc: Acc, turn: { prompt: string; steps: WireStep[] }, at: number): Acc {
	let next = openUserTurn(acc, turn.prompt, at, 'kimi-code/kimi-k2-turbo-preview', 'high');
	let clock = at;
	for (const step of turn.steps) {
		clock += step.delay;
		const update = (step.params as { update?: Record<string, unknown> }).update;
		// Reverse requests (`alnair/exit_plan_mode`) are not transcript updates;
		// the store handles them from the live frame, so a replay skips them.
		if (!update) continue;
		const ctx = { now: clock, sessionId: 's-graph' };
		next =
			step.method === '_alnair/session/update'
				? reduceExtUpdate(next, update as ExtSessionUpdate, ctx)
				: reduceAcpUpdate(next, update as SessionUpdate, ctx);
	}
	if (next.openTurnId !== undefined) {
		next = closeTurn(next, 'complete', undefined, clock);
	}
	return next;
}

/**
 * The showcase transcript: a completed foundation turn, a cancelled run, then a
 * turn parked on a permission request. That covers the three states the header
 * and the thread have to distinguish.
 */
export function initialTranscript(): Acc {
	let acc = emptyAcc();
	acc = foldTurn(acc, foundationTurn, Date.parse(t(14)));
	acc = foldTurn(acc, cancelledTurn, Date.parse(t(6)));
	// Park the last turn on its permission request: drop the frames after it.
	const parked = permissionTurn.steps.slice(
		0,
		permissionTurn.steps.findIndex(
			(step) =>
				(step.params.update as { sessionUpdate?: string }).sessionUpdate === 'pending_interaction'
		) + 1
	);
	acc = foldTurn(acc, { prompt: permissionTurn.prompt, steps: parked }, Date.parse(t(1)));
	return acc;
}

/**
 * The plan artifact the agent asked to have approved. It is a reverse request,
 * so it is not part of the transcript and lives beside it in the store.
 */
export const initialPlan: PlanArtifact = {
	title: 'Restyle pass',
	path: '.alnair/plans/restyle-pass.md',
	updatedAt: t(3),
	markdown: PLAN_MARKDOWN
};

/** The frames up to and including a parked question, for a given turn. */
export function parkedSteps(turn: ScriptedTurn): WireStep[] {
	return turn.steps.slice(
		0,
		turn.steps.findIndex((step) => step.method === 'alnair/ask_user_question') + 1
	);
}

export const parkedQuestionSteps = parkedSteps(questionTurn);
export const parkedPlanQuestionSteps = parkedSteps(planQuestionTurn);

/** The `alnair/ask_user_question` payload, as the transport would deliver it. */
export const parkedQuestionRequest = parkedQuestionSteps.at(-1)!
	.params as unknown as AskUserQuestionRequest;
export const parkedPlanQuestionRequest = parkedPlanQuestionSteps.at(-1)!
	.params as unknown as AskUserQuestionRequest;

/**
 * A session parked on a questionnaire: the transcript up to the request, with
 * the question card already in place. The store reads the reverse request from
 * this session's frames on selection, exactly as it would from a live socket.
 */
export function initialQuestionTranscript(
	turn: ScriptedTurn = questionTurn,
	sessionId = 's-auth'
): Acc {
	let acc = openUserTurn(
		emptyAcc(),
		turn.prompt,
		Date.parse(t(32)),
		'kimi-code/kimi-k2-turbo-preview',
		'high'
	);
	let clock = Date.parse(t(32));
	for (const step of parkedSteps(turn)) {
		clock += step.delay;
		if (step.method === 'alnair/ask_user_question') {
			// A reverse request, not an update: the card is built from it directly.
			acc = questionFromRequest(acc, step.params as unknown as AskUserQuestionRequest, clock);
			continue;
		}
		const update = (step.params as { update?: Record<string, unknown> }).update;
		if (!update) continue;
		const ctx = { now: clock, sessionId };
		acc =
			step.method === '_alnair/session/update'
				? reduceExtUpdate(acc, update as ExtSessionUpdate, ctx)
				: reduceAcpUpdate(acc, update as SessionUpdate, ctx);
	}
	return acc;
}

export const suggestions = [
	'Explain the graph planner contract',
	'Add a cancel button to the composer',
	'Show the diff of the last checkpoint',
	'Why is gn-verify still pending?'
];

/* ------------------------------------------------------- mention & command */

/**
 * Slash commands as the agent advertises them: ACP `AvailableCommand` carries
 * `name`, `description`, and an optional `input.hint`. This is the builtin set
 * the runtime registers, trimmed to the ones a web client can act on.
 */
export const commands: SlashCommand[] = [
	{ name: 'goal', description: 'Run the objective as a goal', hint: '<objective>' },
	{ name: 'graph', description: 'Decompose the objective into a DAG', hint: '<objective>' },
	{ name: 'swarm', description: 'Fan out over a list of items', hint: '<task>' },
	{ name: 'plan', description: 'Enter plan mode' },
	{ name: 'compact', description: 'Compact the conversation' },
	{ name: 'model', description: 'Switch the model', hint: '<model>' },
	{ name: 'clear', description: 'Clear the thread' },
	{ name: 'rewind', description: 'Rewind to an earlier turn', hint: '<turn>' },
	{ name: 'review', description: 'Review the working tree' },
	{ name: 'memory', description: 'Browse and toggle memory' },
	{ name: 'mcp', description: 'Manage MCP servers' },
	{ name: 'terminal-setup', description: 'Per-terminal keyboard recipe' }
];

/**
 * One directory as `alnair/fs/list` returns it: `name`, `path`, `type`.
 * The menu fetches a directory at a time, so this stands in for a workspace.
 */
export const workspaceFiles: FileEntry[] = [
	{ name: 'crates', path: 'crates', type: 'directory' },
	{ name: 'web', path: 'web', type: 'directory' },
	{ name: 'docs', path: 'docs', type: 'directory' },
	{ name: '.alnair', path: '.alnair', type: 'directory' },
	{ name: 'AGENTS.md', path: 'AGENTS.md', type: 'file', size: 12_480 },
	{ name: 'Cargo.toml', path: 'Cargo.toml', type: 'file', size: 8_214 },
	{ name: 'README.md', path: 'README.md', type: 'file', size: 4_920 },
	{ name: 'plan.md', path: 'plan.md', type: 'file', size: 2_110 }
];

/**
 * Subagents the header's list shows.
 *
 * Two sources in the real client: `alnair/subagent/list_running` while they
 * work, and `alnair/subagent/get` for the detail dialog. The fixture holds the
 * finished shape, which carries both, so the list and the dialog agree.
 */
export const subagents: SubagentSummary[] = [
	{
		id: 'sub-thread',
		agent: 'general-purpose',
		description: 'Build the turn thread',
		childSessionId: 's-graph-sub-thread',
		prompt: 'Build the turn thread for the web harness.',
		status: 'running',
		startedAt: MOCK_NOW.getTime() - 6 * 60_000,
		durationMs: 6 * 60_000,
		turnCount: 4,
		toolCallCount: 11,
		tokensUsed: 42_800,
		contextWindowTokens: 262_144,
		contextUsagePct: 16,
		toolsUsed: ['read_file', 'search_replace', 'grep', 'bash'],
		errorCount: 1,
		worktreePath: '.alnair/worktrees/gn-thread'
	},
	{
		id: 'sub-palette',
		agent: 'explore',
		description: 'Audit the TUI palette for web-safe accents',
		childSessionId: 's-graph-sub-palette',
		prompt: 'Audit the TUI palette for web-safe accents.',
		status: 'completed',
		startedAt: MOCK_NOW.getTime() - 42 * 60_000,
		durationMs: 6_100,
		turnCount: 2,
		toolCallCount: 3,
		tokensUsed: 21_900,
		contextWindowTokens: 262_144,
		contextUsagePct: 8,
		toolsUsed: ['read_file', 'grep'],
		errorCount: 0,
		output:
			'Night accents are TokyoNight Night; day accents are the same hues deepened. Keep the theme accents for turn semantics and the site palette for chrome.'
	},
	{
		id: 'sub-tests',
		agent: 'general-purpose',
		description: 'Run the workspace test suite',
		childSessionId: 's-graph-sub-tests',
		prompt: 'Run the workspace test suite and report what fails.',
		status: 'failed',
		startedAt: MOCK_NOW.getTime() - 58 * 60_000,
		durationMs: 94_000,
		turnCount: 1,
		toolCallCount: 2,
		tokensUsed: 8_400,
		contextWindowTokens: 262_144,
		contextUsagePct: 3,
		toolsUsed: ['bash'],
		errorCount: 2,
		failureError: 'cargo test exited 101: two doctests in alnair-pager-render failed.'
	}
];

/**
 * The transcript of a subagent's child session.
 *
 * A subagent is a session, so its history is the same `{ method, params }`
 * envelope a parent's is: `alnair/session/updates` reads the child's
 * `updates.jsonl` by id and the reducer folds it exactly as it folds the main
 * thread. Nothing here is a summary of the subagent — it is its conversation.
 */
export function initialSubagentTranscript(subagent: SubagentSummary): TranscriptEnvelope[] {
	const at = (offsetMs: number) => new Date(subagent.startedAt + offsetMs).toISOString();

	if (subagent.status === 'failed') {
		return [
			envelope(
				subagent.childSessionId,
				at(0),
				userChunk(subagent.childSessionId, subagent.prompt ?? subagent.description)
			),
			envelope(
				subagent.childSessionId,
				at(400),
				thoughtChunk(
					subagent.childSessionId,
					'Running the workspace suite; it is the only way to know what broke.'
				)
			),
			envelope(
				subagent.childSessionId,
				at(900),
				toolCall(subagent.childSessionId, {
					toolCallId: 'sub-tests-call',
					title: 'Execute `cargo test --workspace`',
					kind: 'execute',
					status: 'in_progress',
					rawInput: { command: 'cargo test --workspace' }
				})
			),
			envelope(
				subagent.childSessionId,
				at(94_000),
				toolDone(
					subagent.childSessionId,
					'sub-tests-call',
					[
						textResult(
							'error[E0308]: mismatched types\n  --> alnair-pager-render/src/lib.rs:88:9\n\ntest result: FAILED. 2 passed; 2 failed'
						)
					],
					'failed'
				)
			),
			envelope(
				subagent.childSessionId,
				at(94_500),
				extUpdate(subagent.childSessionId, {
					sessionUpdate: 'retry_state',
					type: 'failed',
					error_type: 'test',
					message: 'cargo test exited 101'
				})
			)
		];
	}

	return [
		envelope(
			subagent.childSessionId,
			at(0),
			userChunk(subagent.childSessionId, subagent.prompt ?? subagent.description)
		),
		envelope(
			subagent.childSessionId,
			at(600),
			thoughtChunk(
				subagent.childSessionId,
				'The palette lives in two theme modules. Read both, then compare the accent slots against the web tokens.'
			)
		),
		envelope(
			subagent.childSessionId,
			at(1_200),
			toolCall(subagent.childSessionId, {
				toolCallId: 'sub-palette-read',
				title: 'Read `alnair-pager-render/src/theme/alnairnight.rs`',
				kind: 'read',
				status: 'in_progress',
				locations: [
					{ path: 'crates/codegen/alnair-pager-render/src/theme/alnairnight.rs', line: 1 }
				],
				rawInput: { path: 'crates/codegen/alnair-pager-render/src/theme/alnairnight.rs' }
			})
		),
		envelope(
			subagent.childSessionId,
			at(1_900),
			toolDone(
				subagent.childSessionId,
				'sub-palette-read',
				[
					textResult(`pub const ACCENT_ASSISTANT: Rgb = Rgb(0xbb, 0x9a, 0xf7);
pub const ACCENT_TOOL: Rgb = Rgb(0xa3, 0xa3, 0xa3);
pub const ACCENT_SUCCESS: Rgb = Rgb(0x9e, 0xce, 0x6a);`)
				],
				'completed'
			)
		),
		envelope(
			subagent.childSessionId,
			at(2_400),
			toolCall(subagent.childSessionId, {
				toolCallId: 'sub-palette-grep',
				title: 'grep "accent_" in alnair-pager-render',
				kind: 'search',
				status: 'in_progress',
				rawInput: { pattern: 'accent_' }
			})
		),
		envelope(
			subagent.childSessionId,
			at(3_100),
			toolDone(
				subagent.childSessionId,
				'sub-palette-grep',
				[textResult('theme/alnairnight.rs: 11 matches\ntheme/alnairday.rs: 11 matches')],
				'completed'
			)
		),
		envelope(
			subagent.childSessionId,
			at(6_100),
			agentChunk(
				subagent.childSessionId,
				subagent.output ??
					'Night accents are TokyoNight Night; day accents are the same hues deepened.'
			)
		)
	];
}

const envelope = (sessionId: string, timestamp: string, step: WireStep): TranscriptEnvelope => ({
	timestamp,
	method: step.method,
	params: step.params
});

/** A nested listing, so drilling into a directory shows something. */
export const filesByDirectory: Record<string, FileEntry[]> = {
	web: [
		{ name: 'src', path: 'web/src', type: 'directory' },
		{ name: 'static', path: 'web/static', type: 'directory' },
		{ name: 'package.json', path: 'web/package.json', type: 'file', size: 1_880 },
		{ name: 'README.md', path: 'web/README.md', type: 'file', size: 9_640 },
		{ name: 'vite.config.ts', path: 'web/vite.config.ts', type: 'file', size: 640 }
	],
	crates: [
		{ name: 'codegen', path: 'crates/codegen', type: 'directory' },
		{ name: 'common', path: 'crates/common', type: 'directory' },
		{ name: 'build', path: 'crates/build', type: 'directory' }
	]
};
