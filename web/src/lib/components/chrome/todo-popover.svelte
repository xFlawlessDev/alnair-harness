<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleDotIcon from '@lucide/svelte/icons/circle-dot';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import LoaderIconIcon from '@lucide/svelte/icons/loader';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { TodoItem } from '#lib/harness/types.js';

	let { todos }: { todos: TodoItem[] } = $props();

	const done = $derived(todos.filter((todo) => todo.status === 'complete').length);
	const total = $derived(todos.length);
	const active = $derived(
		todos.find((todo) => todo.status === 'running') ??
			todos.find((todo) => todo.status === 'pending')
	);
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="sm"
				class="h-7 gap-1.5 rounded-full border border-line px-2 text-[11px] font-normal text-ink-secondary hover:border-line-strong hover:text-ink"
				aria-label={`Todo list, ${done} of ${total} done`}
			>
				<ListChecksIcon class="size-3 text-plan" />
				<span class="tabular font-mono">{done}/{total}</span>
				{#if active}
					<span class="hidden max-w-40 truncate text-ink-tertiary sm:inline">
						{active.title}
					</span>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-80 gap-3 p-0">
		<div class="flex items-center justify-between border-b border-line px-3 py-2">
			<p class="text-[11px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">Todo</p>
			<span class="tabular font-mono text-[10.5px] text-ink-tertiary">{done}/{total}</span>
		</div>

		{#if total === 0}
			<p class="px-3 pt-3 pb-1 text-[12px] text-ink-tertiary">No todo list for this turn yet.</p>
		{:else}
			<ol class="flex flex-col gap-1 px-2 pb-2">
				{#each todos as todo (todo.id)}
					<li class="flex items-start gap-2 rounded-md px-1.5 py-1.5">
						<span class="mt-px flex size-4 shrink-0 items-center justify-center">
							{#if todo.status === 'complete'}
								<CircleCheckIcon class="size-3.5 text-success" />
							{:else if todo.status === 'running'}
								<LoaderIconIcon class="size-3.5 animate-spin text-running" />
							{:else if todo.status === 'error'}
								<CircleDotIcon class="size-3.5 text-error" />
							{:else}
								<CircleDotIcon class="size-3.5 text-ink-tertiary/50" />
							{/if}
						</span>
						<span class="flex min-w-0 flex-col gap-0.5">
							<span
								class="text-[12.5px] leading-snug"
								class:text-ink-tertiary={todo.status === 'pending'}
								class:text-ink-secondary={todo.status !== 'pending'}
								class:line-through={todo.status === 'complete'}
								class:decoration-line-strong={todo.status === 'complete'}
							>
								{todo.title}
							</span>
							{#if todo.detail}
								<span class="font-mono text-[10.5px] text-ink-tertiary">{todo.detail}</span>
							{/if}
						</span>
					</li>
				{/each}
			</ol>
		{/if}
	</Popover.Content>
</Popover.Root>
