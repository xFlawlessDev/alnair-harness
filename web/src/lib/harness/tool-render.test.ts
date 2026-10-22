import { describe, expect, it } from 'vitest';
import { emptyAcc, openUserTurn, reduceAcpUpdate, reduceExtUpdate, toolMetaOf } from './reducer.js';
import type { Acc } from './reducer.js';
import type { SessionUpdate } from './types/acp.js';
import type { ExtSessionUpdate } from './types/ext.js';
import type { TurnPart } from './types.js';

/**
 * Every tool family the agent can emit, folded once and checked.
 *
 * The point of this file is coverage, not depth: each case asserts only that
 * the call reaches the RIGHT part kind, because a tool that silently falls
 * through to the generic row is the failure mode this suite exists to catch.
 * It happened twice — `ask_user_question` and `spawn_subagent` both rendered as
 * "other Tool: …" because the ACP `kind` for every Alnair tool is `other` and
 * only `_meta["alnair/tool"]` says what it is.
 *
 * The wire shapes below are copied from real `updates.jsonl` lines, not
 * invented, so a fixture cannot drift from what the agent sends.
 */

const SESSION = 's-tools';
const NOW = Date.parse('2026-10-22T09:00:00Z');

/** The canonical identity the agent stamps onto every one of its own tools. */
function meta(name: string, kind: string, label: string, input?: Record<string, unknown>) {
	return {
		'alnair/tool': {
			version: 1,
			name,
			kind,
			namespace: 'alnair',
			label,
			read_only: false,
			...(input ? { input } : {})
		}
	};
}

/** Fold one tool call: the announcement, then the completion update. */
function foldTool(
	call: Record<string, unknown>,
	update: Record<string, unknown>
): { acc: Acc; parts: TurnPart[] } {
	let acc = openUserTurn(emptyAcc(), 'go', NOW);
	acc = reduceAcpUpdate(acc, { sessionUpdate: 'tool_call', ...call } as unknown as SessionUpdate, {
		now: NOW + 10,
		sessionId: SESSION
	});
	acc = reduceAcpUpdate(
		acc,
		{ sessionUpdate: 'tool_call_update', ...update } as unknown as SessionUpdate,
		{ now: NOW + 500, sessionId: SESSION }
	);
	// Only the parts the tool produced. The user turn is the FIRST turn; the
	// tool's rows land in the assistant turn that follows it.
	const turn = acc.turns.filter((candidate) => candidate.role === 'assistant').at(-1);
	return { acc, parts: turn?.parts ?? [] };
}

const kinds = (parts: TurnPart[]) => parts.map((part) => part.kind);

