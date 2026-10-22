import { describe, expect, it } from 'vitest';
import { HarnessStore } from './session-store.svelte.js';

/**
 * Exercises the store's replay window end to end: the leader sends a
 * `session/load` replay, then the buffered-live tail, then ordinary live
 * frames. The transcript must contain each chunk exactly once.
 *
 * `HarnessStore` seeds scripted sessions; `s-graph` is the one the fixtures
 * build a full transcript for, so the test drives that id.
 */

const SESSION = 's-graph';

function chunk(text: string, seq: number, replay = false) {
	return {
		method: 'session/update',
		params: {
			sessionId: SESSION,
			update: {
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text }
			},
			_meta: { eventId: `${SESSION}-${seq}`, ...(replay ? { isReplay: true } : {}) }
		}
	};
}

/** Feed frames the way a transport would. */
function feed(store: HarnessStore, frames: { method: string; params: Record<string, unknown> }[]) {
	const receive = (store as unknown as { receive: (sid: string, f: unknown) => void }).receive.bind(
		store
	);
	for (const frame of frames) receive(SESSION, frame);
}

function text(store: HarnessStore): string {
	return store.turns
		.flatMap((turn) => turn.parts)
		.filter((part) => part.kind === 'text')
		.map((part) => (part as { text: string }).text)
		.join('');
}

describe('store: replay window', () => {
	it('folds a replay then a live tail exactly once', () => {
		const store = new HarnessStore();
		store.selectSession(SESSION);

		store.beginSessionLoad(SESSION);
		feed(store, [
			chunk('Hello ', 1, true),
			chunk('world', 2, true),
			{ method: 'session/load:result', params: {} }
		]);
		expect(text(store)).toBe('Hello world');

		// Buffered-live tail the leader forwards after the load response.
		feed(store, [chunk('!', 3)]);
		expect(text(store)).toBe('Hello world!');
	});

	it('drops a duplicate frame delivered after the replay', () => {
		const store = new HarnessStore();
		store.selectSession(SESSION);

		store.beginSessionLoad(SESSION);
		feed(store, [chunk('abc', 1, true), { method: 'session/load:result', params: {} }]);
		// Same event id again: already folded, so it must not append.
		feed(store, [chunk('abc', 1)]);
		expect(text(store)).toBe('abc');
	});

	it('applies unsequenced frames inside the live window', () => {
		const store = new HarnessStore();
		store.selectSession(SESSION);

		store.beginSessionLoad(SESSION);
		feed(store, [chunk('a', 1, true), { method: 'session/load:result', params: {} }]);
		feed(store, [
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } }
				}
			}
		]);
		expect(text(store)).toBe('ab');
	});

	it('a second load rebuilds instead of doubling the transcript', () => {
		const store = new HarnessStore();
		store.selectSession(SESSION);

		store.beginSessionLoad(SESSION);
		feed(store, [chunk('first', 1, true), { method: 'session/load:result', params: {} }]);

		// Leader relaunch: the client reloads and gets the same history again.
		store.beginSessionLoad(SESSION);
		feed(store, [
			chunk('first', 1, true),
			chunk('second', 2, true),
			{ method: 'session/load:result', params: {} }
		]);
		expect(text(store)).toBe('firstsecond');
	});
});
