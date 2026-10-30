import { describe, expect, it } from 'vitest';
import { changeTotals, turnChanges } from './turn-changes.js';
import type { Turn, TurnPart } from '#lib/harness/types.js';

/**
 * Per-turn changes are the audit trail, so the rules worth pinning are the ones
 * that make an audit trustworthy: nothing a turn did may be dropped, and two
 * turns must never be merged.
 */

const turn = (parts: TurnPart[]): Turn => ({
	id: 't1',
	role: 'assistant',
	status: 'complete',
	at: '2026-10-20T09:41:12Z',
	parts
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

const write = (id: string, path: string, lines = ['a', 'b']): TurnPart => ({
	kind: 'file-write',
	id,
	path,
	language: 'ts',
	lines: lines.map((text, index) => ({ n: index + 1, text })),
	created: true,
	status: 'complete'
});

const read = (id: string, path: string): TurnPart => ({
	kind: 'file-read',
	id,
	path,
	language: 'ts',
	lines: [],
	status: 'complete'
});

describe('turnChanges', () => {
	it('lists the files a turn changed, in order', () => {
		const changes = turnChanges(turn([edit('e1', 'b.ts'), write('w1', 'a.ts')]));
		expect(changes.map((change) => change.path)).toEqual(['b.ts', 'a.ts']);
	});

	it('excludes reads, which are not changes', () => {
		// A turn that reads forty files to answer one question would otherwise
		// bury the two it edited.
		const changes = turnChanges(turn([read('r1', 'huge.ts'), edit('e1', 'a.ts')]));
		expect(changes.map((change) => change.path)).toEqual(['a.ts']);
	});

	it('marks a new file as a write and an existing one as an edit', () => {
		const changes = turnChanges(turn([write('w1', 'new.ts'), edit('e1', 'old.ts')]));
		expect(changes[0].action).toBe('write');
		expect(changes[1].action).toBe('edit');
	});

	it('merges two edits of the same file INSIDE one turn', () => {
		const changes = turnChanges(turn([edit('e1', 'a.ts', 3, 1), edit('e2', 'a.ts', 2, 4)]));
		expect(changes).toHaveLength(1);
		expect(changes[0].additions).toBe(5);
		expect(changes[0].deletions).toBe(5);
	});

	it('does NOT merge across turns', () => {
		// The whole point: a file edited in turn 1 and turn 2 must appear in both
		// lists, or the audit cannot say which turn did what.
		const first = turnChanges(turn([edit('e1', 'a.ts')]));
		const second = turnChanges(turn([edit('e2', 'a.ts')]));
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
	});

	it('keeps the newest body when a file is written twice in one turn', () => {
		const changes = turnChanges(
			turn([write('w1', 'a.ts', ['first']), write('w2', 'a.ts', ['second'])])
		);
		expect(changes).toHaveLength(1);
		expect(changes[0].lines?.map((line) => line.text)).toEqual(['second']);
	});

	it('carries a patch for an edit and the lines for a write', () => {
		const [edited] = turnChanges(turn([edit('e1', 'a.ts')]));
		expect(edited.patch).toContain('@@ -1,1 +1,2 @@');
		expect(edited.patch).toContain('+new');

		const [written] = turnChanges(turn([write('w1', 'b.ts')]));
		expect(written.patch).toBeUndefined();
		expect(written.lines).toHaveLength(2);
	});

	it('ignores parts that change nothing', () => {
		const changes = turnChanges(
			turn([
				{ kind: 'text', id: 't', text: 'hi' },
				{ kind: 'tool', id: 'x', name: 'grep', summary: 's', status: 'complete' }
			])
		);
		expect(changes).toEqual([]);
	});

	it('returns nothing for an empty turn', () => {
		expect(turnChanges(turn([]))).toEqual([]);
	});
});

describe('changeTotals', () => {
	it('sums every row', () => {
		const changes = turnChanges(turn([edit('e1', 'a.ts', 3, 1), write('w1', 'b.ts', ['x', 'y'])]));
		expect(changeTotals(changes)).toEqual({ additions: 5, deletions: 1 });
	});

	it('is zero for no changes', () => {
		expect(changeTotals([])).toEqual({ additions: 0, deletions: 0 });
	});
});
