<script lang="ts">
	import BotIcon from '@lucide/svelte/icons/bot';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { formatTokens } from '#lib/harness/format.js';
	import { subagentSummaryLabel } from '#lib/harness/subagents.js';
	import type { SubagentSummary } from '#lib/harness/types.js';
	import StatusDot from './status-dot.svelte';

	/**
	 * The subagent list, opened from the header beside the session title.
	 *
	 * It is a glance, not a control panel: one row per subagent with its state
	 * and cost, and clicking a row opens the detail dialog. The list reads
	 * `alnair/subagent/list_running`; the dialog reads `alnair/subagent/get`.
	 */
	let {
		subagents,
		onselect
	}: {
		subagents: SubagentSummary[];
		onselect: (subagent: SubagentSummary) => void;
	} = $props();

	/**
	 * The dialog opens over the popover, so the popover closes itself first:
	 * leaving it open puts two overlapping surfaces on screen and the reader
	 * loses track of which one is active.
	 */
	let open = $state(false);

	const label = $derived(subagentSummaryLabel(subagents));
	const running = $derived(subagents.some((subagent) => subagent.status === 'running'));

	const tone: Record<SubagentSummary['status'], string> = {
		running: 'text-running',
		completed: 'text-success',
		failed: 'text-error',
		cancelled: 'text-ink-tertiary'
	};
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-2 text-[11px] font-normal text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
				aria-label={label ? `Subagents: ${label}` : 'Subagents'}
			>
				<BotIcon class="size-3 text-system" />
				<span class="tabular font-mono">{subagents.length}</span>
				{#if running}
					<StatusDot status="running" pulse class="shrink-0" />
				{/if}
				<ChevronDownIcon class="size-3 text-ink-tertiary" />
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="start" class="w-[22rem] gap-0 p-0">
		<div class="flex items-center justify-between border-b border-line px-3 py-2">
			<p class="text-[11px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">Subagents</p>
			<span class="font-mono text-[10px] text-ink-tertiary/70">{label ?? 'none'}</span>
		</div>

		{#if subagents.length === 0}
			<p class="px-3 py-4 text-[12px] text-ink-tertiary">
				This session has not spawned a subagent.
			</p>
		{:else}
			<ul class="max-h-72 overflow-y-auto py-1">
				{#each subagents as subagent (subagent.id)}
					<li>
						<button
							type="button"
							class="flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-paper-card"
							onclick={() => {
								open = false;
								onselect(subagent);
							}}
						>
							<span class="flex items-center gap-1.5">
								<StatusDot
									status={subagent.status === 'running'
										? 'running'
										: subagent.status === 'failed'
											? 'error'
											: subagent.status === 'cancelled'
												? 'idle'
												: 'complete'}
									pulse={subagent.status === 'running'}
									class="shrink-0"
								/>
								<span class="min-w-0 flex-1 truncate text-[12px] text-ink">
									{subagent.description}
								</span>
								<span class={['shrink-0 font-mono text-[9.5px]', tone[subagent.status]]}>
									{subagent.status}
								</span>
							</span>
							<span class="flex items-center gap-1.5 pl-3.5 text-[10px] text-ink-tertiary">
								<span class="rounded-sm bg-paper px-1 font-mono text-[9px]">
									{subagent.agent}
								</span>
								<span class="text-ink-tertiary/40">·</span>
								<span class="tabular">{subagent.turnCount} turns</span>
								<span class="text-ink-tertiary/40">·</span>
								<span class="tabular">{subagent.toolCallCount} tools</span>
								<span class="text-ink-tertiary/40">·</span>
								<span class="tabular">{formatTokens(subagent.tokensUsed)}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</Popover.Content>
</Popover.Root>
