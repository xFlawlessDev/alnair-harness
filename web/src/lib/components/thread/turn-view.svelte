<script lang="ts">
	import * as Bubble from '#lib/components/ui/bubble/index.js';
	import * as Message from '#lib/components/ui/message/index.js';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { formatClock } from '#lib/harness/format.js';
	import type { Turn } from '#lib/harness/types.js';
	import Markdown from './markdown-lazy.svelte';
	import PartView from './parts/part-view.svelte';
	import { groupParts } from './segments.js';
	import TurnMeta from './turn-meta.svelte';

	let {
		turn,
		streaming = false,
		onretry
	}: { turn: Turn; streaming?: boolean; onretry?: () => void } = $props();

	const segments = $derived(groupParts(turn.parts));
	const userText = $derived(
		turn.parts
			.filter((part) => part.kind === 'text')
			.map((part) => part.text)
			.join('\n\n')
	);
</script>

{#if turn.role === 'user'}
	<Message.Root align="end">
		<Message.Content class="items-end gap-1.5">
			<Bubble.Root align="end" variant="paper" class="max-w-[min(46rem,88%)]">
				<Bubble.Content
					class="rounded-2xl rounded-br-md px-4 py-2.5 whitespace-pre-wrap shadow-none"
				>
					{userText}
				</Bubble.Content>
			</Bubble.Root>
			<span class="tabular px-1 font-mono text-[10.5px] text-ink-tertiary/80">
				{formatClock(turn.at)}
			</span>
		</Message.Content>
	</Message.Root>
{:else if turn.role === 'system'}
	<div class="flex justify-center">
		<p class="max-w-2xl text-center text-[12px] leading-relaxed text-ink-tertiary">
			{userText}
		</p>
	</div>
{:else}
	<Message.Root>
		<Message.Content class="gap-3">
			{#each segments as segment, index (index)}
				{#if segment.kind === 'trace'}
					<Trace.Root class="gap-1.5">
						{#each segment.parts as part (part.id)}
							<PartView {part} />
						{/each}
					</Trace.Root>
				{:else if segment.kind === 'checkpoint'}
					<PartView part={segment.part} />
				{:else if segment.part.text}
					<Markdown content={segment.part.text} {streaming} />
				{:else if streaming}
					<div class="flex items-center gap-1 py-1" aria-label="Waiting for the reply">
						<span
							class="size-1.5 animate-bounce rounded-full bg-ink-tertiary [animation-delay:-0.3s]"
						></span>
						<span
							class="size-1.5 animate-bounce rounded-full bg-ink-tertiary [animation-delay:-0.15s]"
						></span>
						<span class="size-1.5 animate-bounce rounded-full bg-ink-tertiary"></span>
					</div>
				{/if}
			{/each}

			{#if turn.status === 'cancelled'}
				<p class="text-[11.5px] text-ink-tertiary italic">Stopped.</p>
			{:else if !streaming}
				<TurnMeta {turn} {onretry} />
			{/if}
		</Message.Content>
	</Message.Root>
{/if}
