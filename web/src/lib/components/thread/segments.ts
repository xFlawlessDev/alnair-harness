import { fileName } from '#lib/harness/format.js';
import type { TurnPart } from '#lib/harness/types.js';

export type TurnSegment =
	| { kind: 'trace'; parts: TurnPart[] }
	| { kind: 'text'; part: Extract<TurnPart, { kind: 'text' }> }
	| { kind: 'notice'; part: Extract<TurnPart, { kind: 'notice' }> }
	| { kind: 'system'; part: Extract<TurnPart, { kind: 'system' }> }
	| { kind: 'permission'; part: Extract<TurnPart, { kind: 'permission' }> }
	| { kind: 'question'; part: Extract<TurnPart, { kind: 'question' }> };

const TRACE_KINDS = new Set<TurnPart['kind']>([
	'reasoning',
	'tool',
	'file-read',
	'file-write',
	'file-edit',
	'image-read',
	'terminal',
	'subagent',
	'diff',
	'error'
]);

/**
 * Consecutive trace parts share one `Trace.Root`, so the vertical rule between
 * steps stays continuous — the same shape the AI Elements Chat pattern uses.
 *
 * Text breaks the run: it is the agent talking, not a step. Notices and
 * permission cards break it too, because both need to stand on their own.
 */
export function groupParts(parts: TurnPart[]): TurnSegment[] {
	const segments: TurnSegment[] = [];
	let run: TurnPart[] = [];

	const flush = () => {
		if (run.length > 0) {
			segments.push({ kind: 'trace', parts: run });
			run = [];
		}
	};

	for (const part of parts) {
		if (TRACE_KINDS.has(part.kind)) {
			run.push(part);
			continue;
		}

		flush();

		if (part.kind === 'text') segments.push({ kind: 'text', part });
		else if (part.kind === 'notice') segments.push({ kind: 'notice', part });
		else if (part.kind === 'system') segments.push({ kind: 'system', part });
		else if (part.kind === 'permission') segments.push({ kind: 'permission', part });
		else if (part.kind === 'question') segments.push({ kind: 'question', part });
	}

	flush();
	return segments;
}

/**
 * One part of a finished turn: the WORK it did, or the ANSWER it gave.
 *
 * A turn is one answer plus however many steps it took to get there, and the
 * steps are what makes a long thread unreadable — forty tool rows between the
 * question and the sentence that answers it. Collapsing them is only honest
 * when the split is, so the rule is stated once, here, and tested:
 *
 * - the ANSWER is the LAST text part that carries text. Earlier text is
 *   commentary between steps ("let me check the tests"), which belongs with
 *   the work it narrates;
 * - everything before that answer is WORK, including notices and answered
 *   cards — they are history, and the collapsed header reports them;
 * - a turn with NO text answer (it ended on a tool call, or was cancelled) has
 *   nothing to show collapsed, so the whole turn stays expanded. Hiding every
 *   row of a turn that produced no readable answer would leave the reader with
 *   an empty screen and a button.
 */
export interface TurnSplit {
	/** Everything before the answer, in order. */
	work: TurnPart[];
	/** The part that answers the prompt, when the turn produced one. */
	answer: TurnPart | undefined;
	/** Parts after the answer (rare; kept so nothing is ever hidden). */
	tail: TurnPart[];
}

export function splitFinalWork(parts: TurnPart[]): TurnSplit {
	const answerIndex = parts.reduce(
		(found, part, index) => (part.kind === 'text' && part.text.trim().length > 0 ? index : found),
		-1
	);
	if (answerIndex === -1) return { work: [], answer: undefined, tail: parts };
	return {
		work: parts.slice(0, answerIndex),
		answer: parts[answerIndex],
		tail: parts.slice(answerIndex + 1)
	};
}

/**
 * One line of the collapsed work summary: a KIND of step and how many.
 *
 * The collapsed header must stay one line, so the label carries the count and
 * the detail carries at most one example. Anything that needs more than that
 * belongs in the expanded trace, which is one click away.
 */
export interface WorkSummaryRow {
	/** Stable key, so the list never reorders between renders. */
	kind: string;
	/** `12 calls`, `3 files edited` — count and noun, no examples. */
	label: string;
	/** One representative example: the first command, the first file. */
	detail?: string;
}

/**
 * The collapsed header's content: what kinds of step the work contained.
 *
 * Ordered as a reader scans it — the work done, the files touched, the helpers
 * used — with errors LAST, because that is the row a scannable line should end
 * on. A kind that did not happen produces no row at all.
 */
export function workSummary(parts: TurnPart[]): WorkSummaryRow[] {
	const rows: WorkSummaryRow[] = [];

	const count = (kinds: TurnPart['kind'][]) =>
		parts.filter((part) => kinds.includes(part.kind)).length;
	const first = <K extends TurnPart['kind']>(kind: K) =>
		parts.find((part): part is Extract<TurnPart, { kind: K }> => part.kind === kind);

	const calls = count(['tool', 'terminal']);
	const reads = count(['file-read', 'image-read']);
	const writes = count(['file-write', 'file-edit']);
	const subagents = count(['subagent']);
	const errors = count(['error']);

	if (calls > 0) {
		const command = first('terminal')?.command ?? first('tool')?.summary;
		rows.push({
			kind: 'calls',
			label: `${calls} ${calls === 1 ? 'call' : 'calls'}`,
			detail: command ? clip(command) : undefined
		});
	}
	if (writes > 0) {
		const path = first('file-edit')?.path ?? first('file-write')?.path;
		rows.push({
			kind: 'writes',
			label: `${writes} ${writes === 1 ? 'file edited' : 'files edited'}`,
			detail: path ? fileName(path) : undefined
		});
	}
	if (reads > 0) {
		const path = first('file-read')?.path ?? first('image-read')?.path;
		rows.push({
			kind: 'reads',
			label: `${reads} ${reads === 1 ? 'file read' : 'files read'}`,
			detail: path ? fileName(path) : undefined
		});
	}
	if (subagents > 0) {
		const title = first('subagent')?.title;
		rows.push({
			kind: 'subagents',
			label: `${subagents} ${subagents === 1 ? 'subagent' : 'subagents'}`,
			detail: title ? clip(title) : undefined
		});
	}
	if (errors > 0) {
		rows.push({
			kind: 'errors',
			label: `${errors} ${errors === 1 ? 'error' : 'errors'}`,
			detail: first('error')?.title
		});
	}
	return rows;
}

/** One line of a step, trimmed to something a collapsed row can hold. */
function clip(value: string, limit = 48): string {
	const line = value.split('\n')[0]?.trim() ?? '';
	return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}
