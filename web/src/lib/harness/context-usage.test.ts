import { describe, expect, it } from 'vitest';
import { contextRows, contextCells } from './context-usage.js';
import type { ContextUsage } from './types.js';

const usage = (patch: Partial<ContextUsage> = {}): ContextUsage => ({
	used: 61_440,
	limit: 262_144,
	percent: 23,
	systemPromptTokens: 4_200,
	toolDefinitionsTokens: 12_800,
	toolDefinitionsCount: 18,
	messageTokens: 40_300,
	messageCount: 96,
	turnCount: 7,
	toolCallCount: 34,
	compactionCount: 0,
	freeTokens: 200_704,
	autoCompactThresholdPercent: 85,
	categories: [],
	...patch
});

describe('contextRows', () => {
	it('lists only the categories the agent measures', () => {
		const rows = contextRows(usage());
		expect(rows.map((row) => row.label)).toEqual([
			'System prompt',
			'Tool definitions',
			'Conversation',
			'Overhead'
		]);
	});

	it('computes overhead as what the itemized figures do not account for', () => {
		// 61_440 used − (4_200 + 12_800 + 40_300) = 4_140.
		const overhead = contextRows(usage()).find((row) => row.label === 'Overhead');
		expect(overhead?.tokens).toBe(4_140);
	});

	it('omits overhead when the itemized figures account for everything', () => {
		const rows = contextRows(
			usage({
				used: 57_300,
				systemPromptTokens: 4_200,
				toolDefinitionsTokens: 12_800,
				messageTokens: 40_300
			})
		);
		expect(rows.some((row) => row.label === 'Overhead')).toBe(false);
	});

	it('appends the itemized rows the agent sent', () => {
		const rows = contextRows(
			usage({ categories: [{ label: 'Skills', tokens: 2_900, detail: '12 skills' }] })
		);
		expect(rows.at(-1)).toMatchObject({ label: 'Skills', tokens: 2_900, detail: '12 skills' });
	});
});

describe('contextCells', () => {
	it('always returns a full 100-cell matrix', () => {
		expect(contextCells(usage(), contextRows(usage()))).toHaveLength(100);
	});

	it('fills roughly as many cells as the percentage used', () => {
		const rows = contextRows(usage());
		const filled = contextCells(usage(), rows).filter((cell) => cell !== null).length;
		// 23% of 100 cells.
		expect(filled).toBe(23);
	});

	it('leaves every cell empty when nothing is used', () => {
		const empty = usage({
			used: 0,
			systemPromptTokens: 0,
			toolDefinitionsTokens: 0,
			messageTokens: 0
		});
		expect(contextCells(empty, contextRows(empty)).every((cell) => cell === null)).toBe(true);
	});

	it('gives a tiny category at least one cell so its row stays visible', () => {
		const tiny = usage({
			used: 1_000,
			systemPromptTokens: 10,
			toolDefinitionsTokens: 980,
			messageTokens: 10,
			categories: []
		});
		const cells = contextCells(tiny, contextRows(tiny));
		expect(cells.filter((cell) => cell !== null).length).toBeGreaterThanOrEqual(1);
	});
});
