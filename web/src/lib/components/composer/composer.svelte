<script lang="ts">
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import SquareIcon from '@lucide/svelte/icons/square';
	import XIcon from '@lucide/svelte/icons/x';
	import { tick } from 'svelte';
	import * as Attachment from '#lib/components/ui/attachment/index.js';
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
		attachmentFromFile,
		attachmentMeta,
		nextAttachmentId,
		pastedName,
		promptBlocks,
		shouldAttachText,
		type Attachment as ComposerAttachment
	} from '#lib/harness/attachments.js';
	import {
		filterCommands,
		filterEntries,
		insertEntry,
		triggerAt,
		type Trigger
	} from '#lib/harness/mentions.js';
	import { formatBytes } from '#lib/harness/format.js';
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
		enterToSend = true,
		mentionMenu = true,
		commandMenu = true,
		thresholdPercent,
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
		/** Whether Enter submits, or inserts a newline (Ctrl/Cmd+Enter still sends). */
		enterToSend?: boolean;
		/** Whether `@` opens the file menu. */
		mentionMenu?: boolean;
		/** Whether `/` opens the command menu. */
		commandMenu?: boolean;
		/** Where the context meter turns amber; the settings dialog's value. */
		thresholdPercent?: number;
		/**
		 * Send the draft and its attachments.
		 *
		 * `blocks` is already in wire shape (`text`, `image`, `resource`), built
		 * by `promptBlocks` so the ordering rule lives in one tested place. A
		 * transport that only speaks text ignores it and uses `text`.
		 */
		onsend: (text: string, blocks?: unknown[]) => void;
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
	let fileInput: HTMLInputElement | null = $state(null);

	/**
	 * Pasted or dropped material, held until the prompt is sent.
	 *
	 * A long log or a screenshot is not a good fit for the textarea: the first
	 * buries the question under its own data, and the second cannot be typed at
	 * all. Both become blocks on the wire instead (`attachments.ts`), and this
	 * list is what the reader sees and can remove before sending.
	 */
	let attachments = $state<ComposerAttachment[]>([]);

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

	const canSend = $derived((draft.trim().length > 0 || attachments.length > 0) && !busy);

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
		/**
		 * A disabled menu is not a closed menu: the token stays as plain text
		 * and nothing is inserted on Enter, so `/model` or `@src/x.ts` typed
		 * with the menus off is sent literally — which is what a reader who
		 * turned them off asked for.
		 */
		const allowed =
			next === null ||
			(next.kind === 'command' && commandMenu) ||
			(next.kind === 'mention' && mentionMenu);
		const usable = allowed ? next : null;
		// A closed menu reopens only on a fresh trigger, so Escape is sticky
		// until the reader edits the token again.
		if (usable?.kind !== trigger?.kind || usable?.start !== trigger?.start) active = 0;
		trigger = usable;
		if (usable?.kind === 'mention') {
			// The first `@` of a session has nothing to show yet: the listing is
			// an RPC, and `files` only carries whatever the page seeded. Ask for
			// the workspace root once, lazily, so opening the menu is not a
			// startup cost.
			if (browsing === undefined && listing.length === 0) void loadRoot();
			void refreshMatches(usable.query);
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
		onsend(draft, promptBlocks(draft, attachments));
		releasePreviews();
		draft = '';
		attachments = [];
		close();
		void tick().then(() => textarea?.focus());
	}

	/**
	 * A paste that is a picture, or a chunk of a file, becomes an attachment.
	 *
	 * The clipboard's `text/plain` and `files` are both inspected, and files
	 * win: a screenshot copied out of a browser carries the image AND a
	 * `text/html` caption, and inserting the caption as text beside the
	 * picture is noise. `preventDefault` only fires when something was
	 * consumed, so an ordinary sentence paste still goes through the browser's
	 * own insertion (undo stack, caret handling and all).
	 */
	async function onpaste(event: ClipboardEvent) {
		const data = event.clipboardData;
		if (!data) return;

		const files = [...data.files].filter((file) => file.size > 0);
		const text = data.getData('text/plain');
		// A pasted path is a mention the reader wants in the text, not a file
		// to attach: `@`-style drops come through `drop`, and a bare path from
		// the terminal is something the agent resolves itself.
		const looksLikePath = /^\s*(?:file:\/\/|(?:[A-Za-z]:)?[\\/]|\.\.?[\\/])/.test(text);

		if (files.length > 0) {
			event.preventDefault();
			for (const file of files) await attachFile(file);
			return;
		}

		if (text.length > 0 && !looksLikePath && shouldAttachText(text)) {
			event.preventDefault();
			addAttachment({
				id: nextAttachmentId(attachments),
				kind: 'text',
				name: pastedName(attachments),
				data: text,
				bytes: new Blob([text]).size
			});
			return;
		}

		// Everything else is the browser's own paste. Re-sync so a `/` or `@`
		// the insert introduced opens its menu; the input event is what
		// normally does that, and `preventDefault` was not called here.
		void tick().then(sync);
	}

	/** Drop files or text from the OS; a directory drop is refused quietly. */
	async function ondrop(event: DragEvent) {
		const files = [...(event.dataTransfer?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		for (const file of files) await attachFile(file);
	}

	function ondragover(event: DragEvent) {
		// Only claim the drop when files are actually offered, so dragging
		// selected text inside the textarea keeps working.
		if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
	}

	/**
	 * Read a `File` (a paste or a drop) into an attachment.
	 *
	 * `attachmentFromFile` is the harness-side decoder (image vs text, base64,
	 * thresholds); this only adds the per-draft identity it cannot know.
	 */
	async function attachFile(file: File) {
		const attachment = await attachmentFromFile(file);
		if (!attachment) return;
		// A dropped/pasted file has no stable id of its own; the terminator in
		// `nextAttachmentId` is what keeps two same-named drops apart.
		addAttachment({
			...attachment,
			id: nextAttachmentId(attachments),
			name: uniqueName(attachment.name, attachments)
		});
	}

	function uniqueName(name: string, existing: ComposerAttachment[]): string {
		if (!existing.some((attachment) => attachment.name === name)) return name;
		const dot = name.lastIndexOf('.');
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : '';
		let index = 2;
		while (existing.some((attachment) => attachment.name === `${stem}-${index}${ext}`)) index += 1;
		return `${stem}-${index}${ext}`;
	}

	function addAttachment(attachment: ComposerAttachment) {
		attachments = [...attachments, attachment];
		void tick().then(() => textarea?.focus());
	}

	function removeAttachment(id: string) {
		const target = attachments.find((attachment) => attachment.id === id);
		if (target?.preview) URL.revokeObjectURL(target.preview);
		attachments = attachments.filter((attachment) => attachment.id !== id);
		void tick().then(() => textarea?.focus());
	}

	/** Data URLs are cheap; blob URLs from a drop are not and must be freed. */
	function releasePreviews() {
		for (const attachment of attachments) {
			if (attachment.preview?.startsWith('blob:')) URL.revokeObjectURL(attachment.preview);
		}
	}

	function pickFiles(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		void Promise.all(files.map((file) => attachFile(file)));
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

		// Backspace on an empty draft removes the last attachment, the same
		// gesture every chat composer uses. Guarded on an empty draft so it
		// never eats a character the reader is deleting.
		if (
			event.key === 'Backspace' &&
			draft.length === 0 &&
			attachments.length > 0 &&
			!event.isComposing
		) {
			event.preventDefault();
			removeAttachment(attachments[attachments.length - 1].id);
			return;
		}

		if (event.key !== 'Enter' || event.isComposing) return;

		/**
		 * Shift+Enter always inserts a newline; Enter's meaning is a setting.
		 *
		 * `enter_to_send = false` makes Enter a newline too, which is what a
		 * reader who writes multi-paragraph prompts wants — and then the only
		 * way to send is the button (or Ctrl/Cmd+Enter, which always sends).
		 * Without that modifier the setting would leave a reader with no
		 * keyboard path to send at all.
		 */
		if (event.shiftKey) return;
		if (!enterToSend && !(event.ctrlKey || event.metaKey)) return;

		event.preventDefault();
		form?.requestSubmit();
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
			role="group"
			aria-label="Message composer"
			{ondrop}
			{ondragover}
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
				{onpaste}
				oninput={onedit}
				onclick={sync}
				onkeyup={sync}
				rows="1"
				placeholder="Ask anything · @ to mention anything · / to use a skill"
				aria-label="Message"
				class="block max-h-52 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary/80"
			></textarea>

			{#if attachments.length > 0}
				<!--
					The strip goes UNDER the field and inside the card: it is part
					of the draft, and a chip floating above the composer would read
					as belonging to the thread.
				-->
				<div class="flex flex-wrap gap-1.5 px-3 pt-2 pb-1">
					{#each attachments as attachment (attachment.id)}
						<Attachment.Root size="xs" class="border-line bg-paper">
							<Attachment.Media
								variant={attachment.kind === 'image' ? 'image' : 'icon'}
								class="bg-paper-card"
							>
								{#if attachment.kind === 'image' && attachment.preview}
									<img src={attachment.preview} alt={attachment.name} />
								{:else}
									<FileTextIcon class="text-ink-tertiary" />
								{/if}
							</Attachment.Media>
							<Attachment.Content>
								<Attachment.Title class="text-[11.5px]">{attachment.name}</Attachment.Title>
								<Attachment.Description class="text-[10px]">
									{attachmentMeta(attachment)}
									·
									{formatBytes(attachment.bytes)}
								</Attachment.Description>
							</Attachment.Content>
							<Attachment.Actions>
								<Attachment.Action
									aria-label={`Remove ${attachment.name}`}
									onclick={() => removeAttachment(attachment.id)}
								>
									<XIcon class="size-3" />
								</Attachment.Action>
							</Attachment.Actions>
						</Attachment.Root>
					{/each}
				</div>
			{/if}

			<div class="flex items-center gap-1 px-2 pt-1 pb-2">
				<!--
					The picker is a real file input: `<input type="file">` is the
					one control that reaches the reader's disk without a native
					dialog in the server, and its value is cleared after every
					pick so the same file can be attached twice in a row.
				-->
				<input
					bind:this={fileInput}
					type="file"
					multiple
					class="hidden"
					onchange={pickFiles}
					aria-hidden="true"
					tabindex="-1"
				/>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-paper-card hover:text-ink"
								aria-label="Attach files"
								onclick={() => fileInput?.click()}
							>
								<PaperclipIcon class="size-4" />
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>
						<p>Attach files · or paste an image or a long log</p>
					</Tooltip.Content>
				</Tooltip.Root>

				<AccessPicker access={context.access} onchange={onaccess} />

				<div class="ml-auto flex items-center gap-1.5">
					<ModelPicker {models} {model} {effort} {onmodel} {oneffort} />

					<ContextMeter {usage} {thresholdPercent} onopen={() => onrefreshcontext?.()} />

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
