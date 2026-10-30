<script lang="ts">
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SaveIcon from '@lucide/svelte/icons/save';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { activeTheme, languageFor, loadMonaco } from '#lib/editor.js';
	import { fileName } from '#lib/harness/format.js';
	import { sortEntries } from '#lib/harness/mentions.js';
	import type { FileEntry } from '#lib/harness/types.js';
	import { cn } from '#lib/utils.js';
	import FileTree from './file-tree.svelte';
	import { extensionOf } from './panel-data.js';

	/**
	 * A workspace editor: a file tree, open tabs, and Monaco.
	 *
	 * The shape is VS Code's, because that is the shape a reader already knows:
	 * click a file in the tree, it opens in a tab, edit it, save with the button
	 * (or Ctrl/Cmd+S), close the tab when done. `alnair-ai`'s
	 * `ChatEditorDrawer` does the same, and for the same reason — a file the
	 * agent just changed is the thing a reader most often wants to open, and a
	 * read-only preview cannot answer "let me fix that one line".
	 *
	 * Tabs are keyed by PATH, not by index, and each keeps its own unsaved
	 * buffer: switching tabs must not discard an edit, and saving one file must
	 * not save another.
	 */
	let {
		openFile,
		onbrowse,
		onsearch,
		onread,
		onwrite,
		/**
		 * The workspace directory the tree browses.
		 *
		 * Passed rather than read from a store: it is also the reload key. The
		 * drawer keeps this pane mounted from page load, so the first `onMount`
		 * ran while the session was still `connecting` and `cwd` was empty —
		 * `fs/list` answered nothing, and the tree stayed empty for the whole
		 * session because nothing ever asked again.
		 */
		root,
		/** Whether this pane is the one on screen in the drawer. */
		visible = true
	}: {
		/** A path the caller wants opened (a click in the Files tab, a mention). */
		openFile?: string;
		/** `alnair/fs/list`, for the tree. */
		onbrowse: (path: string) => Promise<FileEntry[]>;
		/** `alnair/fs/search`, for the filter box. */
		onsearch: (query: string) => Promise<FileEntry[]>;
		/** `alnair/fs/read_file`. */
		onread: (path: string) => Promise<{ text?: string } | undefined>;
		/** `alnair/fs/write_file`; absent makes the editor read-only. */
		onwrite?: (path: string, text: string) => Promise<void>;
		root?: string;
		visible?: boolean;
	} = $props();

	interface OpenTab {
		path: string;
		/** The buffer as edited. */
		content: string;
		/** The text as last read or written, for the dirty dot. */
		saved: string;
		language: string;
		loading: boolean;
		error?: string;
	}

	let tabs = $state<OpenTab[]>([]);
	let activePath = $state<string | undefined>(undefined);
	let treeOpen = $state(true);
	let query = $state('');
	let results = $state<FileEntry[]>([]);
	let searching = $state(false);
	let saving = $state(false);
	let saveError = $state<string | undefined>(undefined);

	let rootEntries = $state<FileEntry[]>([]);
	let rootLoading = $state(false);

	let host: HTMLDivElement | null = $state(null);

	interface MonacoEditor {
		dispose(): void;
		setValue(value: string): void;
		getValue(): string;
		updateOptions(options: Record<string, unknown>): void;
		focus(): void;
		layout(): void;
		onDidChangeModelContent(listener: () => void): { dispose(): void };
	}
	let editor: MonacoEditor | undefined;
	let ready = $state(false);
	let editorError = $state<string | undefined>(undefined);

	const active = $derived(tabs.find((tab) => tab.path === activePath));
	const dirty = $derived(tabs.some((tab) => tab.content !== tab.saved));

	/** The workspace root listing. */
	async function loadRoot() {
		if (rootLoading) return;
		rootLoading = true;
		try {
			rootEntries = sortEntries(await onbrowse(''));
		} catch {
			rootEntries = [];
		} finally {
			rootLoading = false;
		}
	}

	/**
	 * Load the tree when the workspace becomes known.
	 *
	 * Keyed on `root` rather than run once on mount: the drawer keeps this pane
	 * mounted from page load, so the first render happens while the session is
	 * still `connecting` and `cwd` is empty — `fs/list` answers nothing, and the
	 * tree stayed empty for the whole session because nothing asked again.
	 *
	 * A DIFFERENT root also invalidates the open tabs: their paths are relative
	 * to the old repository, so keeping them would open the wrong file.
	 */
	let loadedFor = $state<string | undefined>(undefined);
	$effect(() => {
		const workspace = root;
		if (!workspace || workspace === loadedFor) return;
		loadedFor = workspace;
		tabs = [];
		activePath = undefined;
		rootEntries = [];
		void loadRoot();
	});

	/** Open a file in a tab, reading it once. */
	async function open(path: string) {
		const existing = tabs.find((tab) => tab.path === path);
		activePath = path;
		if (existing) return;

		const tab: OpenTab = {
			path,
			content: '',
			saved: '',
			language: languageFor(extensionOf(path)),
			loading: true
		};
		tabs = [...tabs, tab];

		try {
			const preview = await onread(path);
			// The tab may have been closed while the read was in flight.
			if (!tabs.some((candidate) => candidate.path === path)) return;
			const text = preview?.text ?? '';
			tabs = tabs.map((candidate) =>
				candidate.path === path
					? { ...candidate, content: text, saved: text, loading: false }
					: candidate
			);
		} catch (cause) {
			tabs = tabs.map((candidate) =>
				candidate.path === path
					? {
							...candidate,
							loading: false,
							error: cause instanceof Error ? cause.message : 'the file could not be read'
						}
					: candidate
			);
		}
	}

	function close(path: string) {
		const index = tabs.findIndex((tab) => tab.path === path);
		tabs = tabs.filter((tab) => tab.path !== path);
		if (activePath !== path) return;
		// Focus the neighbour, the way every editor does.
		activePath = tabs[index]?.path ?? tabs[index - 1]?.path;
	}

	async function reload() {
		const path = activePath;
		if (!path) return;
		saveError = undefined;
		try {
			const preview = await onread(path);
			const text = preview?.text ?? '';
			tabs = tabs.map((tab) =>
				tab.path === path ? { ...tab, content: text, saved: text, error: undefined } : tab
			);
		} catch (cause) {
			saveError = cause instanceof Error ? cause.message : 'the file could not be read';
		}
	}

	async function save() {
		const path = activePath;
		if (!path || !onwrite || saving) return;
		const tab = tabs.find((candidate) => candidate.path === path);
		if (!tab) return;
		saving = true;
		saveError = undefined;
		try {
			await onwrite(path, tab.content);
			tabs = tabs.map((candidate) =>
				candidate.path === path ? { ...candidate, saved: candidate.content } : candidate
			);
		} catch (cause) {
			saveError = cause instanceof Error ? cause.message : 'the save failed';
		} finally {
			saving = false;
		}
	}

	async function search() {
		const needle = query.trim();
		if (!needle) {
			results = [];
			return;
		}
		searching = true;
		try {
			results = await onsearch(needle);
		} catch {
			results = [];
		} finally {
			searching = false;
		}
	}

	/** The editor is built once and outlives every tab. */
	$effect(() => {
		if (!host || ready) return;
		void (async () => {
			try {
				const monaco = await loadMonaco();
				if (!host) return;
				editor = monaco.editor.create(host, {
					value: active?.content ?? '',
					language: active?.language ?? 'plaintext',
					readOnly: !onwrite,
					readOnlyMessage: { value: 'Read-only: this build cannot write files.' },
					theme: activeTheme(),
					minimap: { enabled: true },
					scrollBeyondLastLine: false,
					fontSize: 12,
					lineNumbersMinChars: 3,
					automaticLayout: true,
					renderLineHighlight: 'line',
					padding: { top: 8, bottom: 8 },
					scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
				});
				ready = true;
				editor.onDidChangeModelContent(() => {
					const path = activePath;
					if (!path || !editor) return;
					const value = editor.getValue();
					tabs = tabs.map((tab) => (tab.path === path ? { ...tab, content: value } : tab));
				});
			} catch (cause) {
				editorError = cause instanceof Error ? cause.message : 'the editor failed to load';
			}
		})();
	});

	/** Swap the buffer when the active tab changes. */
	$effect(() => {
		const next = active?.content;
		if (!ready || !editor || next === undefined) return;
		if (editor.getValue() === next) return;
		editor.setValue(next);
	});

	/** Follow the app's light/dark toggle. */
	$effect(() => {
		if (!ready || !editor) return;
		const observer = new MutationObserver(() => editor?.updateOptions({ theme: activeTheme() }));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
		return () => observer.disconnect();
	});

	/**
	 * Re-layout when the pane becomes visible again.
	 *
	 * `automaticLayout` watches the host with a ResizeObserver, and a host that
	 * was `display:none` reports zero: Monaco keeps the last size it saw and
	 * renders a single collapsed line until something resizes it. Showing the
	 * pane is that something, and the layout has to wait a frame for the host to
	 * have a size again.
	 */
	$effect(() => {
		if (!visible || !ready || !editor) return;
		requestAnimationFrame(() => editor?.layout());
	});

	/** A path the caller asked to open, e.g. a click in the Files list. */
	$effect(() => {
		if (!openFile) return;
		void open(openFile);
	});

	/** Ctrl/Cmd+S saves. Registered on the document so it works while focused. */
	function onkeydown(event: KeyboardEvent) {
		if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
		// Only while this pane is on screen: a global handler that saved on
		// every Cmd+S in the page would fire while the composer had focus.
		if (!host?.isConnected) return;
		event.preventDefault();
		void save();
	}

	const visibleEntries = $derived(query.trim() ? results : rootEntries);
