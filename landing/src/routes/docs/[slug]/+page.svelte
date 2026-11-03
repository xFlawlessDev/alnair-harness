<script lang="ts">
	import DocPage from '$lib/docs/DocPage.svelte';
	import Seo from '$lib/seo/Seo.svelte';
	import { breadcrumbs, techArticle } from '$lib/seo/schema';
	import { absolute } from '$lib/seo/site';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const path = $derived(`/docs/${data.doc.slug}/`);
	const description = $derived(data.doc.description || `${data.doc.title} — Alnair user guide.`);
	const title = $derived(`${data.doc.title} — Alnair user guide`);

	const schema = $derived([
		techArticle({
			headline: data.doc.title,
			description,
			url: absolute(path),
			inLanguage: 'en'
		}),
		breadcrumbs([
			{ name: 'Alnair', path: '/' },
			{ name: 'User guide', path: '/docs/' },
			{ name: data.doc.title, path }
		])
	]);
</script>

<Seo locale="en" {path} {title} {description} type="article" jsonLd={schema} />

<DocPage
	locale="en"
	doc={data.doc}
	html={data.html}
	headings={data.headings}
	minutes={data.minutes}
	docs={data.docs}
/>
