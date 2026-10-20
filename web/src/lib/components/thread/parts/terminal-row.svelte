<script lang="ts">
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import * as CodeBlock from '#lib/components/ui/code-block/index.js';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { formatDuration } from '#lib/harness/format.js';
	import type { TerminalPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let { part }: { part: TerminalPart } = $props();

	const failed = $derived(
		part.status === 'error' || (part.exitCode !== undefined && part.exitCode !== 0)
	);
	const running = $derived(part.status === 'running' || part.status === 'pending');
	const status = $derived(failed ? 'error' : traceStatus(part.status));

	const heading = $derived.by(() => {
		if (part.backgrounded) return 'Backgrounded';
		if (running) return 'Running';
		if (failed) return 'Failed';
		return 'Ran';
	});
</script>

<Trace.Root>
	<Trace.Collapsible open={running || failed}>
		<Trace.CollapsibleTrigger>
			<Trace.Line {status}>
				<Trace.Icon>
					<TerminalIcon />
				</Trace.Icon>
				<Trace.Title>
					<span class="text-ink-secondary">{heading}</span>
					<code class="ml-1 font-mono text-[12.5px] text-ink">{part.command}</code>
				</Trace.Title>
				{#if part.durationMs}
					<Trace.Description>{formatDuration(part.durationMs)}</Trace.Description>
				{/if}
				{#if part.backgrounded}
					<Trace.Description class="text-running">task {part.taskId}</Trace.Description>
				{/if}
				{#if part.exitCode !== undefined}
					<Trace.Description class={failed ? 'text-error' : undefined}>
						exit {part.exitCode}
					</Trace.Description>
				{/if}
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-line/80">
			<CodeBlock.Root
				size="sm"
				variant={failed ? 'destructive' : 'default'}
				class="bg-code-surface"
			>
				<CodeBlock.Header class="pb-1">
					<CodeBlock.Title class="font-mono text-[11px] text-ink-tertiary">
						{part.cwd ?? part.outputFile ?? 'output'}
					</CodeBlock.Title>
					<CodeBlock.Actions>
						<CodeBlock.CopyButton value={part.output} />
					</CodeBlock.Actions>
				</CodeBlock.Header>
				{#if part.output}
					<CodeBlock.Content wrap class="max-h-72 text-ink-secondary" code={part.output} />
				{:else}
					<p class="px-1 pt-1 pb-2 text-[11.5px] text-ink-tertiary">
						{part.backgrounded
							? 'Running in the background; no output yet.'
							: 'The command printed nothing.'}
					</p>
				{/if}
			</CodeBlock.Root>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
