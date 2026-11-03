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
	import Seo from '$lib/seo/Seo.svelte';
	import { softwareApplication, faqPage } from '$lib/seo/schema';
	import { absolute, HOME_PATH } from '$lib/seo/site';
	import { dictionary } from '$lib/i18n';
	import type { Locale } from '$lib/i18n';

	let { locale }: { locale: Locale } = $props();

	const copy = $derived(dictionary(locale));
	const github = 'https://github.com/xFlawlessDev/alnair-harness';
	const releases = `${github}/releases`;
	const license = `${github}/blob/master/LICENSE`;
	const inLanguage = $derived(locale === 'en' ? 'en' : 'id');

	/** The product and its questions, as structured data the page already shows. */
	const schema = $derived([
		softwareApplication({
			name: 'Alnair',
			description: copy.meta.description,
			url: absolute(HOME_PATH[locale]),
			inLanguage,
			image: absolute('/media/alnair-demo-poster.jpg')
		}),
		faqPage(copy.faq.items, inLanguage)
	]);
</script>

<Seo
	{locale}
	path={HOME_PATH[locale]}
	title={copy.meta.title}
	description={copy.meta.description}
	jsonLd={schema}
/>

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
