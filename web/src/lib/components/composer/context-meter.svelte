<script lang="ts">
	import { formatPercent, formatTokens } from '#lib/harness/format.js';
	import { contextCells, contextRows, MATRIX_COLUMNS } from '#lib/harness/context-usage.js';
	import type { ContextUsage } from '#lib/harness/types.js';
	import * as HoverCard from '#lib/components/ui/hover-card/index.js';

	/**
	 * Context usage, opened from the composer's ring.
	 *
	 * The panel follows the reference's shape — a headline figure, a square
	 * matrix, a legend with one row per measured category, and the remainder
	 * at the foot. The rows are not the reference's: they are the categories
	 * `ContextInfo` actually reports. The agent measures the system prompt,
	 * the tool definitions, and all non-system conversation items as one
	 * estimate, so files and memory have no separate figure here.
	 *
	 * Two figures move at different rates. `used` streams in on every frame
	 * (`_meta.totalTokens`, the same source the TUI's context bar reads), so the
	 * ring and the percentage are live. The itemized breakdown — system prompt,
	 * tool definitions, the turn and tool-call counters — is only in the
	 * snapshot, so opening the panel re-reads `alnair/session/info` rather than
	 * showing whatever the attach happened to capture.
	 */
	let {
		usage,
		onopen,
		/** Where the meter turns amber; the dialog's own setting. */
		thresholdPercent
	}: {
		usage: ContextUsage;
		/** Re-read the exact snapshot; called when the panel opens. */
		onopen?: () => void;
		thresholdPercent?: number;
	} = $props();

	/**
	 * Whether the agent has reported a window yet.
	 *
	 * A store that has attached but not yet read `alnair/session/info` carries
	 * zeroes. Rendering "0%" of a 0-token window would claim the conversation
	 * is empty; a dash says the truth, which is that nothing is known yet.
	 */
	const known = $derived(usage.limit > 0);

	const percent = $derived(usage.limit === 0 ? 0 : (usage.used / usage.limit) * 100);

	/**
	 * The warning point.
	 *
	 * Two different numbers, and both matter: `autoCompactThresholdPercent` is
	 * where the AGENT will compact (reported by the wire), while the setting is
	 * where the READER wants to be warned. The meter colours at whichever comes
	 * first, so raising the agent's threshold cannot silently remove the
	 * warning, and lowering the reader's can warn earlier than the agent acts.
	 */
	const warnAt = $derived(
		thresholdPercent === undefined
			? usage.autoCompactThresholdPercent
			: Math.min(thresholdPercent, usage.autoCompactThresholdPercent)
	);

	const tone = $derived(
		percent > 90 ? 'text-error' : percent > warnAt ? 'text-plan' : 'text-ink-secondary'
	);
	const stroke = $derived(
		percent > 90 ? 'stroke-error' : percent > warnAt ? 'stroke-plan' : 'stroke-running'
	);
	const remaining = $derived(Math.max(0, usage.limit - usage.used));

	// A 12-unit circle: 2πr with r = 5.5, so the dash array is exact.
	const RADIUS = 5.5;
	const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
	const filled = $derived(Math.min(1, percent / 100) * CIRCUMFERENCE);

	/**
	 * The legend, in the order the agent accounts for the window. `overhead`
	 * is what the wire does not itemize: anything used beyond the system
	 * prompt, the tool definitions, and the conversation estimate — which is
	 * exactly where the itemized rows (skills, MCP) are counted from.
	 */
	const rows = $derived(contextRows(usage));

	/**
	 * One cell is one percent: 20 × 5 = 100. `null` is free space.
	 */
	const cells = $derived(contextCells(usage, rows));

	/** What the agent will act on; the label says "auto-compact", so it is
	 *  the agent's figure, not the reader's warning point. */
	const threshold = $derived(usage.autoCompactThresholdPercent);
</script>

<HoverCard.Root>
	<HoverCard.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="flex h-7 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-paper-card"
				aria-label={known
					? `Context ${formatPercent(percent / 100)} used`
					: 'Context usage unknown'}
				onmouseenter={() => onopen?.()}
				onfocus={() => onopen?.()}
			>
				<span class={['tabular font-mono text-[11.5px]', known ? tone : 'text-ink-tertiary']}>
					{known ? formatPercent(percent / 100) : '—'}
				</span>
				<svg viewBox="0 0 14 14" class="size-3.5 -rotate-90" aria-hidden="true">
					<circle
						cx="7"
						cy="7"
						r={RADIUS}
						fill="none"
						stroke-width="1.6"
						class="stroke-line-strong"
					/>
					<circle
						cx="7"
						cy="7"
						r={RADIUS}
						fill="none"
						stroke-width="1.6"
						stroke-linecap="round"
						class={stroke}
						stroke-dasharray="{filled} {CIRCUMFERENCE}"
					/>
				</svg>
			</button>
		{/snippet}
	</HoverCard.Trigger>

	<HoverCard.Content class="w-[22rem] p-0">
		<div class="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
			<p class="text-[12.5px] font-medium">Context window</p>
			<span class="rounded-sm bg-paper-card px-1.5 py-0.5 font-mono text-[10px] text-ink-tertiary">
				auto-compact {threshold}%
			</span>
		</div>

		<div class="px-3.5 pt-2.5">
			{#if !known}
				<p class="py-4 text-center text-[12px] text-ink-tertiary">
					The agent has not reported this session's context window yet.
				</p>
			{:else}
				<div class="flex items-baseline gap-1.5">
					<span class="tabular text-[22px] leading-none font-semibold text-ink">
						{formatTokens(usage.used)}
					</span>
					<span class="text-[11.5px] text-ink-tertiary">of {formatTokens(usage.limit)} tokens</span>
					<span
						class={[
							'ml-auto rounded-sm px-1.5 py-0.5 font-mono text-[11px]',
							percent > 90
								? 'bg-error/10 text-error'
								: percent > warnAt
									? 'bg-plan/10 text-plan'
									: 'bg-paper-card text-ink-secondary'
						]}
					>
						{formatPercent(percent / 100)}
					</span>
				</div>

				<!-- The matrix: one cell per percent, filled in legend order. -->
				<div
					class="mt-2.5 grid w-full gap-[3px]"
					style="grid-template-columns: repeat({MATRIX_COLUMNS}, minmax(0, 1fr))"
					aria-hidden="true"
				>
					{#each cells as cell, index (index)}
						<span class={['aspect-square rounded-[2px]', cell ?? 'bg-line/50']}></span>
					{/each}
				</div>

				<ul class="mt-3 flex flex-col gap-1.5">
					{#each rows as row (row.label)}
						<li class="flex items-baseline gap-2">
							<span class={['size-2 shrink-0 translate-y-px rounded-[2px]', row.tone]}></span>
							<span class="text-[12px] text-ink-secondary">{row.label}</span>
							{#if row.detail}
								<span class="truncate font-mono text-[10px] text-ink-tertiary/70">{row.detail}</span
								>
							{/if}
							<span class="tabular ml-auto shrink-0 font-mono text-[11.5px] text-ink-secondary">
								{formatTokens(row.tokens)}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="mt-3 flex items-center justify-between gap-2 border-t border-line px-3 py-2">
			<span class="tabular font-mono text-[11px] text-plan">
				{known ? `${formatTokens(remaining)} free` : '—'}
			</span>
			<span class="font-mono text-[10px] text-ink-tertiary/70">
				{usage.turnCount} turns · {usage.toolCallCount} tools
				{#if usage.compactionCount > 0}
					· {usage.compactionCount} compactions
				{/if}
			</span>
		</div>
	</HoverCard.Content>
</HoverCard.Root>
