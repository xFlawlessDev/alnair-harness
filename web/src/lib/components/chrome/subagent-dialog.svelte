<script lang="ts">
	import BotIcon from '@lucide/svelte/icons/bot';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import Thread from '#lib/components/thread/thread.svelte';
	import { formatDuration, formatTokens } from '#lib/harness/format.js';
	import type { Session, SubagentSummary, Turn } from '#lib/harness/types.js';

	/**
	 * One subagent, opened as a conversation.
	 *
	 * A subagent is a session: the parent spawns a child with its own id, cwd,
	 * and `updates.jsonl`, and `alnair/session/updates` reads that file by id.
	 * So this view is the child's real transcript folded by the same reducer
	 * the main thread uses — not a summary of it. The header keeps the identity
	 * and cost; everything under it is the agent's own conversation.
	 */
	let {
		open = $bindable(false),
		subagent,
		turns,
		loading = false,
		error,
		session
	}: {
		open: boolean;
		/** `undefined` while nothing has been picked. */
		subagent: SubagentSummary | undefined;
		/** The child session's folded transcript. */
		turns: Turn[];
		loading?: boolean;
		error?: string;
		/** Identity for the thread's empty state. */
		session: Session;
	} = $props();

	const tone = $derived(
		subagent?.status === 'running'
			? 'text-running'
			: subagent?.status === 'completed'
				? 'text-success'
				: subagent?.status === 'failed'
					? 'text-error'
					: 'text-ink-tertiary'
	);

	const facts = $derived(
		subagent
			? [
					`${subagent.turnCount} turns`,
					`${subagent.toolCallCount} tools`,
					formatTokens(subagent.tokensUsed),
					`${subagent.contextUsagePct}% ctx`,
					formatDuration(subagent.durationMs) || '—'
				]
			: []
	);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="w-[min(56rem,94vw)] max-w-[min(56rem,94vw)]">
		{#if subagent}
			<header class="flex items-start gap-3 border-b border-line px-4 py-3 pr-10">
				<BotIcon class="mt-0.5 size-4 shrink-0 text-system" />
				<div class="flex min-w-0 flex-col gap-1">
					<Dialog.Title class="text-[13.5px]">{subagent.description}</Dialog.Title>
					<Dialog.Description
						class="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[10.5px]"
					>
						<span class="rounded-sm bg-paper-card px-1 py-0.5">{subagent.agent}</span>
						<span class={tone}>{subagent.status}</span>
						<span class="text-ink-tertiary/40">·</span>
						{#each facts as fact, index (fact)}
							{#if index > 0}
								<span class="text-ink-tertiary/40">·</span>
							{/if}
							<span class="tabular text-ink-tertiary">{fact}</span>
						{/each}
						{#if subagent.errorCount > 0}
							<span class="text-ink-tertiary/40">·</span>
							<span class="text-error">{subagent.errorCount} errors</span>
						{/if}
					</Dialog.Description>
				</div>
			</header>

			{#if subagent.failureError}
				<p class="border-b border-line bg-error/5 px-4 py-2 text-[11.5px] text-ink-secondary">
					{subagent.failureError}
				</p>
			{:else if subagent.cancelReason}
				<p class="border-b border-line px-4 py-2 text-[11.5px] text-ink-tertiary">
					Cancelled: {subagent.cancelReason}
				</p>
			{/if}

			<!-- The child's own conversation, rendered by the thread the main
			     view uses, so a subagent reads exactly like any other session. -->
			<div class="flex h-[min(34rem,74dvh)] min-h-0 flex-col">
				{#if error}
					<p role="status" class="px-4 py-2 text-[11.5px] text-error">{error}</p>
				{/if}
				{#if loading && turns.length === 0}
					<p role="status" class="px-4 py-8 text-center text-[12px] text-ink-tertiary">
						Loading conversation…
					</p>
				{:else if turns.length === 0 && !error}
					<p class="px-4 py-8 text-center text-[12px] text-ink-tertiary">
						This subagent has not written anything yet.
					</p>
				{:else if turns.length > 0}
					<Thread
						{session}
						{turns}
						busy={subagent.status === 'running'}
						suggestions={[]}
						onsuggest={() => {}}
					/>
				{/if}
			</div>

			{#if subagent.worktreePath || subagent.resumedFrom}
				<footer
					class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 font-mono text-[10px] text-ink-tertiary"
				>
					{#if subagent.worktreePath}
						<span class="truncate">worktree {subagent.worktreePath}</span>
					{/if}
					{#if subagent.resumedFrom}
						<span class="truncate">resumed from {subagent.resumedFrom}</span>
					{/if}
					<span class="ml-auto truncate text-ink-tertiary/60">{subagent.childSessionId}</span>
				</footer>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>
