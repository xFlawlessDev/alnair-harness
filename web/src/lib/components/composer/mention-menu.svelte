<script lang="ts">
	import FileIcon from '@lucide/svelte/icons/file';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import CornerDownLeftIcon from '@lucide/svelte/icons/corner-down-left';
	import { formatBytes } from '#lib/harness/format.js';
	import type { FileEntry } from '#lib/harness/types.js';

	/**
	 * The `@` menu: one directory of the workspace at a time, as
	 * `alnair/fs/list` returns it. Directories lead and drill in; files insert
	 * a mention.
	 *
	 * The list is keyboard-driven because the composer keeps focus: Up/Down
	 * move the cursor, Enter accepts, Escape closes. Pointer users get the
	 * same rows, and hovering moves the cursor so both agree.
	 */
	let {
		entries,
		query,
		active,
		truncated = false,
		onhover,
		onaccept
	}: {
		entries: FileEntry[];
		/** What was typed after the `@`, echoed back so the reader sees the filter. */
		query: string;
		/** Index of the highlighted row. */
		active: number;
		/** The directory listing hit the agent's page limit. */
		truncated?: boolean;
		onhover: (index: number) => void;
		onaccept: (entry: FileEntry) => void;
	} = $props();

	const isDir = (entry: FileEntry) => entry.type === 'directory';

	let list: HTMLUListElement | null = $state(null);

	/**
	 * Keep the highlighted row inside the scroll port. Arrow keys move the
	 * cursor without moving focus, so the browser does not scroll for us — the
	 * offset has to be computed here.
	 *
	 * `offsetTop` is relative to the nearest positioned ancestor, which is the
	 * popover panel rather than the list, so the list's own offset is
	 * subtracted. `active` is read explicitly to make the effect depend on it.
	 */
	$effect(() => {
		const index = active;
		const count = entries.length;
		if (!list || count === 0) return;
		const row = list.children[index] as HTMLElement | undefined;
		if (!row) return;

		const top = row.offsetTop - list.offsetTop;
		const bottom = top + row.offsetHeight;
		if (top < list.scrollTop) list.scrollTop = top;
		else if (bottom > list.scrollTop + list.clientHeight) {
			list.scrollTop = bottom - list.clientHeight;
		}
	});
</script>

<div
	class="w-[30rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line-strong bg-popover shadow-lg"
>
	<div class="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
		<p class="text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">
			Mention file
		</p>
		<span class="truncate font-mono text-[10px] text-ink-tertiary/80">
			{#if query}@{query}{:else}type to filter{/if}
		</span>
	</div>

	{#if entries.length === 0}
		<p class="px-3 py-4 text-center text-[12px] text-ink-tertiary">No file matches.</p>
	{:else}
		<ul bind:this={list} class="max-h-64 overflow-y-auto py-1" role="listbox" aria-label="Files">
			{#each entries as entry, index (entry.path)}
				{@const selected = index === active}
				<li role="option" aria-selected={selected}>
					<button
						type="button"
						class={[
							'flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors',
							selected ? 'bg-paper-card' : 'hover:bg-paper-card/50'
						]}
						onmouseenter={() => onhover(index)}
						onclick={() => onaccept(entry)}
					>
						{#if isDir(entry)}
							<FolderIcon class="size-3.5 shrink-0 text-plan" />
						{:else}
							<FileIcon class="size-3.5 shrink-0 text-ink-tertiary" />
						{/if}
						<span class="flex min-w-0 flex-1 flex-col">
							<span class="truncate text-[12px] text-ink-secondary">
								<span class="text-ink-tertiary"
									>{entry.path.slice(0, entry.path.length - entry.name.length)}</span
								><span class="text-ink">{entry.name}</span>
							</span>
						</span>
						{#if entry.size !== undefined && !isDir(entry)}
							<span class="tabular shrink-0 font-mono text-[10px] text-ink-tertiary/70">
								{formatBytes(entry.size)}
							</span>
						{/if}
						{#if selected}
							<CornerDownLeftIcon class="size-3 shrink-0 text-ink-tertiary/60" />
						{/if}
					</button>
				</li>
			{/each}
		</ul>

		{#if truncated}
			<p class="border-t border-line px-3 py-1 text-[10.5px] text-ink-tertiary">
				List truncated by the agent — keep typing to narrow it.
			</p>
		{/if}
	{/if}
</div>
