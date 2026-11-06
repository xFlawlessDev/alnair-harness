import { describe, expect, it } from 'vitest';
import { foundationTurn, cancelledTurn } from './fixtures.js';
import {
	emptyAcc,
	graphToState,
	openUserTurn,
	reduceAcpUpdate,
	reduceExtUpdate,
	replay,
	sessionStatus,
	statusFromStopReason
} from './reducer.js';
import type { ExtSessionUpdate } from './types/ext.js';
import type { SessionUpdate } from './types/acp.js';
import type { Acc } from './reducer.js';
import type { TurnPart } from './types.js';

const SESSION = 's-graph';
const NOW = Date.parse('2026-10-20T09:41:12Z');

describe('runtime failure notices', () => {
	it.each([
		{
			update: { sessionUpdate: 'auto_compact_failed', error: 'out of memory' },
			title: 'Context compaction failed',
			tone: 'warning',
			detail: 'out of memory'
		},
		{
			update: { sessionUpdate: 'auto_compact_cancelled', reason: 'user cancelled' },
			title: 'Context compaction cancelled',
			tone: 'info',
			detail: 'user cancelled'
		},
		{
			update: {
				sessionUpdate: 'auto_recovery_started',
				attempt: 2,
				max_retries: 3,
				error: 'connection lost',
				delay_ms: 500
			},
			title: 'Recovering session (attempt 2/3)',
			tone: 'info',
			detail: 'connection lost'
		},
		{
			update: { sessionUpdate: 'auto_recovery_exhausted', attempts: 3, error: 'still offline' },
			title: 'Session recovery failed',
			tone: 'warning',
			detail: 'still offline'
		}
	])('renders $title without changing the context total', ({ update, title, tone, detail }) => {
		const before = { ...emptyAcc(), contextUsed: 500 };
		const after = reduceExtUpdate(before, update as ExtSessionUpdate, {
			now: NOW,
			sessionId: SESSION
		});
		expect(after.turns.at(-1)?.parts.at(-1)).toMatchObject({ kind: 'notice', title, tone, detail });
		expect(after.contextUsed).toBe(500);
	});
});

/** Fold a scripted turn the way the transport does. */
function runTurn(
	prompt: string,
	steps: { method: string; params: Record<string, unknown> }[]
): Acc {
	let acc = openUserTurn(emptyAcc(), prompt, NOW);
	let clock = NOW;
	for (const step of steps) {
		clock += 10;
		const update = (step.params as { update?: Record<string, unknown> }).update;
		if (!update) continue;
		const ctx = { now: clock, sessionId: SESSION };
		acc =
			step.method === '_alnair/session/update'
				? reduceExtUpdate(acc, update as ExtSessionUpdate, ctx)
				: reduceAcpUpdate(acc, update as SessionUpdate, ctx);
	}
	return acc;
}

describe('reducer: text', () => {
	it('appends chunks into one part instead of one part per chunk', () => {
		const acc = runTurn('hi', [
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'agent_message_chunk',
						content: { type: 'text', text: 'Hello ' }
					}
				}
			},
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } }
				}
			}
		]);
		const assistant = acc.turns.at(-1)!;
		expect(assistant.parts).toHaveLength(1);
		expect(assistant.parts[0]).toMatchObject({ kind: 'text', text: 'Hello world' });
	});

	it('keeps reasoning and text as separate parts when they interleave', () => {
		const acc = runTurn('hi', [
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'agent_thought_chunk',
						content: { type: 'text', text: 'thinking' }
					}
				}
			},
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'agent_message_chunk',
						content: { type: 'text', text: 'answer' }
					}
				}
			}
		]);
		expect(acc.turns.at(-1)!.parts.map((part) => part.kind)).toEqual(['reasoning', 'text']);
	});
});

