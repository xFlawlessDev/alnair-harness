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

const SESSION = 's-graph';
const NOW = Date.parse('2026-10-20T09:41:12Z');

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
