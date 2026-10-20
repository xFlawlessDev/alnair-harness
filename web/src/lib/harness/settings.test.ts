import { describe, expect, it } from 'vitest';
import {
	CATEGORIES,
	DEFAULT_SETTINGS,
	SETTINGS,
	filterSettings,
	settingsByCategory
} from './settings.js';

describe('web settings registry', () => {
	it('gives every setting a category the rail lists', () => {
		const known = new Set(CATEGORIES.map((category) => category.id));
		for (const setting of SETTINGS) {
			expect(known.has(setting.category)).toBe(true);
		}
	});

	it('uses unique keys', () => {
		const keys = SETTINGS.map((setting) => setting.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('gives every setting a default of its own kind', () => {
		for (const setting of SETTINGS) {
			const value = DEFAULT_SETTINGS[setting.key];
			expect(value, `missing default for ${setting.key}`).toBeDefined();
			if (setting.kind.kind === 'bool') expect(typeof value).toBe('boolean');
			if (setting.kind.kind === 'int') expect(typeof value).toBe('number');
			if (setting.kind.kind === 'enum') {
				const allowed = setting.kind.choices.map((choice) => choice.value);
				expect(allowed).toContain(value);
			}
		}
	});

	it('has no empty categories, so the rail never shows a dead tab', () => {
		for (const category of CATEGORIES) {
			expect(settingsByCategory(category.id).length).toBeGreaterThan(0);
		}
	});

	it('carries no default for a key it does not declare', () => {
		const declared = new Set(SETTINGS.map((setting) => setting.key));
		for (const key of Object.keys(DEFAULT_SETTINGS)) {
			expect(declared.has(key), `stray default: ${key}`).toBe(true);
		}
	});

	it('stays out of the TUI registry: no terminal-only settings', () => {
		// These exist in `alnair-tui/src/settings` and mean nothing in a browser.
		// Keeping them out is the point of this registry being its own thing.
		const terminalOnly = [
			'scroll_speed',
			'scroll_mode',
			'invert_scroll',
			'vim_mode',
			'screen_mode',
			'compact_mode',
			'group_tool_verbs',
			'display_refresh_auto_cadence',
			'default_model',
			'fork_secondary_model',
			'auto_update',
			'show_tips',
			'hunk_tracker_mode'
		];
		const keys = SETTINGS.map((setting) => setting.key);
		for (const key of terminalOnly) {
			expect(keys).not.toContain(key);
		}
	});

	it('mirrors only the runtime mode the composer also edits', () => {
		const shared = SETTINGS.filter((setting) => ['permission_mode'].includes(setting.key));
		expect(shared).toHaveLength(1);
	});
});

describe('filterSettings', () => {
	it('returns everything for an empty query', () => {
		expect(filterSettings('')).toHaveLength(SETTINGS.length);
	});

	it('matches the label, the key, the description, and the keywords', () => {
		expect(filterSettings('density').map((setting) => setting.key)).toContain('density');
		expect(filterSettings('enter_to_send').map((setting) => setting.key)).toContain(
			'enter_to_send'
		);
		expect(filterSettings('newline').map((setting) => setting.key)).toContain('enter_to_send');
		expect(filterSettings('yolo').map((setting) => setting.key)).toContain('permission_mode');
	});

	it('is case-insensitive and trims', () => {
		expect(filterSettings('  THEME ').map((setting) => setting.key)).toEqual(['theme']);
	});

	it('returns nothing for a miss', () => {
		expect(filterSettings('zzzz')).toEqual([]);
	});
});
