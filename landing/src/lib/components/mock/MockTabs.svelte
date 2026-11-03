<script lang="ts">
	/**
	 * The `F2` tab strip. `repo ⎇ branch` appears only when the strip spans more
	 * than one repository, which is why the sample shows two different repos.
	 */
	import { glyph, tabChips, toneClass } from './data';
</script>

<div class="strip">
	{#each tabChips as chip (chip.index)}
		<span class="chip" class:active={chip.active}>
			<span class="idx">{chip.index}</span>
			<span class="dot {toneClass[chip.dot ?? 'dim']}" aria-hidden="true">●</span>
			<span class="title">{chip.title}</span>
			<span class="detail">{chip.detail}</span>
			{#if chip.active}
				<span class="close" aria-hidden="true">{glyph.close}</span>
			{/if}
		</span>
	{/each}
	<span class="add" aria-hidden="true">{glyph.add}</span>
</div>

<style>
	.strip {
		display: flex;
		align-items: center;
		gap: 0.3125rem;
		padding: 0.3125rem 0.4375rem;
		border-bottom: 1px solid var(--line);
		background: var(--paper-inset);
		font-family: var(--font-mono);
		font-size: 0.625rem;
		overflow: hidden;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.1875rem 0.4375rem;
		border: 1px solid var(--line);
		border-radius: 0.3125rem;
		color: var(--ink-secondary);
		background: var(--paper);
		white-space: nowrap;
	}

	.chip.active {
		border-color: color-mix(in srgb, var(--olive) 45%, var(--line));
		color: var(--ink);
	}

	.idx {
		color: var(--ink-tertiary);
	}

	.dot {
		font-size: 0.4375rem;
		line-height: 1;
	}

	.detail {
		color: var(--ink-tertiary);
	}

	.close {
		color: var(--ink-tertiary);
		padding-left: 0.125rem;
	}

	.add {
		color: var(--ink-tertiary);
		padding-inline: 0.1875rem;
	}
</style>
