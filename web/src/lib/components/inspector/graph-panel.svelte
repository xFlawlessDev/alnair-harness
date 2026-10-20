<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleDotIcon from '@lucide/svelte/icons/circle-dot';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { formatPercent } from '#lib/harness/format.js';
	import type { GraphNode, GraphState } from '#lib/harness/types.js';

	let { graph }: { graph: GraphState } = $props();

	const layers = $derived.by(() => {
		const byId = new Map(graph.nodes.map((node) => [node.id, node]));
		const depth = new Map<string, number>();

		const resolve = (id: string, seen: Set<string> = new Set()): number => {
			if (depth.has(id)) return depth.get(id)!;
			if (seen.has(id)) return 0;
			seen.add(id);
			const node = byId.get(id);
			if (!node || node.dependsOn.length === 0) {
				depth.set(id, 0);
				return 0;
			}
			const value = 1 + Math.max(...node.dependsOn.map((dep) => resolve(dep, seen)));
			depth.set(id, value);
			return value;
		};

		for (const node of graph.nodes) resolve(node.id);

		const buckets: GraphNode[][] = [];
		for (const node of graph.nodes) {
			const index = depth.get(node.id) ?? 0;
			(buckets[index] ??= []).push(node);
		}
		return buckets;
	});

	const achieved = $derived(graph.nodes.filter((n) => n.status === 'achieved').length);
	const running = $derived(graph.nodes.filter((n) => n.status === 'running').length);
	const total = $derived(graph.nodes.length);

	const statusLabel: Record<GraphNode['status'], string> = {
		pending: 'pending',
		ready: 'ready',
		running: 'running',
		achieved: 'achieved',
		blocked: 'blocked',
		failed: 'failed'
	};

	const statusTone: Record<GraphNode['status'], string> = {
		pending: 'text-ink-tertiary',
		ready: 'text-terra',
		running: 'text-running',
		achieved: 'text-success',
		blocked: 'text-error',
		failed: 'text-error'
	};
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-baseline justify-between">
		<div class="flex items-center gap-1.5">
			<p class="text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">Graph</p>
			<span class="rounded-sm bg-paper-card px-1 font-mono text-[9.5px] text-ink-tertiary">
				v{graph.planVersion}
			</span>
		</div>
		<span class="tabular font-mono text-[10.5px] text-ink-tertiary">
			{formatPercent(achieved, total)}
		</span>
	</div>

	<p class="text-[12px] leading-snug text-ink-secondary">{graph.objective}</p>

	<div class="flex flex-col gap-2">
		{#each layers as layer, index (index)}
			<div class="flex flex-col gap-1">
				<p class="font-mono text-[9.5px] tracking-wide text-ink-tertiary/70 uppercase">
					layer {index}
				</p>
				{#each layer as node (node.id)}
					<div
						class="group relative flex flex-col gap-1 rounded-md border border-line bg-paper px-2 py-1.5"
					>
						<div class="flex items-start gap-1.5">
							{#if node.status === 'achieved'}
								<CircleCheckIcon class="mt-px size-3 shrink-0 text-success" />
							{:else if node.status === 'running'}
								<LoaderIcon class="mt-px size-3 shrink-0 animate-spin text-running" />
							{:else if node.status === 'blocked' || node.status === 'failed'}
								<TriangleAlertIcon class="mt-px size-3 shrink-0 text-error" />
							{:else}
								<CircleDotIcon class="mt-px size-3 shrink-0 text-ink-tertiary/50" />
							{/if}
							<p
								class="min-w-0 flex-1 text-[11.5px] leading-snug"
								class:text-ink-tertiary={node.status === 'pending'}
								class:text-ink-secondary={node.status !== 'pending'}
							>
								{node.title}
							</p>
						</div>

						<div class="flex items-center gap-2 pl-4.5">
							<span class={['font-mono text-[9.5px]', statusTone[node.status]]}>
								{statusLabel[node.status]}
							</span>
							{#if node.budgetUsed !== undefined && node.status !== 'pending'}
								<span class="ml-auto flex h-1 w-12 overflow-hidden rounded-full bg-line">
									<span
										class="h-full rounded-full"
										class:bg-running={node.status === 'running'}
										class:bg-success={node.status === 'achieved'}
										class:bg-olive={node.status === 'ready'}
										style="width: {Math.round(node.budgetUsed * 100)}%"
									></span>
								</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/each}
	</div>

	<p class="font-mono text-[10px] text-ink-tertiary/80">
		{running} running · {graph.concurrency} lanes · {graph.status}
	</p>
</div>
