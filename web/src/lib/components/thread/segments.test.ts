import { describe, expect, it } from 'vitest';
import { groupParts, splitFinalWork } from './segments.js';
import type { TurnPart } from '#lib/harness/types.js';

const text = (id: string): TurnPart => ({ kind: 'text', id, text: id });
const tool = (id: string): TurnPart => ({
	kind: 'tool',
	id,
	name: 'grep',
	summary: 'x',
	status: 'complete'
});
const reasoning = (id: string): TurnPart => ({
	kind: 'reasoning',
	id,
	text: '',
	status: 'complete'
});
const notice = (id: string): TurnPart => ({
	kind: 'notice',
	id,
	tone: 'info',
	title: 'retrying'
});
const permission = (id: string): TurnPart => ({
	kind: 'permission',
	id,
	toolCallId: 'c1',
	title: 'Edit a file',
	toolKind: 'edit',
	options: [],
	resolved: false
});

describe('groupParts', () => {
	it('keeps consecutive trace parts in one segment', () => {
		const segments = groupParts([reasoning('a'), tool('b'), tool('c')]);
		expect(segments).toHaveLength(1);
		expect(segments[0]).toMatchObject({ kind: 'trace' });
		expect(segments[0].kind === 'trace' && segments[0].parts.map((p) => p.id)).toEqual([
			'a',
			'b',
			'c'
		]);
	});

	it('breaks the trace run at text, notices and permission cards', () => {
		const segments = groupParts([
			reasoning('a'),
			text('t1'),
			tool('b'),
			notice('n1'),
			tool('c'),
			permission('p1')
		]);
		expect(segments.map((segment) => segment.kind)).toEqual([
			'trace',
			'text',
			'trace',
			'notice',
			'trace',
			'permission'
		]);
	});

	it('drops nothing and preserves order', () => {
		const parts = [text('t1'), reasoning('r1'), text('t2')];
		const flattened = groupParts(parts).flatMap((segment) =>
			segment.kind === 'trace' ? segment.parts.map((part) => part.id) : [segment.part.id]
		);
		expect(flattened).toEqual(['t1', 'r1', 't2']);
	});

	it('returns nothing for an empty turn', () => {
		expect(groupParts([])).toEqual([]);
	});
});

describe('splitFinalWork', () => {
	it('splits the steps from the answer that follows them', () => {
		const parts = [reasoning('r1'), tool('t1'), text('answer')];
		const split = splitFinalWork(parts);
		expect(split.work.map((part) => part.id)).toEqual(['r1', 't1']);
		expect(split.answer?.id).toBe('answer');
		expect(split.tail).toEqual([]);
	});

	it('treats the LAST text as the answer, keeping earlier commentary with the work', () => {
		// "let me check the tests" is narration between steps, not the reply.
		const parts = [text('narration'), tool('t1'), text('answer')];
		const split = splitFinalWork(parts);
		expect(split.work.map((part) => part.id)).toEqual(['narration', 't1']);
		expect(split.answer?.id).toBe('answer');
	});

	it('folds an answered permission card and a notice into the work', () => {
		const parts = [permission('p1'), notice('n1'), tool('t1'), text('answer')];
		const split = splitFinalWork(parts);
		expect(split.work.map((part) => part.id)).toEqual(['p1', 'n1', 't1']);
	});

	it('keeps everything visible when the turn produced no answer', () => {
		// A cancelled turn, or one that ended on a tool call: hiding every row
		// would leave an empty screen and a button.
		const parts = [tool('t1'), tool('t2')];
		const split = splitFinalWork(parts);
		expect(split.work).toEqual([]);
		expect(split.answer).toBeUndefined();
		expect(split.tail).toEqual(parts);
	});

	it('ignores a whitespace-only text part when looking for the answer', () => {
		const parts = [tool('t1'), { kind: 'text', id: 'blank', text: '   ' } as TurnPart];
		const split = splitFinalWork(parts);
		expect(split.work).toEqual([]);
		expect(split.tail).toHaveLength(2);
	});

	it('keeps anything after the answer in the tail', () => {
		const parts = [tool('t1'), text('answer'), notice('after')];
		const split = splitFinalWork(parts);
		expect(split.work.map((part) => part.id)).toEqual(['t1']);
		expect(split.tail.map((part) => part.id)).toEqual(['after']);
	});

	it('has no work to fold when the answer is the whole turn', () => {
		const split = splitFinalWork([text('answer')]);
		expect(split.work).toEqual([]);
		expect(split.answer?.id).toBe('answer');
	});

	it('returns an empty split for an empty turn', () => {
		expect(splitFinalWork([])).toEqual({ work: [], answer: undefined, tail: [] });
	});
});
