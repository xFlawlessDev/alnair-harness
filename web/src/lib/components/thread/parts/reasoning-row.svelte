<script lang="ts">
	import BrainIcon from '@lucide/svelte/icons/brain';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { formatDuration } from '#lib/harness/format.js';
	import type { ReasoningPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	/**
	 * One thought, as a collapsible row.
	 *
	 * The label is the whole point: `Thinking` while the model is thinking,
	 * `Thought` once it is done. The status comes from the reducer, which
	 * closes a reasoning part the moment any other part arrives — the wire has
	 * no `thought_completed` update, so a row that only listened for one stayed
	 * `Thinking` for the rest of the turn and left a spinner over a finished
	 * thought.
	 *
	 * It also falls back on its own: a part whose turn has already closed is
	 * finished by definition, whatever the part's own status says. That covers
	 * a transcript replayed from before the reducer learned to settle, and a
	 * turn closed by `turn_completed` between two chunks.
	 */
	let {
		part,
		turnClosed = false
	}: {
		part: ReasoningPart;
		/** The owning turn is no longer streaming. */
		turnClosed?: boolean;
	} = $props();

	const running = $derived(!turnClosed && (part.status === 'running' || part.status === 'pending'));
	const label = $derived(running ? 'Thinking' : 'Thought');
	const status = $derived(traceStatus(running ? 'running' : 'complete'));

	// The reader's choice wins; until they click, it follows the run.
	let chosen = $state<boolean | undefined>(undefined);
	const open = $derived(chosen ?? running);
</script>

{#snippet line()}
	<Trace.Line {status}>
		<Trace.Icon>
			{#if running}
				<LoaderIcon class="animate-spin" />
			{:else}
				<BrainIcon />
			{/if}
		</Trace.Icon>
		<Trace.Title>{label}</Trace.Title>
		{#if part.durationMs}
			<Trace.Description>{formatDuration(part.durationMs)}</Trace.Description>
		{/if}
	</Trace.Line>
{/snippet}

<Trace.Root>
	{#if !part.text}
		{@render line()}
	{:else}
		<Trace.Collapsible {open} onOpenChange={(next) => (chosen = next)}>
			<Trace.CollapsibleTrigger>{@render line()}</Trace.CollapsibleTrigger>
			<Trace.CollapsibleContent
				class="border-line/80 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-secondary"
			>
				{part.text}
			</Trace.CollapsibleContent>
		</Trace.Collapsible>
	{/if}
</Trace.Root>
