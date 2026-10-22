import type { SubagentLiveSnapshot, SubagentSnapshot } from './types/ext.js';
import type { SubagentSummary } from './types.js';
import type { SubagentState } from './reducer.js';

/**
 * Project the wire's subagent snapshots onto the view model.
 *
 * Three sources, one shape: `list_running` returns only live subagents, `get`
 * returns one in any state, and the transcript carries the spawn/progress/
 * finish frames that describe every subagent the session ever started. The
 * dialog reads the second, the header the first and third, and all of them end
 * up here.
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
 * Project a transcript subagent onto the same shape.
 *
 * This is the durable source: `subagent_spawned` is persisted, so a session
 * reopened hours later still knows which subagents it started. `list_running`
 * answers only the live subset, which is why the header cannot read it alone —
 * a finished subagent would vanish the moment the page reattached.
 */
export function fromTranscript(state: SubagentState): SubagentSummary {
	return {
		id: state.id,
		agent: state.agent,
		description: state.description,
		childSessionId: state.childSessionId,
		status:
			state.status === 'running' ? 'running' : state.status === 'error' ? 'failed' : 'completed',
		startedAt: state.startedAt,
		durationMs: (state.endedAt ?? Date.now()) - state.startedAt,
		turnCount: state.turnCount,
		toolCallCount: state.toolCallCount,
		tokensUsed: state.tokensUsed,
		contextWindowTokens: 0,
		contextUsagePct: 0,
		toolsUsed: state.toolsUsed,
		errorCount: state.error ? 1 : 0,
		output: state.result,
		failureError: state.error,
		model: state.model
	};
}

/**
 * Merge the two views of a session's subagents.
 *
 * The transcript is the base — it is the only source that survives a reload —
 * and a live snapshot refines a row it already knows, adding the counters the
 * spawn frame did not carry. A live snapshot with no transcript row is kept:
 * it belongs to a subagent that started before this tab attached, and the
 * replay may not have reached its spawn frame yet.
 */
export function mergeSubagents(
	fromTranscript: SubagentSummary[],
	live: SubagentSummary[]
): SubagentSummary[] {
	const byId = new Map(fromTranscript.map((subagent) => [subagent.id, subagent]));
	for (const subagent of live) {
		const known = byId.get(subagent.id);
		// A finished transcript row outranks a stale live one: `list_running`
		// can answer a snapshot taken before the finish landed.
		if (known && known.status !== 'running' && subagent.status === 'running') continue;
		byId.set(subagent.id, known ? { ...known, ...subagent } : subagent);
	}
	return sortSubagents([...byId.values()]);
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
