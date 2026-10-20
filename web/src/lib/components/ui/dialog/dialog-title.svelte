<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { cn } from '#lib/utils.js';

	let { class: className, children, ...restProps }: DialogPrimitive.TitleProps = $props();
</script>

<DialogPrimitive.Title
	data-slot="dialog-title"
	class={cn('text-[13.5px] leading-none font-semibold text-ink', className)}
	{...restProps}
>
	{@render children?.()}
</DialogPrimitive.Title>
