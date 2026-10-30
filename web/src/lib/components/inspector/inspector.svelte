<script lang="ts">
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import ImageIcon from '@lucide/svelte/icons/image';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { dirName, fileName } from '#lib/harness/format.js';
	import type { GitContext, Turn } from '#lib/harness/types.js';
	import GitPane from './git-pane.svelte';
	import { gitChanges, touchedFiles, type GitChange } from './panel-data.js';

	/**
	 * The right rail: what the thread touched, and the working tree.
	 *
	 * Only lists live here. The two panes that need ROOM — the Monaco editor
	 * and the interactive terminal — belong in the bottom drawer, because a
	 * 320px column is the wrong shape for either: a code line is wider than
	 * that, and a shell needs the full width to be usable at all.
	 *
	 * Both lists open their pick in the drawer rather than here, which is the
	 * one behaviour worth knowing: a click on a file is a request to edit it,
	 * not to read a preview of it.
	 */
	let {
		turns,
		git,
		onrefresh,
		ongitstatus,
		onopenfile
	}: {
		turns: Turn[];
		git: GitContext | undefined;
		/** Re-read git info, branches and worktrees (the composer owns those). */
		onrefresh: () => void;
		/** `alnair/git/status`, for the source-control pane. */
		ongitstatus: () => Promise<unknown>;
		/** Open a path in the editor drawer. */
		onopenfile: (path: string) => void;
	} = $props();

	let tab = $state('files');

	let status = $state<unknown>(undefined);
	let statusLoading = $state(false);
	let statusError = $state<string | undefined>(undefined);

	const files = $derived(touchedFiles(turns));
	const changes = $derived<GitChange[]>(gitChanges(status));

	/** Refresh the working tree, on tab open and on demand. */
	async function refreshStatus() {
		if (statusLoading) return;
		statusLoading = true;
		statusError = undefined;
		try {
			status = await ongitstatus();
		} catch (cause) {
			statusError = cause instanceof Error ? cause.message : 'the working tree could not be read';
		} finally {
			statusLoading = false;
		}
	}

	// Reading on first open rather than on mount: the panel is open by default
	// on a wide window, and a git status per page load is a shell-out the reader
	// never asked for. The Files tab needs nothing from it.
	$effect(() => {
		if (tab === 'git' && status === undefined && !statusLoading) void refreshStatus();
	});
</script>

<aside class="rule-l flex h-full w-72 shrink-0 flex-col bg-paper-raised">
	<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col gap-0">
		<div class="rule-b flex h-12 shrink-0 items-center gap-1 px-2">
			<Tabs.List class="h-8 flex-1">
				<Tabs.Trigger value="files" class="gap-1 text-[11px]">
					<FileCodeIcon class="size-3" />
					Files
					{#if files.length > 0}
						<span class="tabular font-mono text-[9.5px] text-ink-tertiary/70">{files.length}</span>
					{/if}
				</Tabs.Trigger>
				<Tabs.Trigger value="git" class="gap-1 text-[11px]">
					<GitBranchIcon class="size-3" />
					Source
					{#if changes.length > 0}
						<span class="tabular font-mono text-[9.5px] text-ink-tertiary/70">
							{changes.length}
						</span>
					{/if}
				</Tabs.Trigger>
			</Tabs.List>
		</div>

		<Tabs.Content value="files" class="flex min-h-0 flex-1 flex-col outline-none">
			<div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
				{#if files.length === 0}
					<p class="px-1.5 py-2 text-[11px] leading-relaxed text-ink-tertiary">
						Nothing touched yet. Files the agent reads or edits appear here, and clicking one opens
						it in the editor panel.
					</p>
				{:else}
					<ul class="flex flex-col gap-0.5">
						{#each files as file (file.path)}
							<li>
								<button
									type="button"
									class="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-paper-card"
									onclick={() => onopenfile(file.path)}
									title={file.path}
								>
									{#if file.kind === 'image'}
										<ImageIcon class="size-3 shrink-0 text-ink-tertiary" />
									{:else}
										<FileCodeIcon class="size-3 shrink-0 text-ink-tertiary" />
									{/if}
									<span class="min-w-0 flex-1 truncate">
										<span class="text-[11px] text-ink-tertiary">{dirName(file.path)}</span>
										<span class="font-mono text-[11px] text-ink-secondary">
											{fileName(file.path)}
										</span>
									</span>
									{#if file.additions > 0 || file.deletions > 0}
										<span class="tabular shrink-0 font-mono text-[10px]">
											{#if file.additions > 0}
												<span class="text-success">+{file.additions}</span>
											{/if}
											{#if file.deletions > 0}
												<span class="text-error">−{file.deletions}</span>
											{/if}
										</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</Tabs.Content>

		<Tabs.Content value="git" class="flex min-h-0 flex-1 flex-col outline-none">
			<GitPane
				{changes}
				branch={git?.branch}
				root={git?.root}
				loading={statusLoading}
				error={statusError}
				onrefresh={() => {
					onrefresh();
					void refreshStatus();
				}}
				onopen={(path) => onopenfile(path)}
			/>
		</Tabs.Content>
	</Tabs.Root>
</aside>
