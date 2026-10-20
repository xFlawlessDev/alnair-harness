import type { ContextUsage } from './types.js';

/**
 * The context panel's accounting, kept out of the component so the rules are
 * testable.
 *
 * Every row is a field the agent actually reports (`ContextInfo`). The one
 * derived row is `Overhead`: whatever `used` exceeds the itemized figures by,
 * which is where the skills and MCP rows are counted from.
 */
export interface ContextRow {
	label: string;
	tokens: number;
	detail?: string;
	/** Tailwind background class for the legend swatch and the matrix cells. */
	tone: string;
}

/** One cell of the matrix: a tone class, or `null` for free space. */
export type ContextCell = string | null;

export const MATRIX_COLUMNS = 20;
export const MATRIX_ROWS = 5;
export const MATRIX_CELLS = MATRIX_COLUMNS * MATRIX_ROWS;

export function contextRows(usage: ContextUsage): ContextRow[] {
	const accounted = usage.systemPromptTokens + usage.toolDefinitionsTokens + usage.messageTokens;
	const overhead = Math.max(0, usage.used - accounted);

	return [
		{
			label: 'System prompt',
			tokens: usage.systemPromptTokens,
			tone: 'bg-ink-tertiary/70'
		},
		{
			label: 'Tool definitions',
			tokens: usage.toolDefinitionsTokens,
			detail: usage.toolDefinitionsCount > 0 ? `${usage.toolDefinitionsCount} tools` : undefined,
			tone: 'bg-system'
		},
		{
			label: 'Conversation',
			tokens: usage.messageTokens,
			detail: usage.messageCount > 0 ? `${usage.messageCount} items` : undefined,
			tone: 'bg-assistant'
		},
		...(overhead > 0
			? [{ label: 'Overhead', tokens: overhead, detail: 'not itemized', tone: 'bg-terra' }]
			: []),
		...usage.categories.map((category) => ({
			label: category.label,
			tokens: category.tokens,
			detail: category.detail,
			tone: 'bg-success'
		}))
	];
}

/**
 * Assign every cell a row, filling in legend order, then pad with free space.
 *
 * A category with any tokens gets at least one cell: at a 262k window one cell
 * is ~2.6k tokens, and a row that rounds to zero would vanish from the matrix
 * while still appearing in the legend.
 */
export function contextCells(usage: ContextUsage, rows: ContextRow[]): ContextCell[] {
	const out: ContextCell[] = [];
	if (usage.limit <= 0) return Array<ContextCell>(MATRIX_CELLS).fill(null);

	const perCell = usage.limit / MATRIX_CELLS;
	let remaining = Math.round((usage.used / usage.limit) * MATRIX_CELLS);
	// Any usage at all must show: at a large window a small figure rounds to
	// zero cells and the matrix would read as empty.
	if (remaining === 0 && usage.used > 0) remaining = 1;

	for (const row of rows) {
		if (remaining <= 0) break;
		let count = Math.round(row.tokens / perCell);
		if (count === 0 && row.tokens > 0) count = 1;
		count = Math.min(count, remaining);
		for (let index = 0; index < count; index += 1) out.push(row.tone);
		remaining -= count;
	}

	// Used space the rows did not claim still reads as used.
	while (remaining > 0) {
		out.push('bg-ink-tertiary/40');
		remaining -= 1;
	}

	while (out.length < MATRIX_CELLS) out.push(null);
	return out;
}
