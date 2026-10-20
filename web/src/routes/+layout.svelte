<script lang="ts">
	import { ModeWatcher } from 'mode-watcher';
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { provideSessionStore } from '#lib/harness/context.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// One store per page load; the harness adapter will replace MockSessionStore.
	provideSessionStore();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta name="color-scheme" content="light dark" />
	<meta
		name="description"
		content="The Alnair web harness — a browser view of the Alnair agent runtime."
	/>
	<title>Alnair — web harness</title>
</svelte:head>

<ModeWatcher defaultMode="system" />

{@render children()}
