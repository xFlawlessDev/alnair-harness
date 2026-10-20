import type { TurnPart } from '#lib/harness/types.js';

export type TurnSegment =
	| { kind: 'trace'; parts: TurnPart[] }
	| { kind: 'text'; part: Extract<TurnPart, { kind: 'text' }> }
	| { kind: 'notice'; part: Extract<TurnPart, { kind: 'notice' }> }
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
		else if (part.kind === 'permission') segments.push({ kind: 'permission', part });
		else if (part.kind === 'question') segments.push({ kind: 'question', part });
	}

	flush();
	return segments;
}