describe('reducer: tool calls', () => {
	it('turns a completed read into a numbered file row', () => {
		const acc = runTurn('hi', [
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: 'c1',
						title: 'Read `a.ts`',
						kind: 'read',
						status: 'in_progress',
						locations: [{ path: 'src/a.ts', line: 4 }]
					}
				}
			},
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'tool_call_update',
						toolCallId: 'c1',
						status: 'completed',
						content: [{ type: 'content', content: { type: 'text', text: 'line one\nline two' } }]
					}
				}
			}
		]);
		const part = acc.turns.at(-1)!.parts[0];
		expect(part.kind).toBe('file-read');
		if (part.kind !== 'file-read') throw new Error('unreachable');
		expect(part.path).toBe('src/a.ts');
		expect(part.lines).toEqual([
			{ n: 4, text: 'line one' },
			{ n: 5, text: 'line two' }
		]);
	});

	it('splits a diff into a hunk with both number columns', () => {
		const acc = runTurn('hi', [
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: 'c2',
						title: 'Edit `a.ts`',
						kind: 'edit',
						status: 'in_progress'
					}
				}
			},
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'tool_call_update',
						toolCallId: 'c2',
						status: 'completed',
						content: [
							{
								type: 'diff',
								path: 'src/a.ts',
								oldText: 'one\ntwo\nthree',
								newText: 'one\nTWO\nthree'
							}
						]
					}
				}
			}
		]);
		const part = acc.turns.at(-1)!.parts[0];
		expect(part.kind).toBe('file-edit');
		if (part.kind !== 'file-edit') throw new Error('unreachable');
		expect(part.additions).toBe(1);
		expect(part.deletions).toBe(1);
		expect(part.hunks[0].lines).toEqual([
			{ kind: 'remove', oldNumber: 2, text: 'two' },
			{ kind: 'add', newNumber: 2, text: 'TWO' }
		]);
	});

	it('renders a new file as a write, not an edit', () => {
		const acc = runTurn('hi', [
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: 'c3',
						title: 'Write `b.ts`',
						kind: 'edit',
						status: 'in_progress'
					}
				}
			},
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'tool_call_update',
						toolCallId: 'c3',
						status: 'completed',
						content: [{ type: 'diff', path: 'src/b.ts', newText: 'export {}' }]
					}
				}
			}
		]);
		const part = acc.turns.at(-1)!.parts[0];
		expect(part.kind).toBe('file-write');
		if (part.kind !== 'file-write') throw new Error('unreachable');
		expect(part.created).toBe(true);
	});

	it('keeps an image read as an image row with a data URL', () => {
		const acc = runTurn('hi', [
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'tool_call',
						toolCallId: 'c4',
						title: 'Read `x.png`',
						kind: 'read',
						status: 'in_progress'
					}
				}
			},
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'tool_call_update',
						toolCallId: 'c4',
						status: 'completed',
						content: [
							{ type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }
						]
					}
				}
			}
		]);
		const part = acc.turns.at(-1)!.parts[0];
		expect(part.kind).toBe('image-read');
		if (part.kind !== 'image-read') throw new Error('unreachable');
		expect(part.src).toBe('data:image/png;base64,AAAA');
		// The wire did not carry dimensions, so the row must not claim any.
		expect(part.width).toBeUndefined();
	});
});

describe('reducer: plan and permissions', () => {
	it('maps ACP plan entries onto the todo list', () => {
		const acc = runTurn('hi', [
			{
				method: 'session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'plan',
						entries: [
							{ content: 'one', priority: 'high', status: 'completed' },
							{ content: 'two', priority: 'medium', status: 'in_progress' },
							{ content: 'three', priority: 'low', status: 'pending' }
						]
					}
				}
			}
		]);
		expect(acc.todos.map((todo) => todo.status)).toEqual(['completed', 'in_progress', 'pending']);
	});

	it('shows a permission card and clears it on resolve', () => {
		const acc = runTurn('hi', [
			{
				method: '_alnair/session/update',
				params: {
					sessionId: SESSION,
					update: { sessionUpdate: 'pending_interaction', tool_call_id: 'c9', kind: 'permission' }
				}
			}
		]);
		expect(sessionStatus(acc)).toBe('attention');
		const card = acc.turns.at(-1)!.parts.find((part) => part.kind === 'permission');
		expect(card).toBeDefined();

		const resolved = reduceExtUpdate(
			acc,
			{ sessionUpdate: 'interaction_resolved', tool_call_id: 'c9' } as ExtSessionUpdate,
			{ now: NOW + 50, sessionId: SESSION }
		);
		expect(resolved.permissions).toEqual({});
		expect(sessionStatus(resolved)).not.toBe('attention');
	});
});

