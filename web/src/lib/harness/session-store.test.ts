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

describe('store: a load is not a replay', () => {
	/**
	 * The reader's report: opening a conversation looked like watching it be
	 * replayed, because every frame was folded (and rendered) as it arrived.
	 * The frames are now collected and folded in one pass when the load ends.
	 */
	it('shows nothing until the load completes, then the whole transcript at once', () => {
		const store = new HarnessStore();
		store.selectSession(SESSION);

		store.beginSessionLoad(SESSION);
		feed(store, [chunk('Hello ', 1, true), chunk('world', 2, true)]);

		// Mid-load: buffered, not rendered. A reader must not watch the
		// conversation assemble itself.
		expect(text(store)).toBe('');

		feed(store, [{ method: 'session/load:result', params: {} }]);
		expect(text(store)).toBe('Hello world');
	});

	it('folds the buffer in ONE write, not one per frame', () => {
		// The other half of the report: a long transcript produced a render per
		// chunk. Counting writes is how that is observable from outside.
		const store = new HarnessStore();
		store.selectSession(SESSION);
		let writes = 0;
		const write = (store as unknown as { write: (acc: unknown) => void }).write.bind(store);
		(store as unknown as { write: (acc: unknown) => void }).write = (acc: unknown) => {
			writes += 1;
			write(acc);
		};

		store.beginSessionLoad(SESSION);
		feed(store, [
			chunk('a', 1, true),
			chunk('b', 2, true),
			chunk('c', 3, true),
			{ method: 'session/load:result', params: {} }
		]);

		expect(text(store)).toBe('abc');
		expect(writes).toBe(1);
	});

	it('flushes even when no load-result frame ever arrives', async () => {
		// A transport whose `openSession` resolves without emitting the marker
		// must still show the transcript; otherwise the thread stays empty.
		//
		// The frames have to arrive DURING the load, which is what a real
		// transport does: it streams the replay and then resolves. The stub
		// therefore pushes through the sink the store registered, then returns.
		let sink: ((sessionId: string, frame: unknown) => void) | undefined;
		const store = new HarnessStore({
			send() {},
			stop() {},
			respond() {},
			respondQuestions() {},
			connect: async () => {},
			listSessions: async () => [],
			onFrame: (registered: (sessionId: string, frame: unknown) => void) => {
				sink = registered;
			},
			openSession: async () => {
				sink?.(SESSION, chunk('only', 1, true));
				// Deliberately NO `session/load:result` frame.
				return { models: [] };
			}
		} as never);
		await store.bootstrap();

		await store.openSession(SESSION);
		expect(text(store)).toBe('only');
	});

	it('does not double-fold when both signals arrive', () => {
		const store = new HarnessStore();
		store.selectSession(SESSION);
		store.beginSessionLoad(SESSION);
		feed(store, [chunk('once', 1, true), { method: 'session/load:result', params: {} }]);
		void store.openSession(SESSION);
		expect(text(store)).toBe('once');
	});

	it('keeps live frames live after the flush', () => {
		const store = new HarnessStore();
		store.selectSession(SESSION);
		store.beginSessionLoad(SESSION);
		feed(store, [chunk('base', 1, true), { method: 'session/load:result', params: {} }]);

		feed(store, [chunk('+tail', 2)]);
		expect(text(store)).toBe('base+tail');
	});
});

describe('store: the loading flag', () => {
	/**
	 * The skeleton's source. An empty transcript and a transcript that has not
	 * arrived yet look identical to a reader, so the store has to say which.
	 */
	it('is set while the replay is in flight and cleared when it lands', () => {
		const store = new HarnessStore();
		store.selectSession(SESSION);

		expect(store.loading).toBe(false);
		store.beginSessionLoad(SESSION);
		expect(store.loading).toBe(true);

		feed(store, [chunk('hi', 1, true), { method: 'session/load:result', params: {} }]);
		expect(store.loading).toBe(false);
	});

	it('clears even when the session has no stored frames', () => {
		// A brand-new session replays nothing; the skeleton must not outlive it.
		const store = new HarnessStore();
		store.selectSession(SESSION);
		store.beginSessionLoad(SESSION);
		expect(store.loading).toBe(true);
		feed(store, [{ method: 'session/load:result', params: {} }]);
		expect(store.loading).toBe(false);
	});
});
