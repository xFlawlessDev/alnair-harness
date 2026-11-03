<script lang="ts">
	/**
	 * The docs shell for both languages. The layout is shared; only the locale,
	 * and therefore the sidebar's language and its link prefix, differ.
	 */
	import DocsShell from '$lib/docs/DocsShell.svelte';
	import type { DocMeta } from '$lib/docs/source';
	import type { Locale } from '$lib/i18n';
	import type { Snippet } from 'svelte';

	let { locale, docs, children }: { locale: Locale; docs: DocMeta[]; children: Snippet } = $props();
</script>

<DocsShell {locale} {docs}>
	{@render children()}
</DocsShell>
