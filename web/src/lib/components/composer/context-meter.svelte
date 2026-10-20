<script lang="ts">
	import { formatPercent, formatTokens } from '#lib/harness/format.js';
	import type { ContextUsage } from '#lib/harness/types.js';
	import * as HoverCard from '#lib/components/ui/hover-card/index.js';

	/**
	 * The compact form of the context meter: a percentage and a ring, as in the
	 * reference. The wire reports how much of the window is used, not what is
	 * in it, so there is no per-category breakdown to draw.
	 */
	let { usage }: { usage: ContextUsage } = $props();

	const percent = $derived(usage.limit === 0 ? 0 : (usage.used / usage.limit) * 100);
	const tone = $derived(
		percent > 90 ? 'text-error' : percent > 70 ? 'text-plan' : 'text-ink-secondary'
	);
	const stroke = $derived(
		percent > 90 ? 'stroke-error' : percent > 70 ? 'stroke-plan' : 'stroke-running'
	);
	const remaining = $derived(Math.max(0, usage.limit - usage.used));

	// A 12-unit circle: 2πr with r = 5.5, so the dash array is exact.
	const RADIUS = 5.5;
	const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
	const filled = $derived(Math.min(1, percent / 100) * CIRCUMFERENCE);
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
				<span class={['tabular font-mono text-[11.5px]', tone]}>{formatPercent(percent / 100)}</span
				>
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
	<HoverCard.Content class="w-64">
		<div class="flex items-baseline justify-between">
			<p class="text-[13px] font-medium">Context window</p>
			<p class="tabular font-mono text-[11px] text-ink-tertiary">
				{formatTokens(usage.used)} / {formatTokens(usage.limit)}
			</p>
		</div>
		<span class="mt-2 flex h-1.5 overflow-hidden rounded-full bg-line">
			<span
				class={percent > 90 ? 'bg-error' : percent > 70 ? 'bg-plan' : 'bg-running'}
				style="width: {Math.min(100, percent)}%"
			></span>
		</span>
		<p class="mt-3 border-t border-line pt-2 text-[11px] text-ink-tertiary">
			{formatTokens(remaining)} tokens left before compaction
		</p>
	</HoverCard.Content>
</HoverCard.Root>
