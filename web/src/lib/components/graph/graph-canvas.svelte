<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { graphLayout, nodeTone, type GraphSnapshot } from '#lib/harness/graph.js';
	import { cn } from '#lib/utils.js';
	let {
		graph,
		selected,
		onselect
	}: { graph: GraphSnapshot; selected: string; onselect: (id: string) => void } = $props();
	let zoom = $state(1);
	const layout = $derived(graphLayout(graph.nodes));
</script>

<div class="flex items-center gap-2 border-b border-line px-3 py-2">
	<span class="flex-1 text-xs text-ink-secondary"
		>Select a node to inspect its progress. Dashed edges mark discoveries.</span
	>
	<Button
		variant="outline"
		size="icon-sm"
		aria-label="Zoom out"
		disabled={zoom <= 0.6}
		onclick={() => (zoom = Math.max(0.6, zoom - 0.2))}>−</Button
	>
	<Button variant="ghost" size="sm" onclick={() => (zoom = 1)} aria-label="Reset zoom"
		>{Math.round(zoom * 100)}%</Button
	>
	<Button
		variant="outline"
		size="icon-sm"
		aria-label="Zoom in"
		disabled={zoom >= 1.6}
		onclick={() => (zoom = Math.min(1.6, zoom + 0.2))}>+</Button
	>
</div>
<!-- svelte-ignore a11y_no_noninteractive_tabindex (The DAG scrolls in both directions for keyboard users.) -->
<div
	role="region"
	aria-label="Graph dependencies"
	tabindex="0"
	class="min-h-64 flex-1 overflow-auto"
>
	<div
		class="relative"
		style:width="{layout.width * zoom}px"
		style:height="{layout.height * zoom}px"
	>
		<div
			class="absolute origin-top-left"
			style:width="{layout.width}px"
			style:height="{layout.height}px"
			style:transform="scale({zoom})"
		>
			<svg
				width={layout.width}
				height={layout.height}
				class="absolute text-ink-tertiary"
				aria-hidden="true"
			>
				<defs
					><marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"
						><path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" /></marker
					></defs
				>
				{#each layout.edges as edge (`${edge.from}:${edge.to}:${edge.kind}`)}
					<path
						d={edge.path}
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-dasharray={edge.kind === 'discovered_from' ? '5 4' : undefined}
						marker-end="url(#graph-arrow)"
					/>
				{/each}
			</svg>
			{#each layout.nodes as { node, x, y } (node.id)}
				<button
					type="button"
					aria-pressed={selected === node.id}
					aria-label={`${node.title}: ${node.status}`}
					onclick={() => onselect(node.id)}
					style:left="{x}px"
					style:top="{y}px"
					class={cn(
						'absolute flex h-[100px] w-60 flex-col gap-1 rounded-md border bg-paper px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-olive',
						selected === node.id
							? 'border-olive ring-1 ring-olive'
							: 'border-line hover:border-line-strong'
					)}
				>
					<span class="truncate text-sm font-medium">{node.title}</span>
					<span class={cn('text-xs', nodeTone(node.status))}
						>{node.status.replaceAll('_', ' ')}</span
					>
					<span class="truncate font-mono text-[10px] text-ink-tertiary"
						>{node.id}{node.id === 'gn-final' ? ' · final verification' : ''}</span
					>
				</button>
			{/each}
		</div>
	</div>
</div>
