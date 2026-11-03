<script lang="ts">
	/**
	 * The docs index: what the guide contains and where to start.
	 *
	 * It lists the chapters in the order the TUI's own docs picker uses, which
	 * is reading order rather than alphabetical order.
	 */
	import Rich from '$lib/components/Rich.svelte';
	import Seo from '$lib/seo/Seo.svelte';
	import { breadcrumbs } from '$lib/seo/schema';
	import { docsCopy } from '$lib/docs/copy';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const copy = $derived(docsCopy.en);

	/** Tier headings are editorial; the guide itself only numbers its chapters. */
	const groups = [
		{ label: 'Start here', from: 0, to: 5 },
		{ label: 'Customise and extend', from: 5, to: 13 },
		{ label: 'Advanced', from: 13, to: Infinity }
	];

	const sections = $derived(
		groups
			.map((group) => ({
				label: group.label,
				docs: data.docs.slice(group.from, Math.min(group.to, data.docs.length))
			}))
			.filter((group) => group.docs.length > 0)
	);
</script>

<Seo
	locale="en"
	path="/docs/"
	title={`${copy.title} — Alnair`}
	description={copy.subtitle}
	jsonLd={[
		breadcrumbs([
			{ name: 'Alnair', path: '/' },
			{ name: 'User guide', path: '/docs/' }
		])
	]}
/>

<header class="intro">
	<h1>{copy.title}</h1>
	<p class="lede"><Rich text={copy.subtitle} /></p>
</header>

{#each sections as section (section.label)}
	<section class="group">
		<h2>{section.label}</h2>
		<ul>
			{#each section.docs as doc (doc.slug)}
				<li>
					<a href="{doc.slug}/">
						<span class="title">{doc.title}</span>
						<span class="desc"><Rich text={doc.description} /></span>
					</a>
				</li>
			{/each}
		</ul>
	</section>
{/each}

<style>
	.intro {
		max-width: 46rem;
	}

	h1 {
		margin: 0;
		font-size: clamp(1.875rem, 3.6vw, 2.75rem);
		font-weight: 600;
		line-height: 1.08;
		letter-spacing: -0.03em;
		color: var(--ink);
	}

	.lede {
		margin: 0.875rem 0 0;
		font-size: 1.0313rem;
		line-height: 1.65;
		color: var(--ink-secondary);
	}

	.group {
		margin-top: 2.75rem;
	}

	h2 {
		margin: 0 0 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 400;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-tertiary);
	}

	ul {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1px;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		background: var(--line);
		overflow: hidden;
	}

	/* Three fixed columns rather than `auto-fill`: a track that fills the row
	   leaves a grey remainder cell, which reads as a missing chapter. */
	@media (max-width: 1100px) {
		ul {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 700px) {
		ul {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	li a {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		height: 100%;
		padding: 0.9375rem 1rem 1.0625rem;
		background: var(--paper-raised);
		text-decoration: none;
		transition: background-color 0.15s ease;
	}

	li a:hover {
		background: var(--paper-card);
	}

	.title {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--ink);
	}

	.desc {
		font-size: 0.75rem;
		line-height: 1.6;
		color: var(--ink-tertiary);
	}
</style>
