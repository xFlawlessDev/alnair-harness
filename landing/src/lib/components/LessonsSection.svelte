<script lang="ts">
	import Section from './Section.svelte';
	import Terminal from './Terminal.svelte';
	import Rich from './Rich.svelte';
	import { reveal } from '$lib/actions/reveal';
	import type { SiteCopy } from '$lib/content/types';

	let { copy }: { copy: SiteCopy } = $props();
</script>

<section class="band" id="lessons">
	<div class="shell">
		<div class="split">
			<div class="snippet">
				<Terminal title={copy.lessons.snippetTitle} lines={copy.lessons.snippetLines} />
			</div>

			<div>
				<Section id="lessons-heading" eyebrow={copy.lessons.eyebrow} title={copy.lessons.title} />

				<p class="lede"><Rich text={copy.lessons.lede} /></p>

				<ul class="points">
					{#each copy.lessons.points as point, index (point.title)}
						<li use:reveal={{ delay: index * 60 }}>
							<h3>{point.title}</h3>
							<p><Rich text={point.body} /></p>
						</li>
					{/each}
				</ul>

				<p class="foot"><Rich text={copy.lessons.footnote} /></p>
			</div>
		</div>
	</div>
</section>

<style>
	.band {
		padding-block: 5rem;
		border-top: 1px solid var(--line);
		background: var(--paper-raised);
	}

	.split {
		display: grid;
		gap: 2.5rem;
		align-items: start;
	}

	.snippet :global(figure) {
		box-shadow: none;
	}

	.lede {
		margin: -1.25rem 0 2rem;
		max-width: 40rem;
		font-size: 1.0313rem;
		line-height: 1.7;
		color: var(--ink-secondary);
	}

	.points {
		display: grid;
		gap: 1.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.points li {
		padding-top: 1.125rem;
		border-top: 1px solid var(--line);
	}

	h3 {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--ink);
	}

	.points p {
		margin: 0.375rem 0 0;
		font-size: 0.875rem;
		line-height: 1.65;
		color: var(--ink-secondary);
	}

	.foot {
		margin: 1.75rem 0 0;
		font-size: 0.75rem;
		line-height: 1.6;
		color: var(--ink-tertiary);
	}

	@media (min-width: 960px) {
		.band {
			padding-block: 6.5rem;
		}

		.split {
			grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
			gap: 4.5rem;
			align-items: start;
		}

		.snippet {
			position: sticky;
			top: 5rem;
		}
	}
</style>
