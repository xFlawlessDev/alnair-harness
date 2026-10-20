<script lang="ts">
	import NetworkIcon from '@lucide/svelte/icons/network';
	import * as HoverCard from '#lib/components/ui/hover-card/index.js';
	import { formatPercent, formatTokens } from '#lib/harness/format.js';
	import type { GraphState } from '#lib/harness/types.js';
	import StatusDot from './status-dot.svelte';

	let { graph }: { graph: GraphState } = $props();

	// The wire sends counts, so the chip counts. It never reconstructs a DAG.
	const done = $derived(graph.total === 0 ? 0 : graph.achieved / graph.total);

	const dotStatus = $derived(
		graph.status === 'paused' || graph.status === 'user_paused' || graph.status === 'budget_limited'
			? 'attention'
			: graph.failed > 0
				? 'error'
				: graph.running > 0
					? 'running'
					: 'complete'
	);
</script>

<HoverCard.Root>
	<HoverCard.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="flex h-7 items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 text-[11px] transition-colors hover:border-line-strong"
				aria-label="Graph status"
			>
				<NetworkIcon class="size-3 text-olive" />
				<StatusDot status={dotStatus} pulse={graph.running > 0} />
				<span class="tabular font-mono text-ink-secondary">
					{graph.achieved}/{graph.total}
				</span>
				<span class="text-ink-tertiary/50">·</span>
				<span class="text-ink-tertiary">v{graph.planVersion}</span>
			</button>
		{/snippet}
	</HoverCard.Trigger>
	<HoverCard.Content class="w-80">
		<p class="text-[12.5px] leading-snug font-medium">{graph.objective}</p>

		<div class="mt-2 flex items-center gap-2 font-mono text-[10.5px] text-ink-tertiary">
			<span class="tabular">{formatPercent(done)}</span>
			<span>·</span>
			<span>{graph.phase}</span>
			<span>·</span>
			<span>{graph.status}</span>
		</div>

		<dl class="mt-3 grid grid-cols-3 gap-2 text-center">
			{#each [{ label: 'running', value: graph.running }, { label: 'achieved', value: graph.achieved }, { label: 'failed', value: graph.failed }] as cell (cell.label)}
				<div class="rounded-md border border-line px-2 py-1.5">
					<dt class="font-mono text-[9.5px] tracking-wide text-ink-tertiary uppercase">
						{cell.label}
					</dt>
					<dd class="tabular mt-0.5 font-mono text-[13px]">{cell.value}</dd>
				</div>
			{/each}
		</dl>

		{#if graph.currentNodeTitle}
			<p class="mt-3 flex items-start gap-1.5 text-[12px]">
				<StatusDot status="running" pulse class="mt-1.5" />
				<span class="min-w-0">
					<span class="block truncate">{graph.currentNodeTitle}</span>
					<span class="font-mono text-[10px] text-ink-tertiary">{graph.currentNode}</span>
				</span>
			</p>
		{/if}

		{#if graph.tokenBudget !== undefined}
			<div class="mt-3 flex flex-col gap-1">
				<div class="flex items-baseline justify-between font-mono text-[10px] text-ink-tertiary">
					<span>budget</span>
					<span class="tabular">
						{formatTokens(graph.tokensSpent)} / {formatTokens(graph.tokenBudget)}
					</span>
				</div>
				<span class="flex h-1 overflow-hidden rounded-full bg-line">
					<span
						class="h-full rounded-full bg-olive"
						style="width: {Math.min(
							100,
							Math.round((graph.tokensSpent / graph.tokenBudget) * 100)
						)}%"
					></span>
				</span>
			</div>
		{/if}

		{#if graph.pauseMessage}
			<p
				class="mt-3 rounded-md border border-terra/30 bg-terra/5 px-2 py-1.5 text-[11.5px] text-ink-secondary"
			>
				{graph.pauseMessage}
			</p>
		{:else if graph.lastEvent}
			<p class="mt-3 truncate font-mono text-[10.5px] text-ink-tertiary">{graph.lastEvent}</p>
		{/if}
	</HoverCard.Content>
</HoverCard.Root>
