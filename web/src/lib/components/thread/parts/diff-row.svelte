<script lang="ts">
	import FileDiffIcon from '@lucide/svelte/icons/file-diff';
	import * as CodeBlock from '#lib/components/ui/code-block/index.js';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import type { DiffPart } from '#lib/harness/types.js';

	let { part }: { part: DiffPart } = $props();

	/** Drop the file headers; the row already names the file. */
	const rows = $derived.by(() =>
		part.patch
			.split('\n')
			.filter((line) => !line.startsWith('diff --git') && !line.startsWith('index '))
			.filter((line) => !line.startsWith('--- ') && !line.startsWith('+++ '))
			.filter((line) => !line.startsWith('new file mode') && !line.startsWith('deleted file mode'))
	);

	function variantOf(line: string): 'added' | 'removed' | 'default' | 'highlighted' {
		if (line.startsWith('+')) return 'added';
		if (line.startsWith('-')) return 'removed';
		if (line.startsWith('@@')) return 'highlighted';
		return 'default';
	}
</script>

<Trace.Root>
	<Trace.Collapsible>
		<Trace.CollapsibleTrigger>
			<Trace.Line>
				<Trace.Icon>
					<FileDiffIcon class="text-verify" />
				</Trace.Icon>
				<Trace.Title class="font-mono text-[12.5px]">{part.path}</Trace.Title>
				<Trace.Description class="tabular">
					<span class="text-success">+{part.additions}</span>
					<span class="mx-0.5 text-ink-tertiary/50">/</span>
					<span class="text-error">−{part.deletions}</span>
				</Trace.Description>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-line/80">
			<CodeBlock.Root size="sm" class="bg-code-surface">
				<CodeBlock.Content class="max-h-96">
					{#each rows as line, index (index)}
						{@const variant = variantOf(line)}
						<CodeBlock.Line {variant} code={variant === 'default' ? line : line.slice(1)} />
					{/each}
				</CodeBlock.Content>
			</CodeBlock.Root>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
