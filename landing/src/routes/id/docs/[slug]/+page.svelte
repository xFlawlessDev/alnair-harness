<script lang="ts">
	import DocPage from '$lib/docs/DocPage.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.doc.title} — Panduan pengguna Alnair</title>
	<meta name="description" content={data.doc.description} />
	<link rel="alternate" hreflang="en" href="/docs/{data.doc.slug}/" />
	<link rel="alternate" hreflang="id" href="/id/docs/{data.doc.slug}/" />
</svelte:head>

<DocPage
	locale="id"
	doc={data.doc}
	html={data.html}
	headings={data.headings}
	minutes={data.minutes}
	docs={data.docs}
/>
