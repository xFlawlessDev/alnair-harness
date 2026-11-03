<script lang="ts">
	import type { SiteCopy } from '$lib/content/types';

	let { copy }: { copy: SiteCopy } = $props();

	const stateColor: Record<string, string> = {
		verified: 'var(--accent-success)',
		running: 'var(--accent-running)',
		ready: 'var(--ink-tertiary)',
		blocked: 'var(--line-strong)'
	};

	/** Column/row layout, in the 582×320 view box the figure is drawn in. */
	const layout: Record<string, { x: number; y: number }> = {
		'gn-plan': { x: 12, y: 132 },
		'gn-api': { x: 158, y: 52 },
		'gn-ui': { x: 158, y: 212 },
		'gn-tests': { x: 304, y: 132 },
		'gn-final': { x: 450, y: 132 }
	};

	const W = 106;
	const H = 56;

	const edges = [
		['gn-plan', 'gn-api'],
		['gn-plan', 'gn-ui'],
		['gn-api', 'gn-tests'],
		['gn-ui', 'gn-tests'],
		['gn-tests', 'gn-final']
	] as const;

	function path(from: string, to: string): string {
		const a = layout[from];
		const b = layout[to];
		const x1 = a.x + W;
		const y1 = a.y + H / 2;
		const x2 = b.x;
		const y2 = b.y + H / 2;
		const mid = (x1 + x2) / 2;
		return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
	}

	const legend = ['verified', 'running', 'ready', 'blocked'] as const;
</script>

<figure class="dag">
	<svg viewBox="0 0 582 320" role="img" aria-label={copy.graph.diagramCaption}>
		<defs>
			<marker
				id="dag-head"
				viewBox="0 0 8 8"
				refX="7"
				refY="4"
				markerWidth="6"
				markerHeight="6"
				orient="auto-start-reverse"
			>
				<path class="head" d="M 1 1 L 7 4 L 1 7 z" />
			</marker>
		</defs>

		{#each edges as [from, to] (from + to)}
			<path class="edge" d={path(from, to)} marker-end="url(#dag-head)" />
		{/each}

		{#each copy.graph.nodes as node (node.id)}
			{@const box = layout[node.id]}
			<g class="node" class:blocked={node.state === 'blocked'}>
				<rect x={box.x} y={box.y} width={W} height={H} rx="8" />
				<circle
					class="dot"
					class:running={node.state === 'running'}
					cx={box.x + 16}
					cy={box.y + 20}
					r="3.2"
					fill={stateColor[node.state]}
				/>
				<text class="id" x={box.x + 27} y={box.y + 24}>{node.label}</text>
				<text class="note" x={box.x + 14} y={box.y + 41}>{node.note}</text>
			</g>
		{/each}
	</svg>

	<figcaption>
		<ul class="legend">
			{#each legend as state (state)}
				<li><i style:background={stateColor[state]}></i>{copy.graph.states[state]}</li>
			{/each}
		</ul>
		<span>{copy.graph.diagramCaption}</span>
	</figcaption>
</figure>

<style>
	.dag {
		margin: 0;
	}

	svg {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
	}

	.edge {
		fill: none;
		stroke: var(--line-strong);
		stroke-width: 1.25;
	}

	.head {
		fill: var(--line-strong);
	}

	.node rect {
		fill: var(--paper-card);
		stroke: var(--line);
		stroke-width: 1;
		transition:
			stroke 0.2s ease,
			fill 0.2s ease;
	}

	.node.blocked rect {
		stroke-dasharray: 4 3;
	}

	.dot.running {
		animation: pulse 1.8s ease-in-out infinite;
	}

	.id {
		fill: var(--ink);
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: -0.01em;
	}

	.note {
		fill: var(--ink-tertiary);
		font-family: var(--font-mono);
		font-size: 9px;
	}

	figcaption {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin-top: 0.875rem;
		font-size: 0.75rem;
		line-height: 1.6;
		color: var(--ink-tertiary);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
	}

	.legend i {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 999px;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dot.running {
			animation: none;
		}
	}
</style>
