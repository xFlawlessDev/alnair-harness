<script lang="ts">
	import { page } from '$app/state';
	import Logo from '$lib/components/Logo.svelte';
	import { absolute } from '$lib/seo/site';

	/**
	 * Not-found and error pages must never be indexed. A 404 that a search engine
	 * stores is a dead end in its results that stays until the crawler revisits.
	 * `noindex` tells it to drop the URL, and `nofollow` keeps it from following
	 * whatever links the error page happens to carry.
	 */
	const isNotFound = $derived(page.status === 404);
	const copy = $derived(
		page.url.pathname.startsWith('/id/')
			? {
					title: 'Halaman tidak ditemukan',
					body: 'Halaman ini tidak ada. Mungkin pindah, atau alamatnya salah ketik.',
					home: 'Ke beranda',
					docs: 'Panduan pengguna',
					homeHref: '/id/',
					docsHref: '/id/docs/'
				}
			: {
					title: 'Page not found',
					body: 'This page does not exist. It may have moved, or the address has a typo.',
					home: 'Back to home',
					docs: 'User guide',
					homeHref: '/',
					docsHref: '/docs/'
				}
	);
</script>

<svelte:head>
	<title>{isNotFound ? copy.title : 'Error'} — Alnair</title>
	<meta name="robots" content="noindex, nofollow" />
	<link rel="canonical" href={absolute(copy.homeHref)} />
</svelte:head>

<main class="wrap">
	<Logo size={28} />
	<p class="code">{page.status}</p>
	<h1>{isNotFound ? copy.title : 'Something went wrong'}</h1>
	<p class="body">{isNotFound ? copy.body : (page.error?.message ?? '')}</p>
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