describe('reducer: graph', () => {
	it('renders the badge payload as counts, not a DAG', () => {
		const acc = runTurn('hi', [
			{
				method: '_alnair/session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'graph_updated',
						graph_id: 'g1',
						objective: 'ship it',
						status: 'active',
						phase: 'executing',
						plan_version: 2,
						total_nodes: 7,
						achieved_nodes: 3,
						failed_nodes: 0,
						running_nodes: 1,
						tokens_spent: 100
					}
				}
			}
		]);
		expect(graphToState(acc.graph!)).toMatchObject({
			total: 7,
			achieved: 3,
			running: 1,
			planVersion: 2
		});
	});

	it('drops the badge when the agent clears the graph', () => {
		const withGraph = runTurn('hi', [
			{
				method: '_alnair/session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'graph_updated',
						graph_id: 'g',
						objective: '',
						status: 'active',
						phase: 'idle',
						plan_version: 1,
						total_nodes: 1,
						achieved_nodes: 0,
						failed_nodes: 0,
						running_nodes: 0,
						tokens_spent: 0
					}
				}
			},
			{
				method: '_alnair/session/update',
				params: {
					sessionId: SESSION,
					update: {
						sessionUpdate: 'graph_updated',
						graph_id: 'g',
						objective: '',
						status: 'cleared',
						phase: 'idle',
						plan_version: 1,
						total_nodes: 0,
						achieved_nodes: 0,
						failed_nodes: 0,
						running_nodes: 0,
						tokens_spent: 0
					}
				}
			}
		]);
		expect(withGraph.graph).toBeUndefined();
	});
});

describe('reducer: turn terminal states', () => {
	it('closes a turn on cancelled and leaves no running parts', () => {
		const acc = runTurn(cancelledTurn.prompt, cancelledTurn.steps);
		const closed = reduceExtUpdate(
			acc,
			{
				sessionUpdate: 'turn_completed',
				prompt_id: 'p',
				stop_reason: 'cancelled'
			} as ExtSessionUpdate,
			{ now: NOW + 100, sessionId: SESSION }
		);
		const turn = closed.turns.at(-1)!;
		expect(turn.status).toBe('cancelled');
		expect(turn.parts.some((part) => 'status' in part && part.status === 'running')).toBe(false);
		expect(closed.openTurnId).toBeUndefined();
	});

	it('maps stop reasons onto turn statuses', () => {
		expect(statusFromStopReason('cancelled')).toBe('cancelled');
		expect(statusFromStopReason('refusal')).toBe('refused');
		expect(statusFromStopReason('end_turn')).toBe('complete');
	});
});

describe('reducer: replay', () => {
	it('rebuilds a whole transcript from storage envelopes', () => {
		const envelopes = foundationTurn.steps.map((step) => ({
			timestamp: new Date(NOW + step.delay).toISOString(),
			method: step.method,
			params: step.params
		}));
		const acc = replay(envelopes, SESSION);
		const assistant = acc.turns.at(-1)!;
		const kinds = assistant.parts.map((part) => part.kind);
		expect(kinds).toContain('reasoning');
		expect(kinds).toContain('terminal');
		expect(kinds).toContain('file-read');
		expect(kinds).toContain('file-edit');
		expect(kinds).toContain('file-write');
		expect(kinds).toContain('image-read');
		expect(kinds).toContain('subagent');
		expect(kinds).toContain('text');
	});
});

