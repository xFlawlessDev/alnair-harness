import { getContext, setContext } from 'svelte';
import { HarnessStore, type SessionStore } from './session-store.svelte.js';
import { WebSocketTransport } from './ws-transport.js';

const KEY = Symbol('alnair-harness-store');

/**
 * Choose the transport.
 *
 * `?fixtures=1` keeps the scripted transcripts available: they exercise states
 * the live agent rarely produces on demand (a parked questionnaire, an
 * exhausted retry) and are what the component tests render. Everything else
 * talks to `alnair web`.
 */
function createTransport(): HarnessStore {
	const params = new URLSearchParams(globalThis.location?.search ?? '');
	if (params.get('fixtures') === '1') return new HarnessStore();

	const scheme = globalThis.location.protocol === 'https:' ? 'wss' : 'ws';
	const transport = new WebSocketTransport(
		() => new WebSocket(`${scheme}://${globalThis.location.host}/ws`),
		''
	);
	const store = new HarnessStore(transport);
	// `bootstrap` is fire-and-forget: the UI paints its empty state and fills in
	// as the handshake, roster and first transcript land, instead of blocking on
	// a socket. The transport reconnects with backoff on its own.
	void store.bootstrap();
	return store;
}

/** Creates the store once per layout and puts it on the component context. */
export function provideSessionStore(): SessionStore {
	const store = createTransport();
	setContext(KEY, store);
	return store;
}

export function useSessionStore(): SessionStore {
	const store = getContext<SessionStore | undefined>(KEY);
	if (!store) {
		throw new Error('useSessionStore() called outside <StoreProvider>.');
	}
	return store;
}
