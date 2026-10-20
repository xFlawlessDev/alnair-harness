<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';

	let { children, ...restProps }: DialogPrimitive.TriggerProps = $props();
</script>

<DialogPrimitive.Trigger {...restProps}>
	{@render children?.()}
</DialogPrimitive.Trigger>
