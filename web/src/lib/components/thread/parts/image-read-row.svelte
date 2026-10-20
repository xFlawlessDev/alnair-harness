<script lang="ts">
	import ImageIcon from '@lucide/svelte/icons/image';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { dirName, fileName, formatBytes, formatDuration } from '#lib/harness/format.js';
	import type { ImageReadPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let { part }: { part: ImageReadPart } = $props();

	const status = $derived(traceStatus(part.status));
	const running = $derived(part.status === 'running' || part.status === 'pending');
	const dimensions = $derived(`${part.width}×${part.height}`);
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
		<Trace.Description class="tabular">{dimensions}</Trace.Description>
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
					<span class="text-ink-secondary">{part.mime}</span>
					<span class="text-ink-tertiary/40">·</span>
					<span class="tabular">{dimensions}</span>
					<span class="text-ink-tertiary/40">·</span>
					<span class="tabular">{formatBytes(part.bytes)}</span>
				</figcaption>
			</figure>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
