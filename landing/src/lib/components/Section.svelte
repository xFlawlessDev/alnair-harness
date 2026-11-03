<script lang="ts">
	import type { Phrase } from '$lib/content/types';
	import { reveal } from '$lib/actions/reveal';
	import Rich from './Rich.svelte';

	let {
		id,
		eyebrow,
		title,
		lede,
		centered = false
	}: {
		id?: string;
		eyebrow: string;
		title: Phrase[];
		lede?: string;
		centered?: boolean;
	} = $props();
</script>

<header {id} class="head" class:centered use:reveal>
	<p class="eyebrow">{eyebrow}</p>
	<h2>
		{#each title as part}<span class:accent={part.accent}>{part.text}</span>{/each}
	</h2>
	{#if lede}
		<p class="lede"><Rich text={lede} /></p>
	{/if}
</header>

<style>
	.head {
		max-width: 46rem;
		margin-bottom: 2.5rem;
	}

	.head.centered {
		margin-inline: auto;
		text-align: center;
	}

	h2 {
		margin: 0.75rem 0 0;
		font-size: clamp(1.75rem, 3.6vw, 2.875rem);
		font-weight: 600;
		line-height: 1.06;
		letter-spacing: -0.03em;
		color: var(--ink);
	}

	.accent {
		color: var(--olive);
	}

	.lede {
		margin: 1.125rem 0 0;
		font-size: 1.0313rem;
		line-height: 1.68;
		color: var(--ink-secondary);
	}

	@media (min-width: 900px) {
		.head {
			margin-bottom: 3rem;
		}
	}
</style>
