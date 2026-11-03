<script lang="ts">
	/**
	 * A subagent's lifecycle in the parent's transcript: spawned, running,
	 * queued behind it. The child owns its own context window, which is the
	 * whole reason to spawn one.
	 */
	import MockFrame from './MockFrame.svelte';
	import { subagentRows, toneClass } from './data';
</script>

<MockFrame label="parent transcript" bleed>
	<ul class="list">
		{#each subagentRows as row (row.label)}
			<li>
				<span class="bullet {toneClass[row.tone]}" aria-hidden="true">{row.done ? '✓' : '◉'}</span>
				<span class="label {toneClass[row.tone]}">{row.label}</span>
				<span class="detail">{row.detail}</span>
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
		grid-template-columns: 0.75rem minmax(0, 1fr);
		column-gap: 0.375rem;
		padding: 0.25rem 0.625rem;
		font-size: 0.6563rem;
	}

	.bullet {
		line-height: 1.45;
	}

	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.detail {
		grid-column: 2;
		color: var(--ink-tertiary);
		font-size: 0.625rem;
	}
</style>
