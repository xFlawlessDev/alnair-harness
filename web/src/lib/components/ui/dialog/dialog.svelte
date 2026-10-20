<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';

	/**
	 * `open` is bindable so a caller can close the dialog from its own state —
	 * the sidebar's button opens it, and the dialog writes back on Escape.
	 */
	let {
		open = $bindable(false),
		onOpenChange,
		children,
		...restProps
	}: DialogPrimitive.RootProps = $props();
</script>

<DialogPrimitive.Root bind:open {onOpenChange} {...restProps}>
	{@render children?.()}
</DialogPrimitive.Root>
