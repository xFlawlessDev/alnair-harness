import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessStore, type Transport } from './session-store.svelte.js';
import { sessions } from './mock.js';
import type { SubagentSummary, Turn } from './types.js';

const child: SubagentSummary = {
	id: 'sub-1',
	agent: 'explore',
	description: 'Inspect the workspace',
	childSessionId: 'child-1',
	status: 'running',
	startedAt: 1_000,
	durationMs: 2_000,
	turnCount: 1,
	toolCallCount: 2,
	tokensUsed: 300,
	contextWindowTokens: 10_000,
	contextUsagePct: 3,
	toolsUsed: ['read_file'],
	errorCount: 0
};

function transcript(text: string) {
	return [
		{
			method: 'session/update',
			timestamp: '2026-11-06T00:00:00Z',
			params: {
				sessionId: child.childSessionId,
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
			}
		}
	];
}

function text(turns: Turn[]) {
	return turns
		.flatMap((turn) => turn.parts)
		.filter((part) => part.kind === 'text')
		.map((part) => part.text)
		.join('');
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function settle() {
	for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function storeWith(extra: Partial<Transport>) {
	const store = new HarnessStore({
		send() {},
		stop() {},
		respond() {},
		respondQuestions() {},
		connect: async () => {},
		...extra
	});
	store.sessions = sessions;
	store.activeSessionId = sessions[0].id;
	return store;
}

describe('open subagent: live refresh', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('refreshes the transcript and counters without changing the parent thread', async () => {
		const updates = vi.fn().mockResolvedValue(transcript('First'));
		const detail = vi.fn().mockResolvedValue({ ...child, tokensUsed: 500 });
		let receive: Parameters<NonNullable<Transport['onFrame']>>[0] | undefined;
		const store = storeWith({
			sessionUpdates: updates,
			getSubagent: detail,
			onFrame: (sink) => {
				receive = sink;
			}
		});
		receive?.(sessions[0].id, {
			method: 'session/update',
			params: {
				sessionId: sessions[0].id,
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Parent' } }
			}
		});
		const parentTurns = store.turns;
		const stop = store.openSubagent(child);
		expect(store.subagentLoading).toBe(true);
		await settle();
		expect(store.subagentLoading).toBe(false);
		expect(text(store.subagentTurns)).toBe('First');
		expect(store.subagentDetail?.tokensUsed).toBe(500);
		expect(updates).toHaveBeenCalledWith({
			sessionId: child.childSessionId,
			cwd: sessions[0].cwd
		});

		updates.mockResolvedValue(transcript('First, then final'));
		detail.mockResolvedValue({ ...child, status: 'completed', turnCount: 3, toolCallCount: 8 });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(text(store.subagentTurns)).toBe('First, then final');
		expect(store.subagentDetail).toMatchObject({
			status: 'completed',
			turnCount: 3,
			toolCallCount: 8
		});
		expect(store.subagents).toMatchObject([{ id: child.id, status: 'completed' }]);
		expect(store.turns).toBe(parentTurns);
		expect(text(store.turns)).toBe('Parent');

		const unchanged = store.subagentTurns;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(store.subagentTurns).toBe(unchanged);
		stop();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(updates).toHaveBeenCalledTimes(3);
	});

	it('keeps the last transcript on failure and recovers on the next refresh', async () => {
		const updates = vi.fn().mockResolvedValue(transcript('Saved'));
		const store = storeWith({ sessionUpdates: updates });
		const stop = store.openSubagent(child);
		await settle();
		updates.mockRejectedValueOnce(new Error('offline'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(text(store.subagentTurns)).toBe('Saved');
		expect(store.subagentError).toContain('Retrying');
		updates.mockResolvedValue(transcript('Recovered'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(text(store.subagentTurns)).toBe('Recovered');
		expect(store.subagentError).toBeUndefined();
		stop();
	});

	it('still updates the transcript when the snapshot lookup fails', async () => {
		const store = storeWith({
			sessionUpdates: async () => transcript('Available'),
			getSubagent: async () => {
				throw new Error('snapshot unavailable');
			}
		});
		const stop = store.openSubagent(child);
		await settle();
		expect(text(store.subagentTurns)).toBe('Available');
		expect(store.subagentDetail?.id).toBe(child.id);
		stop();
	});

	it('does not overlap slow reads', async () => {
		const pending = deferred<ReturnType<typeof transcript>>();
		const updates = vi.fn().mockReturnValue(pending.promise);
		const store = storeWith({ sessionUpdates: updates });
		const stop = store.openSubagent(child);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(updates).toHaveBeenCalledTimes(1);
		pending.resolve(transcript('Late'));
		await settle();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(updates).toHaveBeenCalledTimes(2);
		stop();
	});

	it.each(['resolved', 'rejected'] as const)(
		'ignores an old %s response after another child opens',
		async (outcome) => {
			const pending = deferred<ReturnType<typeof transcript>>();
			const updates = vi
				.fn()
				.mockReturnValueOnce(pending.promise)
				.mockResolvedValue(transcript('Second child'));
			const store = storeWith({ sessionUpdates: updates });
			const oldStop = store.openSubagent(child);
			const stop = store.openSubagent({ ...child, id: 'sub-2', childSessionId: 'child-2' });
			await settle();
			if (outcome === 'resolved') pending.resolve(transcript('Stale child'));
			else pending.reject(new Error('old read failed'));
			oldStop();
			await settle();
			expect(text(store.subagentTurns)).toBe('Second child');
			expect(store.subagentDetail?.id).toBe('sub-2');
			expect(store.subagentError).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(updates).toHaveBeenCalledTimes(3);
			stop();
		}
	);

	it('ignores in-flight reads after closing the dialog', async () => {
		const pending = deferred<ReturnType<typeof transcript>>();
		const updates = vi.fn().mockReturnValue(pending.promise);
		const store = storeWith({ sessionUpdates: updates });
		const stop = store.openSubagent(child);
		stop();
		pending.resolve(transcript('Closed'));
		await settle();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(store.subagentTurns).toHaveLength(0);
		expect(store.subagentDetail).toBeUndefined();
		expect(updates).toHaveBeenCalledTimes(1);
	});

	it('stops refreshing when the parent session changes', async () => {
		const pending = deferred<ReturnType<typeof transcript>>();
		const updates = vi.fn().mockReturnValue(pending.promise);
		const store = storeWith({ sessionUpdates: updates });
		store.openSubagent(child);
		store.selectSession(sessions[1].id);
		pending.resolve(transcript('Wrong session'));
		await settle();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(store.subagentTurns).toHaveLength(0);
		expect(store.subagentDetail).toBeUndefined();
		expect(updates).toHaveBeenCalledTimes(1);
	});

	it('keeps fixtures local without starting a refresh timer', () => {
		const store = new HarnessStore();
		const stop = store.openSubagent(child);
		expect(store.subagentTurns.length).toBeGreaterThan(0);
		expect(vi.getTimerCount()).toBe(0);
		stop();
	});
});
