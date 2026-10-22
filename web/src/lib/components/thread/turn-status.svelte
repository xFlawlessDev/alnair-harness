<script lang="ts">
	import { onDestroy } from 'svelte';
	import { formatDuration, formatTokens } from '#lib/harness/format.js';
	import { resolveActivity } from '#lib/harness/activity.js';
	import type { Turn } from '#lib/harness/types.js';

	/**
	 * The live turn status, above the composer.
	 *
	 * The TUI's `turn_status.rs` answers one question that a transcript cannot:
	 * "is it working, and on what?". A browser tab that has just sent a prompt
	 * otherwise shows nothing until the first token arrives, which reads as a
	 * hung request. This row fills that gap with the same information — a pulse,
	 * what the agent is doing, how long this phase and the turn have taken, and
	 * a stop button.
	 *
	 * It is deliberately outside the scroller: it must not scroll away.
	 */
	let {
		turns,
		busy,
		blocked,
		contextUsed,
		oncancel
	}: {
		turns: Turn[];
		busy: boolean;
		/** A parked permission or question — the agent is waiting on the user. */
		blocked: boolean;
		contextUsed: number;
		oncancel: () => void;
	} = $props();

	/** A 1 Hz clock: both timers count seconds, so a faster tick buys nothing. */
	let now = $state(Date.now());
	const timer = setInterval(() => (now = Date.now()), 1_000);
	onDestroy(() => clearInterval(timer));

	const activity = $derived(
		blocked ? { kind: 'waiting' as const, label: 'Waiting for you' } : resolveActivity(turns, busy)
	);

	/** The open turn's start, so the turn timer survives a remount. */
	const turnStart = $derived.by(() => {
		const open = [...turns].reverse().find((turn) => turn.status === 'streaming');
		return open ? new Date(open.at).getTime() : undefined;
	});

	/**
	 * When the current phase began.
	 *
	 * Approximated from the last part's own arrival: parts carry no timestamp,
	 * so the open turn's start is the only honest anchor. A phase timer that
	 * restarted on every keystroke would be worse than one that reads the turn
	 * clock until the next phase boundary.
	 */
	const phaseStart = $derived(turnStart);
	const turnElapsed = $derived(turnStart === undefined ? undefined : now - turnStart);
	const phaseElapsed = $derived(phaseStart === undefined ? undefined : now - phaseStart);

	const blockedKind = $derived(activity?.kind === 'waiting' || activity?.kind === 'asking');
</script>

{#if activity && (busy || blocked)}
	<div
		class="mx-auto flex w-full max-w-3xl items-center gap-2 px-6 pb-1.5 text-[11.5px]"
		aria-live="polite"
		aria-label="Turn status"
		data-slot="turn-status"
	>
		<!--
			The pulse: three dots travelling left to right while work is moving,
			or one pulsing diamond when the agent is blocked on the reader. Two
			cues because they mean different things — "working" and "your turn".
		-->
		{#if blockedKind}
			<span class="shrink-0 animate-pulse text-terra" aria-hidden="true">◆</span>
		{:else}
			<span class="flex shrink-0 items-center gap-0.5" aria-hidden="true">
				<span class="size-1 animate-pulse rounded-full bg-running"></span>
				<span class="size-1 animate-pulse rounded-full bg-running [animation-delay:200ms]"></span>
				<span class="size-1 animate-pulse rounded-full bg-running [animation-delay:400ms]"></span>
			</span>
		{/if}

		<span class={['min-w-0 truncate', blockedKind ? 'text-terra' : 'text-ink-secondary']}>
			{activity.label}
		</span>

		{#if phaseElapsed !== undefined && !blockedKind && phaseElapsed > 1_000}
			<span class="tabular shrink-0 font-mono text-[10.5px] text-ink-tertiary">
				{formatDuration(phaseElapsed)}
			</span>
		{/if}

		<span class="ml-auto flex shrink-0 items-center gap-2">
			{#if contextUsed > 0}
				<span class="tabular font-mono text-[10.5px] text-ink-tertiary">
					↓{formatTokens(contextUsed)}
				</span>
			{/if}
			{#if turnElapsed !== undefined && turnElapsed > 1_000}
				<span class="tabular font-mono text-[10.5px] text-ink-tertiary">
					{formatDuration(turnElapsed)}
				</span>
			{/if}
			{#if busy}
				<button
					type="button"
					class="rounded-md px-1.5 py-0.5 font-mono text-[10.5px] text-error transition-colors hover:bg-error/10"
					onclick={oncancel}
				>
					[stop]
				</button>
			{/if}
		</span>
	</div>
{/if}
