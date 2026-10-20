<script lang="ts">
	import { formatPercent, formatTokens } from '#lib/harness/format.js';
	import type { GraphState } from '#lib/harness/types.js';

	let { graph }: { graph: GraphState } = $props();

	const done = $derived(graph.total === 0 ? 0 : graph.achieved / graph.total);
	const budgetPct = $derived(
		graph.tokenBudget === undefined || graph.tokenBudget === 0
			? undefined
			: Math.min(100, Math.round((graph.tokensSpent / graph.tokenBudget) * 100))
	);

	const cells = $derived([
		{ label: 'total', value: graph.total, tone: 'text-ink' },
		{ label: 'running', value: graph.running, tone: 'text-running' },
		{ label: 'achieved', value: graph.achieved, tone: 'text-success' },
		{
			label: 'failed',
			value: graph.failed,
			tone: graph.failed > 0 ? 'text-error' : 'text-ink-tertiary'
		}
	]);
</script>

<div class="flex flex-col gap-3">
	<div class="flex items-baseline justify-between">
		<div class="flex items-center gap-1.5">
			<p class="text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">Graph</p>
			<span class="rounded-sm bg-paper-card px-1 font-mono text-[9.5px] text-ink-tertiary">
				v{graph.planVersion}
			</span>
		</div>
		<span class="tabular font-mono text-[10.5px] text-ink-tertiary">{formatPercent(done)}</span>
	</div>

	<p class="text-[12px] leading-snug text-ink-secondary">{graph.objective}</p>

	<div class="grid grid-cols-4 gap-1.5">
		{#each cells as cell (cell.label)}
			<div class="rounded-md border border-line px-1.5 py-1.5 text-center">
				<p class="font-mono text-[9px] tracking-wide text-ink-tertiary uppercase">{cell.label}</p>
				<p class="tabular mt-0.5 font-mono text-[13px] {cell.tone}">{cell.value}</p>
			</div>
		{/each}
	</div>

	{#if graph.currentNodeTitle}
		<div class="flex flex-col gap-0.5 rounded-md border border-running/30 bg-running/5 px-2 py-1.5">
			<p class="text-[9.5px] font-medium tracking-[0.08em] text-running uppercase">current</p>
			<p class="text-[11.5px] leading-snug text-ink-secondary">{graph.currentNodeTitle}</p>
			<p class="truncate font-mono text-[9.5px] text-ink-tertiary">{graph.currentNode}</p>
		</div>
	{/if}

	{#if budgetPct !== undefined && graph.tokenBudget !== undefined}
		<div class="flex flex-col gap-1">
			<div class="flex items-baseline justify-between font-mono text-[9.5px] text-ink-tertiary">
				<span class="uppercase">budget</span>
				<span class="tabular">
					{formatTokens(graph.tokensSpent)} / {formatTokens(graph.tokenBudget)}
				</span>
			</div>
			<span class="flex h-1 overflow-hidden rounded-full bg-line">
				<span class="h-full rounded-full bg-olive" style="width: {budgetPct}%"></span>
			</span>
		</div>
	{/if}

	{#if graph.pauseMessage}
		<p
			class="rounded-md border border-terra/30 bg-terra/5 px-2 py-1.5 text-[11px] text-ink-secondary"
		>
			{graph.pauseMessage}
		</p>
	{/if}

	<p class="font-mono text-[10px] text-ink-tertiary/80">
		{graph.phase} · {graph.status}{graph.lastEvent ? ` · ${graph.lastEvent}` : ''}
	</p>
</div>
