import type { SubagentLiveSnapshot, SubagentSnapshot } from './types/ext.js';
import type { SubagentSummary } from './types.js';

/**
 * Project the wire's subagent snapshots onto the view model.
 *
 * Two sources, one shape: `list_running` returns only live subagents, while
 * `get` returns one in any state and adds the fields that only make sense once
 * it finished. The dialog reads the second, the header reads the first, and
 * both end up here.
 */

const STATUSES = new Set<SubagentSummary['status']>([
	'running',
	'completed',
	'failed',
	'cancelled'
]);

const asStatus = (value: string | undefined): SubagentSummary['status'] =>
	value !== undefined && STATUSES.has(value as SubagentSummary['status'])
		? (value as SubagentSummary['status'])
		: 'running';

export function fromLive(snapshot: SubagentLiveSnapshot): SubagentSummary {
	return {
		id: snapshot.subagentId,
		agent: snapshot.subagentType,
		description: snapshot.description,
		// A subagent IS a session: the child id is what `alnair/session/updates`
		// takes to read its transcript.
		childSessionId: snapshot.childSessionId,
		status: 'running',
		startedAt: snapshot.startedAtEpochMs,
		durationMs: snapshot.durationMs,
		turnCount: snapshot.turnCount,
		toolCallCount: snapshot.toolCallCount,
		tokensUsed: snapshot.tokensUsed,
		contextWindowTokens: snapshot.contextWindowTokens,
		contextUsagePct: snapshot.contextUsagePct,
		toolsUsed: snapshot.toolsUsed ?? [],
		errorCount: snapshot.errorCount
	};
}

export function fromSnapshot(snapshot: SubagentSnapshot): SubagentSummary {
	return {
		...fromLive(snapshot),
		status: asStatus(snapshot.status),
		// A finished subagent reports its final counts under the completed
		// field names; the live ones stop being sent.
		turnCount: snapshot.turns ?? snapshot.turnCount,
		toolCallCount: snapshot.toolCalls ?? snapshot.toolCallCount,
		output: snapshot.output,
		failureError: snapshot.failureError,
		cancelReason: snapshot.cancelReason,
		worktreePath: snapshot.worktreePath,
		resumedFrom: snapshot.resumedFrom
	};
}

/**
 * Order the header's list: running first, then by start time with the newest
 * at the top. A finished subagent keeps its place in the list until the
 * session ends, so the reader can still open it.
 */
export function sortSubagents(list: SubagentSummary[]): SubagentSummary[] {
	const weight = (subagent: SubagentSummary) => (subagent.status === 'running' ? 0 : 1);
	return [...list].sort((a, b) => weight(a) - weight(b) || b.startedAt - a.startedAt);
}

/** The label under the header chip: `2 running` or `3 subagents`. */
export function subagentSummaryLabel(list: SubagentSummary[]): string | undefined {
	if (list.length === 0) return undefined;
	const running = list.filter((subagent) => subagent.status === 'running').length;
	if (running > 0) return `${running} running`;
	return `${list.length} ${list.length === 1 ? 'subagent' : 'subagents'}`;
}
