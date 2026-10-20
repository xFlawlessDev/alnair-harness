import { describe, expect, it } from 'vitest';
import { groupParts } from './segments.js';
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
