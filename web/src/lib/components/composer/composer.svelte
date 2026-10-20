<script lang="ts">
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { tick } from 'svelte';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import type { ContextUsage, ModelOption } from '#lib/harness/types.js';
	import ContextMeter from './context-meter.svelte';
	import ModelPicker from './model-picker.svelte';

	let {
		models,
		model,
		effort,
		usage,
		busy,
		onsend,
		oncancel,
		onmodel,
		oneffort
	}: {
		models: ModelOption[];
		model: string;
		effort: string;
		usage: ContextUsage;
		busy: boolean;
		onsend: (text: string) => void;
		oncancel: () => void;
		onmodel: (id: string) => void;
		oneffort: (effort: string) => void;
	} = $props();

	let draft = $state('');
	let form: HTMLFormElement | null = $state(null);
	let textarea: HTMLTextAreaElement | null = $state(null);

	const canSend = $derived(draft.trim().length > 0 && !busy);

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!canSend) return;
		onsend(draft);
		draft = '';
		void tick().then(() => textarea?.focus());
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			form?.requestSubmit();
		}
	}
</script>

<div class="mx-auto w-full max-w-3xl px-6 pb-5">
	<form bind:this={form} onsubmit={submit}>
		<InputGroup.Root
			class="h-auto flex-col items-stretch rounded-xl border-line-strong bg-paper-raised shadow-[0_1px_0_rgba(0,0,0,0.04)] has-[[data-slot=input-group-control]:focus-visible]:border-olive/60"
		>
			<InputGroup.Textarea
				bind:ref={textarea}
				bind:value={draft}
				placeholder="Ask for a change, a review, or a plan…"
				aria-label="Message"
				class="max-h-52 min-h-11 px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed"
				{onkeydown}
			/>

			<InputGroup.Addon align="block-end" class="gap-1 px-2 pb-2">
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<InputGroup.Button
								{...props}
								type="button"
								size="icon-xs"
								variant="ghost"
								aria-label="Attach files"
								class="text-ink-tertiary hover:text-ink"
							>
								<PaperclipIcon />
							</InputGroup.Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content><p>Attach files (mock)</p></Tooltip.Content>
				</Tooltip.Root>

				<ModelPicker {models} {model} {effort} {onmodel} {oneffort} />

				<div class="ml-auto flex items-center gap-2">
					<ContextMeter {usage} class="hidden sm:flex" />

					{#if busy}
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<InputGroup.Button
										{...props}
										type="button"
										size="icon-sm"
										variant="outline"
										aria-label="Stop"
										class="border-line-strong text-ink"
										onclick={oncancel}
									>
										<SquareIcon class="fill-current" />
									</InputGroup.Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content><p>Stop</p></Tooltip.Content>
						</Tooltip.Root>
					{:else}
						<InputGroup.Button
							type="submit"
							size="icon-sm"
							variant="default"
							disabled={!canSend}
							class="hover:bg-ink-hover bg-ink text-paper disabled:bg-ink/40 disabled:text-paper/70"
							aria-label="Send"
						>
							<ArrowUpIcon />
						</InputGroup.Button>
					{/if}
				</div>
			</InputGroup.Addon>
		</InputGroup.Root>
	</form>

	<p
		class="mt-2 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[10.5px] whitespace-nowrap text-ink-tertiary/80"
	>
		<span class="inline-flex items-center gap-1">
			<Kbd class="h-4 min-w-4 bg-paper-card/70 px-1 text-[10px]">Enter</Kbd>
			<span>to send</span>
		</span>
		<span class="text-ink-tertiary/40">·</span>
		<span class="inline-flex items-center gap-1">
			<Kbd class="h-4 bg-paper-card/70 px-1 text-[10px]">Shift</Kbd>
			<Kbd class="h-4 bg-paper-card/70 px-1 text-[10px]">Enter</Kbd>
			<span>for a new line</span>
		</span>
		<span class="hidden text-ink-tertiary/40 sm:inline">·</span>
		<span class="hidden sm:inline">mocked session</span>
	</p>
</div>
