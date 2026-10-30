<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { TurnPart } from '#lib/harness/types.js';
	import { workSummary } from './segments.js';

	/**
	 * The collapsed form of a finished turn's work.
	 *
	 * Closed, it is one scannable line: how long the turn took and what kinds
	 * of step it took, counted — `Worked for 1m 04s · 12 calls · 3 files
	 * edited`. That is the whole point: forty trace rows between the question
	 * and its answer make a long thread unreadable, but the answer must stay
	 * visible, and nothing may be destroyed to get there.
	 *
	 * Open, it is the original trace, untouched. A `<details>` rather than the
	 * `Collapsible` primitive because the browser's own disclosure is
	 * keyboard-safe and find-in-page aware for free, and there is nothing here
	 * worth animating.
	 *
	 * It is only ever rendered for a turn that has FINISHED — the caller folds
	 * nothing while a turn is running, because the step that is moving is the
	 * one the reader is watching.
	 */
	let {
		parts,
		worked,
		forcedOpen,
		children
	}: {
		parts: TurnPart[];
		/** The `formatWorked` line, e.g. `1m 04s`. */
		worked?: string;
		/**
		 * A token that renders the disclosure open, from another surface.
		 *
		 * A number, not a boolean: a second reveal in the same turn must
		 * re-open a disclosure the reader has since closed, and an unchanged
		 * `true` produces no update.
		 */
		forcedOpen?: number;
		children: import('svelte').Snippet;
	} = $props();

	const summary = $derived(workSummary(parts));

	/** The `<details>` node, so a new reveal token can force it open. */
	let disclosure: HTMLDetailsElement | null = $state(null);

	$effect(() => {
		// Reading the token is the dependency; the body reacts to a NEW reveal.
		const token = forcedOpen;
		if (token === undefined || !disclosure) return;
		disclosure.open = true;
	});
</script>

<details class="group/work w-full min-w-0" bind:this={disclosure}>
	<summary
		class="flex w-fit max-w-full min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 text-[11.5px] text-ink-tertiary transition-colors outline-none select-none hover:text-ink-secondary focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden"
		aria-label="Finished agent work"
	>
		<ChevronRightIcon class="size-3 shrink-0 transition-transform group-open/work:rotate-90" />
		<span class="min-w-0 truncate">
			{#if worked}
				Worked for {worked}
			{:else}
				Work
			{/if}
		</span>
		{#if summary.length > 0}
			<span class="min-w-0 truncate text-ink-tertiary/70">
				· {summary.map((row) => row.label).join(' · ')}
			</span>
		{/if}
	</summary>

	<div class="mt-1.5 min-w-0">
		{@render children()}
	</div>
</details>
