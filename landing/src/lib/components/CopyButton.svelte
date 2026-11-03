<script lang="ts">
	import { copyText } from '$lib/clipboard';

	let {
		text,
		label,
		copiedLabel,
		class: className = ''
	}: { text: string; label: string; copiedLabel: string; class?: string } = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		if (!(await copyText(text))) return;
		copied = true;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 1800);
	}

	$effect(() => () => clearTimeout(timer));
</script>

<button
	type="button"
	class="copy {className}"
	onclick={copy}
	aria-label={copied ? copiedLabel : label}
	title={copied ? copiedLabel : label}
>
	<span class="icon" aria-hidden="true">
		{#if copied}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="m5 12 4.5 4.5L19 7" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		{:else}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
				<rect x="9" y="9" width="11" height="11" rx="2.5" />
				<path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15" />
			</svg>
		{/if}
	</span>
	<span class="sr-only">{copied ? copiedLabel : label}</span>
</button>

<style>
	.copy {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		border: 1px solid var(--line);
		color: var(--ink-tertiary);
		background: transparent;
		cursor: pointer;
		transition:
			color 0.15s ease,
			border-color 0.15s ease,
			background-color 0.15s ease;
	}

	.copy:hover {
		color: var(--ink);
		border-color: var(--line-strong);
		background: var(--paper-card);
	}

	.icon {
		display: inline-flex;
	}

	.icon :global(svg) {
		width: 15px;
		height: 15px;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
