<script lang="ts">
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import * as CodeBlock from '#lib/components/ui/code-block/index.js';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { useHighlightedCode } from '#lib/hooks/use-highlighted-code.svelte.js';
	import { dirName, fileName, formatDuration } from '#lib/harness/format.js';
	import type { FileReadPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let { part }: { part: FileReadPart } = $props();

	const source = $derived(part.lines.map((line) => line.text).join('\n'));
	const start = $derived(part.lines[0]?.n ?? 1);
	const end = $derived(part.lines.at(-1)?.n ?? start);
	const status = $derived(traceStatus(part.status));
	const running = $derived(part.status === 'running' || part.status === 'pending');

	const lines = useHighlightedCode(
		() => source,
		() => part.language
	);
</script>

{#snippet line()}
	<Trace.Line {status}>
		<Trace.Icon>
			<FileTextIcon class={running ? 'text-running' : 'text-tool'} />
		</Trace.Icon>
		<Trace.Title>
			<span class="text-ink-secondary">Read</span>
			<span class="ml-1.5 font-mono text-[12.5px]">
				<span class="text-ink-tertiary">{dirName(part.path)}</span>
				<span class="text-ink">{fileName(part.path)}</span>
			</span>
		</Trace.Title>
		<Trace.Description class="tabular">
			{#if part.lines.length > 0}
				{#if start > 1}
					{start}–{end}
				{:else}
					{part.lines.length} lines
				{/if}
			{/if}
		</Trace.Description>
		{#if part.durationMs}
			<Trace.Description>{formatDuration(part.durationMs)}</Trace.Description>
		{/if}
	</Trace.Line>
{/snippet}

<Trace.Root>
	{#if part.lines.length === 0}
		{@render line()}
	{:else}
		<Trace.Collapsible>
			<Trace.CollapsibleTrigger>{@render line()}</Trace.CollapsibleTrigger>
			<Trace.CollapsibleContent class="border-line/80">
				<CodeBlock.Root size="sm" class="bg-code-surface">
					<CodeBlock.Header class="pb-1">
						<CodeBlock.Title class="font-mono text-[11px] text-ink-tertiary">
							{part.path}
						</CodeBlock.Title>
						<CodeBlock.Actions>
							<CodeBlock.CopyButton value={source} />
						</CodeBlock.Actions>
					</CodeBlock.Header>
					<CodeBlock.Content lineNumbers startLine={start} class="max-h-80">
						{#each lines.current as row, index (index)}
							<CodeBlock.Line code={row} />
						{/each}
					</CodeBlock.Content>
				</CodeBlock.Root>
			</Trace.CollapsibleContent>
		</Trace.Collapsible>
	{/if}
</Trace.Root>
