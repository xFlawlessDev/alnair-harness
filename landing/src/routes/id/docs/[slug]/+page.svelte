<script lang="ts">
	import DocPage from '$lib/docs/DocPage.svelte';
	import Seo from '$lib/seo/Seo.svelte';
	import { breadcrumbs, techArticle } from '$lib/seo/schema';
	import { absolute } from '$lib/seo/site';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const path = $derived(`/id/docs/${data.doc.slug}/`);
	const description = $derived(
		data.doc.description || `${data.doc.title} — panduan pengguna Alnair.`
	);
	const title = $derived(`${data.doc.title} — Panduan pengguna Alnair`);

	const schema = $derived([
		techArticle({
			headline: data.doc.title,
			description,
			url: absolute(path),
			inLanguage: 'id'
		}),
		breadcrumbs([
			{ name: 'Alnair', path: '/id/' },
			{ name: 'Panduan pengguna', path: '/id/docs/' },
			{ name: data.doc.title, path }
		])
	]);
</script>

<Seo locale="id" {path} {title} {description} type="article" jsonLd={schema} />

<DocPage
	locale="id"
	doc={data.doc}
	html={data.html}
	headings={data.headings}
	minutes={data.minutes}
	docs={data.docs}
/>