describe('render: every tool call reaches its own row', () => {
	it('execute → terminal row with the command and its output', () => {
		const { parts } = foldTool(
			{
				toolCallId: 'tc-exec',
				title: 'run_terminal_command',
				kind: 'other',
				status: 'pending',
				rawInput: { command: 'git log --oneline -2' },
				_meta: meta('run_terminal_command', 'execute', 'Run Command')
			},
			{
				toolCallId: 'tc-exec',
				kind: 'execute',
				title: 'Execute `git log --oneline -2`',
				status: 'completed',
				locations: [],
				rawInput: { variant: 'Bash', command: 'git log --oneline -2' },
				rawOutput: {
					type: 'Bash',
					output: [104, 105],
					exit_code: 0,
					command: 'git log --oneline -2'
				},
				content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
				_meta: meta('run_terminal_command', 'execute', 'Run Command')
			}
		);

		expect(kinds(parts)).toEqual(['terminal']);
		const part = parts[0];
		expect(part.kind).toBe('terminal');
		if (part.kind !== 'terminal') return;
		expect(part.command).toBe('git log --oneline -2');
		expect(part.output).toBe('hi');
		expect(part.exitCode).toBe(0);
		expect(part.status).toBe('complete');
	});

	it('read → numbered file row', () => {
		const { parts } = foldTool(
			{
				toolCallId: 'tc-read',
				title: 'read_file',
				kind: 'read',
				status: 'pending',
				_meta: meta('read_file', 'read', 'Read')
			},
			{
				toolCallId: 'tc-read',
				kind: 'read',
				status: 'completed',
				locations: [{ path: 'src/main.rs', line: 1 }],
				content: [{ type: 'content', content: { type: 'text', text: 'fn main() {}' } }],
				_meta: meta('read_file', 'read', 'Read')
			}
		);

		expect(kinds(parts)).toEqual(['file-read']);
		const part = parts[0];
		if (part.kind !== 'file-read') return;
		expect(part.path).toBe('src/main.rs');
		expect(part.lines).toEqual([{ n: 1, text: 'fn main() {}' }]);
	});

	it('write → write row, distinguished from an edit by the missing oldText', () => {
		const { parts } = foldTool(
			{
				toolCallId: 'tc-write',
				title: 'write',
				kind: 'edit',
				status: 'pending',
				_meta: meta('write', 'write', 'Write')
			},
			{
				toolCallId: 'tc-write',
				kind: 'edit',
				status: 'completed',
				locations: [{ path: 'notes.md' }],
				content: [{ type: 'diff', path: 'notes.md', newText: '# Notes\n' }],
				_meta: meta('write', 'write', 'Write')
			}
		);

		expect(kinds(parts)).toEqual(['file-write']);
		const part = parts[0];
		if (part.kind !== 'file-write') return;
		expect(part.created).toBe(true);
		expect(part.lines).toEqual([{ n: 1, text: '# Notes' }]);
	});

	it('edit → diff row with both line columns', () => {
		const { parts } = foldTool(
			{
				toolCallId: 'tc-edit',
				title: 'search_replace',
				kind: 'edit',
				status: 'pending',
				_meta: meta('search_replace', 'edit', 'Edit')
			},
			{
				toolCallId: 'tc-edit',
				kind: 'edit',
				status: 'completed',
				locations: [{ path: 'a.rs' }],
				content: [{ type: 'diff', path: 'a.rs', oldText: 'let a = 1;\n', newText: 'let a = 2;\n' }],
				_meta: meta('search_replace', 'edit', 'Edit')
			}
		);

		expect(kinds(parts)).toEqual(['file-edit']);
		const part = parts[0];
		if (part.kind !== 'file-edit') return;
		expect(part.additions).toBe(1);
		expect(part.deletions).toBe(1);
	});

	it('grep → generic tool row carrying the agent title', () => {
		const { parts } = foldTool(
			{
				toolCallId: 'tc-grep',
				title: 'grep',
				kind: 'search',
				status: 'pending',
				_meta: meta('grep', 'search', 'Search')
			},
			{
				toolCallId: 'tc-grep',
				kind: 'search',
				status: 'completed',
				content: [{ type: 'content', content: { type: 'text', text: '3 matches' } }],
				_meta: meta('grep', 'search', 'Search')
			}
		);

		expect(kinds(parts)).toEqual(['tool']);
		const part = parts[0];
		if (part.kind !== 'tool') return;
		expect(part.summary).toContain('grep');
		expect(part.output).toBe('3 matches');
	});

	it('web_fetch → generic tool row', () => {
		const { parts } = foldTool(
			{
				toolCallId: 'tc-fetch',
				title: 'Fetch: https://example.com',
				kind: 'fetch',
				status: 'pending',
				_meta: meta('web_fetch', 'web_fetch', 'Web Fetch')
			},
			{
				toolCallId: 'tc-fetch',
				kind: 'fetch',
				status: 'completed',
				content: [{ type: 'content', content: { type: 'text', text: 'page body' } }],
				_meta: meta('web_fetch', 'web_fetch', 'Web Fetch')
			}
		);

		expect(kinds(parts)).toEqual(['tool']);
	});

	it('ask_user_question → question card, not a tool row', () => {
		const { parts } = foldTool(
			{
				toolCallId: 'tc-ask',
				title: 'ask_user_question',
				kind: 'other',
				status: 'pending',
				rawInput: {
					questions: [
						{
							multi_select: false,
							question: 'What should I change in README.md?',
							options: [
								{ label: 'Document the newer features', description: 'Add sections.' },
								{ label: 'Fix something specific', description: 'A concrete error.' }
							]
						}
					]
				},
				_meta: meta('ask_user_question', 'ask_user', 'Ask User')
			},
			{
				toolCallId: 'tc-ask',
				kind: 'other',
				title: 'Ask: What should I change in README.md?',
				status: 'completed',
				locations: [],
				rawInput: {
					variant: 'AskUserQuestion',
					questions: [
						{
							question: 'What should I change in README.md?',
							multiSelect: false,
							options: [
								{ label: 'Document the newer features', description: 'Add sections.' },
								{ label: 'Fix something specific', description: 'A concrete error.' }
							]
						}
					]
				},
				_meta: meta('ask_user_question', 'ask_user', 'Ask User')
			}
		);

		expect(kinds(parts)).toEqual(['question']);
		const part = parts[0];
		if (part.kind !== 'question') return;
		expect(part.id).toBe('ask-tc-ask');
		expect(part.questions).toHaveLength(1);
		expect(part.questions[0].question).toBe('What should I change in README.md?');
		expect(part.questions[0].choices.map((choice) => choice.label)).toEqual([
			'Document the newer features',
			'Fix something specific'
		]);
		// The call finished, so the card must not claim the agent is waiting.
		expect(part.resolved).toBe(true);
	});

	it('spawn_subagent → no tool row (the subagent card owns it)', () => {
		const { parts } = foldTool(
			{
				toolCallId: 'tc-task',
				title: 'spawn_subagent',
				kind: 'other',
				status: 'pending',
				rawInput: { description: 'Subagent connectivity test', subagent_type: 'explore' },
				_meta: {
					...meta('spawn_subagent', 'task', 'Subagent'),
					subagentBackground: false
				}
			},
			{
				toolCallId: 'tc-task',
				kind: 'other',
				title: 'Subagent connectivity test',
				status: 'completed',
				locations: [],
				rawInput: { variant: 'Task', description: 'Subagent connectivity test' },
				_meta: meta('spawn_subagent', 'task', 'Subagent')
			}
		);

		expect(parts).toEqual([]);
	});

	it('a subagent tool call leaves no stale row when its identity arrives late', () => {
		// The announcement carries no `_meta` identity, so the first frame looks
		// like an ordinary tool. The completion update names it; the row must go
		// away rather than sit beside the subagent card.
		let acc = openUserTurn(emptyAcc(), 'go', NOW);
		acc = reduceAcpUpdate(
			acc,
			{
				sessionUpdate: 'tool_call',
				toolCallId: 'tc-late',
				title: 'spawn_subagent',
				kind: 'other',
				status: 'pending'
			} as unknown as SessionUpdate,
			{ now: NOW + 10, sessionId: SESSION }
		);
		expect(kinds(acc.turns.at(-1)?.parts ?? [])).toEqual(['tool']);

		acc = reduceAcpUpdate(
			acc,
			{
				sessionUpdate: 'tool_call_update',
				toolCallId: 'tc-late',
				status: 'completed',
				_meta: meta('spawn_subagent', 'task', 'Subagent')
			} as unknown as SessionUpdate,
			{ now: NOW + 500, sessionId: SESSION }
		);
		expect(acc.turns.at(-1)?.parts ?? []).toEqual([]);
	});

	it('task_backgrounded → terminal row that stays running', () => {
		const { acc } = foldTool(
			{
				toolCallId: 'tc-bg',
				title: 'run_terminal_command',
				kind: 'other',
				status: 'pending',
				rawInput: { command: 'npm run dev' },
				_meta: meta('run_terminal_command', 'execute', 'Run Command')
			},
			{
				toolCallId: 'tc-bg',
				kind: 'execute',
				status: 'completed',
				rawInput: { variant: 'Bash', command: 'npm run dev', is_background: true },
				content: [{ type: 'content', content: { type: 'text', text: 'listening' } }],
				_meta: meta('run_terminal_command', 'execute', 'Run Command')
			}
		);

		const withBackground = reduceExtUpdate(
			acc,
			{
				sessionUpdate: 'task_backgrounded',
				tool_call_id: 'tc-bg',
				task_id: 'task-1',
				command: 'npm run dev',
				cwd: '/repo',
				output_file: '/tmp/task-1.log',
				description: 'dev server'
			} as unknown as ExtSessionUpdate,
			{ now: NOW + 700, sessionId: SESSION }
		);
		const part = withBackground.turns.at(-1)?.parts[0];
		expect(part?.kind).toBe('terminal');
		if (part?.kind !== 'terminal') return;
		expect(part.backgrounded).toBe(true);
		expect(part.taskId).toBe('task-1');
		expect(part.status).toBe('running');
	});

	it('a permission-gated call stays a plain row until it resolves', () => {
		let acc = openUserTurn(emptyAcc(), 'go', NOW);
		acc = reduceAcpUpdate(
			acc,
			{
				sessionUpdate: 'tool_call',
				toolCallId: 'tc-perm',
				title: 'Write `a.ts`',
				kind: 'edit',
				status: 'pending'
			} as unknown as SessionUpdate,
			{ now: NOW + 10, sessionId: SESSION }
		);
		acc = reduceExtUpdate(
			acc,
			{
				sessionUpdate: 'pending_interaction',
				tool_call_id: 'tc-perm',
				kind: 'permission'
			} as unknown as ExtSessionUpdate,
			{ now: NOW + 20, sessionId: SESSION }
		);

		const partKinds = acc.turns.at(-1)?.parts.map((part) => part.kind) ?? [];
		expect(partKinds).toContain('tool');
		expect(partKinds).toContain('permission');
	});

	it('the canonical identity is readable off the tool state', () => {
		const { acc } = foldTool(
			{
				toolCallId: 'tc-meta',
				title: 'run_terminal_command',
				kind: 'other',
				status: 'pending',
				_meta: meta('run_terminal_command', 'execute', 'Run Command')
			},
			{
				toolCallId: 'tc-meta',
				kind: 'execute',
				status: 'completed',
				_meta: meta('run_terminal_command', 'execute', 'Run Command')
			}
		);
		const identity = toolMetaOf(acc.tools['tc-meta'].meta);
		expect(identity?.name).toBe('run_terminal_command');
		expect(identity?.kind).toBe('execute');
		expect(identity?.label).toBe('Run Command');
	});

	it('an update that omits _meta keeps the identity from the announcement', () => {
		const { acc } = foldTool(
			{
				toolCallId: 'tc-keep',
				title: 'ask_user_question',
				kind: 'other',
				status: 'pending',
				_meta: meta('ask_user_question', 'ask_user', 'Ask User')
			},
			{
				toolCallId: 'tc-keep',
				kind: 'other',
				status: 'completed'
			}
		);
		expect(toolMetaOf(acc.tools['tc-keep'].meta)?.kind).toBe('ask_user');
		expect(kinds(acc.turns.at(-1)?.parts ?? [])).toEqual(['question']);
	});
});