describe('reducer: turn duration', () => {
	const agentChunk = (text: string): SessionUpdate =>
		({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text }
		}) as unknown as SessionUpdate;

	const toolCall = (id: string, status = 'completed'): SessionUpdate =>
		({
			sessionUpdate: 'tool_call',
			toolCallId: id,
			title: 'Read a file',
			kind: 'read',
			status,
			content: [],
			locations: []
		}) as unknown as SessionUpdate;

	const completed = (reason = 'end_turn'): ExtSessionUpdate =>
		({
			sessionUpdate: 'turn_completed',
			prompt_id: 'p1',
			stop_reason: reason
		}) as unknown as ExtSessionUpdate;

	it('measures from the PROMPT, not from the first token', () => {
		// The whole bug: a turn is created by its first part, which lands after
		// the model has been thinking. Timing from `at` lost that wait, and a
		// tool-only turn reported "0s".
		let acc = openUserTurn(emptyAcc(), 'run the tests', NOW);
		acc = reduceAcpUpdate(acc, agentChunk('on it'), { now: NOW + 4_000, sessionId: SESSION });
		acc = reduceExtUpdate(acc, completed(), { now: NOW + 9_000, sessionId: SESSION });

		const answer = acc.turns.find((turn) => turn.role === 'assistant')!;
		expect(answer.startedAt).toBe(NOW);
		expect(answer.durationMs).toBe(9_000);
	});

	it('reports a real duration for a turn with no text at all', () => {
		let acc = openUserTurn(emptyAcc(), 'read it', NOW);
		acc = reduceAcpUpdate(acc, toolCall('c1'), { now: NOW + 2_500, sessionId: SESSION });
		acc = reduceExtUpdate(acc, completed(), { now: NOW + 3_000, sessionId: SESSION });

		const answer = acc.turns.find((turn) => turn.role === 'assistant')!;
		expect(answer.durationMs).toBe(3_000);
	});

	it('settles a turn that the next prompt supersedes, instead of leaving it blank', () => {
		// A transcript whose tail lost `turn_completed` still has a boundary.
		let acc = openUserTurn(emptyAcc(), 'first', NOW);
		acc = reduceAcpUpdate(acc, agentChunk('answer'), { now: NOW + 1_000, sessionId: SESSION });
		acc = openUserTurn(acc, 'second', NOW + 5_000);

		const first = acc.turns.find((turn) => turn.role === 'assistant')!;
		expect(first.status).toBe('complete');
		expect(first.durationMs).toBe(5_000);
	});

	it('times each turn from its own prompt, not the session start', () => {
		let acc = openUserTurn(emptyAcc(), 'one', NOW);
		acc = reduceAcpUpdate(acc, agentChunk('a'), { now: NOW + 1_000, sessionId: SESSION });
		acc = reduceExtUpdate(acc, completed(), { now: NOW + 2_000, sessionId: SESSION });

		acc = openUserTurn(acc, 'two', NOW + 100_000);
		acc = reduceAcpUpdate(acc, agentChunk('b'), { now: NOW + 104_000, sessionId: SESSION });
		acc = reduceExtUpdate(acc, completed(), { now: NOW + 107_000, sessionId: SESSION });

		const assistants = acc.turns.filter((turn) => turn.role === 'assistant');
		expect(assistants[0].durationMs).toBe(2_000);
		expect(assistants[1].durationMs).toBe(7_000);
	});

	it('clears the prompt anchor once a turn closes', () => {
		// Otherwise the NEXT turn's `startedAt` would reach back to a prompt it
		// did not answer.
		let acc = openUserTurn(emptyAcc(), 'one', NOW);
		acc = reduceAcpUpdate(acc, agentChunk('a'), { now: NOW + 1_000, sessionId: SESSION });
		acc = reduceExtUpdate(acc, completed(), { now: NOW + 2_000, sessionId: SESSION });
		expect(acc.promptStartedAt).toBeUndefined();
	});

	it('never reports a negative duration', () => {
		// A frame whose timestamp is older than the prompt (clock skew across a
		// reconnect) must not paint "-3s".
		let acc = openUserTurn(emptyAcc(), 'one', NOW);
		acc = reduceAcpUpdate(acc, agentChunk('a'), { now: NOW + 1_000, sessionId: SESSION });
		acc = reduceExtUpdate(acc, completed(), { now: NOW - 3_000, sessionId: SESSION });
		expect(acc.turns.find((turn) => turn.role === 'assistant')!.durationMs).toBe(0);
	});

	it('leaves a streaming turn with no duration until it closes', () => {
		let acc = openUserTurn(emptyAcc(), 'one', NOW);
		acc = reduceAcpUpdate(acc, agentChunk('a'), { now: NOW + 1_000, sessionId: SESSION });
		expect(acc.turns.find((turn) => turn.role === 'assistant')!.durationMs).toBeUndefined();
	});
});

