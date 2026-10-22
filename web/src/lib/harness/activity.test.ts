import { describe, expect, it } from 'vitest';
import { resolveActivity, showsTurnStatus } from './activity.js';
import type { Turn, TurnPart } from './types.js';

/**
 * The turn-status rules.
 *
 * The row exists because a turn's first seconds are otherwise blank: the
 * prompt is on screen and nothing has streamed yet. `resolveActivity` is the
 * whole decision, kept pure so the component renders rather than reasons.
 */

const at = '2026-10-22T09:00:00Z';

function turn(parts: TurnPart[], status: Turn['status'] = 'streaming'): Turn {
	return { id: 't1', role: 'assistant', status, at, parts };
}

const text = (value: string): TurnPart => ({ kind: 'text', id: 'p-text', text: value });
const reasoning = (): TurnPart => ({
	kind: 'reasoning',
	id: 'p-think',
	text: '',
	status: 'running'
});
const terminal = (command: string): TurnPart => ({
	kind: 'terminal',
	id: 'p-term',
	command,
	output: '',
	status: 'running'
});
const subagent = (title: string): TurnPart => ({
	kind: 'subagent',
	id: 'p-sub',
	title,
	agent: 'explore',
	status: 'running',
	turnCount: 0,
	toolCallCount: 0,
	tokensUsed: 0,
	toolsUsed: []
});
const question = (resolved: boolean): TurnPart => ({
	kind: 'question',
	id: 'ask-1',
	toolCallId: 'tc-1',
	questions: [],
	mode: 'default',
	resolved
});
const permission = (resolved: boolean): TurnPart => ({
	kind: 'permission',
	id: 'perm-1',
	toolCallId: 'tc-2',
	title: 'Edit a file',
	toolKind: 'edit',
	options: [],
	resolved
});

describe('resolveActivity', () => {
	it('is idle when no turn is running', () => {
		expect(resolveActivity([turn([text('done')], 'complete')], false)).toBeUndefined();
	});

	it('reports thinking for a turn that has produced nothing yet', () => {
		// This is the case the row was built for: the prompt is on screen and
		// the agent has not emitted its first token.
		expect(resolveActivity([turn([])], true)).toMatchObject({ kind: 'thinking' });
	});

	it('reports thinking for reasoning', () => {
		expect(resolveActivity([turn([reasoning()])], true)).toMatchObject({
			kind: 'thinking',
			label: 'Thinking'
		});
	});

	it('reports responding once text streams', () => {
		expect(resolveActivity([turn([text('hello')])], true)).toMatchObject({
			kind: 'responding',
			label: 'Responding'
		});
	});

	it('names the command that is running', () => {
		expect(resolveActivity([turn([terminal('cargo test')])], true)).toMatchObject({
			kind: 'tool',
			label: 'Running: cargo test',
			tool: 'terminal'
		});
	});

	it('reports a waiting subagent by its description', () => {
		expect(resolveActivity([turn([subagent('connectivity test')])], true)).toMatchObject({
			kind: 'tool',
			label: 'Waiting on subagent: connectivity test'
		});
	});

	it('reads the LAST meaningful part, not the first', () => {
		// Text, then a command: the command is what the agent is doing now.
		expect(
			resolveActivity([turn([text('let me check'), terminal('git status')])], true)
		).toMatchObject({ kind: 'tool', label: 'Running: git status' });
	});

	it('treats a resolved question as no activity and an open one as asking', () => {
		expect(resolveActivity([turn([text('x'), question(true)])], true)).toMatchObject({
			kind: 'responding'
		});
		expect(resolveActivity([turn([text('x'), question(false)])], true)).toMatchObject({
			kind: 'asking'
		});
	});

	it('reports a permission wait', () => {
		expect(resolveActivity([turn([permission(false)])], true)).toMatchObject({
			kind: 'waiting',
			label: 'Waiting for permission'
		});
	});

	it('ignores notices when choosing the current step', () => {
		expect(
			resolveActivity(
				[turn([terminal('cargo build'), { kind: 'notice', id: 'n1', tone: 'info', title: 'x' }])],
				true
			)
		).toMatchObject({ kind: 'tool', label: 'Running: cargo build' });
	});

	it('only considers the open turn, never a closed one', () => {
		const closed = turn([terminal('old command')], 'complete');
		const open = turn([text('new')]);
		expect(resolveActivity([closed, open], true)).toMatchObject({ kind: 'responding' });
	});

	it('truncates a long command so the row stays one line', () => {
		const long = 'x'.repeat(200);
		const activity = resolveActivity([turn([terminal(long)])], true);
		expect(activity?.label.endsWith('…')).toBe(true);
		expect(activity?.label.length).toBeLessThan(90);
	});
});

describe('showsTurnStatus', () => {
	it('shows while a turn runs', () => {
		expect(showsTurnStatus(true, false)).toBe(true);
	});

	it('shows while the agent is blocked on the user, even with no turn open', () => {
		expect(showsTurnStatus(false, true)).toBe(true);
	});

	it('hides when idle and unblocked', () => {
		expect(showsTurnStatus(false, false)).toBe(false);
	});
});
