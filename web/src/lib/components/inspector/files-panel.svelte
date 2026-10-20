<script lang="ts">
	import FilesIcon from '@lucide/svelte/icons/files';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import type { Turn } from '#lib/harness/types.js';

	let { turns }: { turns: Turn[] } = $props();

	/**
	 * Files touched in this thread, derived only from parts that name a path.
	 * A `tool` row carries no path (the wire puts it in `locations`), so it is
	 * not counted here rather than guessed at.
	 */
	const files = $derived.by(() => {
		const seen = new Map<
			string,
			{ path: string; additions: number; deletions: number; tool: string }
		>();

		for (const turn of turns) {
			for (const part of turn.parts) {
				if (part.kind === 'diff') {
					seen.set(part.path, {
						path: part.path,
						additions: part.additions,
						deletions: part.deletions,
						tool: 'patch'
					});
				} else if (part.kind === 'file-read') {
					if (!seen.has(part.path)) {
						seen.set(part.path, { path: part.path, additions: 0, deletions: 0, tool: 'read' });
					}
				} else if (part.kind === 'file-write') {
					seen.set(part.path, {
						path: part.path,
						additions: part.lines.length,
						deletions: 0,
						tool: part.created ? 'write' : 'overwrite'
					});
				} else if (part.kind === 'file-edit') {
					seen.set(part.path, {
						path: part.path,
						additions: part.additions,
						deletions: part.deletions,
						tool: 'edit'
					});
				} else if (part.kind === 'image-read') {
					if (!seen.has(part.path)) {
						seen.set(part.path, {
							path: part.path,
							additions: 0,
							deletions: 0,
							tool: 'read image'
						});
					}
				}
			}
		}

		return [...seen.values()];
	});
</script>

<div class="flex flex-col gap-3">
	<div class="flex items-center justify-between">
		<p class="text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">Files</p>
		<span class="tabular font-mono text-[10px] text-ink-tertiary/70">{files.length}</span>
	</div>

	{#if files.length === 0}
		<p class="flex items-center gap-1.5 text-[11.5px] text-ink-tertiary">
			<FilesIcon class="size-3" /> Nothing touched yet.
		</p>
	{:else}
		<ul class="flex flex-col">
			{#each files as file (file.path)}
				<li class="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-paper-card/60">
					<Collapsible.Root class="min-w-0 flex-1">
						<Collapsible.Trigger
							class="flex w-full min-w-0 items-center gap-1.5 text-left text-[11.5px]"
						>
							<span class="min-w-0 truncate font-mono text-ink-secondary">{file.path}</span>
						</Collapsible.Trigger>
						<Collapsible.Content>
							<p class="mt-1 pl-1 font-mono text-[10px] text-ink-tertiary">via {file.tool}</p>
						</Collapsible.Content>
					</Collapsible.Root>
					{#if file.additions || file.deletions}
						<span class="tabular shrink-0 font-mono text-[10px]">
							<span class="text-success">+{file.additions}</span>
							<span class="mx-0.5 text-ink-tertiary/40">/</span>
							<span class="text-error">−{file.deletions}</span>
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
