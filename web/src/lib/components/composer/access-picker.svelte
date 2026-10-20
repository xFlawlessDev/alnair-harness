<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import ShieldQuestionIcon from '@lucide/svelte/icons/shield-question';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import type { AccessMode } from '#lib/harness/types.js';

	/**
	 * How much the agent may do without asking. The three modes are the
	 * runtime's own (`PermissionMode`), not a UI invention, so the labels and
	 * the order match what `permission_mode` accepts in config.toml.
	 */
	let { access, onchange }: { access: AccessMode; onchange: (mode: AccessMode) => void } = $props();

	const modes: { id: AccessMode; label: string; description: string; icon: typeof ShieldIcon }[] = [
		{
			id: 'ask',
			label: 'Ask first',
			description: 'Every write and command needs approval.',
			icon: ShieldQuestionIcon
		},
		{
			id: 'auto',
			label: 'Auto',
			description: 'Safe edits run; risky ones still ask.',
			icon: ShieldIcon
		},
		{
			id: 'always-approve',
			label: 'Full access',
			description: 'Nothing asks. Equivalent to yolo mode.',
			icon: ShieldCheckIcon
		}
	];

	const active = $derived(modes.find((mode) => mode.id === access) ?? modes[1]);
	const Icon = $derived(active.icon);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink-secondary transition-colors hover:bg-paper-card hover:text-ink"
				aria-label={`Access: ${active.label}`}
			>
				<Icon class="size-3.5 text-terra" />
				<span class="whitespace-nowrap">{active.label}</span>
				<ChevronDownIcon class="size-3 text-ink-tertiary" />
			</button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" side="top" class="w-64">
		<DropdownMenu.Label>Access</DropdownMenu.Label>
		{#each modes as mode (mode.id)}
			<DropdownMenu.Item class="items-start gap-2" onclick={() => onchange(mode.id)}>
				<mode.icon class="mt-0.5 size-3.5 shrink-0 text-ink-tertiary" />
				<span class="flex min-w-0 flex-col">
					<span class="truncate">{mode.label}</span>
					<span class="text-[11px] leading-snug whitespace-normal text-ink-tertiary">
						{mode.description}
					</span>
				</span>
				{#if mode.id === access}
					<CheckIcon class="mt-0.5 ml-auto size-3.5 shrink-0 text-olive" />
				{/if}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
