<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { formatDuration } from '#lib/harness/format.js';
	import type { ReasoningPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let { part }: { part: ReasoningPart } = $props();

	const running = $derived(part.status === 'running' || part.status === 'pending');
	const label = $derived(running ? 'Thinking' : 'Thought');
	const status = $derived(traceStatus(part.status));

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
				<CircleCheckIcon />
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
