<script lang="ts">
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitForkIcon from '@lucide/svelte/icons/git-fork';
	import GitCommitHorizontalIcon from '@lucide/svelte/icons/git-commit-horizontal';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import type { ComposerContext } from '#lib/harness/types.js';

	/**
	 * The row under the prompt: where the code is checked out and which branch.
	 *
	 * Both are read-only affordances for now. They name the session's real
	 * checkout, so the row is honest about the state even before the actions
	 * behind the menus exist.
	 */
	let { context }: { context: ComposerContext } = $props();

	const checkoutLabel: Record<ComposerContext['checkout'], string> = {
		branch: 'Current checkout',
		worktree: 'Worktree checkout',
		detached: 'Detached HEAD'
	};

	const CheckoutIcon = $derived(
		context.checkout === 'worktree' ? GitForkIcon : GitCommitHorizontalIcon
	);
</script>

<div
	class="mt-1.5 flex items-center justify-between gap-3 rounded-lg border border-line bg-paper-raised/60 px-2 py-1"
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
		<DropdownMenu.Content align="start" side="top" class="w-56">
			<DropdownMenu.Label>Checkout</DropdownMenu.Label>
			<DropdownMenu.Item disabled>{checkoutLabel[context.checkout]}</DropdownMenu.Item>
			<DropdownMenu.Separator />
			<DropdownMenu.Item disabled class="text-[11.5px] text-ink-tertiary">
				Creating a worktree lands with the socket adapter.
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
					<ChevronDownIcon class="size-3 text-ink-tertiary" />
				</button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" side="top" class="w-56">
			<DropdownMenu.Label>Branch</DropdownMenu.Label>
			<DropdownMenu.Item disabled class="font-mono text-[11.5px]">
				{context.branch ?? 'no branch'}
			</DropdownMenu.Item>
			<DropdownMenu.Separator />
			<DropdownMenu.Item disabled class="text-[11.5px] text-ink-tertiary">
				Switching branches lands with the socket adapter.
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>