describe('reducer: reasoning phase', () => {
	const thought = (text: string): SessionUpdate =>
		({
			sessionUpdate: 'agent_thought_chunk',
			content: { type: 'text', text }
		}) as unknown as SessionUpdate;

	const message = (text: string): SessionUpdate =>
		({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text }
		}) as unknown as SessionUpdate;

	const toolCall = (id: string): SessionUpdate =>
		({
			sessionUpdate: 'tool_call',
			toolCallId: id,
			title: 'Read a file',
			kind: 'read',
			status: 'in_progress',
			content: [],
			locations: []
		}) as unknown as SessionUpdate;

	const reasoningPart = (acc: Acc) => {
		const part = acc.turns.at(-1)?.parts.find((candidate) => candidate.kind === 'reasoning');
		return part as Extract<TurnPart, { kind: 'reasoning' }> | undefined;
	};

	it('starts a thought as running', () => {
		let acc = openUserTurn(emptyAcc(), 'hi', NOW);
		acc = reduceAcpUpdate(acc, thought('weighing options'), { now: NOW + 1, sessionId: SESSION });
		expect(reasoningPart(acc)?.status).toBe('running');
	});

	it('settles the thought when the answer starts', () => {
		// The bug: there is no `thought_completed` on the wire, so the row kept
		// its spinner and said "Thinking" for the rest of the turn.
		let acc = openUserTurn(emptyAcc(), 'hi', NOW);
		acc = reduceAcpUpdate(acc, thought('weighing options'), { now: NOW + 1, sessionId: SESSION });
		acc = reduceAcpUpdate(acc, message('here is the answer'), {
			now: NOW + 2,
			sessionId: SESSION
		});
		expect(reasoningPart(acc)?.status).toBe('complete');
	});

	it('settles the thought when a tool call starts', () => {
		let acc = openUserTurn(emptyAcc(), 'hi', NOW);
		acc = reduceAcpUpdate(acc, thought('I should read the file'), {
			now: NOW + 1,
			sessionId: SESSION
		});
		acc = reduceAcpUpdate(acc, toolCall('c1'), { now: NOW + 2, sessionId: SESSION });
		expect(reasoningPart(acc)?.status).toBe('complete');
	});

	it('settles it when a notice arrives', () => {
		let acc = openUserTurn(emptyAcc(), 'hi', NOW);
		acc = reduceAcpUpdate(acc, thought('thinking'), { now: NOW + 1, sessionId: SESSION });
		acc = reduceExtUpdate(
			acc,
			{
				sessionUpdate: 'auto_compact_started',
				percentage: 90,
				reason: 'context'
			} as unknown as ExtSessionUpdate,
			{ now: NOW + 2, sessionId: SESSION }
		);
		expect(reasoningPart(acc)?.status).toBe('complete');
	});

	it('leaves a LATER thought running until its own boundary', () => {
		// Two thinking phases in one turn: the first is closed by the tool call,
		// the second stays open until the answer.
		let acc = openUserTurn(emptyAcc(), 'hi', NOW);
		acc = reduceAcpUpdate(acc, thought('first'), { now: NOW + 1, sessionId: SESSION });
		acc = reduceAcpUpdate(acc, toolCall('c1'), { now: NOW + 2, sessionId: SESSION });
		acc = reduceAcpUpdate(acc, thought('second'), { now: NOW + 3, sessionId: SESSION });

		const thoughts = acc.turns
			.at(-1)!
			.parts.filter(
				(part): part is Extract<TurnPart, { kind: 'reasoning' }> => part.kind === 'reasoning'
			);
		expect(thoughts.map((part) => part.status)).toEqual(['complete', 'running']);

		acc = reduceAcpUpdate(acc, message('done'), { now: NOW + 4, sessionId: SESSION });
		const settled = acc.turns
			.at(-1)!
			.parts.filter(
				(part): part is Extract<TurnPart, { kind: 'reasoning' }> => part.kind === 'reasoning'
			);
		expect(settled.map((part) => part.status)).toEqual(['complete', 'complete']);
	});

	it('closes a running thought when the turn ends', () => {
		// `closeTurn` settles every running part, which is what makes a turn that
		// ended mid-thought read as finished.
		let acc = openUserTurn(emptyAcc(), 'hi', NOW);
		acc = reduceAcpUpdate(acc, thought('still going'), { now: NOW + 1, sessionId: SESSION });
		acc = reduceExtUpdate(
			acc,
			{
				sessionUpdate: 'turn_completed',
				prompt_id: 'p1',
				stop_reason: 'cancelled'
			} as unknown as ExtSessionUpdate,
			{ now: NOW + 2, sessionId: SESSION }
		);
		expect(reasoningPart(acc)?.status).toBe('complete');
	});
});

