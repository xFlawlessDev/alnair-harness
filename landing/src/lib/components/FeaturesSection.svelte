<script lang="ts">
	import Section from './Section.svelte';
	import MockDashboard from './mock/MockDashboard.svelte';
	import MockHooks from './mock/MockHooks.svelte';
	import MockHeadless from './mock/MockHeadless.svelte';
	import MockMcp from './mock/MockMcp.svelte';
	import MockPermission from './mock/MockPermission.svelte';
	import MockSandbox from './mock/MockSandbox.svelte';
	import MockSkill from './mock/MockSkill.svelte';
	import MockSubagents from './mock/MockSubagents.svelte';
	import MockTabs from './mock/MockTabs.svelte';
	import MockTheme from './mock/MockTheme.svelte';
	import MockWeb from './mock/MockWeb.svelte';
	import { reveal } from '$lib/actions/reveal';
	import type { FeatureItem, FeatureSample, SiteCopy } from '$lib/content/types';

	let { copy, docsHref }: { copy: SiteCopy; docsHref: string } = $props();

	/**
	 * Every sample is a component, not an image, so the card and the sample
	 * cannot drift apart: adding a `FeatureSample` without a component here is a
	 * type error at this map.
	 */
	const samples: Record<FeatureSample, typeof MockDashboard> = {
		dashboard: MockDashboard,
		tabs: MockTabs,
		subagents: MockSubagents,
		mcp: MockMcp,
		skills: MockSkill,
		permission: MockPermission,
		hooks: MockHooks,
		sandbox: MockSandbox,
		headless: MockHeadless,
		theme: MockTheme,
		web: MockWeb
	};

	function sampleFor(item: FeatureItem) {
		return samples[item.sample];
	}
</script>

<section class="band" id="features">
	<div class="shell">
		<div class="head">
			<Section
				id="features-heading"
				eyebrow={copy.features.eyebrow}
				title={copy.features.title}
				lede={copy.features.lede}
			/>

			<a class="docs" href={docsHref}>
				{copy.features.docsLink}
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					aria-hidden="true"
				>
					<path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			</a>
		</div>

		<ul class="bento">
			{#each copy.features.items as item, index (item.sample)}
				{@const Mock = sampleFor(item)}
				<li class="card" class:wide={item.wide} use:reveal={{ delay: (index % 3) * 50 }}>
					<div class="shot">
						<Mock />
					</div>
					<div class="text">
						<h3>{item.title}</h3>
						<p>{item.body}</p>
					</div>
				</li>
			{/each}
		</ul>
	</div>
</section>

<style>
	.band {
		padding-block: 5rem;
		border-top: 1px solid var(--line);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
	}

	.head :global(.head) {
		margin-bottom: 0;
	}

	.docs {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		margin-bottom: 2.5rem;
		padding: 0.5rem 0.875rem;
		border: 1px solid var(--line-strong);
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		color: var(--ink-secondary);
		text-decoration: none;
		transition:
			color 0.15s ease,
			border-color 0.15s ease,
			background-color 0.15s ease;
	}

	.docs:hover {
		color: var(--ink);
		border-color: var(--ink-tertiary);
		background: var(--paper-card);
	}

	.docs svg {
		width: 0.875rem;
		height: 0.875rem;
	}

	.bento {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.875rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 0.875rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		background: var(--paper-raised);
		transition:
			border-color 0.2s ease,
			background-color 0.2s ease;
	}

	.card:hover {
		border-color: var(--line-strong);
		background: var(--paper-card);
	}

	/* The sample is the card's picture: it gets a fixed share of the height so
	   every card in a row lines its heading up, whatever the sample draws. */
	.shot {
		display: flex;
		min-height: 8.25rem;
	}

	.shot > :global(*) {
		flex: 1;
	}

	.wide .shot {
		min-height: 9.5rem;
	}

	.text h3 {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		letter-spacing: -0.005em;
		color: var(--ink);
	}

	.text p {
		margin: 0.375rem 0 0;
		font-size: 0.8125rem;
		line-height: 1.65;
		color: var(--ink-secondary);
	}

	@media (min-width: 640px) {
		.bento {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.wide {
			grid-column: span 2;
		}

		.wide {
			flex-direction: row;
			align-items: center;
			gap: 1.5rem;
		}

		.wide .shot {
			flex: 0 0 58%;
			min-height: 0;
		}

		.wide .text {
			flex: 1;
		}
	}

	/* Three columns above 1080px. Two wide cards take the first two rows so the
	   nine small ones tile into a clean 3×3 below them — a bento whose rows have
	   a ragged last cell reads as a layout bug, not as rhythm. */
	@media (min-width: 1080px) {
		.band {
			padding-block: 6.5rem;
		}

		.bento {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 1rem;
		}

		.wide {
			grid-column: span 3;
			gap: 2rem;
			padding: 1rem;
		}

		.wide .shot {
			flex: 0 0 52%;
		}

		.wide .text {
			max-width: 26rem;
		}
	}
</style>
