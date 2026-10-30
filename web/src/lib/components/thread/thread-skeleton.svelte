<script lang="ts">
	/**
	 * The shape of a transcript while it arrives.
	 *
	 * `openSession` clears the accumulator and collects the replay before folding
	 * it, so there is a real interval where the thread is empty. Without this,
	 * clicking a session showed a blank pane — indistinguishable from a session
	 * that genuinely has no messages, and easy to read as "my history is gone".
	 *
	 * Deliberately the same silhouette as the thread (a short user bubble, an
	 * answer block, a trace row) rather than a spinner: the reader can see what
	 * is coming, and the swap is a fill-in instead of a reflow.
	 */
</script>

<div
	class="mx-auto flex w-full max-w-3xl flex-col gap-7 px-6 py-8"
	role="status"
	aria-live="polite"
	aria-label="Loading the conversation"
	data-slot="thread-skeleton"
>
	<!-- A user turn. -->
	<div class="ml-auto flex max-w-[70%] flex-col items-end gap-2">
		<span class="h-3 w-52 animate-pulse rounded-full bg-line/70"></span>
		<span class="h-3 w-32 animate-pulse rounded-full bg-line/60"></span>
	</div>

	<!-- The answer, and a trace row between them. -->
	<div class="flex flex-col gap-2.5">
		<div class="flex items-center gap-2">
			<span class="size-3 animate-pulse rounded-[3px] bg-line/70"></span>
			<span class="h-2.5 w-40 animate-pulse rounded-full bg-line/60"></span>
			<span class="ml-auto h-2.5 w-9 animate-pulse rounded-full bg-line/50"></span>
		</div>
		<span class="h-3 w-[88%] animate-pulse rounded-full bg-line/60"></span>
		<span class="h-3 w-[72%] animate-pulse rounded-full bg-line/60"></span>
	</div>

	<!-- A second exchange, so the pane reads as a conversation, not one block. -->
	<div class="ml-auto flex max-w-[60%] flex-col items-end gap-2">
		<span class="h-3 w-36 animate-pulse rounded-full bg-line/60"></span>
	</div>
	<div class="flex flex-col gap-2.5">
		<span class="h-3 w-[80%] animate-pulse rounded-full bg-line/60"></span>
		<span class="h-3 w-[54%] animate-pulse rounded-full bg-line/50"></span>
	</div>
</div>
