<script lang="ts">
	import NetworkIcon from '@lucide/svelte/icons/network';
	import * as HoverCard from '#lib/components/ui/hover-card/index.js';
	import { formatPercent } from '#lib/harness/format.js';
	import type { GraphState } from '#lib/harness/types.js';
	import StatusDot from './status-dot.svelte';

	let { graph }: { graph: GraphState } = $props();

	const achieved = $derived(graph.nodes.filter((n) => n.status === 'achieved').length);
	const running = $derived(graph.nodes.filter((n) => n.status === 'running').length);
	const total = $derived(graph.nodes.length);
	const failed = $derived(
		graph.nodes.filter((n) => n.status === 'failed' || n.status === 'blocked').length
	);

	const dotStatus = $derived(
		graph.status === 'paused'
			? 'attention'
			: failed > 0
				? 'error'
				: running > 0
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
				<StatusDot status={dotStatus} pulse={running > 0} />
				<span class="tabular font-mono text-ink-secondary">
					{achieved}/{total}
				</span>
				<span class="text-ink-tertiary/50">·</span>
				<span class="text-ink-tertiary">v{graph.planVersion}</span>
			</button>
		{/snippet}
	</HoverCard.Trigger>
	<HoverCard.Content class="w-80">
		<div class="flex items-start justify-between gap-3">
			<p class="text-[12.5px] leading-snug font-medium">{graph.objective}</p>
		</div>
		<div class="mt-2 flex items-center gap-2 font-mono text-[10.5px] text-ink-tertiary">
			<span class="tabular">{formatPercent(achieved, total)}</span>
			<span>·</span>
			<span>{graph.concurrency} lanes</span>
			<span>·</span>
			<span>{graph.status}</span>
		</div>
		<ul class="mt-3 flex flex-col gap-1">
			{#each graph.nodes as node (node.id)}
				<li class="flex items-center gap-2 text-[12px]">
					<StatusDot
						status={node.status === 'achieved'
							? 'complete'
							: node.status === 'running'
								? 'running'
								: node.status === 'failed' || node.status === 'blocked'
									? 'error'
									: node.status === 'ready'
										? 'attention'
										: 'pending'}
						pulse={node.status === 'running'}
					/>
					<span
						class="min-w-0 truncate"
						class:text-ink-tertiary={node.status === 'pending'}
						class:line-through={node.status === 'achieved'}
						class:text-ink-secondary={node.status !== 'pending' && node.status !== 'achieved'}
					>
						{node.title}
					</span>
				</li>
			{/each}
		</ul>
	</HoverCard.Content>
</HoverCard.Root>
