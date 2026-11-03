<script lang="ts">
	import DemoVideo from './DemoVideo.svelte';
	import FaqSection from './FaqSection.svelte';
	import FeaturesSection from './FeaturesSection.svelte';
	import Footer from './Footer.svelte';
	import GraphSection from './GraphSection.svelte';
	import Hero from './Hero.svelte';
	import InstallSection from './InstallSection.svelte';
	import LessonsSection from './LessonsSection.svelte';
	import Nav from './Nav.svelte';
	import ProvidersSection from './ProvidersSection.svelte';
	import { dictionary } from '$lib/i18n';
	import type { Locale } from '$lib/i18n';

	let { locale }: { locale: Locale } = $props();

	const copy = $derived(dictionary(locale));
	const github = 'https://github.com/xFlawlessDev/alnair-harness';
	const releases = `${github}/releases`;
	const license = `${github}/blob/master/LICENSE`;
	const url = $derived(locale === 'en' ? '/' : '/id/');
</script>

<svelte:head>
	<title>{copy.meta.title}</title>
	<meta name="description" content={copy.meta.description} />
	<link rel="canonical" href={url} />
	<link rel="alternate" hreflang="en" href="/" />
	<link rel="alternate" hreflang="id" href="/id/" />
	<link rel="alternate" hreflang="x-default" href="/" />
	<meta property="og:type" content="website" />
	<meta property="og:title" content={copy.meta.title} />
	<meta property="og:description" content={copy.meta.description} />
	<meta property="og:url" content={url} />
	<meta property="og:image" content="/media/alnair-demo-poster.jpg" />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={copy.meta.title} />
	<meta name="twitter:description" content={copy.meta.description} />
	<meta name="twitter:image" content="/media/alnair-demo-poster.jpg" />
</svelte:head>

<Nav {copy} {locale} {github} />

<main id="main">
	<Hero {copy} />

	<section class="demo-band" aria-label={copy.hero.demoCaption}>
		<div class="shell demo-shell">
			<DemoVideo {copy} />
		</div>
	</section>

	<GraphSection {copy} />
	<LessonsSection {copy} />
	<FeaturesSection {copy} docsHref={locale === 'en' ? '/docs/' : '/id/docs/'} />
	<ProvidersSection {copy} />
	<InstallSection {copy} sourceUrl={`${github}#building-from-source`} />
	<FaqSection {copy} />
</main>

<Footer {copy} {locale} {github} {releases} {license} />

<style>
	.demo-band {
		padding-block: 2.5rem 5rem;
	}

	.demo-shell {
		max-width: 62rem;
	}

	@media (min-width: 960px) {
		.demo-band {
			padding-block: 3.5rem 6.5rem;
		}
	}
</style>
