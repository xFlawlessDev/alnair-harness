import { describe, expect, it } from 'vitest';
import { workSummary } from './segments.js';
import type { TurnPart } from '#lib/harness/types.js';

const tool = (id: string, summary = 'grep -rn foo'): TurnPart => ({
	kind: 'tool',
	id,
	name: 'grep',
	summary,
	status: 'complete'
});

const terminal = (id: string, command = 'npm test'): TurnPart => ({
	kind: 'terminal',
	id,
	command,
	output: '',
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

const edit = (id: string, path: string, additions = 2, deletions = 1): TurnPart => ({
	kind: 'file-edit',
	id,
	path,
	language: 'ts',
	hunks: [],
	additions,
	deletions,
	status: 'complete'
});

const subagent = (id: string, title = 'scan the repo'): TurnPart => ({
	kind: 'subagent',
	id,
	title,
	agent: 'explore',
	status: 'complete',
	turnCount: 1,
	toolCallCount: 2,
	tokensUsed: 100,
	toolsUsed: []
});

const errorPart = (id: string, title = 'Command failed'): TurnPart => ({
	kind: 'error',
	id,
	title,
	message: 'exit 1'
});

describe('workSummary', () => {
	it('returns nothing for a turn that only spoke', () => {
		expect(workSummary([{ kind: 'text', id: 't', text: 'hello' }])).toEqual([]);
	});

	it('counts tool calls and terminal commands together', () => {
		const rows = workSummary([tool('a'), terminal('b')]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: 'calls', label: '2 calls' });
	});

	it('names the first command as the example', () => {
		// A terminal part is listed before a generic tool, so its command is the
		// one a reader recognises.
		const rows = workSummary([tool('a'), terminal('b', 'cargo test')]);
		expect(rows[0].detail).toBe('cargo test');
	});

	it('falls back to a tool summary when no command ran', () => {
		expect(workSummary([tool('a', 'search for auth')])[0].detail).toBe('search for auth');
	});

	it('reports edits before reads, because they are the rarer event', () => {
		const rows = workSummary([read('r1', 'src/a.ts'), edit('e1', 'src/b.ts')]);
		expect(rows.map((row) => row.kind)).toEqual(['writes', 'reads']);
	});

	it('uses the file NAME, not the whole path, as the example', () => {
		const rows = workSummary([edit('e1', 'web/src/lib/deep/nested/composer.svelte')]);
		expect(rows[0].detail).toBe('composer.svelte');
	});

	it('says "1 file edited", not "1 files edited"', () => {
		expect(workSummary([edit('e1', 'a.ts')])[0].label).toBe('1 file edited');
		expect(workSummary([edit('e1', 'a.ts'), edit('e2', 'b.ts')])[0].label).toBe('2 files edited');
	});

	it('counts image reads with file reads', () => {
		const image: TurnPart = {
			kind: 'image-read',
			id: 'i1',
			path: 'shot.png',
			src: 'data:image/png;base64,AA',
			mime: 'image/png',
			status: 'complete'
		};
		const rows = workSummary([read('r1', 'a.ts'), image]);
		expect(rows.find((row) => row.kind === 'reads')?.label).toBe('2 files read');
	});

	it('reports subagents with their description', () => {
		const rows = workSummary([subagent('s1', 'scan the palette')]);
		expect(rows[0]).toMatchObject({
			kind: 'subagents',
			label: '1 subagent',
			detail: 'scan the palette'
		});
	});

	it('puts errors last, so a scannable line ends on the one that matters', () => {
		const rows = workSummary([errorPart('x1'), tool('a'), edit('e1', 'a.ts')]);
		expect(rows.map((row) => row.kind)).toEqual(['calls', 'writes', 'errors']);
	});

	it('omits a kind that did not happen', () => {
		const rows = workSummary([tool('a')]);
		expect(rows.some((row) => row.kind === 'errors')).toBe(false);
		expect(rows.some((row) => row.kind === 'reads')).toBe(false);
	});

	it('clips a long example to one line', () => {
		const long = 'a'.repeat(200);
		const rows = workSummary([terminal('t', long)]);
		expect(rows[0].detail?.length).toBeLessThanOrEqual(48);
		expect(rows[0].detail?.endsWith('…')).toBe(true);
	});

	it('keeps only the first line of a multi-line command', () => {
		const rows = workSummary([terminal('t', 'cd x\nrm -rf y')]);
		expect(rows[0].detail).toBe('cd x');
	});
});
