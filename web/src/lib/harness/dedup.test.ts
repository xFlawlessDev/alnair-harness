import { describe, expect, it } from 'vitest';
import { admit, beginReplay, endReplay, liveGate, parseEventSeq, type GateState } from './dedup.js';

const SID = '019e-aa-bb';

/** Fold a sequence of event ids through the gate, returning what applied. */
function run(initial: GateState, eventIds: (string | undefined)[]): number[] {
	let state = initial;
	const applied: number[] = [];
	for (const id of eventIds) {
		const verdict = admit(state, id);
		state = verdict.state;
		if (verdict.apply) applied.push(parseEventSeq(id) ?? -1);
	}
	return applied;
}

describe('dedup: parseEventSeq', () => {
	it('splits on the last dash so a dashed session id still parses', () => {
		expect(parseEventSeq(`${SID}-42`)).toBe(42);
	});

	it('rejects absent and malformed ids rather than reading them as zero', () => {
		expect(parseEventSeq(undefined)).toBeUndefined();
		expect(parseEventSeq(null)).toBeUndefined();
		expect(parseEventSeq('')).toBeUndefined();
		expect(parseEventSeq('no-dash-suffix-')).toBeUndefined();
		expect(parseEventSeq('sess-abc')).toBeUndefined();
		expect(parseEventSeq('sess-1.5')).toBeUndefined();
		expect(parseEventSeq('sess-9007199254740993')).toBeUndefined();
		expect(parseEventSeq(7)).toBeUndefined();
	});

	it('reads a negative-looking suffix as the sequence after the last dash', () => {
		// `eventId` is `<session_id>-<seq>`; a dashed session id shifts the
		// split, so the digits after the FINAL dash are the sequence.
		expect(parseEventSeq('sess--1')).toBe(1);
	});
});

describe('dedup: live phase', () => {
	it('drops a frame the accumulator already folded', () => {
		const state = { phase: 'live' as const, lastSeq: 10 };
		expect(admit(state, `${SID}-10`).apply).toBe(false);
		expect(admit(state, `${SID}-9`).apply).toBe(false);
	});

	it('advances the watermark on a genuinely new frame', () => {
		const verdict = admit({ phase: 'live', lastSeq: 10 }, `${SID}-11`);
		expect(verdict.apply).toBe(true);
		expect(verdict.state.lastSeq).toBe(11);
	});

	it('does not treat a gap as a reason to reject', () => {
		const verdict = admit({ phase: 'live', lastSeq: 10 }, `${SID}-15`);
		expect(verdict.apply).toBe(true);
		expect(verdict.state.lastSeq).toBe(15);
	});

	it('always applies unsequenced frames', () => {
		const verdict = admit({ phase: 'live', lastSeq: 10 }, undefined);
		expect(verdict.apply).toBe(true);
		expect(verdict.state.lastSeq).toBe(10);
	});
});

describe('dedup: replay phase', () => {
	it('applies every frame and tracks the high-water mark', () => {
		expect(run(beginReplay(), [`${SID}-3`, `${SID}-1`, `${SID}-7`])).toEqual([3, 1, 7]);
	});

	it('does not drop out-of-order replay frames', () => {
		// A replay is authoritative: a lower seq is still new state while the
		// accumulator is being rebuilt.
		expect(run(beginReplay(), [`${SID}-9`, `${SID}-4`])).toEqual([9, 4]);
	});

	it('keeps the high-water mark as the post-replay watermark', () => {
		const state = endReplay({ ...beginReplay(), lastSeq: 9 });
		expect(state.phase).toBe('live');
		expect(admit(state, `${SID}-9`).apply).toBe(false);
		expect(admit(state, `${SID}-10`).apply).toBe(true);
	});
});

describe('dedup: the reconnect the leader cannot see', () => {
	it('drops the overlap when a live stream is replayed into a warm view', () => {
		// A reconnect always begins with a fresh replay, not a bare comparison
		// against the watermark the warm view is already holding.
		const replayed = run(
			beginReplay(),
			[1, 2, 3, 4, 5, 6, 7].map((n) => `${SID}-${n}`)
		);
		expect(replayed).toEqual([1, 2, 3, 4, 5, 6, 7]);

		const live = endReplay({ phase: 'replay', lastSeq: 7 });
		// The buffered-live tail the leader forwards after the load response.
		expect(run(live, [`${SID}-8`, `${SID}-9`])).toEqual([8, 9]);
	});

	it('survives a mixed sequenced/unsequenced stream', () => {
		const state = { phase: 'live' as const, lastSeq: 4 };
		expect(run(state, [`${SID}-4`, undefined, `${SID}-5`, undefined])).toEqual([-1, 5, -1]);
	});
});

describe('dedup: gate lifecycle', () => {
	it('starting from live with no watermark applies everything once', () => {
		expect(run(liveGate(), [`${SID}-1`, `${SID}-2`])).toEqual([1, 2]);
	});

	it('endReplay is idempotent', () => {
		const once = endReplay(beginReplay());
		expect(endReplay(once)).toBe(once);
	});
});
