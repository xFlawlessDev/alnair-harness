<script lang="ts">
	import { onDestroy } from 'svelte';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button, type ButtonProps } from '#lib/components/ui/button/index.js';
	import { copyText } from '#lib/clipboard.js';
	import { cn } from '#lib/utils.js';

	/**
	 * Copy a block's text.
	 *
	 * Three states, not two: a copy that the browser refused used to look
	 * identical to one that worked for two seconds and then revert, which is
	 * indistinguishable from a dead button. `failed` says so with an icon.
	 */
	let {
		ref = $bindable(null),
		class: className,
		value,
		variant = 'ghost',
		size = 'icon-xs',
		onclick,
		...restProps
	}: Omit<ButtonProps, 'onclick'> & {
		value: string;
		onclick?: (e: MouseEvent) => void;
	} = $props();

	let copied = $state(false);
	let failed = $state(false);
	let timeout: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		const landed = await copyText(value);
		copied = landed;
		failed = !landed;
		clearTimeout(timeout);
		timeout = setTimeout(() => {
			copied = false;
			failed = false;
		}, 2000);
	}

	onDestroy(() => clearTimeout(timeout));
</script>

<Button
	bind:ref
	data-slot="code-block-copy-button"
	data-copied={copied || undefined}
	data-failed={failed || undefined}
	{variant}
	{size}
	aria-label={failed ? 'Copy failed' : copied ? 'Copied' : 'Copy'}
	class={cn(failed && 'text-error', className)}
	onclick={(e) => {
		onclick?.(e);
		void copy();
	}}
	{...restProps}
>
	{#if failed}
		<XIcon />
	{:else if copied}
		<CheckIcon />
	{:else}
		<CopyIcon />
	{/if}
</Button>
<span aria-live="polite" class="sr-only">
	{failed ? 'Copy failed' : copied ? 'Copied' : ''}
</span>
