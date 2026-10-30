<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import type { FileEntry } from '#lib/harness/types.js';
	import { sortEntries } from '#lib/harness/mentions.js';
	import { cn } from '#lib/utils.js';
	// A self-import, not `<svelte:self>`: that tag is deprecated, and the import
	// is the same recursion with one fewer exception to remember.
	import FileTree from './file-tree.svelte';

	/**
	 * One directory level of the workspace tree.
	 *
	 * Recursive, because the two-level version could not reach
	 * `crates/codegen/alnair-shell/src/session/` — a repository is deeper than
	 * one expansion, and a tree that stops opening is a tree the reader cannot
	 * navigate. Each level keeps its own expansions, so opening one branch does
	 * not refetch the others.
	 */
	let {
		entries,
		depth = 0,
		activePath,
		onopen,
		onbrowse
	}: {
		entries: FileEntry[];
		/** Indent level; the caller increments it when recursing. */
		depth?: number;
		/** The file currently open in the editor. */
		activePath?: string;
		onopen: (path: string) => void;
		/** One directory's children, fetched on first expand. */
		onbrowse: (path: string) => Promise<FileEntry[]>;
	} = $props();

	/** Children per expanded directory, keyed by path. */
	let children = $state<Record<string, FileEntry[]>>({});
	/** Directories whose fetch is in flight. */
	let loading = $state<Record<string, boolean>>({});

	async function toggle(entry: FileEntry) {
		if (children[entry.path]) {
			const { [entry.path]: _collapsed, ...rest } = children;
			children = rest;
			return;
		}
		loading = { ...loading, [entry.path]: true };
		try {
			const listing = await onbrowse(entry.path);
			// Directories first, then alphabetical — the same order the root
			// uses, so expanding a branch does not reshuffle what is under it.
			children = { ...children, [entry.path]: sortEntries(listing) };
		} catch {
			// A directory that vanished between the click and the read is not
			// worth an error row; an empty list is the honest answer.
			children = { ...children, [entry.path]: [] };
		} finally {
			loading = { ...loading, [entry.path]: false };
		}
	}

	/** Indentation for this depth; the caret column stays aligned at every level. */
	const pad = (offset: number) => `${depth * 10 + offset}px`;
</script>

<ul class="flex flex-col">
	{#each entries as entry (entry.path)}
		<li>
			{#if entry.type === 'directory'}
				{@const open = Boolean(children[entry.path])}
				<button
					type="button"
					class="flex w-full min-w-0 items-center gap-1 rounded py-0.5 pr-1 text-left transition-colors hover:bg-paper-card"
					style:padding-left={pad(2)}
					aria-expanded={open}
					title={entry.path}
					onclick={() => void toggle(entry)}
				>
					<ChevronRightIcon
						class="size-2.5 shrink-0 text-ink-tertiary/60 transition-transform {open
							? 'rotate-90'
							: ''}"
					/>
					{#if loading[entry.path]}
						<LoaderIcon class="size-3 shrink-0 animate-spin text-ink-tertiary" />
					{:else if open}
						<FolderOpenIcon class="size-3 shrink-0 text-olive" />
					{:else}
						<FolderIcon class="size-3 shrink-0 text-ink-tertiary" />
					{/if}
					<span class="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-secondary">
						{entry.name}
					</span>
				</button>
				{#if children[entry.path]}
					{#if children[entry.path].length === 0}
						<p
							class="py-0.5 font-mono text-[10px] text-ink-tertiary/60 italic"
							style:padding-left={pad(18)}
						>
							empty
						</p>
					{:else}
						<!-- Recurse: the next level fetches and expands on its own. -->
						<FileTree
							entries={children[entry.path]}
							depth={depth + 1}
							{activePath}
							{onopen}
							{onbrowse}
						/>
					{/if}
				{/if}
			{:else}
				{@const current = activePath === entry.path}
				<button
					type="button"
					class={cn(
						'flex w-full min-w-0 items-center gap-1 rounded py-0.5 pr-1 text-left transition-colors hover:bg-paper-card',
						current && 'bg-paper-card'
					)}
					style:padding-left={pad(12)}
					title={entry.path}
					onclick={() => onopen(entry.path)}
				>
					<FileCodeIcon class="size-3 shrink-0 {current ? 'text-olive' : 'text-ink-tertiary'}" />
					<span
						class="min-w-0 flex-1 truncate font-mono text-[11px]"
						class:text-ink={current}
						class:text-ink-secondary={!current}
					>
						{entry.name}
					</span>
				</button>
			{/if}
		</li>
	{/each}
</ul>
