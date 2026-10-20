import { describe, expect, it } from 'vitest';
import {
	CATEGORIES,
	DEFAULT_SETTINGS,
	SETTINGS,
	filterSettings,
	settingsByCategory
} from './settings.js';

describe('settings registry', () => {
	it('gives every setting a category the rail lists', () => {
		const known = new Set(CATEGORIES.map((category) => category.id));
		for (const setting of SETTINGS) {
			expect(known.has(setting.category)).toBe(true);
		}
	});

	it('uses unique keys, since the key is the config.toml name', () => {
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

	it('keeps declaration order inside a category', () => {
		const keys = settingsByCategory('appearance').map((setting) => setting.key);
		expect(keys[0]).toBe('theme');
	});
});

describe('filterSettings', () => {
	it('returns everything for an empty query', () => {
		expect(filterSettings('')).toHaveLength(SETTINGS.length);
	});

	it('matches the label, the key, and the description', () => {
		expect(filterSettings('compact').map((setting) => setting.key)).toContain('compact_mode');
		expect(filterSettings('permission_mode').map((setting) => setting.key)).toContain(
			'permission_mode'
		);
		expect(filterSettings('yolo').map((setting) => setting.key)).toContain('permission_mode');
	});

	it('is case-insensitive and trims', () => {
		expect(filterSettings('  THEME ').map((setting) => setting.key)).toEqual(['theme']);
	});

	it('returns nothing for a miss', () => {
		expect(filterSettings('zzzz')).toEqual([]);
	});
});
