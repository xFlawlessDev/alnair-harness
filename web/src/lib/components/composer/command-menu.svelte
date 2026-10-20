<script lang="ts">
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import CornerDownLeftIcon from '@lucide/svelte/icons/corner-down-left';
	import type { SlashCommand } from '#lib/harness/types.js';

	/**
	 * The `/` menu: the commands the agent advertised through ACP
	 * `available_commands_update`. It only appears at the start of a message,
	 * because a slash mid-sentence is punctuation, not a command.
	 */
	let {
		commands,
		query,
		active,
		onhover,
		onaccept
	}: {
		commands: SlashCommand[];
		/** What was typed after the slash. */
		query: string;
		active: number;
		onhover: (index: number) => void;
		onaccept: (command: SlashCommand) => void;
	} = $props();

	let list: HTMLUListElement | null = $state(null);

	/**
	 * Keep the highlighted row inside the scroll port. Arrow keys move the
	 * cursor without moving focus, so the browser does not scroll for us — the
	 * offset has to be computed here.
	 *
	 * `offsetTop` is relative to the nearest positioned ancestor, which is the
	 * popover panel rather than the list, so the list's own offset is
	 * subtracted. `active` is read explicitly to make the effect depend on it.
	 */
	$effect(() => {
		const index = active;
		const count = commands.length;
		if (!list || count === 0) return;
		const row = list.children[index] as HTMLElement | undefined;
		if (!row) return;

		const top = row.offsetTop - list.offsetTop;
		const bottom = top + row.offsetHeight;
		if (top < list.scrollTop) list.scrollTop = top;
		else if (bottom > list.scrollTop + list.clientHeight) {
			list.scrollTop = bottom - list.clientHeight;
		}
	});
</script>

<div
	class="w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line-strong bg-popover shadow-lg"
>
	<div class="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
		<p class="text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">Commands</p>
		<span class="truncate font-mono text-[10px] text-ink-tertiary/80">
			{#if query}/{query}{:else}type to filter{/if}
		</span>
	</div>

	{#if commands.length === 0}
		<p class="px-3 py-4 text-center text-[12px] text-ink-tertiary">No command matches.</p>
	{:else}
		<ul bind:this={list} class="max-h-64 overflow-y-auto py-1" role="listbox" aria-label="Commands">
			{#each commands as command, index (command.name)}
				{@const selected = index === active}
				<li role="option" aria-selected={selected}>
					<button
						type="button"
						class={[
							'flex w-full items-start gap-2 px-2.5 py-1.5 text-left transition-colors',
							selected ? 'bg-paper-card' : 'hover:bg-paper-card/50'
						]}
						onmouseenter={() => onhover(index)}
						onclick={() => onaccept(command)}
					>
						<TerminalIcon class="mt-0.5 size-3.5 shrink-0 text-ink-tertiary" />
						<span class="flex min-w-0 flex-1 flex-col gap-0.5">
							<span class="flex items-baseline gap-1.5">
								<span class="font-mono text-[12px] text-ink">/{command.name}</span>
								{#if command.hint}
									<span class="truncate font-mono text-[10.5px] text-ink-tertiary/70">
										{command.hint}
									</span>
								{/if}
							</span>
							<span class="truncate text-[11px] text-ink-tertiary">{command.description}</span>
						</span>
						{#if selected}
							<CornerDownLeftIcon class="mt-0.5 size-3 shrink-0 text-ink-tertiary/60" />
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
