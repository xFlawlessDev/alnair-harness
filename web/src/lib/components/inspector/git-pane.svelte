<script lang="ts">
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import FilePlusIcon from '@lucide/svelte/icons/file-plus';
	import FileMinusIcon from '@lucide/svelte/icons/file-minus';
	import FilePenIcon from '@lucide/svelte/icons/file-pen';
	import FileQuestionIcon from '@lucide/svelte/icons/file-question';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { GitChange } from './panel-data.js';

	/**
	 * Source control, as the agent's own git APIs report it.
	 *
	 * Read-only on purpose. Staging, committing and discarding are the agent's
	 * verbs — it has the tools, the transcript shows what it did, and a browser
	 * button that quietly rewrote the working tree would be a second, unaudited
	 * writer. What the panel adds is the thing the thread cannot show: the
	 * current state of everything, not only the files a turn happened to touch.
	 */
	let {
		changes,
		branch,
		upstream,
		ahead = 0,
		behind = 0,
		root,
		loading = false,
		error,
		onrefresh,
		onopen
	}: {
		changes: GitChange[];
		branch?: string;
		upstream?: string;
		ahead?: number;
		behind?: number;
		root?: string;
		loading?: boolean;
		error?: string;
		onrefresh: () => void;
		onopen: (path: string) => void;
	} = $props();

	const staged = $derived(changes.filter((change) => change.staged));
	const unstaged = $derived(changes.filter((change) => !change.staged));

	function iconFor(type: string) {
		if (type === 'added' || type === 'untracked') return FilePlusIcon;
		if (type === 'deleted') return FileMinusIcon;
		if (type === 'modified' || type === 'renamed') return FilePenIcon;
		return FileQuestionIcon;
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5">
		<GitBranchIcon class="size-3 shrink-0 text-ink-tertiary" />
		<p class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-secondary">
			{branch || 'detached'}
			{#if upstream}
				<span class="text-ink-tertiary">→ {upstream}</span>
			{/if}
			{#if ahead > 0 || behind > 0}
				<span class="tabular text-ink-tertiary">
					{ahead > 0 ? ` ↑${ahead}` : ''}{behind > 0 ? ` ↓${behind}` : ''}
				</span>
			{/if}
		</p>
		<Button
			variant="ghost"
			size="icon-xs"
			aria-label="Refresh source control"
			class="shrink-0 text-ink-tertiary hover:text-ink"
			onclick={onrefresh}
		>
			<RefreshCwIcon class={loading ? 'animate-spin' : ''} />
		</Button>
	</div>

	{#if root}
		<p class="truncate px-3 pt-1.5 font-mono text-[10px] text-ink-tertiary/70">{root}</p>
	{/if}

	<div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
		{#if error}
			<p class="px-1.5 py-2 text-[11px] text-ink-tertiary">{error}</p>
		{:else if changes.length === 0}
			<p class="px-1.5 py-2 text-[11px] text-ink-tertiary">
				{loading ? 'Reading the working tree…' : 'No changes. The working tree is clean.'}
			</p>
		{:else}
			{#each [{ label: 'Staged', rows: staged }, { label: 'Changes', rows: unstaged }] as group (group.label)}
				{#if group.rows.length > 0}
					<p
						class="px-1.5 pt-1.5 pb-1 text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase"
					>
						{group.label}
						<span class="tabular font-mono normal-case">({group.rows.length})</span>
					</p>
					<ul class="flex flex-col">
						{#each group.rows as change (change.path)}
							{@const Icon = iconFor(change.type)}
							<li>
								<button
									type="button"
									class="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-paper-card"
									onclick={() => onopen(change.path)}
									title={change.path}
								>
									<Icon class="size-3 shrink-0 text-ink-tertiary" />
									<span class="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-secondary">
										{change.path}
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
							</li>
						{/each}
					</ul>
				{/if}
			{/each}
		{/if}
	</div>
</div>
