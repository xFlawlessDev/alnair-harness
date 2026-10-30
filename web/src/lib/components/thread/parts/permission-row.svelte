<script lang="ts">
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import ShieldQuestionIcon from '@lucide/svelte/icons/shield-question';
	import type { PermissionPart } from '#lib/harness/types.js';

	/**
	 * A parked `session/request_permission`, shown inline where it happened.
	 *
	 * It is deliberately not clickable: the answer comes from the banner above
	 * the composer, which is the one place a blocked agent is always visible.
	 * Two sets of buttons for one request invites answering it twice.
	 *
	 * ANSWERED requests collapse to a single quiet line. A resolved card is
	 * history — the reader already made the decision, the tool ran, and the
	 * result is the row underneath — so it must not keep a boxed, bordered
	 * block that out-shouts the work it unblocked. Only the live request earns
	 * the frame and the sentence explaining what to do about it.
	 */
	let { part }: { part: PermissionPart } = $props();
</script>

{#if part.resolved}
	<p
		class="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-tertiary"
		data-slot="permission-answered"
	>
		<ShieldCheckIcon class="size-3 shrink-0 text-ink-tertiary/70" />
		<span class="shrink-0">Permission answered</span>
		<span class="text-ink-tertiary/40">·</span>
		<span class="min-w-0 truncate font-mono text-ink-tertiary/80">{part.title}</span>
	</p>
{:else}
	<div
		class="flex flex-col gap-2 rounded-lg border bg-paper px-3 py-2.5"
		style:border-color="color-mix(in oklab, var(--terra) 40%, transparent)"
		data-slot="permission-required"
	>
		<div class="flex items-start gap-2">
			<ShieldQuestionIcon class="mt-px size-3.5 shrink-0 text-terra" />
			<div class="flex min-w-0 flex-col gap-0.5">
				<p class="text-[12.5px] leading-snug font-medium">Permission required</p>
				<p class="truncate font-mono text-[11px] text-ink-tertiary">{part.title}</p>
			</div>
		</div>

		<p class="pl-5.5 text-[11px] text-ink-tertiary">
			Answer above the composer to let the agent continue.
		</p>
	</div>
{/if}
