<script lang="ts">
	import ImageIcon from '@lucide/svelte/icons/image';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { dirName, fileName, formatBytes, formatDuration } from '#lib/harness/format.js';
	import type { ImageReadPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let { part }: { part: ImageReadPart } = $props();

	const status = $derived(traceStatus(part.status));
	const running = $derived(part.status === 'running' || part.status === 'pending');

	/**
	 * The wire only carries the bytes; dimensions appear when the agent put
	 * them in `_meta`, which is not required. So the caption lists what is
	 * known and skips the rest rather than printing a guessed size.
	 */
	const dimensions = $derived(
		part.width !== undefined && part.height !== undefined
			? `${part.width}×${part.height}`
			: undefined
	);
	const facts = $derived(
		[part.mime, dimensions, part.bytes !== undefined ? formatBytes(part.bytes) : undefined].filter(
			(value): value is string => value !== undefined
		)
	);
</script>

{#snippet line()}
	<Trace.Line {status}>
		<Trace.Icon>
			<ImageIcon class={running ? 'text-running' : 'text-tool'} />
		</Trace.Icon>
		<Trace.Title>
			<span class="text-ink-secondary">Read image</span>
			<span class="ml-1.5 font-mono text-[12.5px]">
				<span class="text-ink-tertiary">{dirName(part.path)}</span>
				<span class="text-ink">{fileName(part.path)}</span>
			</span>
		</Trace.Title>
		<Trace.Description class="tabular">{dimensions ?? part.mime}</Trace.Description>
		{#if part.durationMs}
			<Trace.Description>{formatDuration(part.durationMs)}</Trace.Description>
		{/if}
	</Trace.Line>
{/snippet}

<Trace.Root>
	<Trace.Collapsible>
		<Trace.CollapsibleTrigger>{@render line()}</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-line/80">
			<figure class="overflow-hidden rounded-lg border border-line bg-code-surface">
				<div
					class="flex items-center justify-center bg-[repeating-conic-gradient(var(--paper-card)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-2"
				>
					<img
						src={part.src}
						alt={`Preview of ${fileName(part.path)}`}
						width={part.width}
						height={part.height}
						loading="lazy"
						decoding="async"
						class="max-h-80 w-auto max-w-full rounded-[4px] object-contain"
					/>
				</div>
				<figcaption
					class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line px-2.5 py-1.5 font-mono text-[10.5px] text-ink-tertiary"
				>
					{#each facts as fact, index (fact)}
						{#if index > 0}
							<span class="text-ink-tertiary/40">·</span>
						{/if}
						<span class="tabular" class:text-ink-secondary={index === 0}>{fact}</span>
					{/each}
				</figcaption>
			</figure>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
