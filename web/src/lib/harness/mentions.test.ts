import { describe, expect, it } from 'vitest';
import {
	filterCommands,
	filterEntries,
	fuzzyMatch,
	insertEntry,
	rank,
	sortEntries,
	triggerAt
} from './mentions.js';
import type { FileEntry, SlashCommand } from './types.js';

const file = (path: string, type: FileEntry['type'] = 'file'): FileEntry => ({
	name: path.split('/').pop()!,
	path,
	type
});

describe('triggerAt', () => {
	it('opens the command menu on a leading slash', () => {
		expect(triggerAt('/go', 3)).toEqual({ kind: 'command', query: 'go', start: 0, end: 3 });
	});

	it('ignores a slash inside prose', () => {
		expect(triggerAt('run cargo test /workspace', 25)).toBeNull();
	});

	it('opens the command menu at the start of a later line', () => {
		expect(triggerAt('first line\n/mo', 13)).toMatchObject({ kind: 'command', query: 'mo' });
	});

	it('opens the mention menu anywhere, including mid-sentence', () => {
		// Caret after "web/src" (offset 15), with the rest of the message beyond.
		expect(triggerAt('look at @web/src now', 15)).toMatchObject({
			kind: 'mention',
			query: 'web/src',
			start: 8,
			end: 16
		});
	});

	it('returns nothing for a plain word', () => {
		expect(triggerAt('hello world', 11)).toBeNull();
	});

	it('measures the token under the caret, not to the end of the line', () => {
		// The caret sits inside the token; accepting must still replace the whole
		// word, so `end` reaches past the caret to the next boundary. The query
		// is the whole token, which is what the filter should use.
		expect(triggerAt('@web/src rest', 4)).toEqual({
			kind: 'mention',
			query: 'web/src',
			start: 0,
			end: 8
		});
	});
});

describe('insertEntry', () => {
	it('replaces the token and leaves the rest of the message alone', () => {
		const trigger = triggerAt('check @web/src please', 14)!;
		const next = insertEntry('check @web/src please', trigger, '@web/src/app.css');
		expect(next.value).toBe('check @web/src/app.css please');
	});

	it('puts the caret at the end when the token is the whole message', () => {
		// Nothing follows, so there is no space to add and nowhere else to go.
		const trigger = triggerAt('/go', 3)!;
		const next = insertEntry('/go', trigger, '/goal');
		expect(next.value).toBe('/goal');
		expect(next.caret).toBe(5);
	});

	it('adds a space before following text so the next word stays separate', () => {
		const trigger = triggerAt('/go please', 3)!;
		const next = insertEntry('/go please', trigger, '/goal');
		expect(next.value).toBe('/goal please');
		// The caret sits right after `/goal`; the existing space follows it.
		expect(next.caret).toBe(5);
	});
});

describe('ranking', () => {
	it('matches a subsequence', () => {
		expect(fuzzyMatch('wsc', 'web/src/components')).toBe(true);
		expect(fuzzyMatch('xyz', 'web/src')).toBe(false);
	});

	it('orders prefix before substring before subsequence', () => {
		const items = ['src/web', 'web', 'w-e-b'];
		expect(rank(items, 'web', (value) => value)).toEqual(['web', 'src/web', 'w-e-b']);
	});

	it('keeps the incoming order for equal scores', () => {
		expect(rank(['a1', 'a2'], 'a', (value) => value)).toEqual(['a1', 'a2']);
	});
});

describe('menus', () => {
	it('leads with directories, then files, each alphabetical', () => {
		const sorted = sortEntries([
			file('z.ts'),
			file('src', 'directory'),
			file('a.ts'),
			file('docs', 'directory')
		]);
		expect(sorted.map((entry) => entry.name)).toEqual(['docs', 'src', 'a.ts', 'z.ts']);
	});

	it('filters entries by path, alphabetical inside the tier', () => {
		const entries = [file('web/src/app.css'), file('crates/lib.rs'), file('web/package.json')];
		expect(filterEntries(entries, 'web').map((entry) => entry.path)).toEqual([
			'web/package.json',
			'web/src/app.css'
		]);
	});

	it('filters commands by name', () => {
		const commands: SlashCommand[] = [
			{ name: 'goal', description: '' },
			{ name: 'graph', description: '' },
			{ name: 'clear', description: '' }
		];
		expect(filterCommands(commands, 'gr').map((command) => command.name)).toEqual(['graph']);
	});
});
