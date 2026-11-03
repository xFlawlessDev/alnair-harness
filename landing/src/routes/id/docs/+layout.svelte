<script lang="ts">
	import '$lib/docs/prose.css';
	import DocsLayout from '$lib/docs/DocsLayout.svelte';
	import type { LayoutProps } from './$types';
	import type { DocMeta } from '$lib/docs/source';

	let { data, children }: LayoutProps = $props();

	const docs = $derived((data as { docs: DocMeta[] }).docs);
</script>

<DocsLayout locale="id" {docs}>
	{@render children()}
</DocsLayout>
