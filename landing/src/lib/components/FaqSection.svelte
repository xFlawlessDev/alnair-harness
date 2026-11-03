<script lang="ts">
	import Section from './Section.svelte';
	import Rich from './Rich.svelte';
	import { reveal } from '$lib/actions/reveal';
	import type { SiteCopy } from '$lib/content/types';

	let { copy }: { copy: SiteCopy } = $props();
</script>

<section class="band" id="faq">
	<div class="shell">
		<Section id="faq-heading" eyebrow={copy.faq.eyebrow} title={copy.faq.title} />

		<div class="list">
			{#each copy.faq.items as item, index (item.q)}
				<details use:reveal={{ delay: index * 35 }}>
					<summary>
						<span>{item.q}</span>
						<span class="plus" aria-hidden="true"></span>
					</summary>
					<p><Rich text={item.a} /></p>
				</details>
			{/each}
		</div>
	</div>
</section>

<style>
	.band {
		padding-block: 5rem;
		border-top: 1px solid var(--line);
		background: var(--paper-raised);
	}

	.list {
		display: grid;
		border-top: 1px solid var(--line);
	}

	details {
		border-bottom: 1px solid var(--line);
	}

	summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1.5rem;
		padding: 1.125rem 0;
		font-size: 0.9375rem;
		font-weight: 500;
		color: var(--ink);
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	.plus {
		position: relative;
		flex: none;
		width: 0.75rem;
		height: 0.75rem;
	}

	.plus::before,
	.plus::after {
		content: '';
		position: absolute;
		background: var(--ink-tertiary);
		transition: transform 0.2s ease;
	}

	.plus::before {
		inset: 0 0 auto 0;
		height: 1px;
		top: 50%;
	}

	.plus::after {
		inset: 0 auto 0 0;
		width: 1px;
		left: 50%;
	}

	details[open] .plus::after {
		transform: scaleY(0);
	}

	details p {
		margin: 0;
		padding: 0 2.5rem 1.375rem 0;
		max-width: 46rem;
		font-size: 0.875rem;
		line-height: 1.7;
		color: var(--ink-secondary);
	}

	@media (min-width: 960px) {
		.band {
			padding-block: 6.5rem;
		}

		summary {
			padding-block: 1.375rem;
			font-size: 1rem;
		}
	}
</style>
