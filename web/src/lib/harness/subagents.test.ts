import { describe, expect, it } from 'vitest';
import {
	fromLive,
	fromSnapshot,
	fromTranscript,
	mergeSubagents,
	sortSubagents,
	subagentSummaryLabel
} from './subagents.js';
import type { SubagentLiveSnapshot, SubagentSnapshot } from './types/ext.js';
import type { SubagentSummary } from './types.js';
import type { SubagentState } from './reducer.js';

const live: SubagentLiveSnapshot = {
	subagentId: 'sub-1',
	parentSessionId: 's-1',
	childSessionId: 's-1-sub',
	subagentType: 'explore',
	description: 'Audit the palette',
	startedAtEpochMs: 1_000,
	durationMs: 4_000,
	turnCount: 2,
	toolCallCount: 3,
	tokensUsed: 18_000,
	contextWindowTokens: 262_144,
	contextUsagePct: 7,
	toolsUsed: ['read_file', 'grep'],
	errorCount: 0
};

const summary = (patch: Partial<SubagentSummary> = {}): SubagentSummary => ({
	...fromLive(live),
	...patch
});

describe('subagent projection', () => {
	it('reads a live snapshot as running', () => {
		expect(fromLive(live)).toMatchObject({
			id: 'sub-1',
			agent: 'explore',
			status: 'running',
			turnCount: 2,
			toolCallCount: 3
		});
	});

	it('takes the completed counts when the snapshot is finished', () => {
		// A finished subagent stops sending the live counters and reports
		// `turns` / `toolCalls` instead.
		const snapshot: SubagentSnapshot = {
			...live,
			status: 'completed',
			turnCount: 0,
			toolCallCount: 0,
			turns: 5,
			toolCalls: 9,
			output: 'done'
		};
		const projected = fromSnapshot(snapshot);
		expect(projected.status).toBe('completed');
		expect(projected.turnCount).toBe(5);
		expect(projected.toolCallCount).toBe(9);
		expect(projected.output).toBe('done');
	});

	it('falls back to the live counts when the completed ones are absent', () => {
		const snapshot: SubagentSnapshot = { ...live, status: 'running' };
		const projected = fromSnapshot(snapshot);
		expect(projected.turnCount).toBe(2);
		expect(projected.toolCallCount).toBe(3);
	});

	it('treats an unknown status as running rather than inventing one', () => {
		const snapshot: SubagentSnapshot = { ...live, status: 'weird' };
		expect(fromSnapshot(snapshot).status).toBe('running');
	});

	it('carries the failure reason through', () => {
		const snapshot: SubagentSnapshot = { ...live, status: 'failed', failureError: 'exit 101' };
		expect(fromSnapshot(snapshot).failureError).toBe('exit 101');
	});
});

describe('ordering and label', () => {
	it('puts running subagents first, newest first within each group', () => {
		const list = [
			summary({ id: 'a', status: 'completed', startedAt: 3_000 }),
			summary({ id: 'b', status: 'running', startedAt: 1_000 }),
			summary({ id: 'c', status: 'running', startedAt: 2_000 })
		];
		expect(sortSubagents(list).map((entry) => entry.id)).toEqual(['c', 'b', 'a']);
	});

	it('counts the running ones when any are live', () => {
		expect(
			subagentSummaryLabel([summary({ status: 'running' }), summary({ status: 'completed' })])
		).toBe('1 running');
	});

	it('names the total once nothing is running', () => {
		expect(subagentSummaryLabel([summary({ status: 'completed' })])).toBe('1 subagent');
		expect(
			subagentSummaryLabel([summary({ status: 'completed' }), summary({ status: 'failed' })])
		).toBe('2 subagents');
	});

	it('has no label for an empty list, so the header hides the chip', () => {
		expect(subagentSummaryLabel([])).toBeUndefined();
	});
});

/**
 * The header's list is DERIVED from two sources, and this is the rule that
 * keeps a session switch from blanking it.
 *
 * The transcript is the durable half — `subagent_spawned` is persisted, so a
 * reload still knows every subagent the session started. `list_running` only
 * answers the live subset. Reading either one alone is what produced the bug
 * the reader hit: a subagent that was already running stayed invisible until
 * it happened to emit a frame, and switching sessions appeared to "fix" it.
 */
describe('merging the transcript with the live snapshot', () => {
	const transcript = (patch: Partial<SubagentState> = {}): SubagentState => ({
		id: 'sub-1',
		childSessionId: 's-1-sub',
		description: 'Audit the palette',
		agent: 'explore',
		model: 'alnair/one',
		status: 'running',
		turnCount: 0,
		toolCallCount: 0,
		tokensUsed: 0,
		toolsUsed: [],
		startedAt: 1_000,
		...patch
	});

	it('keeps a finished subagent that no live read reports', () => {
		// The whole reason the header cannot read `list_running` alone.
		const merged = mergeSubagents(
			[fromTranscript(transcript({ status: 'complete', endedAt: 5_000 }))],
			[]
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].status).toBe('completed');
	});

	it('refines a transcript row with the live counters', () => {
		const merged = mergeSubagents([fromTranscript(transcript())], [summary({ id: 'sub-1' })]);
		expect(merged).toHaveLength(1);
		expect(merged[0].toolCallCount).toBe(3);
		expect(merged[0].tokensUsed).toBe(18_000);
	});

	it('keeps a live subagent whose spawn frame has not arrived yet', () => {
		// A tab that attached mid-turn may see `list_running` before the replay
		// reaches the spawn frame; dropping it would hide a running child.
		const merged = mergeSubagents([], [summary({ id: 'sub-9' })]);
		expect(merged.map((entry) => entry.id)).toEqual(['sub-9']);
	});

	it('does not let a stale live read resurrect a finished subagent', () => {
		const merged = mergeSubagents(
			[fromTranscript(transcript({ status: 'complete', endedAt: 5_000 }))],
			[summary({ id: 'sub-1', status: 'running' })]
		);
		expect(merged[0].status).toBe('completed');
	});

	it('orders running first, as the header renders it', () => {
		const merged = mergeSubagents(
			[
				fromTranscript(transcript({ id: 'done', status: 'complete', endedAt: 2_000 })),
				fromTranscript(transcript({ id: 'live' }))
			],
			[]
		);
		expect(merged.map((entry) => entry.id)).toEqual(['live', 'done']);
	});

	it('projects a transcript row with the fields the dialog reads', () => {
		const projected = fromTranscript(
			transcript({
				status: 'error',
				error: 'exit 101',
				result: 'partial',
				endedAt: 4_000,
				turnCount: 2,
				toolCallCount: 7,
				tokensUsed: 900
			})
		);
		expect(projected).toMatchObject({
			id: 'sub-1',
			agent: 'explore',
			status: 'failed',
			failureError: 'exit 101',
			output: 'partial',
			turnCount: 2,
			toolCallCount: 7,
			tokensUsed: 900,
			errorCount: 1,
			durationMs: 3_000
		});
	});
});
