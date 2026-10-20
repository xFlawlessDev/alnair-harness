<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { cn } from '#lib/utils.js';

	let { class: className, children, ...restProps }: DialogPrimitive.DescriptionProps = $props();
</script>

<DialogPrimitive.Description
	data-slot="dialog-description"
	class={cn('text-[12px] leading-snug text-ink-tertiary', className)}
	{...restProps}
>
	{@render children?.()}
</DialogPrimitive.Description>
