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
const checkpoint = (id: string): TurnPart => ({ kind: 'checkpoint', id, label: 'c', detail: '' });

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

	it('breaks the trace run at text and checkpoints', () => {
		const segments = groupParts([
			reasoning('a'),
			text('t1'),
			tool('b'),
			checkpoint('c1'),
			tool('c')
		]);
		expect(segments.map((segment) => segment.kind)).toEqual([
			'trace',
			'text',
			'trace',
			'checkpoint',
			'trace'
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
