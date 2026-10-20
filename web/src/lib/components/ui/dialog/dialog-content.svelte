<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import XIcon from '@lucide/svelte/icons/x';
	import { cn } from '#lib/utils.js';
	import DialogOverlay from './dialog-overlay.svelte';
	import DialogPortal from './dialog-portal.svelte';

	let {
		ref = $bindable(null),
		class: className,
		children,
		showCloseButton = true,
		...restProps
	}: DialogPrimitive.ContentProps & { showCloseButton?: boolean } = $props();
</script>

<DialogPortal>
	<DialogOverlay />
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(
			// No `sm:max-w-*` here: a responsive variant and an unprefixed
			// `max-w-*` are different keys to tailwind-merge, so both would
			// apply and the breakpoint would win. Callers own the max width.
			'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-0 overflow-hidden rounded-xl border border-line bg-popover shadow-2xl outline-none',
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		{#if showCloseButton}
			<DialogPrimitive.Close
				class="absolute top-3 right-3 flex size-6 items-center justify-center rounded-md text-ink-tertiary transition-colors hover:bg-paper-card hover:text-ink focus-visible:ring-2 focus-visible:ring-line-strong focus-visible:outline-none"
				aria-label="Close"
			>
				<XIcon class="size-3.5" />
			</DialogPrimitive.Close>
		{/if}
	</DialogPrimitive.Content>
</DialogPortal>
