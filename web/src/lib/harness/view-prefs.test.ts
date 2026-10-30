import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_PREFS, viewPrefs } from './view-prefs.js';
import { DEFAULT_SETTINGS } from './settings.js';

/**
 * The bridge between the settings registry and what a transcript row renders.
 *
 * Worth testing because the two vocabularies are easy to cross: the registry
 * spells a setting `show_thinking` and a row asks for `thinking`, and a missing
 * `!== false` here is the difference between "the setting works" and "the
 * setting silently does nothing" — which is how the dialog spent a release full
 * of dead controls.
 */
describe('viewPrefs', () => {
	it('maps the registry onto the row vocabulary', () => {
		expect(viewPrefs(DEFAULT_SETTINGS)).toEqual(DEFAULT_VIEW_PREFS);
	});

	it('honours each boolean', () => {
		expect(viewPrefs({ ...DEFAULT_SETTINGS, show_timestamps: false }).timestamps).toBe(false);
		expect(viewPrefs({ ...DEFAULT_SETTINGS, show_thinking: false }).thinking).toBe(false);
		expect(viewPrefs({ ...DEFAULT_SETTINGS, collapse_edits: false }).collapseEdits).toBe(false);
		expect(viewPrefs({ ...DEFAULT_SETTINGS, render_mermaid: true }).mermaid).toBe(true);
	});

	it('treats a missing key as the default, not as false', () => {
		// A store that has not restored yet, or an older build's settings object.
		// Reading absence as "off" would hide reasoning for everyone.
		const sparse = {} as typeof DEFAULT_SETTINGS;
		expect(viewPrefs(sparse)).toEqual(DEFAULT_VIEW_PREFS);
	});

	it('narrows density to the two values the thread knows', () => {
		expect(viewPrefs({ ...DEFAULT_SETTINGS, density: 'compact' }).density).toBe('compact');
		expect(viewPrefs({ ...DEFAULT_SETTINGS, density: 'comfortable' }).density).toBe('comfortable');
		// A value from a future build must not reach a class name.
		expect(viewPrefs({ ...DEFAULT_SETTINGS, density: 'ultra' }).density).toBe('comfortable');
	});

	it('matches the registry’s own defaults', () => {
		// If the registry changes a default, this projection must follow it —
		// otherwise the setting and the rendered thread disagree from the start.
		expect(DEFAULT_VIEW_PREFS.thinking).toBe(DEFAULT_SETTINGS.show_thinking !== false);
		expect(DEFAULT_VIEW_PREFS.timestamps).toBe(DEFAULT_SETTINGS.show_timestamps !== false);
		expect(DEFAULT_VIEW_PREFS.collapseEdits).toBe(DEFAULT_SETTINGS.collapse_edits === true);
	});
});
