import { DEFAULT_SETTINGS, type SettingsState } from './settings.js';
import type { ViewPrefs } from './types.js';

/**
 * Project the settings registry onto the values a transcript row renders with.
 *
 * A separate function rather than four lookups at each call site: the thread is
 * a tree of components, and threading `settings` through every level would put
 * the registry's shape into components that only want a boolean. This is the
 * one place the two vocabularies meet, and it is pure — so a test can pin it.
 *
 * **A missing key resolves to the registry's own default, not to `false`.**
 * That matters for two real cases: a store that has not restored yet, and a
 * settings object written by an older build. Reading absence as "off" would
 * hide the agent's reasoning (or unfold every diff) for a reader who never
 * touched the setting — and the direction of that mistake depends on which
 * default the registry chose, which is exactly why it is looked up rather than
 * hardcoded here.
 */
export function viewPrefs(settings: SettingsState): ViewPrefs {
	const pick = (key: string) => settings[key] ?? DEFAULT_SETTINGS[key];
	return {
		timestamps: pick('show_timestamps') !== false,
		thinking: pick('show_thinking') !== false,
		collapseEdits: pick('collapse_edits') === true,
		density: pick('density') === 'compact' ? 'compact' : 'comfortable',
		mermaid: pick('render_mermaid') === true
	};
}

/** The same projection with nothing set, for a caller with no store. */
export const DEFAULT_VIEW_PREFS: ViewPrefs = viewPrefs(DEFAULT_SETTINGS);
