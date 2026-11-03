<script lang="ts">
	/**
	 * Hooks, in firing order: the event, the tool it matches, and what the hook
	 * does. Blocking ones are red because a `PreToolUse` hook that exits non-zero
	 * stops the call.
	 */
	import MockFrame from './MockFrame.svelte';
	import { hookRows, toneClass } from './data';
</script>

<MockFrame label=".alnair/hooks.toml" bleed>
	<ul class="list">
		{#each hookRows as row (row.event)}
			<li>
				<span class="event {toneClass[row.tone]}">{row.event}</span>
				<span class="matcher">{row.matcher}</span>
				<span class="action">{row.action}</span>
			</li>
		{/each}
	</ul>
</MockFrame>

<style>
	.list {
		margin: 0;
		padding: 0.375rem 0;
		list-style: none;
	}

	li {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		align-items: baseline;
		column-gap: 0.4375rem;
		padding: 0.2813rem 0.625rem;
		font-size: 0.625rem;
	}

	.event {
		font-size: 0.5938rem;
	}

	.matcher {
		color: var(--ink-tertiary);
		font-size: 0.5938rem;
	}

	.action {
		color: var(--ink-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
