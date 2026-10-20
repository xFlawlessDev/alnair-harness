<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import RefreshCcwIcon from '@lucide/svelte/icons/refresh-ccw';
	import { onDestroy } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { formatDuration } from '#lib/harness/format.js';
	import type { Turn } from '#lib/harness/types.js';

	let { turn, onretry }: { turn: Turn; onretry?: () => void } = $props();

	const text = $derived(
		turn.parts
			.filter((part) => part.kind === 'text')
			.map((part) => part.text)
			.join('\n\n')
	);

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function copy() {
		void navigator.clipboard.writeText(text);
		copied = true;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 1_600);
	}

	onDestroy(() => clearTimeout(timer));
</script>

<div class="flex items-center gap-2.5 text-[11px] text-ink-tertiary">
	{#if turn.model}
		<span class="font-medium text-ink-secondary">{turn.model}</span>
		<span class="text-ink-tertiary/50">·</span>
	{/if}
	{#if turn.effort}
		<span class="font-mono">{turn.effort}</span>
		<span class="text-ink-tertiary/50">·</span>
	{/if}
	{#if turn.durationMs}
		<span class="tabular">{formatDuration(turn.durationMs)}</span>
	{/if}

	<div class="ml-1 flex items-center gap-0.5">
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon-xs"
						aria-label={copied ? 'Copied' : 'Copy reply'}
						class="text-ink-tertiary hover:text-ink"
						onclick={copy}
					>
						{#if copied}
							<CheckIcon />
						{:else}
							<CopyIcon />
						{/if}
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content><p>{copied ? 'Copied' : 'Copy reply'}</p></Tooltip.Content>
		</Tooltip.Root>

		{#if onretry}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-xs"
							aria-label="Retry"
							class="text-ink-tertiary hover:text-ink"
							onclick={onretry}
						>
							<RefreshCcwIcon />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content><p>Retry</p></Tooltip.Content>
			</Tooltip.Root>
		{/if}
	</div>
</div>
