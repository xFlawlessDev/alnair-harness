<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import {
		CATEGORIES,
		DEFAULT_SETTINGS,
		filterSettings,
		SETTINGS,
		settingsByCategory,
		type SettingCategory,
		type SettingsState,
		type SettingValue
	} from '#lib/harness/settings.js';

	/**
	 * The settings dialog.
	 *
	 * The registry is large — seven categories and dozens of entries — so the
	 * sections live in a rail on the left rather than one long scroll. A search
	 * box flattens the whole registry, because looking for a setting by name is
	 * faster than remembering which section it hides in.
	 *
	 * Every row is a `SettingMeta` from the backend registry: same key, same
	 * label, same wording. The dialog does not invent settings.
	 */
	let {
		open = $bindable(false),
		settings,
		onchange
	}: {
		open: boolean;
		settings: SettingsState;
		onchange: (key: string, value: SettingValue) => void;
	} = $props();

	let category = $state<SettingCategory>('appearance');
	let query = $state('');

	const visible = $derived.by(() => {
		if (query.trim().length > 0) return filterSettings(query);
		return settingsByCategory(category);
	});

	const searching = $derived(query.trim().length > 0);

	function reset() {
		for (const setting of SETTINGS) {
			onchange(setting.key, DEFAULT_SETTINGS[setting.key]);
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="w-[min(64rem,94vw)] max-w-[min(64rem,94vw)]">
		<header class="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
			<div class="flex min-w-0 flex-col gap-1">
				<Dialog.Title>Settings</Dialog.Title>
				<Dialog.Description class="max-w-[42rem]">
					Changes apply to this session; anything marked restart takes effect on the next one.
				</Dialog.Description>
			</div>
			<Button variant="ghost" size="sm" class="mr-6 shrink-0 gap-1.5 text-[11.5px]" onclick={reset}>
				<RotateCcwIcon class="size-3" />
				Reset
			</Button>
		</header>

		<!--
			The body is a fixed height so switching tabs never resizes the
			dialog. It is sized for the largest section and capped to the
			viewport; a longer section scrolls, a shorter one leaves calm space
			below rather than snapping the frame smaller under the pointer.
		-->
		<div class="flex h-[min(32rem,78dvh)] min-h-0">
			<!-- Rail: the registry's own categories, in its render order. It
			     narrows on small screens and the label truncates rather than
			     wrapping, so the pane never squeezes the settings text. -->
			<nav
				class="flex w-36 shrink-0 flex-col gap-0.5 border-r border-line bg-paper-raised p-2 sm:w-48"
				aria-label="Setting categories"
			>
				{#each CATEGORIES as entry (entry.id)}
					{@const count = settingsByCategory(entry.id).length}
					<button
						type="button"
						class={[
							'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
							!searching && category === entry.id
								? 'bg-paper-card font-medium text-ink'
								: 'text-ink-secondary hover:bg-paper-card/60 hover:text-ink'
						]}
						aria-current={!searching && category === entry.id ? 'true' : undefined}
						onclick={() => {
							category = entry.id;
							query = '';
						}}
					>
						<span class="truncate">{entry.label}</span>
						<span class="tabular shrink-0 font-mono text-[10px] text-ink-tertiary/70">{count}</span>
					</button>
				{/each}
			</nav>

			<div class="flex min-w-0 flex-1 flex-col">
				<div class="flex items-center gap-2 border-b border-line px-3 py-2">
					<SearchIcon class="size-3.5 shrink-0 text-ink-tertiary" />
					<input
						bind:value={query}
						type="search"
						placeholder="Search settings"
						aria-label="Search settings"
						class="w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary/70"
					/>
					{#if searching}
						<span class="tabular shrink-0 font-mono text-[10px] text-ink-tertiary/70">
							{visible.length}
						</span>
					{/if}
				</div>

				<div class="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-4 py-3">
					{#if !searching}
						<p class="mb-3 text-[11.5px] text-ink-tertiary">
							{CATEGORIES.find((entry) => entry.id === category)?.description}
						</p>
					{/if}

					{#if visible.length === 0}
						<p class="py-8 text-center text-[12px] text-ink-tertiary">
							No setting matches “{query}”.
						</p>
					{:else}
						<ul class="flex flex-col gap-1">
							{#each visible as setting (setting.key)}
								{@const value = settings[setting.key]}
								<li class="rounded-lg px-2 py-2 transition-colors hover:bg-paper-card/40">
									<!-- On a narrow dialog the control drops below its text
									     instead of squeezing it; at `sm` and up it sits in
									     a fixed column on the right. -->
									<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
										<div class="flex min-w-0 flex-1 flex-col gap-0.5">
											<div class="flex items-baseline gap-1.5">
												<span class="text-[12.5px] font-medium whitespace-nowrap text-ink">
													{setting.label}
												</span>
												{#if setting.restartRequired}
													<span
														class="rounded-sm bg-plan/10 px-1 font-mono text-[9px] whitespace-nowrap text-plan"
														title="Takes effect on the next session"
													>
														restart
													</span>
												{/if}
												{#if searching}
													<span
														class="truncate font-mono text-[9.5px] whitespace-nowrap text-ink-tertiary/60"
													>
														{CATEGORIES.find((entry) => entry.id === setting.category)?.label}
													</span>
												{/if}
											</div>
											<p class="text-[11.5px] leading-snug text-ink-tertiary">
												{setting.description}
											</p>
										</div>

										<!-- A fixed control column. The slider is sized to fit
										     inside it (input + readout + gap), so it cannot
										     push past the dialog edge. -->
										<div class="flex w-full shrink-0 items-center justify-end pt-0.5 sm:w-44">
											{#if setting.kind.kind === 'bool'}
												<Switch
													checked={value === true}
													onCheckedChange={(next) => onchange(setting.key, next)}
													aria-label={setting.label}
												/>
											{:else if setting.kind.kind === 'enum'}
												<Select.Root
													type="single"
													value={String(value ?? '')}
													onValueChange={(next) => onchange(setting.key, next)}
												>
													<Select.Trigger size="sm" class="w-40 max-w-full text-[11.5px]">
														{setting.kind.choices.find((choice) => choice.value === value)?.label ??
															'—'}
													</Select.Trigger>
													<Select.Content>
														{#each setting.kind.choices as choice (choice.value)}
															<Select.Item value={choice.value} label={choice.label}>
																<span class="flex flex-col">
																	<span>{choice.label}</span>
																	{#if choice.description}
																		<span class="text-[10.5px] text-ink-tertiary">
																			{choice.description}
																		</span>
																	{/if}
																</span>
															</Select.Item>
														{/each}
													</Select.Content>
												</Select.Root>
											{:else if setting.kind.kind === 'int'}
												<div class="flex w-full items-center gap-2">
													<input
														type="range"
														min={setting.kind.min}
														max={setting.kind.max}
														step={setting.kind.step ?? 1}
														value={Number(value ?? setting.kind.min)}
														aria-label={setting.label}
														class="min-w-0 flex-1 accent-olive"
														oninput={(event) =>
															onchange(setting.key, Number(event.currentTarget.value))}
													/>
													<span
														class="tabular w-8 shrink-0 text-right font-mono text-[11px] text-ink-secondary"
													>
														{value}{setting.kind.suffix ?? ''}
													</span>
												</div>
											{:else}
												<input
													type="text"
													value={String(value ?? '')}
													placeholder={setting.kind.placeholder}
													aria-label={setting.label}
													class="h-7 w-full rounded-md border border-line bg-paper px-2 font-mono text-[11.5px] text-ink outline-none focus-visible:border-olive/60"
													oninput={(event) => onchange(setting.key, event.currentTarget.value)}
												/>
											{/if}
										</div>
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
