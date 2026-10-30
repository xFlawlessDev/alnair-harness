import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	loadHidden,
	loadLayout,
	loadSettings,
	saveHidden,
	saveLayout,
	saveSettings
} from './preferences.js';
import { DEFAULT_SETTINGS, SETTINGS } from './settings.js';

/**
 * Preferences are the difference between a page and an application, so the two
 * failure modes matter more than the happy path: a store that throws (a
 * partitioned context) and a value that no longer validates (an older build).
 */

/** A localStorage stand-in that can be made to throw. */
function stubStorage(options: { throwOn?: 'get' | 'set' } = {}) {
	const map = new Map<string, string>();
	const storage = {
		getItem(key: string) {
			if (options.throwOn === 'get') throw new Error('denied');
			return map.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			if (options.throwOn === 'set') throw new Error('quota');
			map.set(key, value);
		},
		removeItem(key: string) {
			map.delete(key);
		},
		clear() {
			map.clear();
		}
	};
	Object.defineProperty(globalThis, 'localStorage', {
		value: storage,
		configurable: true,
		writable: true
	});
	return map;
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
	if (original) Object.defineProperty(globalThis, 'localStorage', original);
	else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('settings: round trip', () => {
	beforeEach(() => {
		stubStorage();
	});

	it('starts from the registry defaults with nothing stored', () => {
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
	});

	it('reads back what it wrote', () => {
		saveSettings({ ...DEFAULT_SETTINGS, theme: 'dark', density: 'compact' });
		const loaded = loadSettings();
		expect(loaded.theme).toBe('dark');
		expect(loaded.density).toBe('compact');
	});

	it('keeps a stored `false` instead of replacing it with a `true` default', () => {
		// The bug a naive `value ?? default` would cause: `show_thinking: false`
		// would silently become `true` on every reload.
		saveSettings({ ...DEFAULT_SETTINGS, show_thinking: false });
		expect(loadSettings().show_thinking).toBe(false);
	});
});

describe('settings: validation', () => {
	beforeEach(() => {
		stubStorage();
	});

	it('drops a key that is no longer in the registry', () => {
		localStorage.setItem(
			'alnair.web.settings',
			JSON.stringify({ theme: 'dark', removed_setting: 'x' })
		);
		const loaded = loadSettings();
		expect(loaded).not.toHaveProperty('removed_setting');
		expect(loaded.theme).toBe('dark');
	});

	it('replaces an enum value outside its choices', () => {
		localStorage.setItem('alnair.web.settings', JSON.stringify({ theme: 'neon' }));
		expect(loadSettings().theme).toBe(DEFAULT_SETTINGS.theme);
	});

	it('clamps an int to its declared range', () => {
		localStorage.setItem('alnair.web.settings', JSON.stringify({ context_threshold_percent: 999 }));
		expect(loadSettings().context_threshold_percent).toBe(95);
	});

	it('replaces a wrong-typed value', () => {
		localStorage.setItem('alnair.web.settings', JSON.stringify({ show_thinking: 'yes' }));
		expect(loadSettings().show_thinking).toBe(DEFAULT_SETTINGS.show_thinking);
	});

	it('survives corrupt JSON', () => {
		localStorage.setItem('alnair.web.settings', '{not json');
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
	});

	it('survives a stored array instead of an object', () => {
		localStorage.setItem('alnair.web.settings', '[]');
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
	});

	it('covers every registry entry, so none is left unvalidated', () => {
		// A setting added to the registry without a coerce branch would keep the
		// fallback forever; this pins that every key survives a round trip.
		const all: Record<string, unknown> = {};
		for (const setting of SETTINGS) {
			all[setting.key] =
				setting.kind.kind === 'bool'
					? false
					: setting.kind.kind === 'enum'
						? setting.kind.choices[0].value
						: setting.kind.kind === 'int'
							? setting.kind.min
							: 'x';
		}
		localStorage.setItem('alnair.web.settings', JSON.stringify(all));
		const loaded = loadSettings();
		for (const setting of SETTINGS) {
			expect(loaded[setting.key], setting.key).toEqual(all[setting.key]);
		}
	});
});

describe('settings: a storage that throws', () => {
	it('reads the defaults when access is denied', () => {
		stubStorage({ throwOn: 'get' });
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
	});

	it('does not throw when the write is refused', () => {
		stubStorage({ throwOn: 'set' });
		expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
	});

	it('survives an absent localStorage entirely', () => {
		Object.defineProperty(globalThis, 'localStorage', {
			value: undefined,
			configurable: true,
			writable: true
		});
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
		expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
	});
});

describe('layout', () => {
	beforeEach(() => {
		stubStorage();
	});

	it('is undefined until something is stored', () => {
		// `undefined` is load-bearing: the rail's first-paint default comes from
		// the viewport, so "no preference" and "preferred closed" must differ.
		expect(loadLayout()).toBeUndefined();
	});

	it('round-trips every field', () => {
		saveLayout({ rail: false, drawer: true, drawerTab: 'editor', drawerHeight: 420 });
		expect(loadLayout()).toEqual({
			rail: false,
			drawer: true,
			drawerTab: 'editor',
			drawerHeight: 420
		});
	});

	it('clamps a height outside the drag handle’s bounds', () => {
		localStorage.setItem('alnair.web.layout', JSON.stringify({ drawerHeight: 5000, drawer: true }));
		expect(loadLayout()?.drawerHeight).toBe(900);
		localStorage.setItem('alnair.web.layout', JSON.stringify({ drawerHeight: 1, drawer: true }));
		expect(loadLayout()?.drawerHeight).toBe(140);
	});

	it('defaults a malformed tab name to terminal', () => {
		localStorage.setItem('alnair.web.layout', JSON.stringify({ drawerTab: 'nonsense' }));
		expect(loadLayout()?.drawerTab).toBe('terminal');
	});

	it('survives corrupt JSON', () => {
		localStorage.setItem('alnair.web.layout', 'nope');
		expect(loadLayout()).toBeUndefined();
	});
});

describe('hidden workspaces', () => {
	beforeEach(() => {
		stubStorage();
	});

	it('is empty by default', () => {
		expect(loadHidden()).toEqual([]);
	});

	it('round-trips a list', () => {
		saveHidden(['alpha', 'beta']);
		expect(loadHidden()).toEqual(['alpha', 'beta']);
	});

	it('drops entries that are not strings', () => {
		localStorage.setItem('alnair.web.hidden', JSON.stringify(['ok', 42, null]));
		expect(loadHidden()).toEqual(['ok']);
	});

	it('survives a stored non-array', () => {
		localStorage.setItem('alnair.web.hidden', JSON.stringify({ nope: true }));
		expect(loadHidden()).toEqual([]);
	});
});

describe('namespace', () => {
	it('keeps every key under one prefix', () => {
		const map = stubStorage();
		saveSettings(DEFAULT_SETTINGS);
		saveLayout({ rail: true, drawer: false, drawerTab: 'terminal', drawerHeight: 320 });
		saveHidden(['x']);
		for (const key of map.keys()) {
			expect(key.startsWith('alnair.web.')).toBe(true);
		}
	});
});
