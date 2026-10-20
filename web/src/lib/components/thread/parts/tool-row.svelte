<script lang="ts">
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import * as CodeBlock from '#lib/components/ui/code-block/index.js';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { formatDuration } from '#lib/harness/format.js';
	import type { ToolPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let { part }: { part: ToolPart } = $props();

	const running = $derived(part.status === 'running' || part.status === 'pending');
	const failed = $derived(part.status === 'error');
	const status = $derived(traceStatus(part.status));
	const hasBody = $derived(Boolean(part.input || part.output));
</script>

{#snippet line()}
	<Trace.Line {status}>
		<Trace.Icon>
			<WrenchIcon class={running ? 'text-running' : 'text-tool'} />
		</Trace.Icon>
		<Trace.Title>
			<span class="font-mono text-[12.5px] text-ink">{part.name}</span>
			<span class="ml-1.5 text-ink-tertiary">{part.summary}</span>
		</Trace.Title>
		{#if part.durationMs}
			<Trace.Description>{formatDuration(part.durationMs)}</Trace.Description>
		{/if}
	</Trace.Line>
{/snippet}

<Trace.Root>
	{#if hasBody}
		<Trace.Collapsible>
			<Trace.CollapsibleTrigger>{@render line()}</Trace.CollapsibleTrigger>
			<Trace.CollapsibleContent class="border-line/80">
				<div class="flex flex-col gap-2">
					{#if part.input}
						<CodeBlock.Root size="sm" class="bg-code-surface">
							<CodeBlock.Header class="pb-1">
								<CodeBlock.Title class="font-mono text-[11px] text-ink-tertiary">
									input
								</CodeBlock.Title>
							</CodeBlock.Header>
							<CodeBlock.Content wrap class="max-h-40 text-ink-secondary" code={part.input} />
						</CodeBlock.Root>
					{/if}
					{#if part.output}
						<CodeBlock.Root
							size="sm"
							variant={failed ? 'destructive' : 'default'}
							class="bg-code-surface"
						>
							<CodeBlock.Header class="pb-1">
								<CodeBlock.Title class="font-mono text-[11px] text-ink-tertiary">
									output
								</CodeBlock.Title>
							</CodeBlock.Header>
							<CodeBlock.Content wrap class="max-h-48 text-ink-secondary" code={part.output} />
						</CodeBlock.Root>
					{/if}
				</div>
			</Trace.CollapsibleContent>
		</Trace.Collapsible>
	{:else}
		{@render line()}
	{/if}
</Trace.Root>
