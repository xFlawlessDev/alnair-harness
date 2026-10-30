import { fileName } from '#lib/harness/format.js';
import type { Turn, TurnPart } from '#lib/harness/types.js';

/**
 * The files ONE turn changed, for the summary at the end of it.
 *
 * The inspector's `touchedFiles` answers "what did this session touch" — a
 * merged, deduplicated list, which is the right shape for a file browser and
 * the wrong shape for an audit. A reader reviewing a long session needs "what
 * did THIS turn change", in order, because that is the unit they can check,
 * revert or ask about. Merging across turns also silently hides a file that was
 * edited twice: the second edit replaces the first and the history is gone.
 *
 * Reads are excluded on purpose. A read is not a change, and a turn that opens
 * forty files to answer one question would bury the two it edited.
 */
export interface TurnChange {
	path: string;
	/** `write` for a new file, `edit` for a change to an existing one. */
	action: 'write' | 'overwrite' | 'edit';
	additions: number;
	deletions: number;
	/** The unified patch, for an edit. Absent for a whole-file write. */
	patch?: string;
	/** The whole file, for a write. */
	lines?: { n: number; text: string }[];
	language: string;
}

/**
 * The changes a turn made, one row per file, in the order they happened.
 *
 * Two edits to the same path inside one turn are merged into a single row with
 * summed counts: they are one intent, and the panel shows the last patch. Across
 * turns they stay separate, which is the whole point.
 */
export function turnChanges(turn: Turn): TurnChange[] {
	const rows: TurnChange[] = [];

	for (const part of turn.parts) {
		const change = changeFrom(part);
		if (!change) continue;

		const existing = rows.find((row) => row.path === change.path);
		if (!existing) {
			rows.push(change);
			continue;
		}
		// Same file, later in the same turn: keep the newer body and sum the
		// counts, so nothing the agent did disappears from the totals.
		existing.additions += change.additions;
		existing.deletions += change.deletions;
		existing.action = change.action;
		existing.patch = change.patch ?? existing.patch;
		existing.lines = change.lines ?? existing.lines;
	}

	return rows;
}

function changeFrom(part: TurnPart): TurnChange | undefined {
	switch (part.kind) {
		case 'file-write':
			return {
				path: part.path,
				action: part.created ? 'write' : 'overwrite',
				additions: part.lines.length,
				deletions: 0,
				lines: part.lines,
				language: part.language
			};
		case 'file-edit':
			return {
				path: part.path,
				action: 'edit',
				additions: part.additions,
				deletions: part.deletions,
				patch: part.hunks
					.map(
						(hunk) =>
							`${hunk.header}\n${hunk.lines
								.map(
									(line) =>
										`${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`
								)
								.join('\n')}`
					)
					.join('\n'),
				language: part.language
			};
		default:
			return undefined;
	}
}

/** The totals a turn's change list should show. */
export function changeTotals(changes: TurnChange[]): { additions: number; deletions: number } {
	return changes.reduce(
		(sum, change) => ({
			additions: sum.additions + change.additions,
			deletions: sum.deletions + change.deletions
		}),
		{ additions: 0, deletions: 0 }
	);
}

/** `composer.svelte`, for the one-line row. */
export const changeLabel = (change: TurnChange): string => fileName(change.path);
