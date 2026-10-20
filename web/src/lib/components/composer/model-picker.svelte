<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CheckIcon from '@lucide/svelte/icons/check';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import type { ModelOption } from '#lib/harness/types.js';

	/**
	 * The model and its thinking effort, as one segmented control: the model
	 * name, then the effort, both opening the same menu because they are two
	 * halves of one choice — which model, thinking how hard.
	 */
	let {
		models,
		model,
		effort,
		onmodel,
		oneffort
	}: {
		models: ModelOption[];
		model: string;
		effort: string;
		onmodel: (id: string) => void;
		oneffort: (effort: string) => void;
	} = $props();

	const active = $derived(models.find((candidate) => candidate.id === model) ?? models[0]);
	const hasEfforts = $derived(active.efforts.length > 0);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="flex h-8 items-stretch overflow-hidden rounded-md bg-paper-card text-[11.5px] transition-colors hover:bg-accent"
				aria-label={`Model: ${active.label}`}
			>
				<span class="flex items-center gap-1 px-2.5">
					<span class="max-w-44 truncate font-medium text-ink">{active.label}</span>
					<ChevronDownIcon class="size-3 text-ink-tertiary" />
				</span>
				{#if hasEfforts}
					<span class="flex items-center border-l border-line/70 px-2 font-mono text-ink-tertiary">
						{effort}
					</span>
				{/if}
			</button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" side="top" class="w-64">
		<DropdownMenu.Label>Model</DropdownMenu.Label>
		{#each models as option (option.id)}
			<DropdownMenu.Item class="gap-2" onclick={() => onmodel(option.id)}>
				<span class="flex min-w-0 flex-col">
					<span class="truncate">{option.label}</span>
					<span class="truncate text-[11px] text-ink-tertiary">{option.provider}</span>
				</span>
				{#if option.id === model}
					<CheckIcon class="ml-auto size-3.5 shrink-0 text-olive" />
				{/if}
			</DropdownMenu.Item>
		{/each}
		{#if hasEfforts}
			<DropdownMenu.Separator />
			<DropdownMenu.Label>Thinking effort</DropdownMenu.Label>
			{#each active.efforts as level (level)}
				<DropdownMenu.Item class="gap-2" onclick={() => oneffort(level)}>
					<span class="font-mono text-[12px]">{level}</span>
					{#if level === effort}
						<CheckIcon class="ml-auto size-3.5 shrink-0 text-olive" />
					{/if}
				</DropdownMenu.Item>
			{/each}
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>
