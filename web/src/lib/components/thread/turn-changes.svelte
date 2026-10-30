<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import FilePlusIcon from '@lucide/svelte/icons/file-plus';
	import FilePenIcon from '@lucide/svelte/icons/file-pen';
	import { useHighlightedCode } from '#lib/hooks/use-highlighted-code.svelte.js';
	import { dirName, fileName } from '#lib/harness/format.js';
	import type { HighlightedLine } from '#lib/highlighter.js';
	import { cn } from '#lib/utils.js';
	import { changeTotals, type TurnChange } from './turn-changes.js';

	/**
	 * What one turn changed, at the end of that turn.
	 *
	 * The audit surface. The right rail merges every file the session touched,
	 * which is right for browsing and useless for review: it cannot say which
	 * turn made a change, and a file edited twice shows only its last state. This
	 * list is per turn, in order, so a reader can walk a session change by change.
	 *
	 * It sits after the answer rather than inside the folded work summary
	 * because it is the one part of the work a reader wants WITHOUT opening
	 * anything: "what did this touch" is the question, and the diff is the
	 * detail behind it.
	 */
	let {
		changes,
		onopen
	}: {
		changes: TurnChange[];
		/** Open a path in the editor panel. */
		onopen?: (path: string) => void;
	} = $props();

	const totals = $derived(changeTotals(changes));

	/** Which change is expanded; one at a time, so the list stays scannable. */
	let expanded = $state<string | undefined>(undefined);

	/**
	 * The patch for a change.
	 *
	 * A whole-file write carries no hunks, so the file itself is the honest
	 * view — marked as all-additions would claim a diff that does not exist.
	 */
	function patchOf(change: TurnChange): string {
		if (change.patch) return change.patch;
		return change.lines?.map((line) => line.text).join('\n') ?? '';
	}

	/** One line of a rendered patch, with its +/- tint. */
	function lineClass(line: HighlightedLine): string {
		if (typeof line !== 'string') return '';
		if (line.startsWith('+')) return 'bg-success/10 text-success';
		if (line.startsWith('-')) return 'bg-error/10 text-error';
		return 'text-ink-secondary';
	}
</script>

{#if changes.length > 0}
	<div class="mt-1 flex flex-col gap-0.5" data-slot="turn-changes">
		<div class="flex items-center gap-1.5 text-[11px] text-ink-tertiary">
			<span class="font-medium">
				{changes.length}
				{changes.length === 1 ? 'file' : 'files'} changed
			</span>
			<span class="tabular font-mono text-[10.5px]">
				<span class="text-success">+{totals.additions}</span>
				<span class="mx-0.5 text-ink-tertiary/40">/</span>
				<span class="text-error">−{totals.deletions}</span>
			</span>
		</div>

		<ul class="flex flex-col">
			{#each changes as change (change.path)}
				{@const open = expanded === change.path}
				{@const created = change.action === 'write'}
				<li>
					<!--
						The row and its "open" affordance are siblings, not nested
						buttons: a button inside a button is invalid HTML and the
						browser drops the inner one's click.
					-->
					<div
						class="group/change flex w-full min-w-0 items-center gap-1 rounded transition-colors hover:bg-paper-card/60"
					>
						<button
							type="button"
							class="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5 text-left"
							aria-expanded={open}
							title={change.path}
							onclick={() => (expanded = open ? undefined : change.path)}
						>
							<ChevronRightIcon
								class="size-2.5 shrink-0 text-ink-tertiary/60 transition-transform {open
									? 'rotate-90'
									: ''}"
							/>
							{#if created}
								<FilePlusIcon class="size-3 shrink-0 text-success" />
							{:else}
								<FilePenIcon class="size-3 shrink-0 text-ink-tertiary" />
							{/if}
							<span class="min-w-0 flex-1 truncate font-mono text-[11px]">
								<span class="text-ink-tertiary">{dirName(change.path)}</span>
								<span class="text-ink-secondary">{fileName(change.path)}</span>
							</span>
							<span class="tabular shrink-0 font-mono text-[10px]">
								{#if change.additions > 0}
									<span class="text-success">+{change.additions}</span>
								{/if}
								{#if change.deletions > 0}
									<span class="text-error">−{change.deletions}</span>
								{/if}
							</span>
						</button>

						{#if onopen}
							<button
								type="button"
								class="mr-1 shrink-0 rounded px-1 font-mono text-[9.5px] text-ink-tertiary/0 transition-colors group-hover/change:text-ink-tertiary hover:bg-paper hover:text-ink focus-visible:text-ink-tertiary"
								aria-label={`Open ${fileName(change.path)} in the editor`}
								onclick={() => onopen?.(change.path)}
							>
								open
							</button>
						{/if}
					</div>

					{#if open}
						{@render diff(change, patchOf(change))}
					{/if}
				</li>
			{/each}
		</ul>
	</div>
{/if}

{#snippet diff(change: TurnChange, patch: string)}
	{@const rendered = useHighlightedCode(
		() => patch,
		() => 'diff'
	)}
	<pre
		class="mt-1 mb-1.5 max-h-72 overflow-auto rounded-md border border-line/70 bg-code-surface px-2 py-1.5 font-mono text-[10.5px] leading-relaxed"
		aria-label={`Diff for ${fileName(change.path)}`}><code
			>{#each rendered.current as line, index (index)}<span class={cn('block', lineClass(line))}
					>{#if typeof line === 'string'}{line ||
							' '}{:else}{#each line as token, tokenIndex (tokenIndex)}<span
								style={token.style}
								class={token.class}>{token.content}</span
							>{/each}{/if}</span
				>{/each}</code
		></pre>
{/snippet}
