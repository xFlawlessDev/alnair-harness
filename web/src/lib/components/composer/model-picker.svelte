<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CheckIcon from '@lucide/svelte/icons/check';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { ModelOption } from '#lib/harness/types.js';

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

	const active = $derived(models.find((m) => m.id === model) ?? models[0]);
</script>

<div class="flex items-center gap-1">
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="xs"
					class="gap-1 px-1.5 font-medium text-ink-secondary hover:text-ink"
					aria-label="Select model"
				>
					<span class="max-w-40 truncate">{active.label}</span>
					<ChevronDownIcon class="size-3 text-ink-tertiary" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" side="top" class="w-64">
			<DropdownMenu.Label>Model</DropdownMenu.Label>
			{#each models as option (option.id)}
				<DropdownMenu.Item
					class="gap-2"
					onclick={() => onmodel(option.id)}
					data-active={option.id === model}
				>
					<span class="flex min-w-0 flex-col">
						<span class="truncate">{option.label}</span>
						<span class="truncate text-[11px] text-ink-tertiary">{option.provider}</span>
					</span>
					{#if option.id === model}
						<CheckIcon class="ml-auto size-3.5 text-olive" />
					{/if}
				</DropdownMenu.Item>
			{/each}
			<DropdownMenu.Separator />
			<DropdownMenu.Label>Thinking effort</DropdownMenu.Label>
			{#each active.efforts as level (level)}
				<DropdownMenu.Item
					class="gap-2"
					onclick={() => oneffort(level)}
					data-active={level === effort}
				>
					<span class="font-mono text-[12px]">{level}</span>
					{#if level === effort}
						<CheckIcon class="ml-auto size-3.5 text-olive" />
					{/if}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>
