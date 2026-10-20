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
		FileEntry,
		ModelOption,
		SlashCommand
	} from '#lib/harness/types.js';
	import {
		filterCommands,
		filterEntries,
		insertEntry,
		triggerAt,
		type Trigger
	} from '#lib/harness/mentions.js';
	import AccessPicker from './access-picker.svelte';
	import CheckoutBar from './checkout-bar.svelte';
	import CommandMenu from './command-menu.svelte';
	import ContextMeter from './context-meter.svelte';
	import MentionMenu from './mention-menu.svelte';
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
		commands = [],
		files = [],
		onsend,
		oncancel,
		onmodel,
		oneffort,
		onaccess,
		onbrowse
	}: {
		models: ModelOption[];
		model: string;
		effort: string;
		usage: ContextUsage;
		context: ComposerContext;
		busy: boolean;
		/** Commands the agent advertised; empty until it does. */
		commands?: SlashCommand[];
		/** The workspace listing for the `@` menu. */
		files?: FileEntry[];
		onsend: (text: string) => void;
		oncancel: () => void;
		onmodel: (id: string) => void;
		oneffort: (effort: string) => void;
		onaccess: (mode: AccessMode) => void;
		/** Open a directory in the mention menu. */
		onbrowse?: (path: string) => FileEntry[];
	} = $props();

	let draft = $state('');
	let form: HTMLFormElement | null = $state(null);
	let textarea: HTMLTextAreaElement | null = $state(null);

	/** Which menu is open, what filters it, and which row is highlighted. */
	let trigger = $state<Trigger>(null);
	let active = $state(0);
	/** The directory the `@` menu is currently listing. */
	let browsing = $state<string | undefined>(undefined);
	let listing = $state<FileEntry[]>(files);
	/**
	 * Set right after an insert: the text now ends in a valid mention token, so
	 * a naive re-sync would reopen the menu the reader just closed. Any further
	 * edit clears it.
	 */
	let suppress = $state(false);

	const canSend = $derived(draft.trim().length > 0 && !busy);

	const options = $derived.by(() => {
		if (trigger?.kind === 'command') return filterCommands(commands, trigger.query);
		if (trigger?.kind === 'mention') return filterEntries(listing, trigger.query);
		return [];
	});

	const open = $derived(trigger !== null && (options.length > 0 || trigger.kind === 'mention'));

	/** Recompute the trigger from the field, after any edit or caret move. */
	function sync() {
		if (!textarea) return;
		if (suppress) {
			trigger = null;
			return;
		}
		const next = triggerAt(textarea.value, textarea.selectionStart);
		// A closed menu reopens only on a fresh trigger, so Escape is sticky
		// until the reader edits the token again.
		if (next?.kind !== trigger?.kind || next?.start !== trigger?.start) active = 0;
		trigger = next;
		if (next?.kind === 'mention' && browsing === undefined) listing = files;
	}

	/** Called on every edit: a fresh keystroke lifts the post-insert mute. */
	function onedit() {
		suppress = false;
		sync();
	}

	function close() {
		trigger = null;
		browsing = undefined;
	}

	function accept() {
		const choice = options[active];
		if (!choice || !trigger) return;

		if (trigger.kind === 'command') {
			const command = choice as SlashCommand;
			apply(`/${command.name}`);
			close();
			return;
		}

		const entry = choice as FileEntry;
		if (entry.type === 'directory') {
			// Drill in without touching the text: the mention is not finished yet.
			const children = onbrowse?.(entry.path) ?? [];
			browsing = entry.path;
			listing = children;
			draft = `${draft.slice(0, trigger.start)}@${entry.path}/${draft.slice(trigger.end)}`;
			trigger = {
				kind: 'mention',
				query: `${entry.path}/`,
				start: trigger.start,
				end: trigger.start + entry.path.length + 2
			};
			active = 0;
			void tick().then(() => textarea?.focus());
			return;
		}

		apply(`@${entry.path}`);
		close();
	}

	/** Replace the trigger token and put the caret after it. */
	function apply(replacement: string) {
		if (!trigger) return;
		const next = insertEntry(draft, trigger, replacement);
		draft = next.value;
		// The inserted text is itself a valid mention token; keep the menu shut
		// until the reader types again.
		suppress = true;
		trigger = null;
		void tick().then(() => {
			if (!textarea) return;
			textarea.focus();
			textarea.setSelectionRange(next.caret, next.caret);
		});
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!canSend) return;
		onsend(draft);
		draft = '';
		close();
		void tick().then(() => textarea?.focus());
	}

	function onkeydown(event: KeyboardEvent) {
		if (open) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				active = (active + 1) % options.length;
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				active = (active - 1 + options.length) % options.length;
				return;
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				accept();
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				close();
				return;
			}
		}

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
			class="relative rounded-xl border border-line-strong bg-paper-raised shadow-[0_1px_0_rgba(0,0,0,0.04)] transition-colors focus-within:border-olive/60"
		>
			<!--
				The menus sit above the card, anchored to its top edge. They are
				rendered here rather than in a portal so the composer owns the
				trigger state; the card's `relative` is the positioning context.
			-->
			{#if open && trigger}
				<div class="absolute inset-x-0 bottom-full z-20 mb-2 flex justify-center">
					{#if trigger.kind === 'command'}
						<CommandMenu
							commands={options as SlashCommand[]}
							query={trigger.query}
							{active}
							onhover={(index) => (active = index)}
							onaccept={() => accept()}
						/>
					{:else}
						<MentionMenu
							entries={options as FileEntry[]}
							query={trigger.query}
							{active}
							onhover={(index) => (active = index)}
							onaccept={() => accept()}
						/>
					{/if}
				</div>
			{/if}

			<textarea
				bind:this={textarea}
				use:autosize
				bind:value={draft}
				{onkeydown}
				oninput={onedit}
				onclick={sync}
				onkeyup={sync}
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
