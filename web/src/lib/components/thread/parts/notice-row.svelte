<script lang="ts">
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import type { NoticePart } from '#lib/harness/types.js';

	/**
	 * A one-line system event: a retry, a compaction, a model switch, a recap.
	 * Alnair sends these as separate updates; they all read the same way.
	 */
	let { part }: { part: NoticePart } = $props();

	const Icon = $derived(
		part.tone === 'warning'
			? TriangleAlertIcon
			: part.tone === 'success'
				? CircleCheckIcon
				: InfoIcon
	);
	const tone = $derived(
		part.tone === 'warning'
			? 'text-terra'
			: part.tone === 'success'
				? 'text-success'
				: 'text-system'
	);
</script>

<div class="flex items-start gap-2 rounded-md border border-line/70 px-2.5 py-1.5">
	<Icon class="mt-px size-3.5 shrink-0 {tone}" />
	<div class="flex min-w-0 flex-col gap-0.5">
		<p class="text-[11.5px] leading-snug text-ink-secondary">{part.title}</p>
		{#if part.detail}
			<p class="text-[11px] leading-snug text-ink-tertiary">{part.detail}</p>
		{/if}
	</div>
</div>
