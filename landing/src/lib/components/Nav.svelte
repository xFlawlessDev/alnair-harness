<script lang="ts">
	import Logo from './Logo.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import { href } from '$lib/i18n';
	import type { SiteCopy } from '$lib/content/types';
	import type { Locale } from '$lib/i18n';

	let { copy, locale, github }: { copy: SiteCopy; locale: Locale; github: string } = $props();

	let open = $state(false);

	const links = [
		{ key: 'graph', href: '#graph' },
		{ key: 'features', href: '#features' },
		{ key: 'lessons', href: '#lessons' },
		{ key: 'providers', href: '#providers' },
		{ key: 'install', href: '#install' }
	] as const;

	const other: Locale = $derived(locale === 'en' ? 'id' : 'en');
	const docs = $derived(locale === 'en' ? '/docs/' : '/id/docs/');
</script>

<header class="nav">
	<div class="shell bar">
		<a class="brand" href={href(locale)} aria-label="Alnair">
			<Logo size={22} />
			<span>Alnair</span>
		</a>

		<nav class="links" aria-label="Primary">
			{#each links as link}
				<a href={link.href}>{copy.nav[link.key]}</a>
			{/each}
			<a href={docs}>{copy.nav.docs}</a>
		</nav>

		<div class="actions">
			<a
				class="lang"
				href={href(other)}
				hreflang={other}
				lang={other}
				title={other === 'id' ? 'Bahasa Indonesia' : 'English'}
			>
				{other === 'id' ? 'ID' : 'EN'}
			</a>

			<ThemeToggle label={copy.nav.theme} />

			<a class="ghost-btn" href={github} rel="noreferrer">
				<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path
						d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
					/>
				</svg>
				<span class="ghost-text">{copy.nav.source}</span>
			</a>

			<a class="pill" href="#install">{copy.nav.install}</a>

			<button
				type="button"
				class="burger"
				aria-expanded={open}
				aria-controls="mobile-nav"
				aria-label={copy.nav.menu}
				onclick={() => (open = !open)}
			>
				{#if open}
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						aria-hidden="true"
					>
						<path d="m6 6 12 12M18 6 6 18" stroke-linecap="round" />
					</svg>
				{:else}
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						aria-hidden="true"
					>
						<path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round" />
					</svg>
				{/if}
			</button>
		</div>
	</div>

	{#if open}
		<div id="mobile-nav" class="sheet">
			<nav class="shell sheet-links" aria-label="Primary">
				{#each links as link}
					<a href={link.href} onclick={() => (open = false)}>{copy.nav[link.key]}</a>
				{/each}
				<a href={docs} onclick={() => (open = false)}>{copy.nav.docs}</a>
			</nav>
		</div>
	{/if}
</header>

<style>
	.nav {
		position: sticky;
		top: 0;
		z-index: 50;
		background: color-mix(in srgb, var(--paper) 82%, transparent);
		backdrop-filter: blur(14px) saturate(140%);
		border-bottom: 1px solid var(--line);
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		height: 3.75rem;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.5625rem;
		font-weight: 600;
		font-size: 0.9375rem;
		letter-spacing: -0.01em;
		color: var(--ink);
		text-decoration: none;
	}

	.links {
		display: none;
		align-items: center;
		gap: 1.625rem;
		margin-right: auto;
	}

	.links a {
		font-size: 0.8125rem;
		color: var(--ink-secondary);
		text-decoration: none;
		transition: color 0.15s ease;
	}

	.links a:hover {
		color: var(--ink);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-left: auto;
	}

	.lang {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 2.25rem;
		padding-inline: 0.5rem;
		border-radius: 0.5rem;
		border: 1px solid var(--line);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.04em;
		color: var(--ink-secondary);
		text-decoration: none;
		transition:
			color 0.15s ease,
			border-color 0.15s ease;
	}

	.lang:hover {
		color: var(--ink);
		border-color: var(--line-strong);
	}

	.ghost-btn {
		display: none;
		align-items: center;
		gap: 0.4375rem;
		height: 2.25rem;
		padding-inline: 0.625rem;
		border-radius: 0.5rem;
		color: var(--ink-secondary);
		font-size: 0.8125rem;
		text-decoration: none;
		transition:
			color 0.15s ease,
			background-color 0.15s ease;
	}

	.ghost-btn:hover {
		color: var(--ink);
		background: var(--paper-card);
	}

	.ghost-btn svg {
		width: 1rem;
		height: 1rem;
	}

	.pill {
		display: none;
		align-items: center;
		height: 2.25rem;
		padding-inline: 0.8125rem;
		border-radius: 0.5rem;
		background: var(--olive);
		color: var(--olive-ink);
		font-size: 0.8125rem;
		font-weight: 500;
		text-decoration: none;
		transition: background-color 0.15s ease;
	}

	.pill:hover {
		background: var(--olive-soft);
	}

	.burger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border: 1px solid transparent;
		border-radius: 0.5rem;
		background: transparent;
		color: var(--ink-secondary);
		cursor: pointer;
	}

	.burger:hover {
		color: var(--ink);
		border-color: var(--line);
	}

	.burger svg {
		width: 1.125rem;
		height: 1.125rem;
	}

	.sheet {
		border-top: 1px solid var(--line);
		background: var(--paper);
	}

	.sheet-links {
		display: flex;
		flex-direction: column;
		padding-block: 0.5rem 1rem;
	}

	.sheet-links a {
		padding-block: 0.75rem;
		border-bottom: 1px solid var(--line);
		color: var(--ink);
		font-size: 0.9375rem;
		text-decoration: none;
	}

	@media (min-width: 860px) {
		.links,
		.ghost-btn,
		.pill {
			display: inline-flex;
		}

		.pill {
			margin-left: 0.25rem;
		}

		.burger,
		.sheet {
			display: none;
		}
	}
</style>
