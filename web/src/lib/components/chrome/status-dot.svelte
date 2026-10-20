<script lang="ts">
	import { cn } from '#lib/utils.js';

	let {
		status = 'idle',
		class: className,
		pulse = false
	}: {
		status?: 'idle' | 'running' | 'attention' | 'complete' | 'error' | 'pending';
		class?: string;
		pulse?: boolean;
	} = $props();

	const tone = $derived(
		{
			idle: 'bg-ink-tertiary',
			running: 'bg-running',
			attention: 'bg-terra',
			complete: 'bg-success',
			error: 'bg-error',
			pending: 'bg-line-strong'
		}[status]
	);
</script>

<span
	class={cn('relative inline-flex size-1.5 shrink-0 rounded-full', tone, className)}
	aria-hidden="true"
>
	{#if pulse || status === 'running'}
		<span class={cn('absolute inset-0 animate-ping rounded-full opacity-60', tone)}></span>
	{/if}
</span>
