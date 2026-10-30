import { describe, expect, it } from 'vitest';
import { extensionOf, gitChanges, touchedFiles } from './panel-data.js';
import type { Turn, TurnPart } from '#lib/harness/types.js';

const turn = (parts: TurnPart[]): Turn => ({
	id: `t-${parts.map((part) => part.id).join('-')}`,
	role: 'assistant',
	status: 'complete',
	at: '2026-10-20T09:41:12Z',
	parts
});

const read = (id: string, path: string, lines: string[] = ['a', 'b']): TurnPart => ({
	kind: 'file-read',
	id,
	path,
	language: 'ts',
	lines: lines.map((text, index) => ({ n: index + 1, text })),
	status: 'complete'
});

const write = (id: string, path: string, lines = ['x']): TurnPart => ({
	kind: 'file-write',
	id,
	path,
	language: 'ts',
	lines: lines.map((text, index) => ({ n: index + 1, text })),
	created: true,
	status: 'complete'
});

const edit = (id: string, path: string, additions = 2, deletions = 1): TurnPart => ({
	kind: 'file-edit',
	id,
	path,
	language: 'ts',
	hunks: [
		{
			id: `${id}-h0`,
			header: '@@ -1,1 +1,2 @@',
			lines: [
				{ kind: 'remove', oldNumber: 1, text: 'old' },
				{ kind: 'add', newNumber: 1, text: 'new' }
			]
		}
	],
	additions,
	deletions,
	status: 'complete'
});

const image = (id: string, path: string): TurnPart => ({
	kind: 'image-read',
	id,
	path,
	src: 'data:image/png;base64,AA',
	mime: 'image/png',
	status: 'complete'
});

describe('touchedFiles', () => {
	it('lists every file the thread named, sorted by path', () => {
		const files = touchedFiles([turn([read('r1', 'src/b.ts'), edit('e1', 'src/a.ts')])]);
		expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
	});

	it('collapses a file read and then edited into one row', () => {
		const files = touchedFiles([turn([read('r1', 'src/a.ts')]), turn([edit('e1', 'src/a.ts')])]);
		expect(files).toHaveLength(1);
		expect(files[0].action).toBe('edit');
	});

	it('keeps the earlier content when the newer record is an edit', () => {
		// An edit carries only hunks; the preview must still have the file body
		// the earlier read supplied, or the pane would show nothing.
		const files = touchedFiles([
			turn([read('r1', 'src/a.ts', ['one', 'two'])]),
			turn([edit('e1', 'src/a.ts')])
		]);
		expect(files[0].content).toBe('one\ntwo');
		expect(files[0].lines).toHaveLength(2);
		expect(files[0].patch).toContain('@@ -1,1 +1,2 @@');
	});

	it('takes the newer content when the newer record has it', () => {
		const files = touchedFiles([
			turn([read('r1', 'src/a.ts', ['stale'])]),
			turn([write('w1', 'src/a.ts', ['fresh'])])
		]);
		expect(files[0].content).toBe('fresh');
		expect(files[0].action).toBe('write');
	});

	it('marks an image read as an image, keeping its src', () => {
		const files = touchedFiles([turn([image('i1', 'shot.png')])]);
		expect(files[0].kind).toBe('image');
		expect(files[0].src).toBe('data:image/png;base64,AA');
	});

	it('sums nothing from a read into the edit counts', () => {
		const files = touchedFiles([turn([read('r1', 'a.ts'), edit('e1', 'a.ts', 5, 2)])]);
		expect(files[0].additions).toBe(5);
		expect(files[0].deletions).toBe(2);
	});

	it('ignores a part that names no file', () => {
		const files = touchedFiles([
			turn([{ kind: 'tool', id: 'x', name: 'grep', summary: 'search', status: 'complete' }])
		]);
		expect(files).toEqual([]);
	});

	it('returns nothing for an empty transcript', () => {
		expect(touchedFiles([])).toEqual([]);
	});
});

describe('gitChanges', () => {
	it('flattens staged and unstaged into one list', () => {
		const changes = gitChanges({
			staged: [{ path: 'a.ts', type: 'modified', additions: 1, deletions: 0 }],
			unstaged: [{ path: 'b.ts', type: 'modified', additions: 0, deletions: 3 }]
		});
		expect(changes.map((change) => change.path)).toEqual(['a.ts', 'b.ts']);
		expect(changes[0].staged).toBe(true);
		expect(changes[1].staged).toBe(false);
	});

	it('reports a file that is both staged and modified once, as staged', () => {
		const changes = gitChanges({
			staged: [{ path: 'a.ts', type: 'modified', additions: 2, deletions: 0 }],
			unstaged: [{ path: 'a.ts', type: 'modified', additions: 1, deletions: 1 }]
		});
		expect(changes).toHaveLength(1);
		expect(changes[0].staged).toBe(true);
		// Counts are summed so the second half of the change does not vanish.
		expect(changes[0].additions).toBe(3);
		expect(changes[0].deletions).toBe(1);
	});

	it('defaults an unknown type rather than dropping the row', () => {
		const changes = gitChanges({ unstaged: [{ path: 'a.ts' }] });
		expect(changes[0].type).toBe('modified');
	});

	it('skips an entry with no path', () => {
		expect(gitChanges({ unstaged: [{ type: 'modified' }] })).toEqual([]);
	});

	it('survives a missing or malformed status', () => {
		expect(gitChanges(undefined)).toEqual([]);
		expect(gitChanges(null)).toEqual([]);
		expect(gitChanges({})).toEqual([]);
		expect(gitChanges({ staged: 'nope' })).toEqual([]);
	});

	it('sorts by path so the list does not jump between refreshes', () => {
		const changes = gitChanges({
			unstaged: [{ path: 'z.ts' }, { path: 'a.ts' }]
		});
		expect(changes.map((change) => change.path)).toEqual(['a.ts', 'z.ts']);
	});
});

describe('extensionOf', () => {
	it('reads the extension of a file name', () => {
		expect(extensionOf('web/src/lib/composer.svelte')).toBe('svelte');
		expect(extensionOf('C:\\repo\\main.rs')).toBe('rs');
	});

	it('returns an empty string for a dotfile or no extension', () => {
		expect(extensionOf('.gitignore')).toBe('');
		expect(extensionOf('Makefile')).toBe('');
	});
});
