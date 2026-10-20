<script lang="ts">
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Markdown from '#lib/components/thread/markdown-lazy.svelte';
	import { formatRelative } from '#lib/harness/format.js';
	import type { PlanDocument } from '#lib/harness/types.js';

	let { plan }: { plan: PlanDocument } = $props();

	let scroller: HTMLDivElement | null = $state(null);

	/**
	 * The focus scope would land on the first focusable element, which is the
	 * copy button inside the plan's code block — that scrolls the document to
	 * the middle before the reader has seen the top. Focus the scroller instead.
	 */
	function focusTop(event: Event) {
		event.preventDefault();
		scroller?.focus();
	}
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="sm"
				class="h-7 max-w-52 gap-1.5 rounded-full border border-line px-2 text-[11px] font-normal text-ink-secondary hover:border-line-strong hover:text-ink"
				aria-label={`Plan: ${plan.title}`}
			>
				<FileTextIcon class="size-3 shrink-0 text-plan" />
				<span class="truncate">{plan.title}</span>
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		align="end"
		class="w-[32rem] max-w-[calc(100vw-2rem)] gap-0 p-0"
		onOpenAutoFocus={focusTop}
	>
		<div class="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
			<div class="flex min-w-0 flex-col">
				<p class="truncate text-[12px] font-medium">{plan.title}</p>
				<p class="truncate font-mono text-[10px] text-ink-tertiary">{plan.path}</p>
			</div>
			<span class="tabular shrink-0 font-mono text-[10px] text-ink-tertiary">
				{formatRelative(plan.updatedAt)}
			</span>
		</div>
		<div
			bind:this={scroller}
			tabindex="-1"
			class="max-h-[26rem] scroll-fade-y scrollbar-thin overflow-y-auto px-4 py-3 outline-none"
		>
			<Markdown content={plan.markdown} />
		</div>
	</Popover.Content>
</Popover.Root>
