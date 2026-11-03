<script lang="ts">
	import GraphDiagram from './GraphDiagram.svelte';
	import InstallCommand from './InstallCommand.svelte';
	import Rich from './Rich.svelte';
	import type { SiteCopy } from '$lib/content/types';

	let { copy }: { copy: SiteCopy } = $props();

	/**
	 * The badge in the window chrome is derived from the diagram's own nodes,
	 * not typed in: a mockup that claims a state its picture does not show is
	 * the kind of detail a reader notices and stops trusting.
	 */
	const running = $derived(copy.graph.nodes.filter((node) => node.state === 'running').length);
</script>

<section class="hero">
	<div class="backdrop" aria-hidden="true">
		<div class="grid"></div>
		<div class="halo"></div>
	</div>

	<div class="shell inner">
		<div class="copy">
			<p class="badge">
				<span class="dot" aria-hidden="true"></span>
				{copy.hero.badge}
			</p>

			<h1>
				{#each copy.hero.title as part}<span class:accent={part.accent}>{part.text}</span>{/each}
			</h1>

			<p class="lede"><Rich text={copy.hero.lede} /></p>

			<div class="install-slot">
				<InstallCommand {copy} variant="compact" />
			</div>

			<p class="note"><Rich text={copy.hero.note} /></p>

			<div class="cta">
				<a class="btn btn-primary" href="#install">{copy.hero.primary}</a>
				<a class="btn btn-ghost" href="#graph">{copy.hero.secondary}</a>
			</div>
		</div>

		<div class="visual">
			<div class="viewer">
				<div class="viewer-bar" aria-hidden="true">
					<span class="dots"><i></i><i></i><i></i></span>
					<span class="viewer-title">alnair — /graph</span>
					<span class="viewer-state">{running} {copy.graph.states.running}</span>
				</div>
				<div class="viewer-body">
					<GraphDiagram {copy} />
				</div>
			</div>
		</div>
	</div>

	<div class="shell">
		<dl class="stats">
			{#each copy.stats as stat}
				<div class="stat">
					<dt>{stat.label}</dt>
					<dd class="value">{stat.value}</dd>
					<dd class="detail">{stat.detail}</dd>
				</div>
			{/each}
		</dl>
	</div>
</section>

<style>
	.hero {
		position: relative;
		overflow: clip;
		padding-top: 3.5rem;
	}

	.backdrop {
		position: absolute;
		inset: -6rem 0 auto 0;
		height: 44rem;
		pointer-events: none;
	}

	.grid {
		position: absolute;
		inset: 0;
		background-image: radial-gradient(var(--line-strong) 1px, transparent 1px);
		background-size: 24px 24px;
		mask-image: radial-gradient(ellipse 70% 55% at 50% 20%, #000 25%, transparent 75%);
		opacity: 0.7;
	}

	.halo {
		position: absolute;
		inset: -8rem -10% auto;
		height: 30rem;
		background: radial-gradient(ellipse 55% 60% at 50% 40%, var(--glow), transparent 70%);
	}

	.inner {
		position: relative;
		display: grid;
		gap: 3rem;
		align-items: start;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		padding: 0.3125rem 0.75rem 0.3125rem 0.5rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--paper-raised);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.02em;
		color: var(--ink-secondary);
	}

	.dot {
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 999px;
		background: var(--olive);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--olive) 20%, transparent);
	}

	h1 {
		margin: 1.25rem 0 0;
		font-size: clamp(2.5rem, 5.6vw, 4.25rem);
		font-weight: 600;
		line-height: 1.02;
		letter-spacing: -0.035em;
		color: var(--ink);
	}

	.accent {
		color: var(--olive);
	}

	.lede {
		margin: 1.375rem 0 0;
		max-width: 34rem;
		font-size: 1.0625rem;
		line-height: 1.68;
		color: var(--ink-secondary);
	}

	.install-slot {
		margin-top: 1.75rem;
		max-width: 34rem;
	}

	.note {
		margin: 0.75rem 0 0;
		max-width: 34rem;
		font-size: 0.75rem;
		line-height: 1.6;
		color: var(--ink-tertiary);
	}

	.cta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.625rem;
		margin-top: 1.5rem;
	}

	.visual {
		display: none;
	}

	.viewer {
		border: 1px solid var(--line);
		border-radius: var(--radius-panel);
		background: var(--paper-raised);
		box-shadow: var(--shadow);
		overflow: hidden;
	}

	.viewer-bar {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.625rem 0.875rem;
		border-bottom: 1px solid var(--line);
	}

	.dots {
		display: inline-flex;
		gap: 0.3125rem;
	}

	.dots i {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 999px;
		background: var(--line-strong);
	}

	.viewer-title {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--ink-tertiary);
	}

	.viewer-state {
		margin-left: auto;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--olive);
	}

	.viewer-body {
		padding: 1.5rem 1.375rem 0.5rem;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		margin: 3.5rem 0 0;
		border-top: 1px solid var(--line);
	}

	.stat {
		padding: 1.25rem 0.5rem 1.25rem 0;
		border-bottom: 1px solid var(--line);
	}

	.stat:nth-child(even) {
		padding-left: 1rem;
		border-left: 1px solid var(--line);
	}

	.stat dt {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-tertiary);
	}

	.stat .value {
		margin: 0.5rem 0 0;
		font-size: 1.75rem;
		font-weight: 600;
		line-height: 1;
		letter-spacing: -0.02em;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}

	.stat .detail {
		margin: 0.375rem 0 0;
		font-size: 0.75rem;
		color: var(--ink-tertiary);
	}

	@media (min-width: 900px) {
		.hero {
			padding-top: 5rem;
		}

		.inner {
			grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.92fr);
			gap: 3.5rem;
		}

		.visual {
			display: block;
			padding-top: 2.5rem;
		}

		.stats {
			grid-template-columns: repeat(4, minmax(0, 1fr));
			margin-top: 4.5rem;
		}

		.stat {
			padding: 1.5rem 1.25rem 1.5rem 0;
			border-bottom: 0;
		}

		.stat:nth-child(even) {
			padding-left: 1.5rem;
		}

		.stat:not(:first-child) {
			padding-left: 1.5rem;
			border-left: 1px solid var(--line);
		}
	}
</style>
