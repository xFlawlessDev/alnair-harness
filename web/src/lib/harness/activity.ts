import type { Turn, TurnPart } from './types.js';

/**
 * What the agent is doing right now, in the TUI's vocabulary.
 *
 * The turn-status row exists because a turn's first seconds are otherwise a
 * blank pane: the prompt is on screen, the agent is working, and nothing has
 * been emitted yet. The TUI resolves this from its tracker
 * (`TurnActivity`); the browser has only the folded transcript, so the same
 * answer is derived from the last part of the open turn.
 *
 * `kind` drives the cue: `waiting` and `asking` pulse a diamond (the agent is
 * blocked on the user), everything else runs the travelling-dot pulse.
 */
export type ActivityKind = 'thinking' | 'responding' | 'tool' | 'compacting' | 'waiting' | 'asking';

export interface TurnActivity {
	kind: ActivityKind;
	/** The short label beside the pulse, e.g. `Running: Read x.ts`. */
	label: string;
	/** The tool that is running, when one is. */
	tool?: string;
}

/** Titles the agent uses for its own tools, so the label can name the action. */
const TITLE_LIMIT = 64;

function clip(value: string): string {
	const first = value.split('\n')[0]?.trim() ?? '';
	return first.length <= TITLE_LIMIT ? first : `${first.slice(0, TITLE_LIMIT - 1)}…`;
}

/**
 * The activity a part represents, or `undefined` for parts that do not move the
 * agent forward (a notice, an answered card).
 */
function activityOfPart(part: TurnPart): TurnActivity | undefined {
	switch (part.kind) {
		case 'reasoning':
			return { kind: 'thinking', label: 'Wait for response' };
		case 'text':
			return { kind: 'responding', label: 'Responding' };
		case 'terminal':
			return {
				kind: 'tool',
				label: part.command ? `Running: ${clip(part.command)}` : 'Running a command',
				tool: 'terminal'
			};
		case 'subagent':
			return {
				kind: 'tool',
				label: `Waiting on subagent: ${clip(part.title)}`,
				tool: 'subagent'
			};
		case 'file-read':
			return { kind: 'tool', label: `Reading ${clip(part.path)}`, tool: 'read' };
		case 'file-write':
			return { kind: 'tool', label: `Writing ${clip(part.path)}`, tool: 'write' };
		case 'file-edit':
			return { kind: 'tool', label: `Editing ${clip(part.path)}`, tool: 'edit' };
		case 'image-read':
			return { kind: 'tool', label: `Reading ${clip(part.path)}`, tool: 'read' };
		case 'tool':
			return {
				kind: 'tool',
				label: `Running: ${clip(part.summary || part.name)}`,
				tool: part.name
			};
		case 'question':
			return part.resolved ? undefined : { kind: 'asking', label: 'Waiting for your answer' };
		case 'permission':
			return part.resolved ? undefined : { kind: 'waiting', label: 'Waiting for permission' };
		case 'notice':
		case 'error':
		case 'diff':
		case 'system':
			return undefined;
		default:
			return undefined;
	}
}

/**
 * Resolve the live activity for a session.
 *
 * Only the OPEN turn can be in flight; a turn that already closed describes
 * work that is over. When the open turn has produced nothing yet, the agent is
 * still reading the prompt — which the TUI calls `Thinking` too, and which is
 * exactly the state that used to render as an empty pane.
 */
export function resolveActivity(turns: Turn[], busy: boolean): TurnActivity | undefined {
	if (!busy) return undefined;
	const open = [...turns].reverse().find((turn) => turn.status === 'streaming');
	if (!open) return { kind: 'thinking', label: 'Wait for response' };
	// Walk backwards: the last part that means something is the current step.
	for (let index = open.parts.length - 1; index >= 0; index -= 1) {
		const activity = activityOfPart(open.parts[index]);
		if (activity) return activity;
	}
	return { kind: 'thinking', label: 'Wait for response' };
}

/** The open turn's start, for the turn timer. */
export function openTurnStartedAt(turns: Turn[]): number | undefined {
	const open = [...turns].reverse().find((turn) => turn.status === 'streaming');
	return open ? new Date(open.at).getTime() : undefined;
}

/**
 * Whether the status row should paint at all.
 *
 * A parked question or permission keeps the row visible even when no turn is
 * open: the agent is blocked on the user, and that is the one state the reader
 * must not miss.
 */
export function showsTurnStatus(busy: boolean, blocked: boolean): boolean {
	return busy || blocked;
}
