<script lang="ts">
	/**
	 * The docs shell: a persistent sidebar of every guide, and the page itself.
	 *
	 * The sidebar is a real list of links, not a client-side menu, so every
	 * guide is crawlable and reachable with JavaScript off. The filter box
	 * narrows the rendered list in place — it is a convenience over a page that
	 * is already complete.
	 */
	import { page } from '$app/state';
	import Logo from '$lib/components/Logo.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { docsCopy } from '$lib/docs/copy';
	import type { DocMeta } from '$lib/docs/source';
	import { href, other, type Locale } from '$lib/i18n';
	import type { Snippet } from 'svelte';

	let { locale, docs, children }: { locale: Locale; docs: DocMeta[]; children: Snippet } = $props();

	const copy = $derived(docsCopy[locale]);
	const base = $derived(locale === 'en' ? '/docs/' : '/id/docs/');
	const otherLocale = $derived(other(locale));

	let filter = $state('');
	let menuOpen = $state(false);

	const results = $derived.by(() => {
		const query = filter.trim().toLowerCase();
		if (!query) return docs;
		return docs.filter(
			(doc) =>
				doc.title.toLowerCase().includes(query) ||
				doc.description.toLowerCase().includes(query) ||
				doc.slug.includes(query)
		);
	});

	/** The active doc's slug, so the sidebar can mark it without a prop drilled down. */
	const active = $derived(page.url.pathname.replace(base, '').replace(/\/$/, ''));

	/** The other language's page for the same guide, so switching keeps the reader in place. */
	const otherHref = $derived(
		`${locale === 'en' ? '/id/docs/' : '/docs/'}${active ? `${active}/` : ''}`
	);
</script>

<div class="docs">
	<header class="bar">
		<div class="shell bar-inner">
			<a class="brand" href={href(locale)} aria-label="Alnair">
				<Logo size={20} />
				<span>Alnair</span>
			</a>

			<span class="sep" aria-hidden="true">/</span>
			<a class="section" href={base}>{copy.title}</a>

			<div class="tools">
				<a
					class="lang"
					href={otherHref}
					hreflang={otherLocale}
					lang={otherLocale}
					title={otherLocale === 'id' ? 'Bahasa Indonesia' : 'English'}
				>
					{otherLocale === 'id' ? 'ID' : 'EN'}
				</a>

				<ThemeToggle label="Toggle theme" />

				<button
					type="button"
					class="menu-toggle"
					aria-expanded={menuOpen}
					onclick={() => (menuOpen = !menuOpen)}
				>
					{copy.menu}
				</button>
			</div>
		</div>
	</header>

	<div class="shell layout">
		<aside class="sidebar" class:open={menuOpen}>
			<label class="search">
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="6.5" />
					<path d="m16 16 4.5 4.5" stroke-linecap="round" />
				</svg>
				<span class="sr"> {copy.filter} </span>
				<input
					type="search"
					bind:value={filter}
					placeholder={copy.searchPlaceholder}
					aria-label={copy.filter}
				/>
			</label>

			<nav aria-label={copy.allGuides}>
				{#if results.length === 0}
					<p class="empty">{copy.searchEmpty}</p>
				{/if}

				<ol>
					{#each results as doc (doc.slug)}
						<li>
							<a
								href="{base}{doc.slug}/"
								class:active={doc.slug === active}
								aria-current={doc.slug === active ? 'page' : undefined}
							>
								{doc.title}
							</a>
						</li>
					{/each}
				</ol>
			</nav>
		</aside>

		<main id="main" class="content">
			{@render children()}
		</main>
	</div>
</div>

<style>
	.docs {
		min-height: 100vh;
	}

	.bar {
		position: sticky;
		top: 0;
		z-index: 40;
		border-bottom: 1px solid var(--line);
		background: color-mix(in srgb, var(--paper) 88%, transparent);
		backdrop-filter: blur(14px) saturate(140%);
	}

	.bar-inner {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		height: 3.5rem;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--ink);
		font-weight: 600;
		font-size: 0.875rem;
		text-decoration: none;
	}

	.sep {
		color: var(--line-strong);
	}

	.section {
		font-size: 0.875rem;
		color: var(--ink-secondary);
		text-decoration: none;
	}

	.section:hover {
		color: var(--ink);
	}

	.tools {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-left: auto;
	}

	.lang {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 2.125rem;
		padding-inline: 0.5rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--ink-secondary);
		text-decoration: none;
	}

	.lang:hover {
		color: var(--ink);
		border-color: var(--line-strong);
	}

	.menu-toggle {
		display: inline-flex;
		align-items: center;
		height: 2.125rem;
		padding-inline: 0.625rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: transparent;
		color: var(--ink-secondary);
		font-size: 0.75rem;
		cursor: pointer;
	}

	.layout {
		display: grid;
		gap: 2.5rem;
		padding-block: 2rem 4rem;
	}

	.sidebar {
		display: none;
		font-size: 0.8125rem;
	}

	.sidebar.open {
		display: block;
	}

	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 1rem;
		padding: 0.4375rem 0.625rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--paper-raised);
	}

	.search svg {
		width: 0.875rem;
		height: 0.875rem;
		color: var(--ink-tertiary);
		flex: none;
	}

	.search input {
		width: 100%;
		border: 0;
		background: transparent;
		color: var(--ink);
		font-size: 0.8125rem;
		outline: none;
	}

	.search input::placeholder {
		color: var(--ink-tertiary);
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	ol {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	ol a {
		display: block;
		padding: 0.3125rem 0.625rem;
		border-left: 2px solid transparent;
		color: var(--ink-secondary);
		text-decoration: none;
		line-height: 1.45;
		transition:
			color 0.12s ease,
			border-color 0.12s ease;
	}

	ol a:hover {
		color: var(--ink);
	}

	ol a.active {
		color: var(--ink);
		border-left-color: var(--olive);
		background: color-mix(in srgb, var(--olive) 7%, transparent);
	}

	.empty {
		margin: 0.25rem 0 0;
		padding-inline: 0.625rem;
		color: var(--ink-tertiary);
	}

	.content {
		min-width: 0;
	}

	@media (min-width: 980px) {
		.layout {
			grid-template-columns: 15rem minmax(0, 1fr);
			gap: 3.5rem;
			padding-block: 2.5rem 5rem;
		}

		.sidebar,
		.sidebar.open {
			display: block;
			position: sticky;
			top: 5rem;
			align-self: start;
			max-height: calc(100vh - 6.5rem);
			overflow-y: auto;
			padding-right: 0.5rem;
		}

		.menu-toggle {
			display: none;
		}
	}

	/* The article grows a sticky contents rail at 1200px (see `DocPage`), so the
	   container widens there: at the marketing shell's 76rem the rail would eat
	   the reading measure instead of sitting beside it. */
	@media (min-width: 1200px) {
		.layout {
			max-width: 88rem;
		}
	}
</style>
