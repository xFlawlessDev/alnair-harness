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
	 */
	let { usage }: { usage: ContextUsage } = $props();

	const percent = $derived(usage.limit === 0 ? 0 : (usage.used / usage.limit) * 100);
	const tone = $derived(
		percent > 90
			? 'text-error'
			: percent > usage.autoCompactThresholdPercent
				? 'text-plan'
				: 'text-ink-secondary'
	);
	const stroke = $derived(
		percent > 90
			? 'stroke-error'
			: percent > usage.autoCompactThresholdPercent
				? 'stroke-plan'
				: 'stroke-running'
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

	const threshold = $derived(usage.autoCompactThresholdPercent);
</script>

<HoverCard.Root>
	<HoverCard.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="flex h-7 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-paper-card"
				aria-label={`Context ${formatPercent(percent / 100)} used`}
			>
				<span class={['tabular font-mono text-[11.5px]', tone]}>
					{formatPercent(percent / 100)}
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
							: percent > threshold
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
							<span class="truncate font-mono text-[10px] text-ink-tertiary/70">{row.detail}</span>
						{/if}
						<span class="tabular ml-auto shrink-0 font-mono text-[11.5px] text-ink-secondary">
							{formatTokens(row.tokens)}
						</span>
					</li>
				{/each}
			</ul>
		</div>

		<div class="mt-3 flex items-center justify-between gap-2 border-t border-line px-3 py-2">
			<span class="tabular font-mono text-[11px] text-plan">
				{formatTokens(remaining)} free
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
