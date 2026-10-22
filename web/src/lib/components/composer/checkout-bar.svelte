<script lang="ts">
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitForkIcon from '@lucide/svelte/icons/git-fork';
	import GitCommitHorizontalIcon from '@lucide/svelte/icons/git-commit-horizontal';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CheckIcon from '@lucide/svelte/icons/check';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import FolderGit2Icon from '@lucide/svelte/icons/folder-git-2';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { tick } from 'svelte';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import type {
		BranchEntry,
		ComposerContext,
		GitContext,
		WorktreeEntry
	} from '#lib/harness/types.js';
	import WorktreeDialog from './worktree-dialog.svelte';

	/**
	 * The row under the prompt: where the code is checked out and which branch.
	 *
	 * Both menus are real: the checkout menu lists the repo's worktrees and can
	 * create one, and the branch menu switches branches (creating a local branch
	 * when the pick is a remote-tracking ref). The data comes from
	 * `alnair/git/*`, which resolves everything from the session's own cwd, so a
	 * session already inside a worktree sees that worktree's repo.
	 */
	let {
		context,
		git,
		branches,
		worktrees,
		onbranch,
		onworktree,
		onrefreshgit
	}: {
		context: ComposerContext;
		git: GitContext | undefined;
		branches: BranchEntry[];
		worktrees: WorktreeEntry[];
		onbranch: (name: string, create?: boolean) => void;
		onworktree: (label: string, gitRef?: string) => void;
		onrefreshgit: () => void;
	} = $props();

	const checkoutLabel: Record<ComposerContext['checkout'], string> = {
		branch: 'Current checkout',
		worktree: 'Worktree checkout',
		detached: 'Detached HEAD'
	};

	const CheckoutIcon = $derived(
		context.checkout === 'worktree' ? GitForkIcon : GitCommitHorizontalIcon
	);

	/** Local branches first; remote-tracking refs are a second, smaller group. */
	const local = $derived(branches.filter((branch) => !branch.remote));
	const remote = $derived(branches.filter((branch) => branch.remote));

	/** An in-flight git action, so the row can say what it is doing. */
	let pending = $state<string | undefined>(undefined);

	async function run(label: string, action: () => void) {
		pending = label;
		// The callback is synchronous into the store (which owns the async
		// request), so this clears on the next paint rather than on a promise
		// the component does not own.
		action();
		await tick();
		pending = undefined;
	}

	/** New-branch input, shown inline in the branch menu. */
	let creating = $state(false);
	let branchDraft = $state('');
	let branchInput: HTMLInputElement | null = $state(null);

	function beginCreate() {
		creating = true;
		branchDraft = '';
		void tick().then(() => branchInput?.focus());
	}

	function commitCreate() {
		const name = branchDraft.trim();
		creating = false;
		if (!name) return;
		void run(`creating ${name}`, () => onbranch(name, true));
	}

	/** New-worktree dialog. */
	let worktreeOpen = $state(false);
</script>

<div
	class="mt-1.5 flex items-center justify-between gap-3 rounded-lg border border-line bg-paper-raised/60 px-2 py-1"
	data-slot="checkout-bar"
