import { describe, expect, it } from 'vitest';
import {
	graphCommand,
	graphLayout,
	nodeSubagents,
	type GraphNode,
	type GraphInspection
} from './graph.js';
import type { SubagentSummary } from './types.js';

const node = (id: string, deps: GraphNode['deps'] = []): GraphNode => ({
	id,
	title: id,
	spec: `Implement ${id}`,
	deps,
	status: 'waiting',
	rounds: 0,
	tokens_used: 0
});
const createdAt = Date.parse('2026-11-06T00:00:00Z');
const inspection: GraphInspection = {
	graph: {
		graph_id: 'current-graph',
		objective: 'Ship the feature',
		status: 'active',
		phase: 'executing',
		plan_version: 1,
		nodes: [],
		created_at: new Date(createdAt).toISOString(),
		elapsed_ms: 0,
		tokens_spent_nodes: 0,
		replan_runs: 0,
		history: []
	},
	enabled: true,
	source: 'session',
	node_goal: null
};
const workerId = (nodeId: string, role = 'w', at = createdAt + 1000) => {
	const time = at.toString(16).padStart(12, '0');
	return `graph-${nodeId}-${role}1-${time.slice(0, 8)}-${time.slice(8)}-7000-8000-000000000001`;
};
const agent = (id: string, description: string): SubagentSummary => ({
	id,
	description,
	childSessionId: `child-${id}`,
	agent: 'general-purpose',
	status: 'running',
	startedAt: 0,
	durationMs: 1000,
	turnCount: 2,
	toolCallCount: 3,
	tokensUsed: 200,
	contextWindowTokens: 1000,
	contextUsagePct: 20,
	toolsUsed: [],
	errorCount: 0
});

describe('graph dependency layout', () => {
	it('lays out a diamond and its final verification gate after dependencies', () => {
		const layout = graphLayout([
			node('final', [
				{ on: 'b', kind: 'blocks' },
				{ on: 'c', kind: 'blocks' }
			]),
			node('b', [{ on: 'a', kind: 'blocks' }]),
			node('c', [{ on: 'a', kind: 'blocks' }]),
			node('a')
		]);
		const pos = (id: string) => layout.nodes.find((entry) => entry.node.id === id)!;
		expect(pos('a').x).toBeLessThan(pos('b').x);
		expect(pos('b').x).toBe(pos('c').x);
		expect(pos('b').y).not.toBe(pos('c').y);
		expect(pos('final').x).toBeGreaterThan(pos('c').x);
		expect(layout.edges).toHaveLength(4);
	});
	it('keeps discovery provenance out of the scheduling levels', () => {
		const layout = graphLayout([node('a'), node('b', [{ on: 'a', kind: 'discovered_from' }])]);
		expect(layout.nodes[0].x).toBe(layout.nodes[1].x);
		expect(layout.edges[0].kind).toBe('discovered_from');
	});
	it('does not hang on malformed cycles or draw dangling edges', () => {
		const layout = graphLayout([
			node('a', [{ on: 'b', kind: 'blocks' }]),
			node('b', [
				{ on: 'a', kind: 'blocks' },
				{ on: 'missing', kind: 'blocks' }
			])
		]);
		expect(layout.nodes).toHaveLength(2);
		expect(layout.edges).toHaveLength(2);
		expect(Number.isFinite(layout.width)).toBe(true);
	});
});

describe('graph controls', () => {
	it('builds start and budget-top-up commands using the runtime grammar', () => {
		expect(graphCommand('start', 'Ship the feature', '100000')).toBe(
			'/graph Ship the feature --budget 100000'
		);
		expect(graphCommand('resume', '', '50000')).toBe('/graph resume --budget 50000');
		expect(graphCommand('resume', '', '')).toBe('/graph resume');
	});
	it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])(
		'refuses invalid budgets: %s',
		(budget) => {
			expect(() => graphCommand('resume', '', budget)).toThrow();
		}
	);
	it.each(['', 'pause', 'resume --budget 100', 'resume-typo', 'clear'])(
		'does not turn a start objective into a control command: %s',
		(objective) => {
			expect(() => graphCommand('start', objective, '')).toThrow();
		}
	);
});

describe('node worker association', () => {
	it('matches the exact harness-authored node id and includes worker and verifier sessions', () => {
		const workers = [
			agent(workerId('gn-a'), 'graph node worker (gn-a)'),
			agent(workerId('gn-a', 'v'), 'graph node verifier (gn-a)'),
			agent(workerId('gn-ab'), 'graph node worker (gn-ab)'),
			agent('free', 'Inspect gn-a')
		];
		expect(nodeSubagents(node('gn-a'), inspection, workers).map((a) => a.id)).toEqual([
			workerId('gn-a'),
			workerId('gn-a', 'v')
		]);
	});
	it('excludes a previous graph worker even when replay gives it a recent receive time', () => {
		const old = {
			...agent(workerId('gn-a', 'w', createdAt - 1000), 'graph node worker (gn-a)'),
			startedAt: createdAt + 1000
		};
		const current = agent(workerId('gn-a'), 'graph node worker (gn-a)');
		expect(nodeSubagents(node('gn-a'), inspection, [old, current])).toEqual([current]);
	});
	it('does not associate local activity with a read-only project graph', () => {
		const current = agent(workerId('gn-a'), 'graph node worker (gn-a)');
		expect(nodeSubagents(node('gn-a'), { ...inspection, source: 'project' }, [current])).toEqual(
			[]
		);
	});
	it('rejects a model-authored description without a harness spawn id', () => {
		const spoof = agent('free', 'graph node worker (gn-a)');
		expect(nodeSubagents(node('gn-a'), inspection, [spoof])).toEqual([]);
	});
	it('associates a serial goal subagent only with the current node', () => {
		const data = {
			...inspection,
			node_goal: {
				node_id: 'gn-final',
				worker_rounds: 1,
				verify_rounds: 1,
				tokens_used: 300,
				elapsed_ms: 1000,
				subagent_id: 'skeptic',
				subagent_role: 'verifier',
				pause_message: null
			}
		};
		const workers = [agent('skeptic', 'Verify the overall objective')];
		expect(nodeSubagents(node('gn-final'), data, workers)).toHaveLength(1);
		expect(nodeSubagents(node('gn-a'), data, workers)).toHaveLength(0);
	});
});
