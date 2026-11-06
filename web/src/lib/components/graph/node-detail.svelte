<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { formatDuration, formatTokens } from '#lib/harness/format.js';
	import { nodeSubagents, nodeTone, type GraphNode, type GraphView } from '#lib/harness/graph.js';
	import type { SubagentSummary } from '#lib/harness/types.js';
	let {
		node,
		data,
		onselect,
		onsubagent
	}: {
		node: GraphNode;
		data: GraphView;
		onselect: (id: string) => void;
		onsubagent: (agent: SubagentSummary) => void;
	} = $props();
	const agents = $derived(nodeSubagents(node, data, data.subagents));
	const goal = $derived(data.node_goal?.node_id === node.id ? data.node_goal : undefined);
	const dependents = $derived(
		data.graph?.nodes.filter((candidate) => candidate.deps.some((dep) => dep.on === node.id)) ?? []
	);
	const history = $derived(data.graph?.history.filter((event) => event.node_id === node.id) ?? []);
	const name = (id: string) =>
		data.graph?.nodes.find((candidate) => candidate.id === id)?.title ?? id;
</script>

<aside
	aria-label="Node details"
	class="flex min-h-0 flex-col gap-4 border-t border-line p-4 lg:overflow-y-auto lg:border-t-0 lg:border-l"
>
	<div>
		<h3 class="text-sm font-medium">{node.title}</h3>
		<p class="mt-1 font-mono text-xs text-ink-tertiary">{node.id}</p>
		<p class={nodeTone(node.status)}>{node.status.replaceAll('_', ' ')}</p>
	</div>
	<p class="text-sm whitespace-pre-wrap text-ink-secondary">{node.spec}</p>
	<dl class="grid grid-cols-2 gap-3 text-xs">
		<div>
			<dt class="text-ink-tertiary">{goal ? 'Worker rounds' : 'Recorded rounds'}</dt>
			<dd class="font-mono">{goal?.worker_rounds ?? node.rounds}</dd>
		</div>
		<div>
			<dt class="text-ink-tertiary">Recorded tokens</dt>
			<dd class="font-mono">{formatTokens(goal?.tokens_used ?? node.tokens_used)}</dd>
		</div>
		{#if goal}<div>
				<dt class="text-ink-tertiary">Verification rounds</dt>
				<dd class="font-mono">{goal.verify_rounds}</dd>
			</div>
			<div>
				<dt class="text-ink-tertiary">Elapsed</dt>
				<dd>{formatDuration(goal.elapsed_ms) || '—'}</dd>
			</div>{/if}
	</dl>
	{#if node.failure || goal?.pause_message}<p role="status" class="text-sm text-error">
			{node.failure || goal?.pause_message}
		</p>{/if}
	<section aria-label="Dependencies">
		<h4 class="mb-1 text-xs font-medium">Dependencies</h4>
		{#if node.deps.length === 0}<p class="text-xs text-ink-tertiary">No dependencies.</p>{/if}
		{#each node.deps as dep (`${dep.on}:${dep.kind}`)}
			<Button variant="link" size="sm" onclick={() => onselect(dep.on)}
				>{name(dep.on)}{dep.kind === 'discovered_from' ? ' (discovered from)' : ''}</Button
			>
		{/each}
	</section>
	{#if dependents.length}
		<section aria-label="Dependent nodes">
			<h4 class="text-xs font-medium">Used by</h4>
			{#each dependents as dep (dep.id)}<Button
					variant="link"
					size="sm"
					onclick={() => onselect(dep.id)}>{dep.title}</Button
				>{/each}
		</section>
	{/if}
	<section aria-label="Node workers" class="flex flex-col gap-2">
		<h4 class="text-xs font-medium">Worker and verifier activity</h4>
		{#each agents as agent (agent.id)}
			<div class="rounded-md border border-line p-2 text-xs">
				<p class="font-medium">{agent.description}</p>
				<p class="text-ink-secondary">
					{agent.status} · {agent.turnCount} turns · {agent.toolCallCount} tool calls
				</p>
				<p class="text-ink-tertiary">
					{formatTokens(agent.tokensUsed)} live context tokens · {agent.contextUsagePct}% context · {formatDuration(
						agent.durationMs
					)}
				</p>
				{#if agent.toolsUsed.length}<p class="mt-1 text-ink-tertiary">
						Tools: {agent.toolsUsed.join(', ')}
					</p>{/if}
				{#if agent.errorCount}<p class="text-error">{agent.errorCount} errors</p>{/if}
				<Button variant="outline" size="sm" class="mt-2" onclick={() => onsubagent(agent)}
					>View transcript</Button
				>
			</div>
		{:else}
			<p class="text-xs text-ink-tertiary">
				{node.status === 'waiting' || node.status === 'ready'
					? 'No worker has started.'
					: 'No child activity is available in this session. Recorded node totals are shown above.'}
			</p>
		{/each}
	</section>
	{#if history.length}
		<section aria-label="Node history">
			<h4 class="mb-2 text-xs font-medium">Node history</h4>
			<ol class="flex flex-col gap-2 text-xs">
				{#each history as event, index (`${event.timestamp}:${index}`)}<li>
						<time class="text-ink-tertiary" datetime={event.timestamp}
							>{new Date(event.timestamp).toLocaleTimeString()}</time
						>
						<p>{event.event.replaceAll('_', ' ')}</p>
						{#if event.detail}<p class="whitespace-pre-wrap text-ink-secondary">
								{event.detail}
							</p>{/if}
					</li>{/each}
			</ol>
		</section>
	{/if}
</aside>
