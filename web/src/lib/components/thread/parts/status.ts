import type { PartStatus, TurnStatus } from '#lib/harness/types.js';
import type { TraceLineStatus } from '#lib/components/ui/trace/index.js';

/**
 * One vocabulary for "how far along is this step", shared by every part.
 * `complete` has no Trace status — it is the resting state.
 */
export function traceStatus(status: PartStatus | TurnStatus): TraceLineStatus | undefined {
	switch (status) {
		case 'pending':
			return 'pending';
		case 'running':
		case 'streaming':
			return 'running';
		case 'error':
			return 'error';
		default:
			return undefined;
	}
}

/** Semantic accent for a part kind, matching the TUI's accent_* slots. */
export function accentFor(kind: string): string {
	switch (kind) {
		case 'reasoning':
			return 'text-thinking';
		case 'tool':
		case 'file-read':
		case 'file-write':
		case 'image-read':
			return 'text-tool';
		case 'file-edit':
			return 'text-verify';
		case 'terminal':
			return 'text-running';
		case 'subagent':
			return 'text-system';
		case 'diff':
			return 'text-verify';
		case 'error':
			return 'text-error';
		case 'permission':
		case 'question':
			return 'text-terra';
		default:
			return 'text-ink-secondary';
	}
}
