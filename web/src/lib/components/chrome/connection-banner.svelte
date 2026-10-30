<script lang="ts">
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import WifiOffIcon from '@lucide/svelte/icons/wifi-off';

	/**
	 * The socket's health, when it is not healthy.
	 *
	 * A page that silently retries for ten seconds is indistinguishable from a
	 * frozen one: the reader types, nothing happens, and the only clue is a
	 * spinner that never stops. This strip says which state the connection is
	 * in, so "wait" and "something is wrong" are different sentences.
	 *
	 * Nothing renders while the socket is `live` — a permanent "connected"
	 * badge is noise. The strip appears in the flow above the thread, so it
	 * cannot be missed and cannot cover the conversation.
	 */
	let { state }: { state: 'live' | 'reconnecting' | 'offline' } = $props();
</script>

{#if state !== 'live'}
	<div
		class="mx-auto flex w-full max-w-3xl items-center gap-2 px-6 pt-2 text-[11.5px]"
		role="status"
		aria-live="polite"
		data-slot="connection-banner"
	>
		{#if state === 'reconnecting'}
			<LoaderIcon class="size-3.5 shrink-0 animate-spin text-plan" />
			<p class="min-w-0 flex-1 text-ink-secondary">
				Reconnecting to the agent…
				<span class="text-ink-tertiary">your conversation is safe; nothing was lost.</span>
			</p>
		{:else}
			<WifiOffIcon class="size-3.5 shrink-0 text-error" />
			<p class="min-w-0 flex-1 text-ink-secondary">
				Disconnected. Reload the page once <span class="font-mono">alnair web</span> is running again.
			</p>
		{/if}
	</div>
{/if}
