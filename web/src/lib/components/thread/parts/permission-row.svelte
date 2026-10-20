<script lang="ts">
	import ShieldQuestionIcon from '@lucide/svelte/icons/shield-question';
	import type { PermissionPart } from '#lib/harness/types.js';

	/**
	 * A parked `session/request_permission`, shown inline where it happened.
	 *
	 * It is deliberately not clickable: the answer comes from the banner above
	 * the composer, which is the one place a blocked agent is always visible.
	 * Two sets of buttons for one request invites answering it twice.
	 */
	let { part }: { part: PermissionPart } = $props();
</script>

<div
	class="flex flex-col gap-2 rounded-lg border px-3 py-2.5"
	class:border-line={part.resolved}
	class:bg-paper={!part.resolved}
	style:border-color={part.resolved
		? undefined
		: 'color-mix(in oklab, var(--terra) 40%, transparent)'}
>
	<div class="flex items-start gap-2">
		<ShieldQuestionIcon class="mt-px size-3.5 shrink-0 text-terra" />
		<div class="flex min-w-0 flex-col gap-0.5">
			<p class="text-[12.5px] leading-snug font-medium">
				{part.resolved ? 'Permission answered' : 'Permission required'}
			</p>
			<p class="truncate font-mono text-[11px] text-ink-tertiary">{part.title}</p>
		</div>
	</div>

	{#if !part.resolved}
		<p class="pl-5.5 text-[11px] text-ink-tertiary">
			Answer above the composer to let the agent continue.
		</p>
	{/if}
</div>
