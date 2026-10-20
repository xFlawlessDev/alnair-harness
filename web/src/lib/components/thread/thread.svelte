<script lang="ts">
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as MessageScroller from '#lib/components/ui/message-scroller/index.js';
	import type { Session, Turn } from '#lib/harness/types.js';
	import TurnView from './turn-view.svelte';

	let {
		session,
		turns,
		busy,
		suggestions,
		onsuggest
	}: {
		session: Session;
		turns: Turn[];
		busy: boolean;
		suggestions: string[];
		onsuggest: (text: string) => void;
	} = $props();

	const lastAssistantId = $derived(
		[...turns].reverse().find((turn) => turn.role === 'assistant')?.id
	);
</script>

<MessageScroller.Provider autoScroll defaultScrollPosition="end">
	<MessageScroller.Root>
		<MessageScroller.Viewport>
			<MessageScroller.Content class="mx-auto w-full max-w-3xl gap-7 px-6 py-8">
				{#if turns.length === 0}
					<Empty.Root class="border-none bg-transparent py-16">
						<Empty.Header>
							<Empty.Media variant="icon" class="bg-paper-card text-ink">
								<SparklesIcon />
							</Empty.Media>
							<Empty.Title class="text-base">Nothing in this thread yet</Empty.Title>
							<Empty.Description>
								{session.cwd} · {session.branch}
							</Empty.Description>
						</Empty.Header>
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
					</Empty.Root>
				{:else}
					{#each turns as turn (turn.id)}
						<MessageScroller.Item messageId={turn.id} scrollAnchor={turn.role === 'user'}>
							{#snippet child({ props })}
								<div {...props}>
									<TurnView {turn} streaming={busy && turn.id === lastAssistantId} />
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
