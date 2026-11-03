<script lang="ts">
	/**
	 * A sample surface: the frame every UI mockup sits in.
	 *
	 * `label` names what is being shown in the sample's own chrome (a window
	 * title, a command), never in the page's voice — the card's heading already
	 * does that, and repeating it here would read as two captions.
	 */
	import type { Snippet } from 'svelte';

	let {
		label,
		children,
		bleed = false
	}: { label?: string; children: Snippet; bleed?: boolean } = $props();
</script>

<div class="sample" class:bleed>
	{#if label}
		<div class="bar">
			<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
			<span class="label">{label}</span>
		</div>
	{/if}
	<div class="body">
		{@render children()}
	</div>
</div>

<style>
	.sample {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		border: 1px solid var(--line);
		border-radius: 0.75rem;
		background: var(--code-surface);
		overflow: hidden;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4375rem 0.6875rem;
		border-bottom: 1px solid var(--line);
		background: var(--paper-inset);
	}

	.dots {
		display: inline-flex;
		gap: 0.25rem;
	}

	.dots i {
		width: 0.3125rem;
		height: 0.3125rem;
		border-radius: 999px;
		background: var(--line-strong);
	}

	.label {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		color: var(--ink-tertiary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.body {
		flex: 1;
		min-height: 0;
		padding: 0.625rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		line-height: 1.5;
	}

	.bleed .body {
		padding: 0;
	}
</style>
