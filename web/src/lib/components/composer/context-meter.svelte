<script lang="ts">
	import { formatPercent, formatTokens } from '#lib/harness/format.js';
	import type { ContextUsage } from '#lib/harness/types.js';
	import * as HoverCard from '#lib/components/ui/hover-card/index.js';

	let { usage, class: className }: { usage: ContextUsage; class?: string } = $props();

	const tones = ['bg-system', 'bg-assistant', 'bg-olive', 'bg-terra', 'bg-running', 'bg-verify'];

	const percent = $derived((usage.used / usage.limit) * 100);
	const tone = $derived(
		percent > 90 ? 'text-error' : percent > 70 ? 'text-plan' : 'text-ink-secondary'
	);
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
				aria-label={`Context ${formatPercent(usage.used, usage.limit)} used`}
			>
				<span class="flex h-1.5 w-16 overflow-hidden rounded-full bg-line" aria-hidden="true">
					{#each usage.segments as segment, index (segment.label)}
						{@const width = (segment.tokens / usage.limit) * 100}
						<span class={tones[index % tones.length]} style="width: {width}%"></span>
					{/each}
				</span>
				<span class={['tabular', tone]}>{formatPercent(usage.used, usage.limit)}</span>
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
		<ul class="mt-3 flex flex-col gap-1.5">
			{#each usage.segments as segment, index (segment.label)}
				<li class="flex items-center gap-2 text-[12px]">
					<span class={['size-2 rounded-[2px]', tones[index % tones.length]]}></span>
					<span class="text-ink-secondary">{segment.label}</span>
					<span class="tabular ml-auto font-mono text-[11px] text-ink-tertiary">
						{formatTokens(segment.tokens)}
					</span>
				</li>
			{/each}
		</ul>
		<p class="mt-3 border-t border-line pt-2 text-[11px] text-ink-tertiary">
			{formatTokens(usage.limit - usage.used)} tokens left before compaction
		</p>
	</HoverCard.Content>
</HoverCard.Root>
