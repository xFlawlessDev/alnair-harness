<script lang="ts">
	/**
	 * The dashboard, as `Ctrl+\` draws it: one row per top-level agent, sorted
	 * by state, with the dispatch input underneath. Glyphs and the activity
	 * column come from `mock/data.ts`.
	 */
	import MockFrame from './MockFrame.svelte';
	import { dashboardRows, glyph, toneClass } from './data';
</script>

<MockFrame label="Alnair · Dashboard — 4 agents · 2 awaiting" bleed>
	<ul class="rows">
		{#each dashboardRows as row (row.title)}
			<li class="row" class:selected={row.selected}>
				<span class="marker" aria-hidden="true">{row.selected ? '▌' : ' '}</span>
				<span class={toneClass[row.tone]} aria-hidden="true">{row.glyph}</span>
				<span class="title">{row.title}</span>
				<span class="activity {toneClass[row.activityTone]}">{row.activity}</span>
				<span class="age">{row.age}</span>
			</li>
		{/each}
	</ul>

	<div class="dispatch">
		<span class="prompt">{glyph.prompt}</span>
		<span class="placeholder">Dispatch a new agent</span>
	</div>
</MockFrame>

<style>
	.rows {
		margin: 0;
		padding: 0.25rem 0;
		list-style: none;
	}

	.row {
		display: grid;
		grid-template-columns: 0.5rem 0.875rem minmax(0, 1fr) auto auto;
		align-items: baseline;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem 0.25rem 0;
		font-size: 0.6563rem;
	}

	.selected {
		background: color-mix(in srgb, var(--olive) 8%, transparent);
	}

	.marker {
		color: var(--olive);
		opacity: 0.9;
	}

	.title {
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.activity {
		justify-self: end;
		font-size: 0.625rem;
		white-space: nowrap;
	}

	.age {
		color: var(--ink-tertiary);
		font-size: 0.625rem;
		font-variant-numeric: tabular-nums;
		padding-left: 0.5rem;
	}

	.dispatch {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		margin: 0.25rem 0.5rem 0.5rem;
		padding: 0.3125rem 0.5rem;
		border: 1px solid var(--line-strong);
		border-radius: 0.375rem;
		background: var(--paper-raised);
	}

	.prompt {
		color: var(--olive);
	}

	.placeholder {
		color: var(--ink-tertiary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
