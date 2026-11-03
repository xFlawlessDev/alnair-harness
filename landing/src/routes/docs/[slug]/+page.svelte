<script lang="ts">
	import DocPage from '$lib/docs/DocPage.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.doc.title} — Alnair user guide</title>
	<meta name="description" content={data.doc.description} />
</svelte:head>

<DocPage
	locale="en"
	doc={data.doc}
	html={data.html}
	headings={data.headings}
	minutes={data.minutes}
	docs={data.docs}
/>
