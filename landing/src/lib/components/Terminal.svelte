<script lang="ts">
	import TermLine from './TermLine.svelte';
	import type { TermLine as Line } from '$lib/content/types';

	let {
		title,
		lines,
		class: className = ''
	}: { title: string; lines: Line[]; class?: string } = $props();
</script>

<!--
	A terminal window in markup, not an image: it stays crisp on every display,
	themes with the page, and its text is selectable and reachable by a screen
	reader. The chrome is three dots and a title, the same shape the real TUI
	puts around a transcript.
-->
<figure class="term {className}">
	<div class="chrome" aria-hidden="true">
		<span class="dots"><i></i><i></i><i></i></span>
		<span class="title">{title}</span>
	</div>

	<pre class="body" aria-label={title}>{#each lines as line}<TermLine {line} />{/each}</pre>
</figure>

<style>
	.term {
		margin: 0;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		background: var(--code-surface);
		box-shadow: var(--shadow);
	}

	.chrome {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0.875rem;
		border-bottom: 1px solid var(--line);
		background: var(--paper-raised);
	}

	.dots {
		display: inline-flex;
		gap: 0.3125rem;
	}

	.dots i {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 999px;
		background: var(--line-strong);
	}

	.title {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--ink-tertiary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.body {
		margin: 0;
		padding: 1rem 1.125rem 1.25rem;
		overflow-x: hidden;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		line-height: 1.55;
		color: var(--ink);
		tab-size: 2;
	}

	@media (min-width: 640px) {
		.body {
			font-size: 0.8125rem;
		}
	}
</style>
