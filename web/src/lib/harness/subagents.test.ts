import { describe, expect, it } from 'vitest';
import { fromLive, fromSnapshot, sortSubagents, subagentSummaryLabel } from './subagents.js';
import type { SubagentLiveSnapshot, SubagentSnapshot } from './types/ext.js';
import type { SubagentSummary } from './types.js';

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
