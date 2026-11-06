import type { SubagentSummary } from './types.js';

export type GraphNodeStatus =
	'waiting' | 'ready' | 'running' | 'verifying' | 'achieved' | 'failed' | 'blocked';
export interface GraphNode {
	id: string;
	title: string;
	spec: string;
	deps: { on: string; kind: 'blocks' | 'discovered_from' }[];
	status: GraphNodeStatus;
	goal_id?: string;
	rounds: number;
	tokens_used: number;
	failure?: string;
}
export interface GraphSnapshot {
	graph_id: string;
	objective: string;
	status: string;
	phase: string;
	plan_version: number;
	nodes: GraphNode[];
	current_node?: string;
	created_at: string;
	elapsed_ms: number;
	token_budget?: number;
	tokens_spent_nodes: number;
	pause_message?: string;
	replan_runs: number;
	pending_discoveries?: { from_node: string; description: string }[];
	history: { timestamp: string; event: string; node_id?: string; detail?: string }[];
}
export interface GraphInspection {
	graph: GraphSnapshot | null;
	enabled: boolean;
	source: 'session' | 'project' | 'none';
	node_goal: {
		node_id: string;
		worker_rounds: number;
		verify_rounds: number;
		tokens_used: number;
		elapsed_ms: number;
		subagent_id: string | null;
		subagent_role: string | null;
		pause_message: string | null;
	} | null;
}
export interface GraphView extends GraphInspection {
	subagents: SubagentSummary[];
}
export type GraphControl = 'pause' | 'clear';

/** Internal graph-worker descriptions are authored by graph_workers.rs. */
export function nodeSubagents(
	node: GraphNode,
	inspection: GraphInspection,
	subagents: SubagentSummary[]
): SubagentSummary[] {
	const goal = inspection.node_goal?.node_id === node.id ? inspection.node_goal : undefined;
	return subagents.filter((agent) => {
		if (goal?.subagent_id === agent.id) return true;
		if (inspection.source !== 'session' || !inspection.graph) return false;
		const match = /^graph node (?:worker|verifier) \(([^)]+)\)$/.exec(agent.description);
		if (match?.[1] !== node.id) return false;
		const prefix = `graph-${node.id}-`;
		if (!agent.id.startsWith(prefix)) return false;
		const spawn =
			/^[wv]\d+-([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(
				agent.id.slice(prefix.length)
			);
		// UUIDv7 preserves spawn time across replay, whose receive time can be newer.
		const spawnedAt = spawn ? Number.parseInt(spawn[1] + spawn[2], 16) : NaN;
		return spawnedAt >= Date.parse(inspection.graph.created_at);
	});
}

export function graphCommand(
	action: 'start' | 'resume',
	objective: string,
	budget: string
): string {
	const value = budget.trim();
	if (
		value &&
		(!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
	) {
		throw new Error('Enter a positive whole number of tokens.');
	}
	const text = objective.trim();
	if (action === 'start' && !text) throw new Error('Enter a graph objective.');
	// Reserved subcommands must never turn a Start click into a different operation.
	if (
		action === 'start' &&
		(/^resume/i.test(text) || /^(?:status|show|pause|clear)(?:\s|$)/i.test(text))
	) {
		throw new Error('Start the objective with the work to perform, rather than a graph command.');
	}
	return `/graph ${action === 'resume' ? 'resume' : text}${value ? ` --budget ${value}` : ''}`;
}

export function nodeTone(status: GraphNodeStatus): string {
	if (status === 'achieved') return 'text-success';
	if (status === 'failed' || status === 'blocked') return 'text-error';
	if (status === 'running' || status === 'verifying') return 'text-running';
	return 'text-ink-secondary';
}

/** Stable layered layout. Discovery edges are provenance, never scheduling gates. */
export function graphLayout(nodes: GraphNode[]) {
	const ids = new Set(nodes.map((node) => node.id));
	const levels = new Map<string, number>();
	let pending = [...nodes];
	for (let pass = 0; pending.length && pass <= nodes.length; pass += 1) {
		const next: GraphNode[] = [];
		for (const node of pending) {
			const deps = node.deps.filter((dep) => dep.kind === 'blocks' && ids.has(dep.on));
			if (deps.some((dep) => !levels.has(dep.on))) {
				next.push(node);
				continue;
			}
			levels.set(
				node.id,
				deps.reduce((max, dep) => Math.max(max, (levels.get(dep.on) ?? 0) + 1), 0)
			);
		}
		if (next.length === pending.length) break;
		pending = next;
	}
	const rows = new Map<number, number>();
	const positioned = nodes.map((node) => {
		const level = levels.get(node.id) ?? 0;
		const row = rows.get(level) ?? 0;
		rows.set(level, row + 1);
		return { node, x: 24 + level * 300, y: 24 + row * 130 };
	});
	const positions = new Map(positioned.map((p) => [p.node.id, p]));
	const edges = nodes.flatMap((node) =>
		node.deps.flatMap((dep) => {
			const from = positions.get(dep.on),
				to = positions.get(node.id);
			if (!from || !to) return [];
			const x = from.x + 240,
				y = from.y + 50;
			const targetX = to.x,
				targetY = to.y + 50;
			return [
				{
					from: dep.on,
					to: node.id,
					kind: dep.kind,
					path: `M ${x} ${y} C ${x + 30} ${y}, ${targetX - 30} ${targetY}, ${targetX} ${targetY}`
				}
			];
		})
	);
	return {
		nodes: positioned,
		edges,
		width: Math.max(340, ...positioned.map((p) => p.x + 264)),
		height: Math.max(180, ...positioned.map((p) => p.y + 124))
	};
}
