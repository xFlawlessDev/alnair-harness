import { getContext, setContext } from 'svelte';
import { MockSessionStore, type SessionStore } from './session-store.svelte.js';

const KEY = Symbol('alnair-harness-store');

/** Creates the store once per layout and puts it on the component context. */
export function provideSessionStore(): SessionStore {
	const store = new MockSessionStore();
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
