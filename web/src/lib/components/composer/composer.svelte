<script lang="ts">
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { tick } from 'svelte';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import type {
		AccessMode,
		BranchEntry,
		ComposerContext,
		ContextUsage,
		FileEntry,
		GitContext,
		ModelOption,
		SlashCommand,
		WorktreeEntry
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
		git,
		branches,
		worktrees,
		busy,
		commands = [],
		onsend,
		oncancel,
		onmodel,
		oneffort,
		onaccess,
		onbrowse,
		onsearch,
		onbranch,
		onworktree,
		onrefreshgit,
		onrefreshcontext
	}: {
		models: ModelOption[];
		model: string;
		effort: string;
		usage: ContextUsage;
		context: ComposerContext;
		/** The session's repository, when it has one. */
		git?: GitContext;
		branches?: BranchEntry[];
		worktrees?: WorktreeEntry[];
		busy: boolean;
		/** Commands the agent advertised; empty until it does. */
		commands?: SlashCommand[];
		onsend: (text: string) => void;
		oncancel: () => void;
		onmodel: (id: string) => void;
		oneffort: (effort: string) => void;
		onaccess: (mode: AccessMode) => void;
		/**
		 * List one directory, for the `@` menu's drill-down.
		 *
		 * Async because the listing is an RPC to the agent: the browser has no
		 * filesystem, and the menu must not block the keystroke on it.
		 */
		onbrowse?: (path: string) => Promise<FileEntry[]>;
		/**
		 * Ranked matches across the workspace, for a typed `@` query.
		 *
		 * This is the fuzzy search the TUI runs in-process; over the wire it is
		 * `alnair/fs/search`.
		 */
		onsearch?: (query: string) => Promise<FileEntry[]>;
		/** Check out a branch; `create` makes a new one at HEAD. */
		onbranch?: (name: string, create?: boolean) => void;
		/** Create a worktree from the current checkout. */
		onworktree?: (label: string, gitRef?: string) => void;
		/** Re-read the repository (branch, worktrees) from disk. */
		onrefreshgit?: () => void;
		/**
		 * Re-read the exact context snapshot (`alnair/session/info`).
		 *
		 * The ring's figure streams with the conversation, but the itemized
		 * breakdown — system prompt, tool definitions, turn and tool-call
		 * counters — only exists in the snapshot. Asking on open is what makes
		 * the panel describe the session now rather than when it attached.
		 */
		onrefreshcontext?: () => void;
	} = $props();

	let draft = $state('');
	let form: HTMLFormElement | null = $state(null);
	let textarea: HTMLTextAreaElement | null = $state(null);

	/** Which menu is open, what filters it, and which row is highlighted. */
	let trigger = $state<Trigger>(null);
	let active = $state(0);
	/** The directory the `@` menu is currently listing. */
	let browsing = $state<string | undefined>(undefined);
	/**
	 * The rows for the directory being browsed.
	 *
	 * Starts empty: the first `@` fetches the workspace root from the agent, so
	 * nothing has to be seeded up front and the menu can never show a listing
	 * the agent would not agree with.
	 */
	let listing = $state<FileEntry[]>([]);
	/**
	 * Set right after an insert: the text now ends in a valid mention token, so
	 * a naive re-sync would reopen the menu the reader just closed. Any further
	 * edit clears it.
	 */
	let suppress = $state(false);

	/**
	 * Results of the in-flight `@` query.
	 *
	 * A separate cell from `listing` because the two answer different
	 * questions: `listing` is "what is in this directory" (a drill-down), and
	 * this is "what matches what I typed" (a ranked search across the tree).
	 * When the query is empty the menu shows the listing; once it has text, the
	 * search wins.
	 */
	let matches = $state<FileEntry[]>([]);
	/** Guards against an older query's reply overwriting a newer one. */
	let searchSeq = 0;

	const canSend = $derived(draft.trim().length > 0 && !busy);

	const options = $derived.by(() => {
		if (trigger?.kind === 'command') return filterCommands(commands, trigger.query);
		if (trigger?.kind === 'mention') {
			const source = trigger.query.length > 0 && matches.length > 0 ? matches : listing;
			return filterEntries(source, trigger.query);
		}
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
		if (next?.kind === 'mention') {
			// The first `@` of a session has nothing to show yet: the listing is
			// an RPC, and `files` only carries whatever the page seeded. Ask for
			// the workspace root once, lazily, so opening the menu is not a
			// startup cost.
			if (browsing === undefined && listing.length === 0) void loadRoot();
			void refreshMatches(next.query);
		}
	}

	/** Fetch the workspace root listing the first time the menu needs it. */
	async function loadRoot() {
		if (!onbrowse) return;
		const children = await onbrowse('');
		// Only fill in if the reader has not already drilled elsewhere.
		if (browsing === undefined && listing.length === 0) listing = children;
	}

	/**
	 * Ask the agent for matches for the typed query.
	 *
	 * Empty query means "no search": the menu shows the directory listing,
	 * which is the pre-typed state. Each reply is tagged with the sequence it
	 * answered, so a slow reply for "co" cannot replace the rows for "comp".
	 */
	async function refreshMatches(query: string) {
		if (!onsearch || query.length === 0) {
			searchSeq += 1;
			matches = [];
			return;
		}
		const seq = ++searchSeq;
		const found = await onsearch(query);
		if (seq !== searchSeq) return;
		matches = found;
	}

	/** Called on every edit: a fresh keystroke lifts the post-insert mute. */
	function onedit() {
		suppress = false;
		sync();
	}

	function close() {
		trigger = null;
		browsing = undefined;
		matches = [];
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
			// The listing is an RPC, so the token is rewritten immediately and
			// the rows fill in when the agent answers.
			browsing = entry.path;
			matches = [];
			listing = [];
			draft = `${draft.slice(0, trigger.start)}@${entry.path}/${draft.slice(trigger.end)}`;
			trigger = {
				kind: 'mention',
				query: `${entry.path}/`,
				start: trigger.start,
				end: trigger.start + entry.path.length + 2
			};
			active = 0;
			const path = entry.path;
			void onbrowse?.(path).then((children) => {
				// A drill-down that resolved after the menu moved on must not
				// replace the rows for whatever is showing now.
				if (browsing === path) listing = children;
			});
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

					<ContextMeter {usage} onopen={() => onrefreshcontext?.()} />

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

		<CheckoutBar
			{context}
			{git}
			branches={branches ?? []}
			worktrees={worktrees ?? []}
			onbranch={(name, create) => onbranch?.(name, create)}
			onworktree={(label, ref) => onworktree?.(label, ref)}
			onrefreshgit={() => onrefreshgit?.()}
		/>
	</form>
</div>
