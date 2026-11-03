<script lang="ts">
	/**
	 * The one place a page's `<head>` search metadata is written.
	 *
	 * Every URL it emits is absolute, built from `SITE_URL`. A page that sets its
	 * own `<link rel="canonical">` by hand is how the root `/` ended up canonical
	 * as a relative `href="/"`; routing all of it through here makes that
	 * impossible to get wrong per page.
	 */
	import { SITE_NAME, OG_IMAGE, absolute } from '$lib/seo/site';
	import type { SiteLocale } from '$lib/seo/site';

	let {
		locale,
		path,
		title,
		description,
		type = 'website',
		image = OG_IMAGE,
		jsonLd = []
	}: {
		locale: SiteLocale;
		/** The page's path within its language, e.g. `/` or `/docs/hooks/`. */
		path: string;
		title: string;
		description: string;
		type?: 'website' | 'article';
		image?: string;
		/** Extra structured-data objects, each serialised as its own `<script>`. */
		jsonLd?: Record<string, unknown>[];
	} = $props();

	/** The path of this page in each language, so the two versions point at each other. */
	const enPath = $derived(locale === 'en' ? path : path.replace(/^\/id/, '') || '/');
	const idPath = $derived(locale === 'id' ? path : enPath === '/' ? '/id/' : `/id${enPath}`);

	const canonical = $derived(absolute(locale === 'en' ? enPath : idPath));
	const url = $derived(canonical);
	const ogLocale = $derived(locale === 'en' ? 'en_US' : 'id_ID');
	const ogAlt = $derived(locale === 'en' ? 'id_ID' : 'en_US');

	/** Escapes `<` so a JSON value can never close the surrounding `<script>`. */
	const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<meta name="robots" content="index, follow, max-image-preview:large" />

	<link rel="canonical" href={canonical} />
	<link rel="alternate" hreflang="en" href={absolute(enPath)} />
	<link rel="alternate" hreflang="id" href={absolute(idPath)} />
	<link rel="alternate" hreflang="x-default" href={absolute(enPath)} />

	<meta property="og:type" content={type} />
	<meta property="og:site_name" content={SITE_NAME} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:image" content={image} />
	<meta property="og:image:alt" content={title} />
	<meta property="og:locale" content={ogLocale} />
	<meta property="og:locale:alternate" content={ogAlt} />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={image} />

	{#each jsonLd as block, index (index)}
		<svelte:element this={"script"} type="application/ld+json"
			>{safeJson({
				'@context': 'https://schema.org',
				...block
			})}</svelte:element
		>
	{/each}
</svelte:head>
