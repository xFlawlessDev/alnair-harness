<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import XIcon from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';

	/**
	 * A slide-over panel, for the session list on a narrow window.
	 *
	 * The sidebar is `hidden md:flex`: below 768px there was no way to reach a
	 * session at all, which is fine for a page beside a terminal and not fine
	 * for the only surface a reader has. A sheet is the smallest honest answer —
	 * the same list, slid over the thread, dismissed by tapping the overlay.
	 *
	 * Built on `bits-ui`'s Dialog rather than a second primitive library: it
	 * already brings the focus trap, the Escape handling and the scroll lock
	 * that a hand-rolled drawer would have to reimplement (and get wrong).
	 */
	let {
		open = $bindable(false),
		title,
		children
	}: {
		open?: boolean;
		/** Screen-reader label; the panel itself is the content. */
		title: string;
		children: Snippet;
	} = $props();
</script>

<DialogPrimitive.Root bind:open>
	<DialogPrimitive.Portal>
		<DialogPrimitive.Overlay
			class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/40"
		/>
		<DialogPrimitive.Content
			class={cn(
				'data-[state=open]:animate-in data-[state=closed]:animate-out fixed inset-y-0 left-0 z-50 flex w-[min(17rem,86vw)] flex-col overflow-hidden bg-paper shadow-2xl outline-none',
				'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left'
			)}
		>
			<!-- The title is required by the primitive's accessibility contract,
			     but the sidebar already draws its own header. -->
			<DialogPrimitive.Title class="sr-only">{title}</DialogPrimitive.Title>
			<DialogPrimitive.Close
				class="absolute top-3 right-2 z-10 flex size-6 items-center justify-center rounded-md text-ink-tertiary transition-colors hover:bg-paper-card hover:text-ink focus-visible:ring-2 focus-visible:ring-line-strong focus-visible:outline-none"
				aria-label="Close the session list"
			>
				<XIcon class="size-3.5" />
			</DialogPrimitive.Close>
			{@render children()}
		</DialogPrimitive.Content>
	</DialogPrimitive.Portal>
</DialogPrimitive.Root>
