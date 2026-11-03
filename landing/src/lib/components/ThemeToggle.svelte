<script lang="ts">
	import { onMount } from 'svelte';

	let { label }: { label: string } = $props();

	let dark = $state(true);
	let mounted = $state(false);

	onMount(() => {
		mounted = true;
		dark = document.documentElement.dataset.theme !== 'light';
	});

	function toggle() {
		dark = !dark;
		document.documentElement.dataset.theme = dark ? 'dark' : 'light';
		try {
			localStorage.setItem('alnair-theme', dark ? 'dark' : 'light');
		} catch {
			// Private modes can refuse the write; the page still toggles.
		}
	}
</script>

<button type="button" class="toggle" onclick={toggle} aria-label={label} title={label}>
	{#if mounted && !dark}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="4.2" />
			<path
				d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.2 5.2l1.5 1.5M17.3 17.3l1.5 1.5M18.8 5.2l-1.5 1.5M6.7 17.3l-1.5 1.5"
				stroke-linecap="round"
			/>
		</svg>
	{:else}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			aria-hidden="true"
		>
			<path
				d="M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5a8.6 8.6 0 1 0 10.7 10.7Z"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	{/if}
</button>

<style>
	.toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.5rem;
		border: 1px solid transparent;
		background: transparent;
		color: var(--ink-tertiary);
		cursor: pointer;
		transition:
			color 0.15s ease,
			background-color 0.15s ease,
			border-color 0.15s ease;
	}

	.toggle:hover {
		color: var(--ink);
		background: var(--paper-card);
		border-color: var(--line);
	}

	.toggle svg {
		width: 1.0625rem;
		height: 1.0625rem;
	}
</style>
