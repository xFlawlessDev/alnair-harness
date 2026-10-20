import type { TurnPart } from '#lib/harness/types.js';

export type TurnSegment =
	| { kind: 'trace'; parts: TurnPart[] }
	| { kind: 'text'; part: Extract<TurnPart, { kind: 'text' }> }
	| { kind: 'checkpoint'; part: Extract<TurnPart, { kind: 'checkpoint' }> };

const TRACE_KINDS = new Set<TurnPart['kind']>([
	'reasoning',
	'tool',
	'file-read',
	'file-write',
	'file-edit',
	'image-read',
	'terminal',
	'plan',
	'subagent',
	'tests',
	'sources',
	'diff',
	'error'
]);

/**
 * Consecutive trace parts share one `Trace.Root`, so the vertical rule between
 * steps stays continuous — the same shape the AI Elements Chat pattern uses.
 * Text and checkpoints break the run.
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
		else if (part.kind === 'checkpoint') segments.push({ kind: 'checkpoint', part });
	}

	flush();
	return segments;
}
