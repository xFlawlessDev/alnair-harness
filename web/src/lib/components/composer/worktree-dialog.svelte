<script lang="ts">
	import GitForkIcon from '@lucide/svelte/icons/git-fork';
	import { tick } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import type { GitContext } from '#lib/harness/types.js';

	/**
	 * Create a worktree from the active session's checkout.
	 *
	 * A dialog rather than an inline field in the checkout menu: the menu closes
	 * on selection, and a text field inside one cannot be typed into reliably.
	 * The label becomes the worktree's directory name, which is what makes it
	 * findable later — an auto-generated one is a UUID.
	 */
	let {
		open = $bindable(false),
		git,
		branch,
		oncreate
	}: {
		open: boolean;
		git: GitContext | undefined;
		branch: string | undefined;
		oncreate: (label: string, gitRef?: string) => void;
	} = $props();

	let label = $state('');
	let ref = $state('');
	let input: HTMLInputElement | null = $state(null);

	// Reset each time the dialog opens, so a cancelled attempt does not leave a
	// stale label to accidentally confirm.
	$effect(() => {
		if (!open) return;
		label = '';
		ref = '';
		void tick().then(() => input?.focus());
	});

	function submit(event: SubmitEvent) {
		event.preventDefault();
		const name = label.trim();
		if (!name) return;
		open = false;
		oncreate(name, ref.trim() || undefined);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-md">
		<form onsubmit={submit} class="flex flex-col gap-4 p-5">
			<div class="flex items-start gap-2.5">
				<GitForkIcon class="mt-0.5 size-4 shrink-0 text-ink-tertiary" />
				<div class="min-w-0">
					<Dialog.Title class="text-[13.5px] font-medium">New worktree</Dialog.Title>
					<Dialog.Description class="mt-1 text-[11.5px] leading-relaxed text-ink-tertiary">
						Branches off <span class="font-mono">{branch ?? 'HEAD'}</span> and starts a session in the
						new checkout. The source repo stays untouched.
					</Dialog.Description>
				</div>
			</div>

			<label class="flex flex-col gap-1.5">
				<span class="text-[11px] font-medium text-ink-secondary">Label</span>
				<input
					bind:this={input}
					bind:value={label}
					class="rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-olive/60"
					placeholder="fix-flaky-test"
					aria-label="Worktree label"
					required
				/>
				<span class="text-[10.5px] text-ink-tertiary">
					Becomes the worktree's directory name.
				</span>
			</label>

			<label class="flex flex-col gap-1.5">
				<span class="text-[11px] font-medium text-ink-secondary">Base ref</span>
				<input
					bind:value={ref}
					class="rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-olive/60"
					placeholder={branch ?? 'HEAD'}
					aria-label="Base ref"
				/>
				<span class="text-[10.5px] text-ink-tertiary">
					Empty uses the current checkout. {git?.root ?? ''}
				</span>
			</label>

			<div class="flex justify-end gap-2">
				<Button type="button" variant="outline" size="sm" onclick={() => (open = false)}>
					Cancel
				</Button>
				<Button type="submit" size="sm" disabled={label.trim().length === 0}>Create worktree</Button
				>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
