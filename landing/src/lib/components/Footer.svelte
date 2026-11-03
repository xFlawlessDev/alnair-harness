<script lang="ts">
	import Logo from './Logo.svelte';
	import { href } from '$lib/i18n';
	import type { SiteCopy } from '$lib/content/types';
	import type { Locale } from '$lib/i18n';

	let {
		copy,
		locale,
		github,
		releases,
		license
	}: { copy: SiteCopy; locale: Locale; github: string; releases: string; license: string } =
		$props();

	const other = $derived<Locale>(locale === 'en' ? 'id' : 'en');
</script>

<footer class="foot">
	<div class="shell">
		<div class="top">
			<div class="brand">
				<a class="mark" href={href(locale)} aria-label="Alnair">
					<Logo size={22} />
					<span>Alnair</span>
				</a>
				<p>{copy.footer.tagline}</p>
			</div>

			<nav class="col" aria-label={copy.footer.product}>
				<h2>{copy.footer.product}</h2>
				<a href="#features">{copy.nav.features}</a>
				<a href="#graph">{copy.nav.graph}</a>
				<a href="#lessons">{copy.nav.lessons}</a>
				<a href="#providers">{copy.nav.providers}</a>
				<a href="#install">{copy.nav.install}</a>
			</nav>

			<nav class="col" aria-label={copy.footer.project}>
				<h2>{copy.footer.project}</h2>
				<a href={locale === 'en' ? '/docs/' : '/id/docs/'}>{copy.nav.docs}</a>
				<a href={github} rel="noreferrer">{copy.nav.source}</a>
				<a href={releases} rel="noreferrer">Releases</a>
				<a href={license} rel="noreferrer">{copy.footer.license}</a>
				<a href={`${github}#building-from-source`} rel="noreferrer">{copy.install.buildLink}</a>
			</nav>

			<div class="col">
				<h2>{copy.footer.language}</h2>
				<div class="langs">
					<a href="/" class:active={locale === 'en'} hreflang="en" lang="en">English</a>
					<a href="/id/" class:active={locale === 'id'} hreflang="id" lang="id">Bahasa Indonesia</a>
				</div>
			</div>
		</div>

		<div class="legal">
			<p>{copy.footer.attribution}</p>
			<a class="lic" href={license} rel="noreferrer">{copy.footer.license}</a>
			<span class="sep" aria-hidden="true">·</span>
			<a href={href(other)} hreflang={other} lang={other}>{other === 'id' ? 'ID' : 'EN'}</a>
		</div>
	</div>
</footer>

<style>
	.foot {
		border-top: 1px solid var(--line);
		padding-block: 3.5rem 2.5rem;
	}

	.top {
		display: grid;
		gap: 2.5rem;
	}

	.mark {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--ink);
		text-decoration: none;
	}

	.brand p {
		margin: 0.75rem 0 0;
		max-width: 20rem;
		font-size: 0.8125rem;
		line-height: 1.65;
		color: var(--ink-tertiary);
	}

	.col {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
	}

	.col h2 {
		margin: 0 0 0.375rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-tertiary);
	}

	.col a {
		font-size: 0.8125rem;
		color: var(--ink-secondary);
		text-decoration: none;
		transition: color 0.15s ease;
	}

	.col a:hover {
		color: var(--ink);
	}

	.langs {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.langs .active {
		color: var(--ink);
	}

	.langs .active::before {
		content: '— ';
		color: var(--olive);
	}

	.legal {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 3rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--line);
		font-size: 0.75rem;
		color: var(--ink-tertiary);
	}

	.legal p {
		flex: 1 1 100%;
		margin: 0;
		max-width: 52rem;
		line-height: 1.7;
	}

	.legal a {
		color: var(--ink-secondary);
		text-decoration: none;
	}

	.legal a:hover {
		color: var(--ink);
	}

	.sep {
		opacity: 0.5;
	}

	@media (min-width: 760px) {
		.top {
			grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 0.8fr));
			gap: 2rem;
		}

		.legal p {
			flex-basis: auto;
			margin-right: auto;
		}
	}
</style>