>
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					class="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-ink-secondary transition-colors hover:bg-paper-card hover:text-ink"
					aria-label={`Checkout: ${checkoutLabel[context.checkout]}`}
				>
					<CheckoutIcon class="size-3 text-ink-tertiary" />
					<span class="whitespace-nowrap">{checkoutLabel[context.checkout]}</span>
					<ChevronDownIcon class="size-3 text-ink-tertiary" />
				</button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" side="top" class="w-64">
			<DropdownMenu.Label>Checkout</DropdownMenu.Label>
			<DropdownMenu.Item disabled class="font-mono text-[11px]">
				{git?.root ?? 'no repository'}
			</DropdownMenu.Item>
			<DropdownMenu.Separator />

			{#if worktrees.length > 0}
				<DropdownMenu.Label>Worktrees</DropdownMenu.Label>
				{#each worktrees as worktree (worktree.path)}
					<DropdownMenu.Item
						class="gap-2"
						onclick={() => {
							// A worktree is a directory, not a branch: opening one
							// means starting a session there, which is what the
							// dashboard's worktree dispatch does.
							if (!worktree.current)
								void run('opening worktree', () =>
									onworktree(worktree.label ?? worktree.branch ?? 'worktree')
								);
						}}
					>
						<FolderGit2Icon class="size-3.5 shrink-0 text-ink-tertiary" />
						<span class="flex min-w-0 flex-col">
							<span class="truncate">{worktree.label ?? worktree.branch ?? worktree.path}</span>
							<span class="truncate font-mono text-[10.5px] text-ink-tertiary">
								{worktree.branch ?? worktree.path}
							</span>
						</span>
						{#if worktree.current}
							<CheckIcon class="ml-auto size-3.5 shrink-0 text-olive" />
						{/if}
					</DropdownMenu.Item>
				{/each}
				<DropdownMenu.Separator />
			{/if}

			{#if worktreeOpen}
				<!-- The dialog is portalled, so nothing renders inline here; the
				     flag only guards against opening it twice. -->
			{:else}
				<DropdownMenu.Item disabled={!git} onclick={() => (worktreeOpen = true)}>
					<PlusIcon class="size-3.5" />
					<span class="flex min-w-0 flex-col">
						<span>New worktree…</span>
						<span class="text-[10.5px] text-ink-tertiary">
							{git ? `from ${context.branch ?? 'HEAD'}` : 'needs a git repository'}
						</span>
					</span>
				</DropdownMenu.Item>
			{/if}

			<DropdownMenu.Item onclick={() => onrefreshgit()}>
				<RefreshCwIcon class="size-3.5" />
				Refresh repository
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					class="flex h-6 items-center gap-1.5 rounded-md px-1.5 font-mono text-[11.5px] text-ink-secondary transition-colors hover:bg-paper-card hover:text-ink"
					aria-label={`Branch: ${context.branch ?? 'unknown'}`}
				>
					<GitBranchIcon class="size-3 text-ink-tertiary" />
					<span class="max-w-48 truncate">{context.branch ?? 'no branch'}</span>
					{#if pending}
						<span class="text-[10px] text-ink-tertiary">{pending}…</span>
					{/if}
					<ChevronDownIcon class="size-3 text-ink-tertiary" />
				</button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" side="top" class="max-h-80 w-64 overflow-y-auto">
			<DropdownMenu.Label>Branch</DropdownMenu.Label>
			<DropdownMenu.Item disabled class="font-mono text-[11.5px]">
				{context.branch ?? 'no branch'}
			</DropdownMenu.Item>
			<DropdownMenu.Separator />

			{#if creating}
				<div class="flex items-center gap-1 px-2 py-1.5">
					<input
						bind:this={branchInput}
						bind:value={branchDraft}
						class="min-w-0 flex-1 rounded border border-line bg-paper px-1.5 py-1 font-mono text-[11px] text-ink outline-none focus:border-olive/60"
						placeholder="new-branch"
						aria-label="New branch name"
						onkeydown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								commitCreate();
							} else if (event.key === 'Escape') {
								event.preventDefault();
								creating = false;
							}
						}}
					/>
					<button
						type="button"
						class="flex size-5 items-center justify-center rounded text-olive hover:bg-paper-card"
						aria-label="Create branch"
						onclick={commitCreate}
					>
						<CheckIcon class="size-3.5" />
					</button>
				</div>
			{:else}
				<DropdownMenu.Item disabled={!git} onclick={beginCreate}>
					<PlusIcon class="size-3.5" />
					New branch from {context.branch ?? 'HEAD'}…
				</DropdownMenu.Item>
			{/if}

			{#if local.length > 0}
				<DropdownMenu.Separator />
				<DropdownMenu.Label>Local</DropdownMenu.Label>
				{#each local as branch (branch.name)}
					<DropdownMenu.Item
						class="gap-2 font-mono text-[11.5px]"
						onclick={() => {
							if (branch.current) return;
							void run(`switching to ${branch.name}`, () => onbranch(branch.name));
						}}
					>
						<GitBranchIcon class="size-3.5 shrink-0 text-ink-tertiary" />
						<span class="truncate">{branch.name}</span>
						{#if branch.current}
							<CheckIcon class="ml-auto size-3.5 shrink-0 text-olive" />
						{/if}
					</DropdownMenu.Item>
				{/each}
			{/if}

			{#if remote.length > 0}
				<DropdownMenu.Separator />
				<DropdownMenu.Label>Remote</DropdownMenu.Label>
				{#each remote as branch (branch.name)}
					<DropdownMenu.Item
						class="gap-2 font-mono text-[11.5px]"
						onclick={() => void run(`tracking ${branch.name}`, () => onbranch(branch.name, true))}
					>
						<GitBranchIcon class="size-3.5 shrink-0 text-ink-tertiary/60" />
						<span class="truncate text-ink-secondary">{branch.name}</span>
					</DropdownMenu.Item>
				{/each}
			{/if}

			{#if branches.length === 0}
				<DropdownMenu.Item disabled class="text-[11px] text-ink-tertiary">
					{git ? 'Reading branches…' : 'Not a git repository'}
				</DropdownMenu.Item>
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>

<WorktreeDialog
	bind:open={worktreeOpen}
	{git}
	branch={context.branch}
	oncreate={(label, ref) => void run(`creating ${label}`, () => onworktree(label, ref))}
/>
