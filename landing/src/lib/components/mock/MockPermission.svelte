<script lang="ts">
	/**
	 * The permission card, the one place a tool call stops and waits.
	 *
	 * `[1]`…`[4]` are the real keys: on the dashboard a permission request does
	 * not open its own modal, it flips the row to "needs input" and the options
	 * render in the peek panel — the same numbers either way.
	 */
	import MockFrame from './MockFrame.svelte';
	import { permissionOptions, toneClass } from './data';
</script>

<MockFrame label="permission" bleed>
	<div class="prompt">
		<span class="cmd">cargo test --workspace</span>
		<span class="what">wants to run a command</span>
	</div>

	<ul class="options">
		{#each permissionOptions as option (option.key)}
			<li>
				<span class="key">{option.key}</span>
				<span class={toneClass[option.tone]}>{option.label}</span>
			</li>
		{/each}
	</ul>
</MockFrame>

<style>
	.prompt {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.4375rem 0.6875rem 0.375rem;
		border-bottom: 1px solid var(--line);
		background: color-mix(in srgb, var(--accent-plan) 7%, transparent);
	}

	.cmd {
		color: var(--ink);
		font-size: 0.6875rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.what {
		color: var(--ink-tertiary);
		font-size: 0.5938rem;
	}

	.options {
		margin: 0;
		padding: 0.25rem 0 0.375rem;
		list-style: none;
	}

	li {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.1875rem 0.6875rem;
		font-size: 0.6563rem;
	}

	.key {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 0.875rem;
		height: 0.875rem;
		border: 1px solid var(--line-strong);
		border-radius: 0.1875rem;
		color: var(--ink-tertiary);
		font-size: 0.5625rem;
		flex: none;
	}
</style>
