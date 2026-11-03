<script lang="ts">
	import CopyButton from './CopyButton.svelte';
	import type { SiteCopy } from '$lib/content/types';

	let {
		copy,
		variant = 'full'
	}: {
		copy: SiteCopy;
		variant?: 'full' | 'compact';
	} = $props();

	let shell = $state<'unix' | 'windows'>('unix');

	const command = $derived(
		shell === 'unix' ? copy.install.commands.unix : copy.install.commands.windows
	);
</script>

<div class="install" class:compact={variant === 'compact'}>
	<div class="tabs" role="tablist" aria-label="{copy.install.unix} / {copy.install.windows}">
		<button
			type="button"
			role="tab"
			aria-selected={shell === 'unix'}
			class:active={shell === 'unix'}
			onclick={() => (shell = 'unix')}>{copy.install.unix}</button
		>
		<button
			type="button"
			role="tab"
			aria-selected={shell === 'windows'}
			class:active={shell === 'windows'}
			onclick={() => (shell = 'windows')}>{copy.install.windows}</button
		>
	</div>

	<div class="row">
		<!-- The command wraps rather than scrolls: it is the one line on this
		     page a reader is most likely to compare against a screenshot, and a
		     horizontally clipped `curl … | bash` reads as a broken command. -->
		<code class="cmd"
			><span class="prompt" aria-hidden="true">$</span><span class="text">{command}</span></code
		>
		<CopyButton text={command} label={copy.install.copy} copiedLabel={copy.install.copied} />
	</div>
</div>

<style>
	.install {
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-card);
		background: var(--paper-raised);
		overflow: hidden;
	}

	.tabs {
		display: flex;
		gap: 0.125rem;
		padding: 0.25rem;
		border-bottom: 1px solid var(--line);
		background: var(--paper-inset);
	}

	.tabs button {
		border: 0;
		background: transparent;
		border-radius: 0.5rem;
		padding: 0.375rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.02em;
		color: var(--ink-tertiary);
		cursor: pointer;
		transition:
			color 0.15s ease,
			background-color 0.15s ease;
	}

	.tabs button:hover {
		color: var(--ink);
	}

	.tabs button.active {
		color: var(--ink);
		background: var(--paper-card);
	}

	.row {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.6875rem 0.625rem 0.6875rem 0.875rem;
	}

	.cmd {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		line-height: 1.6;
		color: var(--ink);
	}

	.prompt {
		color: var(--olive);
		flex: none;
	}

	.text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.compact .row {
		padding-block: 0.5625rem;
	}

	@media (min-width: 640px) {
		.cmd {
			font-size: 0.8125rem;
		}
	}
</style>