</script>

<svelte:window {onkeydown} />

<div class="flex min-h-0 flex-1" data-slot="editor-pane">
	<!-- The tree. Collapsible, because a narrow window needs the width back. -->
	{#if treeOpen}
		<aside class="flex w-56 shrink-0 flex-col border-r border-line">
			<div class="flex shrink-0 items-center gap-1 px-2 py-1.5">
				<input
					bind:value={query}
					class="h-6 min-w-0 flex-1 rounded border border-line bg-paper px-1.5 font-mono text-[10.5px] text-ink outline-none placeholder:text-ink-tertiary/60 focus:border-olive/60"
					placeholder="Find file"
					aria-label="Find a file"
					spellcheck="false"
					oninput={() => void search()}
				/>
				<Button
					variant="ghost"
					size="icon-xs"
					class="shrink-0 text-ink-tertiary hover:text-ink"
					aria-label="Reload the file list"
					onclick={() => void loadRoot()}
				>
					<RefreshCwIcon class={rootLoading ? 'animate-spin' : ''} />
				</Button>
			</div>

			{#if root}
				<p class="truncate px-2 pb-1 font-mono text-[9.5px] text-ink-tertiary/70" title={root}>
					{root}
				</p>
			{/if}

			<div class="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
				{#if searching}
					<p class="flex items-center gap-1.5 px-1.5 py-2 text-[10.5px] text-ink-tertiary">
						<LoaderIcon class="size-3 animate-spin" />
						Searching…
					</p>
				{:else if rootLoading && visibleEntries.length === 0}
					<div class="flex flex-col gap-1.5 px-1.5 py-2">
						{#each [72, 54, 84, 46, 66] as width, index (index)}
							<span class="h-2.5 animate-pulse rounded-full bg-line/60" style="width: {width}%"
							></span>
						{/each}
					</div>
				{:else if visibleEntries.length === 0}
					<p class="px-1.5 py-2 text-[10.5px] leading-relaxed text-ink-tertiary">
						{query.trim()
							? 'No matching files.'
							: root
								? 'This directory is empty.'
								: 'Waiting for the session to load…'}
					</p>
				{:else}
					<FileTree
						entries={visibleEntries}
						{activePath}
						onopen={(path) => void open(path)}
						{onbrowse}
					/>
				{/if}
			</div>
		</aside>
	{/if}

	<section class="flex min-h-0 min-w-0 flex-1 flex-col">
		<!-- The tab strip, with the actions on its right. -->
		<div class="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1">
			<Button
				variant="ghost"
				size="icon-xs"
				class="shrink-0 text-ink-tertiary hover:text-ink"
				aria-label={treeOpen ? 'Hide the file tree' : 'Show the file tree'}
				onclick={() => (treeOpen = !treeOpen)}
			>
				<FolderOpenIcon />
			</Button>

			{#each tabs as tab (tab.path)}
				<div class="group/tab flex shrink-0 items-center">
					<button
						type="button"
						class={cn(
							'flex h-6 max-w-44 items-center gap-1.5 rounded px-2 text-[11px] transition-colors',
							tab.path === activePath
								? 'bg-paper-card text-ink'
								: 'text-ink-tertiary hover:bg-paper-card/60 hover:text-ink-secondary'
						)}
						title={tab.path}
						onclick={() => (activePath = tab.path)}
					>
						{#if tab.content !== tab.saved}
							<span class="size-1.5 shrink-0 rounded-full bg-terra" aria-label="Unsaved"></span>
						{/if}
						<span class="min-w-0 truncate font-mono">{fileName(tab.path)}</span>
					</button>
					<button
						type="button"
						class="-ml-1 flex size-4 shrink-0 items-center justify-center rounded text-ink-tertiary/0 transition-colors group-hover/tab:text-ink-tertiary hover:bg-paper hover:text-ink"
						aria-label={`Close ${fileName(tab.path)}`}
						onclick={() => close(tab.path)}
					>
						<XIcon class="size-2.5" />
					</button>
				</div>
			{/each}

			{#if tabs.length === 0}
				<p class="px-1.5 text-[10.5px] text-ink-tertiary">Open a file from the tree</p>
			{/if}

			<div class="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
				{#if saveError}
					<p class="max-w-40 truncate text-[10px] text-error">{saveError}</p>
				{/if}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-xs"
								class="text-ink-tertiary hover:text-ink"
								aria-label="Reload the file from disk"
								disabled={!active || active.loading}
								onclick={() => void reload()}
							>
								<RefreshCwIcon />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content><p>Reload from disk</p></Tooltip.Content>
				</Tooltip.Root>

				{#if onwrite}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant={active && active.content !== active.saved ? 'default' : 'ghost'}
									size="icon-xs"
									class="shrink-0"
									aria-label="Save the file"
									disabled={!active || active.content === active.saved || saving}
									onclick={() => void save()}
								>
									{#if saving}
										<LoaderIcon class="animate-spin" />
									{:else}
										<SaveIcon />
									{/if}
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content><p>Save · Ctrl/Cmd+S</p></Tooltip.Content>
					</Tooltip.Root>
				{/if}
			</div>
		</div>

		<!-- The editor surface. -->
		<div class="relative min-h-0 flex-1">
			{#if !active}
				<div class="flex h-full items-center justify-center px-6">
					<p class="max-w-sm text-center text-[11.5px] leading-relaxed text-ink-tertiary">
						Open a file from the tree, or pick one the thread touched. Edits are held in the tab
						until you save them.
					</p>
				</div>
			{:else if active.loading}
				<div class="flex h-full items-center justify-center gap-2 text-[11.5px] text-ink-tertiary">
					<LoaderIcon class="size-3.5 animate-spin" />
					Reading {fileName(active.path)}…
				</div>
			{:else if active.error}
				<div class="flex h-full items-center justify-center px-6">
					<p class="text-center text-[11.5px] text-terra">{active.error}</p>
				</div>
			{:else if editorError}
				<div class="flex h-full items-center justify-center px-6">
					<p class="text-center text-[11.5px] text-terra">{editorError}</p>
				</div>
			{/if}
			<!--
				The host stays mounted across every state above so Monaco is built
				once; it is hidden rather than unmounted while a file loads.
			-->
			<div
				bind:this={host}
				class={cn('absolute inset-0', (!active || active.loading || active.error) && 'invisible')}
				data-slot="monaco-host"
			></div>
		</div>
	</section>
</div>

{#if dirty}
	<span class="sr-only">Unsaved changes</span>
{/if}
