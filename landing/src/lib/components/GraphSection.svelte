<script lang="ts">
	import Rich from './Rich.svelte';
	import Section from './Section.svelte';
	import Terminal from './Terminal.svelte';
	import { reveal } from '$lib/actions/reveal';
	import type { SiteCopy } from '$lib/content/types';

	let { copy }: { copy: SiteCopy } = $props();
</script>

<section class="band" id="graph">
	<div class="shell">
		<Section
			id="graph-heading"
			eyebrow={copy.graph.eyebrow}
			title={copy.graph.title}
			lede={copy.graph.lede}
		/>

		<div class="split">
			<ol class="steps">
				{#each copy.graph.steps as step, index (step.title)}
					<li use:reveal={{ delay: index * 40 }}>
						<span class="num" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
						<div>
							<h3>{step.title}</h3>
							<p><Rich text={step.body} /></p>
						</div>
					</li>
				{/each}
			</ol>

			<div class="aside">
				<Terminal title={copy.graph.commandTitle} lines={copy.graph.commandLines} />

				<div class="notes">
					<p><Rich text={copy.graph.state} /></p>
					<p><Rich text={copy.graph.config} /></p>
				</div>
			</div>
		</div>
	</div>
</section>

<style>
	.band {
		padding-block: 5rem;
		border-top: 1px solid var(--line);
	}

	.split {
		display: grid;
		gap: 2.5rem;
	}

	.steps {
		display: grid;
		gap: 1.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.steps li {
		display: grid;
		grid-template-columns: 2rem minmax(0, 1fr);
		gap: 0.75rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--line);
	}

	.steps li:first-child {
		padding-top: 0;
		border-top: 0;
	}

	.num {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--olive);
		padding-top: 0.1875rem;
	}

	h3 {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--ink);
	}

	.steps p {
		margin: 0.375rem 0 0;
		font-size: 0.875rem;
		line-height: 1.68;
		color: var(--ink-secondary);
	}

	.aside {
		display: grid;
		gap: 1.25rem;
		align-content: start;
	}

	.notes {
		display: grid;
		gap: 0.75rem;
	}

	.notes p {
		margin: 0;
		padding: 1rem 1.125rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		background: var(--paper-raised);
		font-size: 0.8125rem;
		line-height: 1.65;
		color: var(--ink-secondary);
	}

	@media (min-width: 960px) {
		.band {
			padding-block: 6.5rem;
		}

		.split {
			grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
			gap: 4rem;
			align-items: start;
		}

		.aside {
			position: sticky;
			top: 5.25rem;
		}
	}
</style>
