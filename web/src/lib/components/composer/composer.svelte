<script lang="ts">
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { tick } from 'svelte';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import type {
		AccessMode,
		ComposerContext,
		ContextUsage,
		ModelOption
	} from '#lib/harness/types.js';
	import AccessPicker from './access-picker.svelte';
	import CheckoutBar from './checkout-bar.svelte';
	import ContextMeter from './context-meter.svelte';
	import ModelPicker from './model-picker.svelte';

	/**
	 * The prompt input, laid out as one card: the field on top, a control row
	 * under it, and the checkout row attached below.
	 *
	 * The field is a bare textarea rather than the input-group primitive,
	 * because the reference puts the controls in a row of their own across the
	 * full width instead of hugging the field.
	 */
	let {
		models,
		model,
		effort,
		usage,
		context,
		busy,
		onsend,
		oncancel,
		onmodel,
		oneffort,
		onaccess
	}: {
		models: ModelOption[];
		model: string;
		effort: string;
		usage: ContextUsage;
		context: ComposerContext;
		busy: boolean;
		onsend: (text: string) => void;
		oncancel: () => void;
		onmodel: (id: string) => void;
		oneffort: (effort: string) => void;
		onaccess: (mode: AccessMode) => void;
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

	/** Grow with the text, up to a ceiling, then scroll. */
	function autosize(node: HTMLTextAreaElement) {
		const resize = () => {
			node.style.height = 'auto';
			node.style.height = `${Math.min(node.scrollHeight, 208)}px`;
		};
		resize();
		node.addEventListener('input', resize);
		return {
			destroy: () => node.removeEventListener('input', resize)
		};
	}
</script>

<div class="mx-auto w-full max-w-3xl px-6 pb-5">
	<form bind:this={form} onsubmit={submit}>
		<div
			class="rounded-xl border border-line-strong bg-paper-raised shadow-[0_1px_0_rgba(0,0,0,0.04)] transition-colors focus-within:border-olive/60"
		>
			<textarea
				bind:this={textarea}
				use:autosize
				bind:value={draft}
				{onkeydown}
				rows="1"
				placeholder="Ask anything · @ to mention anything · / to use a skill"
				aria-label="Message"
				class="block max-h-52 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary/80"
			></textarea>

			<div class="flex items-center gap-1 px-2 pt-1 pb-2">
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-paper-card hover:text-ink"
								aria-label="Attach"
							>
								<PlusIcon class="size-4" />
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content><p>Attach (mock)</p></Tooltip.Content>
				</Tooltip.Root>

				<AccessPicker access={context.access} onchange={onaccess} />

				<div class="ml-auto flex items-center gap-1.5">
					<ModelPicker {models} {model} {effort} {onmodel} {oneffort} />

					<ContextMeter {usage} />

					{#if busy}
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<button
										{...props}
										type="button"
										class="flex size-8 shrink-0 items-center justify-center rounded-full border border-line-strong bg-paper text-ink transition-colors hover:bg-paper-card"
										aria-label="Stop"
										onclick={oncancel}
									>
										<SquareIcon class="size-3 fill-current" />
									</button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content><p>Stop</p></Tooltip.Content>
						</Tooltip.Root>
					{:else}
						<button
							type="submit"
							disabled={!canSend}
							class="hover:bg-ink-hover flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-paper transition-colors disabled:cursor-not-allowed disabled:bg-ink/15 disabled:text-paper/60"
							aria-label="Send"
						>
							<ArrowUpIcon class="size-4" />
						</button>
					{/if}
				</div>
			</div>
		</div>

		<CheckoutBar {context} />
	</form>
</div>
