<script lang="ts">
	import Logo from './logo.svelte';

	/**
	 * The page's shape before any state has arrived.
	 *
	 * Deliberately not the fixture conversation: a reader who lands here while
	 * the handshake and the first replay are in flight must not be shown a
	 * transcript that is not theirs. The blocks mirror the real layout (rail,
	 * header, thread, composer) so the swap is a fill-in rather than a reflow,
	 * and a slow leader reads as "loading", not "broken".
	 *
	 * `animate-pulse` is the only motion. A spinner would say the page is busy;
	 * a skeleton says what is coming.
	 */
</script>

<div
	class="flex h-dvh w-full overflow-hidden bg-paper text-ink"
	role="status"
	aria-live="polite"
	aria-label="Connecting to the agent"
>
	<!-- The rail: workspace groups, then their conversations. -->
	<aside class="hidden w-60 shrink-0 flex-col gap-3 border-r border-line px-3 py-3 md:flex">
		<div class="flex items-center gap-2 px-1 pb-1">
			<Logo />
			<span class="animate-pulse rounded-sm bg-line/70 text-[11px] text-transparent">Alnair</span>
		</div>

		{#each [3, 2] as rows, group (group)}
			<div class="flex flex-col gap-1.5">
				<div class="flex items-center gap-1.5 px-1 py-1">
					<span class="size-3 animate-pulse rounded-[3px] bg-line/70"></span>
					<span
						class="h-2.5 animate-pulse rounded-full bg-line/70"
						style="width: {group === 0 ? 62 : 48}%"
					></span>
				</div>
				{#each Array(rows) as _, index (index)}
					<div class="flex items-center gap-2 rounded-md px-1.5 py-1.5">
						<span class="size-1.5 shrink-0 animate-pulse rounded-full bg-line/70"></span>
						<span
							class="h-2.5 animate-pulse rounded-full bg-line/60"
							style="width: {42 + ((index * 17 + group * 11) % 40)}%"
						></span>
					</div>
				{/each}
			</div>
		{/each}

		<div class="mt-auto flex items-center gap-2 px-1 py-1">
			<span class="size-3 animate-pulse rounded-[3px] bg-line/60"></span>
			<span class="h-2.5 w-16 animate-pulse rounded-full bg-line/60"></span>
		</div>
	</aside>

	<!-- The thread column. -->
	<main class="flex min-w-0 flex-1 flex-col bg-thread">
		<div class="flex items-center gap-2 border-b border-line px-6 py-3">
			<span class="h-3 w-40 animate-pulse rounded-full bg-line/70"></span>
			<span class="ml-auto h-3 w-14 animate-pulse rounded-full bg-line/60"></span>
		</div>

		<div class="flex min-h-0 flex-1 flex-col gap-6 px-6 py-6">
			<div class="mx-auto flex w-full max-w-3xl flex-col gap-6">
				<!-- A user turn, then the answer it started. -->
				<div class="ml-auto flex max-w-[80%] flex-col items-end gap-2">
					<span class="h-3 w-44 animate-pulse rounded-full bg-line/70"></span>
					<span class="h-3 w-28 animate-pulse rounded-full bg-line/60"></span>
				</div>

				<div class="flex flex-col gap-2">
					<span class="h-3 w-full animate-pulse rounded-full bg-line/60"></span>
					<span class="h-3 w-[92%] animate-pulse rounded-full bg-line/60"></span>
					<span class="h-3 w-[64%] animate-pulse rounded-full bg-line/60"></span>
				</div>

				<!-- A tool row, which is where the wait usually is. -->
				<div class="flex items-center gap-2 rounded-lg border border-line px-3 py-2.5">
					<span class="size-3.5 animate-pulse rounded-[3px] bg-line/70"></span>
					<span class="h-2.5 w-32 animate-pulse rounded-full bg-line/60"></span>
					<span class="ml-auto h-2.5 w-10 animate-pulse rounded-full bg-line/50"></span>
				</div>

				<div class="flex flex-col gap-2">
					<span class="h-3 w-[86%] animate-pulse rounded-full bg-line/60"></span>
					<span class="h-3 w-[48%] animate-pulse rounded-full bg-line/60"></span>
				</div>
			</div>
		</div>

		<!-- The composer, at its resting height. -->
		<div class="mx-auto w-full max-w-3xl px-6 pb-5">
			<div class="rounded-xl border border-line-strong bg-paper-raised px-3.5 py-3">
				<span class="block h-3.5 w-[58%] animate-pulse rounded-full bg-line/60"></span>
				<div class="mt-4 flex items-center gap-1.5">
					<span class="size-7 animate-pulse rounded-md bg-line/50"></span>
					<span class="h-5 w-20 animate-pulse rounded-md bg-line/50"></span>
					<span class="ml-auto h-5 w-16 animate-pulse rounded-md bg-line/50"></span>
					<span class="size-8 animate-pulse rounded-full bg-line/60"></span>
				</div>
			</div>
			<div class="mt-2 flex items-center gap-2 px-1">
				<span class="h-2.5 w-24 animate-pulse rounded-full bg-line/50"></span>
				<span class="h-2.5 w-16 animate-pulse rounded-full bg-line/50"></span>
			</div>
		</div>
	</main>
</div>
