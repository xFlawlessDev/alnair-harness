/**
 * Fixture data for the harness, all of it derived from wire shapes.
 *
 * The transcripts are replayed through the same reducer the socket will use,
 * so what the UI shows here is what it will show against a real agent — minus
 * the agent. `session/list` rows are `AlnairSessionRow` objects, and the model
 * catalog mirrors the registry keys the picker receives.
 */

import { cancelledTurn, foundationTurn, permissionTurn, PLAN_MARKDOWN } from './fixtures.js';
import type { WireStep } from './fixtures.js';
import { closeTurn, emptyAcc, openUserTurn, reduceAcpUpdate, reduceExtUpdate } from './reducer.js';
import type { Acc } from './reducer.js';
import type { ExtSessionUpdate } from './types/ext.js';
import type { SessionUpdate } from './types/acp.js';
import type { AlnairSessionRow } from './types/ext.js';
import type { ContextUsage, ModelOption, PlanArtifact, Session, WorkspaceInfo } from './types.js';

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
		summary: 'Refresh OAuth tokens on 401',
		firstPrompt: 'Why does the Claude Pro session die after an hour?',
		createdAt: t(2_880),
		updatedAt: t(96),
		cwd: '~/dev/alnair-cli',
		source: 'local',
		modelId: 'claude-pro-max/claude-sonnet-4-5',
		numMessages: 24,
		branch: 'fix/oauth-refresh',
		repoName: 'alnair-cli',
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
		summary: 'Rewrite terminal setup guide',
		firstPrompt: 'Cover Windows Terminal and VTE.',
		createdAt: t(5_760),
		updatedAt: t(2_880),
		cwd: '~/dev/alnair-docs',
		source: 'local',
		modelId: 'kimi-code/kimi-k2-turbo-preview',
		numMessages: 6,
		branch: 'main',
		repoName: 'alnair-docs',
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
		status
	};
}

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

export const contextUsage: ContextUsage = {
	used: 61_440,
	limit: 262_144,
	percent: 23
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

export const suggestions = [
	'Explain the graph planner contract',
	'Add a cancel button to the composer',
	'Show the diff of the last checkpoint',
	'Why is gn-verify still pending?'
];
