<script lang="ts">
	import { mode, setMode, toggleMode } from 'mode-watcher';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon-sm"
				class="text-ink-tertiary hover:text-ink"
				aria-label="Toggle theme"
			>
				{#if mode.current === 'dark'}
					<MoonIcon />
				{:else if mode.current === 'light'}
					<SunIcon />
				{:else}
					<MonitorIcon />
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-36">
		<DropdownMenu.Item onclick={() => setMode('light')} class="gap-2">
			<SunIcon class="size-3.5" /> Light
		</DropdownMenu.Item>
		<DropdownMenu.Item onclick={() => setMode('dark')} class="gap-2">
			<MoonIcon class="size-3.5" /> Dark
		</DropdownMenu.Item>
		<DropdownMenu.Item onclick={() => setMode('system')} class="gap-2">
			<MonitorIcon class="size-3.5" /> System
		</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item onclick={() => toggleMode()} class="gap-2 text-ink-secondary">
			Toggle
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
