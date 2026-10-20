<script lang="ts">
	import { formatPercent, formatTokens } from '#lib/harness/format.js';
	import type { ContextUsage } from '#lib/harness/types.js';
	import * as HoverCard from '#lib/components/ui/hover-card/index.js';

	/**
	 * The wire reports how much of the window is used, not what is in it, so
	 * the meter is a single bar. A per-category breakdown would be invented.
	 */
	let { usage, class: className }: { usage: ContextUsage; class?: string } = $props();

	const percent = $derived(usage.limit === 0 ? 0 : (usage.used / usage.limit) * 100);
	const tone = $derived(
		percent > 90 ? 'text-error' : percent > 70 ? 'text-plan' : 'text-ink-secondary'
	);
	const fill = $derived(percent > 90 ? 'bg-error' : percent > 70 ? 'bg-plan' : 'bg-running');
	const remaining = $derived(Math.max(0, usage.limit - usage.used));
</script>

<HoverCard.Root>
	<HoverCard.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class={[
					'flex items-center gap-2 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-paper-card',
					className
				]}
				aria-label={`Context ${formatPercent(usage.used / usage.limit)} used`}
			>
				<span class="flex h-1.5 w-16 overflow-hidden rounded-full bg-line" aria-hidden="true">
					<span class={fill} style="width: {Math.min(100, percent)}%"></span>
				</span>
				<span class={['tabular', tone]}>{formatPercent(usage.used / usage.limit)}</span>
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
			<span class={fill} style="width: {Math.min(100, percent)}%"></span>
		</span>
		<p class="mt-3 border-t border-line pt-2 text-[11px] text-ink-tertiary">
			{formatTokens(remaining)} tokens left before compaction
		</p>
	</HoverCard.Content>
</HoverCard.Root>
