<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import RefreshCcwIcon from '@lucide/svelte/icons/refresh-ccw';
	import XIcon from '@lucide/svelte/icons/x';
	import { onDestroy } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { copyText, downloadText, safeFilename } from '#lib/clipboard.js';
	import { formatDuration } from '#lib/harness/format.js';
	import type { Turn } from '#lib/harness/types.js';

	let {
		turn,
		onretry,
		showDuration = true
	}: {
		turn: Turn;
		onretry?: () => void;
		/**
		 * Whether this row prints the turn's duration.
		 *
		 * The collapsed work header already says "Worked for 1m 04s", so the
		 * meta line under the answer would be the second time the reader sees
		 * the same figure on the same screen.
		 */
		showDuration?: boolean;
	} = $props();

	const text = $derived(
		turn.parts
			.filter((part) => part.kind === 'text')
			.map((part) => part.text)
			.join('\n\n')
	);

	let copied = $state(false);
	let failed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		// `copyText`, not `navigator.clipboard`: the latter is undefined outside
		// a secure context, so the bare call threw inside the handler and the
		// button appeared dead. See `#lib/clipboard.ts`.
		const landed = await copyText(text);
		copied = landed;
		failed = !landed;
		clearTimeout(timer);
		timer = setTimeout(() => {
			copied = false;
			failed = false;
		}, 1_600);
	}

	/**
	 * Save the reply as Markdown.
	 *
	 * There was no download at all before — this is the feature, not a repair.
	 * The reply is the part worth keeping, so the file holds the text parts and
	 * nothing else; a transcript of tool rows belongs in the session, which
	 * already has one on disk.
	 */
	function download() {
		const title = safeFilename(turn.modelId ? `reply-${turn.modelId}` : 'reply', 'reply');
		downloadText(`${title}.md`, text, 'text/markdown');
	}

	onDestroy(() => clearTimeout(timer));
</script>

<div class="flex items-center gap-2.5 text-[11px] text-ink-tertiary">
	{#if turn.modelId}
		<span class="font-medium text-ink-secondary">{turn.modelId}</span>
		<span class="text-ink-tertiary/50">·</span>
	{/if}
	{#if turn.effort}
		<span class="font-mono">{turn.effort}</span>
		<span class="text-ink-tertiary/50">·</span>
	{/if}
	{#if showDuration && turn.durationMs}
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
						aria-label={failed ? 'Copy failed' : copied ? 'Copied' : 'Copy reply'}
						class="text-ink-tertiary hover:text-ink {failed ? 'text-error' : ''}"
						onclick={() => void copy()}
					>
						{#if failed}
							<XIcon />
						{:else if copied}
							<CheckIcon />
						{:else}
							<CopyIcon />
						{/if}
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>
				<p>{failed ? 'Could not copy — the browser refused' : copied ? 'Copied' : 'Copy reply'}</p>
			</Tooltip.Content>
		</Tooltip.Root>

		{#if text}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-xs"
							aria-label="Download reply as Markdown"
							class="text-ink-tertiary hover:text-ink"
							onclick={download}
						>
							<DownloadIcon />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content><p>Download as Markdown</p></Tooltip.Content>
			</Tooltip.Root>
		{/if}

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