describe('reducer: injected system notes', () => {
	const reminder = (body: string): SessionUpdate =>
		({
			sessionUpdate: 'user_message_chunk',
			content: { type: 'text', text: `<system-reminder>\n${body}\n</system-reminder>` }
		}) as unknown as SessionUpdate;

	const userChunk = (text: string): SessionUpdate =>
		({
			sessionUpdate: 'user_message_chunk',
			content: { type: 'text', text }
		}) as unknown as SessionUpdate;

	it('does not render a reminder as a user prompt', () => {
		// The whole bug: the shell stores injected context as a synthetic USER
		// message, so it arrives on the user rail and used to become a bubble on
		// the right — claiming the reader typed a task notification.
		const acc = reduceAcpUpdate(emptyAcc(), reminder('Background task "x" completed.'), {
			now: NOW,
			sessionId: SESSION
		});
		expect(acc.turns.some((turn) => turn.role === 'user')).toBe(false);
		const part = acc.turns.flatMap((turn) => turn.parts).find((p) => p.kind === 'system');
		expect(part).toMatchObject({
			kind: 'system',
			tag: 'system-reminder',
			body: 'Background task "x" completed.'
		});
	});

	it('stands alone as a system turn when nothing is open', () => {
		const acc = reduceAcpUpdate(emptyAcc(), reminder('a note'), { now: NOW, sessionId: SESSION });
		expect(acc.turns).toHaveLength(1);
		expect(acc.turns[0].role).toBe('system');
		expect(acc.turns[0].status).toBe('complete');
		// It must not open a turn: a `streaming` turn with no `turn_completed`
		// leaves a spinner and a stop button on an idle session.
		expect(acc.openTurnId).toBeUndefined();
	});

	it('stands alone right after a prompt, because no answer has started', () => {
		// A reminder that arrives between the prompt and the first token has no
		// assistant turn to join. It becomes its own system turn — NOT a part of
		// the user's bubble, and not a fake assistant turn that would render as
		// a reply the agent never gave.
		let acc = openUserTurn(emptyAcc(), 'do the thing', NOW);
		acc = reduceAcpUpdate(acc, reminder('a background task finished'), {
			now: NOW + 10,
			sessionId: SESSION
		});

		expect(acc.turns.map((turn) => turn.role)).toEqual(['user', 'system']);
		expect(acc.openTurnId).toBeUndefined();
	});

	it('joins the open assistant turn when one is running', () => {
		let acc = openUserTurn(emptyAcc(), 'do the thing', NOW);
		acc = reduceAcpUpdate(
			acc,
			{
				sessionUpdate: 'agent_thought_chunk',
				content: { type: 'text', text: 'working on it' }
			} as unknown as SessionUpdate,
			{ now: NOW + 5, sessionId: SESSION }
		);
		acc = reduceAcpUpdate(acc, reminder('a background task finished'), {
			now: NOW + 10,
			sessionId: SESSION
		});

		// One assistant turn holds both the thought and the reminder, so the
		// thread keeps its shape instead of splitting into three rows.
		expect(acc.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
		expect(acc.turns[1].parts.some((part) => part.kind === 'system')).toBe(true);
		expect(acc.openTurnId).toBe(acc.turns[1].id);
	});

	it('does not extend a prompt bubble with a reminder chunk', () => {
		// A reminder can arrive inside the user-chunk window; joining it would
		// append the reminder's text to what the reader typed.
		let acc = emptyAcc();
		acc = reduceAcpUpdate(acc, userChunk('what is up'), { now: NOW, sessionId: SESSION });
		acc = reduceAcpUpdate(acc, reminder('injected note'), {
			now: NOW + 1,
			sessionId: SESSION
		});

		const user = acc.turns.find((turn) => turn.role === 'user')!;
		expect((user.parts[0] as { text: string }).text).toBe('what is up');
		expect(acc.turns.some((turn) => turn.parts.some((part) => part.kind === 'system'))).toBe(true);
	});

	it('still treats a prompt that merely mentions the tag as a prompt', () => {
		const acc = reduceAcpUpdate(
			emptyAcc(),
			userChunk('why does <system-reminder> appear in my chat?'),
			{ now: NOW, sessionId: SESSION }
		);
		expect(acc.turns[0].role).toBe('user');
		expect(acc.turns[0].parts[0]).toMatchObject({ kind: 'text' });
	});

	it('is ambient, so a later part does not open a turn for it', () => {
		const acc = reduceAcpUpdate(emptyAcc(), reminder('note'), { now: NOW, sessionId: SESSION });
		expect(acc.openTurnId).toBeUndefined();
	});
});

describe('reducer: turn ordering', () => {
	const userChunk = (text: string): SessionUpdate =>
		({
			sessionUpdate: 'user_message_chunk',
			content: { type: 'text', text }
		}) as unknown as SessionUpdate;

	const agentChunk = (text: string): SessionUpdate =>
		({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text }
		}) as unknown as SessionUpdate;

	it('does not append a new reply to a stale open turn', () => {
		// A replay can leave a turn open (its transcript never got
		// `turn_completed`). Sending a prompt then used to append the answer to
		// that earlier turn, so the reply rendered ABOVE the question.
		let acc: Acc = reduceAcpUpdate(emptyAcc(), agentChunk('stale answer'), {
			now: NOW,
			sessionId: SESSION
		});
		expect(acc.openTurnId).toBeDefined();

		acc = openUserTurn(acc, 'fresh question', NOW + 10);
		acc = reduceAcpUpdate(acc, agentChunk('fresh answer'), { now: NOW + 20, sessionId: SESSION });

		expect(acc.turns.map((turn) => turn.role)).toEqual(['assistant', 'user', 'assistant']);
		const last = acc.turns.at(-1)!;
		expect(last.parts[0]).toMatchObject({ kind: 'text', text: 'fresh answer' });
		// The stale turn is closed rather than left streaming forever.
		expect(acc.turns[0].status).toBe('complete');
	});

	it('builds user turns from replayed chunks', () => {
		// Replay has no optimistic turn, so `user_message_chunk` is the only
		// source of the user side of the conversation.
		const acc = replay(
			[
				{
					timestamp: new Date(NOW).toISOString(),
					method: 'session/update',
					params: { sessionId: SESSION, update: userChunk('hello') }
				},
				{
					timestamp: new Date(NOW + 1).toISOString(),
					method: 'session/update',
					params: { sessionId: SESSION, update: userChunk(' world') }
				},
				{
					timestamp: new Date(NOW + 2).toISOString(),
					method: 'session/update',
					params: { sessionId: SESSION, update: agentChunk('hi there') }
				}
			],
			SESSION
		);

		expect(acc.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
		expect(acc.turns[0].parts[0]).toMatchObject({ kind: 'text', text: 'hello world' });
	});

	it('starts a new user turn for a second replayed prompt', () => {
		const envelopes = [
			{
				timestamp: new Date(NOW).toISOString(),
				method: 'session/update',
				params: { sessionId: SESSION, update: userChunk('one') }
			},
			{
				timestamp: new Date(NOW + 1).toISOString(),
				method: 'session/update',
				params: { sessionId: SESSION, update: agentChunk('a') }
			},
			{
				timestamp: new Date(NOW + 2).toISOString(),
				method: 'session/update',
				params: { sessionId: SESSION, update: userChunk('two') }
			},
			{
				timestamp: new Date(NOW + 3).toISOString(),
				method: 'session/update',
				params: { sessionId: SESSION, update: agentChunk('b') }
			}
		];
		const acc = replay(envelopes, SESSION);
		expect(acc.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
		expect(acc.turns[2].parts[0]).toMatchObject({ text: 'two' });
	});

	it('swallows the echo of a live prompt', () => {
		// A live send paints the prompt; the agent echoing it back must not add
		// a second bubble.
		let acc = openUserTurn(emptyAcc(), 'hello', NOW);
		acc = reduceAcpUpdate(acc, userChunk('hello'), { now: NOW + 1, sessionId: SESSION });
		expect(acc.turns).toHaveLength(1);
		expect(acc.turns[0].role).toBe('user');
	});
});

/**
 * A cancelled turn reloaded as `hi test sub agenthi test sub agent`.
 *
 * The transcript holds two prompts with the same text: the one that was
 * stopped, and the retry typed afterwards. `turn_completed` — the separator
 * between them — is an EXTENSION frame, and the user-chunk window used to close
 * only on ACP frames. So the window stayed open across the boundary and the
 * second prompt's echo was appended to the first bubble.
 */
describe('reducer: a stopped turn does not swallow the next prompt', () => {
	const userChunk = (text: string, promptIndex?: number): SessionUpdate =>
		({
			sessionUpdate: 'user_message_chunk',
			content: { type: 'text', text },
			...(promptIndex === undefined ? {} : { _meta: { promptIndex } })
		}) as unknown as SessionUpdate;

	const turnCompleted = (stopReason: string): ExtSessionUpdate =>
		({
			sessionUpdate: 'turn_completed',
			prompt_id: 'p1',
			stop_reason: stopReason
		}) as unknown as ExtSessionUpdate;

	const agentChunk = (text: string): SessionUpdate =>
		({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text }
		}) as unknown as SessionUpdate;

	it('starts a new bubble when turn_completed separates two identical prompts', () => {
		let acc = emptyAcc();
		acc = reduceAcpUpdate(acc, userChunk('hi test sub agent', 0), { now: NOW, sessionId: SESSION });
		acc = reduceExtUpdate(acc, turnCompleted('cancelled'), { now: NOW + 1, sessionId: SESSION });
		acc = reduceAcpUpdate(acc, userChunk('hi test sub agent', 1), {
			now: NOW + 2,
			sessionId: SESSION
		});

		expect(acc.turns.map((turn) => turn.role)).toEqual(['user', 'user']);
		expect(acc.turns.map((turn) => (turn.parts[0] as { text: string }).text)).toEqual([
			'hi test sub agent',
			'hi test sub agent'
		]);
	});

	it('splits on a changed promptIndex even with no turn boundary between', () => {
		// The durable rule: `promptIndex` is the server's own turn key, so two
		// prompts differ by it whether or not a `turn_completed` arrived.
		let acc = emptyAcc();
		acc = reduceAcpUpdate(acc, userChunk('same', 0), { now: NOW, sessionId: SESSION });
		acc = reduceAcpUpdate(acc, userChunk('same', 1), { now: NOW + 1, sessionId: SESSION });

		expect(acc.turns).toHaveLength(2);
	});

	it('still joins consecutive chunks of ONE prompt', () => {
		// The fix must not split a prompt that arrives in pieces.
		let acc = emptyAcc();
		acc = reduceAcpUpdate(acc, userChunk('hi ', 0), { now: NOW, sessionId: SESSION });
		acc = reduceAcpUpdate(acc, userChunk('there', 0), { now: NOW + 1, sessionId: SESSION });

		expect(acc.turns).toHaveLength(1);
		expect((acc.turns[0].parts[0] as { text: string }).text).toBe('hi there');
	});

	it('keeps the positional rule when the frames carry no promptIndex', () => {
		// Older transcripts have no `promptIndex`; an assistant reply between
		// two prompts must still separate them.
		let acc = emptyAcc();
		acc = reduceAcpUpdate(acc, userChunk('one'), { now: NOW, sessionId: SESSION });
		acc = reduceAcpUpdate(acc, agentChunk('reply'), { now: NOW + 1, sessionId: SESSION });
		acc = reduceAcpUpdate(acc, userChunk('two'), { now: NOW + 2, sessionId: SESSION });

		expect(acc.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
	});

	it('closes the window on a retry_state frame', () => {
		// A retry banner arrives between attempts; it must not leave the window
		// open for the next prompt.
		let acc = emptyAcc();
		acc = reduceAcpUpdate(acc, userChunk('first'), { now: NOW, sessionId: SESSION });
		acc = reduceExtUpdate(
			acc,
			{
				sessionUpdate: 'retry_state',
				type: 'retrying',
				attempt: 1,
				max_retries: 3,
				reason: 'transient'
			} as unknown as ExtSessionUpdate,
			{ now: NOW + 1, sessionId: SESSION }
		);
		acc = reduceAcpUpdate(acc, userChunk('second'), { now: NOW + 2, sessionId: SESSION });

		const users = acc.turns.filter((turn) => turn.role === 'user');
		expect(users).toHaveLength(2);
		expect(users.map((turn) => (turn.parts[0] as { text: string }).text)).toEqual([
			'first',
			'second'
		]);
	});

	it('a replay of the stopped-then-retried transcript keeps both prompts', () => {
		// The exact shape from a real `updates.jsonl`: prompt, retries, a
		// cancelled `turn_completed`, then the same prompt again.
		const envelopes = [
			{
				method: 'session/update',
				params: { sessionId: SESSION, update: userChunk('hi test sub agent', 0) }
			},
			{
				method: '_alnair/session/update',
				params: { sessionId: SESSION, update: turnCompleted('cancelled') }
			},
			{
				method: 'session/update',
				params: { sessionId: SESSION, update: userChunk('hi test sub agent', 1) }
			},
			{ method: 'session/update', params: { sessionId: SESSION, update: agentChunk('done') } }
		].map((envelope, index) => ({
			...envelope,
			timestamp: new Date(NOW + index).toISOString()
		}));

		const acc = replay(envelopes, SESSION);
		const users = acc.turns.filter((turn) => turn.role === 'user');
		expect(users).toHaveLength(2);
		for (const turn of users) {
			expect((turn.parts[0] as { text: string }).text).toBe('hi test sub agent');
		}
	});
});
