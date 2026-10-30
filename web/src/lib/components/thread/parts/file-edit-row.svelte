<script lang="ts">
	import FileDiffIcon from '@lucide/svelte/icons/file-diff';
	import * as CodeBlock from '#lib/components/ui/code-block/index.js';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { useHighlightedCode } from '#lib/hooks/use-highlighted-code.svelte.js';
	import { dirName, fileName, formatDuration } from '#lib/harness/format.js';
	import type { DiffLine, FileEditPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let {
		part,
		/** Whether the diff starts folded; the dialog's `collapse_edits`. */
		collapse = true
	}: { part: FileEditPart; collapse?: boolean } = $props();

	const status = $derived(traceStatus(part.status));
	const failed = $derived(part.status === 'error');

	/**
	 * The diff shows two number columns, so it cannot use `CodeBlock.Content`'s
	 * built-in single gutter. It keeps the code surface and highlights the
	 * after-side text (context + added lines) in one pass, which keeps
	 * multi-line constructs intact; removed lines have no place in that text,
	 * so they render plain and rely on the tint to read as removed.
	 */
	const rows = $derived.by(() => {
		let afterIndex = 0;
		return part.hunks.flatMap((hunk) => [
			{ header: hunk.header, id: hunk.id },
			...hunk.lines.map((line) => {
				const row = { line, afterIndex: line.kind === 'remove' ? -1 : afterIndex };
				if (line.kind !== 'remove') afterIndex += 1;
				return row;
			})
		]);
	});

	const afterText = $derived(
		part.hunks
			.flatMap((hunk) => hunk.lines)
			.filter((line) => line.kind !== 'remove')
			.map((line) => line.text)
			.join('\n')
	);

	const highlighted = useHighlightedCode(
		() => afterText,
		() => part.language
	);

	function signOf(line: DiffLine): string {
		return line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ';
	}
</script>

{#snippet line()}
	<Trace.Line {status}>
		<Trace.Icon>
			<FileDiffIcon class={failed ? 'text-error' : 'text-verify'} />
		</Trace.Icon>
		<Trace.Title>
			<span class="text-ink-secondary">Edited</span>
			<span class="ml-1.5 font-mono text-[12.5px]">
				<span class="text-ink-tertiary">{dirName(part.path)}</span>
				<span class="text-ink">{fileName(part.path)}</span>
			</span>
		</Trace.Title>
		<Trace.Description class="tabular">
			<span class="text-success">+{part.additions}</span>
			<span class="mx-0.5 text-ink-tertiary/50">/</span>
			<span class="text-error">−{part.deletions}</span>
		</Trace.Description>
		{#if part.durationMs}
			<Trace.Description>{formatDuration(part.durationMs)}</Trace.Description>
		{/if}
	</Trace.Line>
{/snippet}

<Trace.Root>
	{#if part.hunks.length === 0}
		{@render line()}
	{:else}
		<Trace.Collapsible open={!collapse}>
			<Trace.CollapsibleTrigger>{@render line()}</Trace.CollapsibleTrigger>
			<Trace.CollapsibleContent class="border-line/80">
				<CodeBlock.Root size="sm" class="bg-code-surface">
					<CodeBlock.Content class="max-h-96 px-0 py-2">
						{#each rows as row, index (index)}
							{#if 'header' in row}
								<div
									class="my-1 border-y border-line/60 bg-paper-card/40 px-3 py-1 font-mono text-[10.5px] text-ink-tertiary"
								>
									{row.header}
								</div>
							{:else}
								{@const line = row.line}
								<div
									class={[
										'grid grid-cols-[2.5rem_2.5rem_1.25rem_1fr] items-baseline px-1 font-mono text-[12px] leading-relaxed',
										line.kind === 'add'
											? 'bg-success/10'
											: line.kind === 'remove'
												? 'bg-error/10'
												: ''
									]}
								>
									<span
										class="tabular pr-2 text-right text-[10.5px] text-ink-tertiary/70 select-none"
									>
										{line.oldNumber ?? ''}
									</span>
									<span
										class="tabular pr-2 text-right text-[10.5px] text-ink-tertiary/70 select-none"
									>
										{line.newNumber ?? ''}
									</span>
									<span
										class={[
											'select-none',
											line.kind === 'add'
												? 'text-success'
												: line.kind === 'remove'
													? 'text-error'
													: 'text-ink-tertiary/40'
										]}
									>
										{signOf(line)}
									</span>
									<span
										class={[
											'min-w-0 whitespace-pre-wrap',
											line.kind === 'remove' ? 'text-error/80' : 'text-ink'
										]}
									>
										{#if line.kind !== 'remove' && highlighted.current[row.afterIndex]}
											{#each highlighted.current[row.afterIndex] as token, tokenIndex (tokenIndex)}
												{#if typeof token === 'string'}
													{token}
												{:else}
													<span style={token.style} class={token.class}>{token.content}</span>
												{/if}
											{/each}
										{:else}
											{line.text || ' '}
										{/if}
									</span>
								</div>
							{/if}
						{/each}
					</CodeBlock.Content>
				</CodeBlock.Root>
			</Trace.CollapsibleContent>
		</Trace.Collapsible>
	{/if}
</Trace.Root>
