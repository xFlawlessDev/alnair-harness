<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import PartView from './parts/part-view.svelte';
	import { verbGroupDetail, type VerbRun } from './verb-group.js';

	/**
	 * One folded run of non-destructive steps.
	 *
	 * Closed, it is a single row: `Read 3 files, Searched 2 patterns`, wearing
	 * the running accent while any member is still moving and a red suffix when
	 * any member failed. Open, it restores the members exactly as they would
	 * have rendered — the same `PartView`, not a second rendering path — so
	 * expanding can never show something the unfolded thread would not.
	 *
	 * The fold is only ever applied to NON-destructive calls (see
	 * `verbGroupKindOf`): a command, an edit or an MCP dispatch is never hidden
	 * behind a count, because those are the steps a reader audits.
	 */
	let {
		run,
		turnClosed = false,
		collapseEdits = true
	}: {
		run: VerbRun;
		/** Whether the owning turn has finished; passed through to the rows. */
		turnClosed?: boolean;
		collapseEdits?: boolean;
	} = $props();

	const detail = $derived(verbGroupDetail(run));
</script>

<details class="group/verbs w-full min-w-0">
	<summary
		class="flex w-fit max-w-full min-w-0 cursor-pointer list-none items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors outline-none select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
		aria-label="Grouped tool calls"
	>
		<ChevronRightIcon class="size-3 shrink-0 transition-transform group-open/verbs:rotate-90" />
		<span class="min-w-0 truncate" data-slot="verb-group-label">
			{run.label.text}
		</span>
		{#if run.label.failed > 0}
			<span class="shrink-0 text-destructive">· {run.label.failed} failed</span>
		{/if}
		{#if detail}
			<span class="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
				{detail}
			</span>
		{/if}
	</summary>

	<Trace.Root class="mt-1.5 gap-1.5">
		{#each run.members as part (part.id)}
			<PartView {part} {turnClosed} {collapseEdits} />
		{/each}
	</Trace.Root>
</details>
