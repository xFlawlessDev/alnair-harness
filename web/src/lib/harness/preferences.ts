import { DEFAULT_SETTINGS, SETTINGS, type SettingsState, type SettingValue } from './settings.js';

/**
 * Preferences that survive a reload.
 *
 * A browser tab has no `~/.alnair/config.toml`: without this, every reload reset
 * the density, the panel layout, the hidden workspaces and every setting in the
 * dialog. For a reader whose only surface is the browser, that is the
 * difference between an application and a page.
 *
 * Two rules hold throughout:
 *
 * - **Every read is fallible.** `localStorage` throws when access is denied (a
 *   partitioned or private context), and a stored value may come from an older
 *   build. A failed read returns the default; nothing here throws into a
 *   constructor or an event handler.
 * - **Every stored value is validated against the registry.** A key that no
 *   longer exists is dropped and a value outside its enum is replaced, so an
 *   old build's data can never reach a component as a type it cannot handle.
 */

const PREFIX = 'alnair.web.';

function read(key: string): string | undefined {
	try {
		return globalThis.localStorage?.getItem(`${PREFIX}${key}`) ?? undefined;
	} catch {
		return undefined;
	}
}

function write(key: string, value: string): void {
	try {
		globalThis.localStorage?.setItem(`${PREFIX}${key}`, value);
	} catch {
		// Quota exhausted or storage denied. The UI keeps working; it just will
		// not remember. Never rethrow: this runs inside event handlers.
	}
}

function readJson(key: string): unknown {
	const raw = read(key);
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		// Half-written or hand-edited. The default is the answer.
		return undefined;
	}
}

/* ------------------------------------------------------------- settings */

/**
 * One stored setting, coerced to what its registry entry allows.
 *
 * Driven by `SettingMeta.kind` rather than a hand-written per-key list: the
 * registry already says `density` is one of two strings and the threshold is an
 * int in a range, so validation and the dialog cannot drift apart, and a new
 * setting needs no change here.
 */
function coerce(key: string, raw: unknown, fallback: SettingValue): SettingValue {
	const meta = SETTINGS.find((setting) => setting.key === key);
	if (!meta) return fallback;

	switch (meta.kind.kind) {
		case 'bool':
			return typeof raw === 'boolean' ? raw : fallback;
		case 'enum': {
			const allowed = meta.kind.choices.map((choice) => choice.value);
			return typeof raw === 'string' && allowed.includes(raw) ? raw : fallback;
		}
		case 'int':
			if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
			return Math.min(meta.kind.max, Math.max(meta.kind.min, Math.round(raw)));
		case 'string':
			return typeof raw === 'string' ? raw : fallback;
	}
}

/** Every setting, with unknown keys dropped and invalid values replaced. */
export function loadSettings(): SettingsState {
	const stored = readJson('settings');
	const record =
		stored && typeof stored === 'object' && !Array.isArray(stored)
			? (stored as Record<string, unknown>)
			: {};

	const next: SettingsState = { ...DEFAULT_SETTINGS };
	for (const setting of SETTINGS) {
		// `in` rather than a value check, so a stored `false` is not read as
		// "unset" and quietly replaced by a `true` default.
		if (!(setting.key in record)) continue;
		next[setting.key] = coerce(setting.key, record[setting.key], DEFAULT_SETTINGS[setting.key]);
	}
	return next;
}

export function saveSettings(settings: SettingsState): void {
	write('settings', JSON.stringify(settings));
}

/* --------------------------------------------------------------- layout */

/**
 * The panel layout, remembered.
 *
 * One key rather than four: they are read together on mount and written
 * together when they change, and separate keys could be observed
 * half-updated.
 */
export interface LayoutState {
	/** The right rail (files and source control). */
	rail: boolean;
	/** The bottom drawer (editor and terminal). */
	drawer: boolean;
	drawerTab: 'terminal' | 'editor';
	/** Drawer height in px, clamped to the drag handle's own bounds. */
	drawerHeight: number;
}

/** Must match the drawer's own MIN/MAX, or a restored height is unreachable. */
const MIN_DRAWER = 140;
const MAX_DRAWER = 900;

/**
 * The stored layout, or `undefined` when nothing has been stored yet.
 *
 * `undefined` is meaningful: the rail's first-paint default comes from the
 * viewport width, so "no preference" and "preferred closed" must be
 * distinguishable — otherwise a reader who closed the rail on a wide window
 * would get it back on every resize.
 */
export function loadLayout(): LayoutState | undefined {
	const stored = readJson('layout');
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
	const record = stored as Record<string, unknown>;

	return {
		rail: typeof record.rail === 'boolean' ? record.rail : true,
		drawer: record.drawer === true,
		drawerTab: record.drawerTab === 'editor' ? 'editor' : 'terminal',
		// Clamped: a height dragged on a tall monitor must not open a drawer
		// taller than the laptop it is restored on.
		drawerHeight:
			typeof record.drawerHeight === 'number' && Number.isFinite(record.drawerHeight)
				? Math.min(MAX_DRAWER, Math.max(MIN_DRAWER, Math.round(record.drawerHeight)))
				: 320
	};
}

export function saveLayout(layout: LayoutState): void {
	write('layout', JSON.stringify(layout));
}

/* ------------------------------------------------------ hidden workspaces */

/**
 * Workspaces the reader put away, by display name.
 *
 * Kept separately from the layout because it is written from the store (which
 * owns the workspace list) while the layout is written from the page.
 */
export function loadHidden(): string[] {
	const stored = readJson('hidden');
	return Array.isArray(stored)
		? stored.filter((entry): entry is string => typeof entry === 'string')
		: [];
}

export function saveHidden(names: string[]): void {
	write('hidden', JSON.stringify(names));
}
