<script lang="ts">
	import Logo from '$lib/components/Logo.svelte';
	import { absolute } from '$lib/seo/site';

	/**
	 * The not-found page as a real document, published as `404.html`.
	 *
	 * `noindex, nofollow`: a search engine must drop this URL and must not follow
	 * the links it carries. An unknown address stored in an index is a dead end
	 * that persists until the crawler revisits.
	 */
	const copy = {
		title: 'Page not found',
		body: 'This page does not exist. It may have moved, or the address has a typo.',
		home: 'Back to home',
		docs: 'User guide',
		homeHref: '/',
		docsHref: '/docs/'
	};
</script>

<svelte:head>
	<title>{copy.title} — Alnair</title>
	<meta name="robots" content="noindex, nofollow" />
	<link rel="canonical" href={absolute(copy.homeHref)} />
</svelte:head>

<main class="wrap">
	<Logo size={28} />
	<p class="code">404</p>
	<h1>{copy.title}</h1>
	<p class="body">{copy.body}</p>
	<nav class="links">
		<a href={copy.homeHref}>{copy.home}</a>
		<a href={copy.docsHref}>{copy.docs}</a>
	</nav>
</main>

<style>
	.wrap {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 0.75rem;
		min-height: 70vh;
		max-width: 36rem;
		margin-inline: auto;
		padding: 2rem 1.25rem;
		color: var(--ink);
	}

	.code {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.1em;
		color: var(--ink-tertiary);
	}

	h1 {
		margin: 0;
		font-size: clamp(1.75rem, 4vw, 2.25rem);
		font-weight: 600;
		letter-spacing: -0.02em;
	}

	.body {
		margin: 0;
		color: var(--ink-secondary);
		line-height: 1.6;
	}

	.links {
		display: flex;
		gap: 1rem;
		margin-top: 0.5rem;
	}

	.links a {
		color: var(--ink);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
