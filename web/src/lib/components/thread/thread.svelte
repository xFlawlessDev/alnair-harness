<script lang="ts">
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { tick } from 'svelte';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as MessageScroller from '#lib/components/ui/message-scroller/index.js';
	import { DEFAULT_VIEW_PREFS } from '#lib/harness/view-prefs.js';
	import type { Session, Turn, ViewPrefs } from '#lib/harness/types.js';
	import TurnView from './turn-view.svelte';

	let {
		session,
		turns,
		busy,
		suggestions,
		onsuggest,
		revealId,
		onrevealed,
		prefs = DEFAULT_VIEW_PREFS,
		onopenfile
	}: {
		session: Session;
		turns: Turn[];
		busy: boolean;
		/** Starter prompts for the empty state; empty hides that block. */
		suggestions: string[];
		onsuggest: (text: string) => void;
		/**
		 * A part the inspector asked to show.
		 *
		 * The thread owns the scroll container, so "show in thread" is a
		 * request here rather than a scroll the panel could perform itself.
		 * The turn holding that part is expanded — a row inside a collapsed
		 * work block is not on screen to scroll to — and then scrolled into
		 * view.
		 */
		revealId?: string;
		/** Called once the reveal has been applied, so it can fire again. */
		onrevealed?: () => void;
		/** What each row renders with, projected from the settings registry. */
		prefs?: ViewPrefs;
		/** Open a changed file in the editor panel. */
		onopenfile?: (path: string) => void;
	} = $props();

	const lastAssistantId = $derived(
		[...turns].reverse().find((turn) => turn.role === 'assistant')?.id
	);

	/**
	 * Whether a turn is still producing output.
	 *
	 * Only the last assistant turn can be live. Two things keep it live: the
	 * agent is still working, or a backgrounded command it started is still
	 * running. A backgrounded command alone does not make the turn stream once
	 * the agent has spoken its last word — the answer already landed, and
	 * painting a live indicator over it is the "never finishes" symptom.
	 */
	function isStreaming(turn: Turn): boolean {
		if (!busy) return false;
		if (turn.id !== lastAssistantId) return false;
		const hasRunningBackground = turn.parts.some(
			(part) =>
				'backgrounded' in part &&
				part.backgrounded === true &&
				'status' in part &&
				part.status === 'running'
		);
		if (!hasRunningBackground) return true;
		// The agent has finished talking: the turn reads as complete even
		// though the background task keeps running.
		return turn.parts[turn.parts.length - 1]?.kind !== 'text';
	}

	/** The turn that owns a part, so a reveal can open it before scrolling. */
	function turnOf(partId: string): string | undefined {
		return turns.find((turn) => turn.parts.some((part) => part.id === partId))?.id;
	}

	/** The turn a pending reveal points at; it renders itself expanded. */
	let revealTurn = $state<string | undefined>(undefined);
	/**
	 * A counter bumped on every reveal, so a repeat opens the turn again.
	 *
	 * `revealTurn` alone is not enough: revealing a second row in the SAME turn
	 * would set the same value, nothing would change, and a turn the reader had
	 * since collapsed would stay collapsed with the jump landing on a row that
	 * is not rendered. A fresh token makes the disclosure re-open.
	 */
	let revealTick = $state(0);

	/**
	 * Scroll to a revealed part's turn, expanding its folded work.
	 *
	 * The scroll target is the TURN, not the part: a part's own row can be
	 * nested inside a collapsed `<details>`, and there is nothing on screen to
	 * scroll to until that opens. Marking the turn lets `TurnView` render it
	 * open, and the frame after that is when the element exists.
	 */
	$effect(() => {
		const id = revealId;
		if (!id) return;
		const turnId = turnOf(id);
		if (turnId === undefined) {
			onrevealed?.();
			return;
		}
		revealTurn = turnId;
		revealTick += 1;

		void tick().then(() =>
			requestAnimationFrame(() => {
				const target = document.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
				target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
				// The turn stays expanded after the jump: the reader asked to see
				// this row, and folding it back the moment it scrolled into view
				// would hide the thing they asked for.
				onrevealed?.();
			})
		);
	});
</script>

<MessageScroller.Provider autoScroll defaultScrollPosition="end">
	<MessageScroller.Root>
		<MessageScroller.Viewport>
			<MessageScroller.Content
				class="mx-auto w-full max-w-3xl px-6 py-8 {prefs.density === 'compact' ? 'gap-4' : 'gap-7'}"
			>
				{#if turns.length === 0}
					<Empty.Root class="border-none bg-transparent py-16">
						<Empty.Header>
							<Empty.Media variant="icon" class="bg-paper-card text-ink">
								<SparklesIcon />
							</Empty.Media>
							<Empty.Title class="text-base">Nothing in this thread yet</Empty.Title>
							<Empty.Description>
								{session.cwd}{session.branch ? ` · ${session.branch}` : ''}
							</Empty.Description>
						</Empty.Header>
						{#if suggestions.length > 0}
							<Empty.Content>
								<div class="flex flex-wrap justify-center gap-1.5">
									{#each suggestions as suggestion (suggestion)}
										<button
											type="button"
											class="rounded-full border border-line bg-paper-raised px-3 py-1.5 text-[12px] text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
											onclick={() => onsuggest(suggestion)}
										>
											{suggestion}
										</button>
									{/each}
								</div>
							</Empty.Content>
						{/if}
					</Empty.Root>
				{:else}
					{#each turns as turn (turn.id)}
						<MessageScroller.Item messageId={turn.id} scrollAnchor={turn.role === 'user'}>
							{#snippet child({ props })}
								<div {...props} data-turn-id={turn.id}>
									<TurnView
										{turn}
										{prefs}
										{onopenfile}
										streaming={isStreaming(turn)}
										forcedOpen={revealTurn === turn.id ? revealTick : undefined}
									/>
								</div>
							{/snippet}
						</MessageScroller.Item>
					{/each}
				{/if}
			</MessageScroller.Content>
		</MessageScroller.Viewport>
		<MessageScroller.Button>
			<ArrowDownIcon />
			<span class="sr-only">Scroll to latest</span>
		</MessageScroller.Button>
	</MessageScroller.Root>
</MessageScroller.Provider>
