<script lang="ts">
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import { tick } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { formatRelative } from '#lib/harness/format.js';
	import {
		flatSessions,
		SIDEBAR_LAYOUTS,
		statusGroups,
		workspaceLabelOf,
		type SidebarLayout
	} from '#lib/harness/sidebar-layout.js';
	import type { Session, WorkspaceGroup } from '#lib/harness/types.js';
	import Logo from './logo.svelte';
	import StatusDot from './status-dot.svelte';

	/**
	 * The session list, nested the way the backend models it: one row per
	 * workspace, its conversations underneath.
	 *
	 * Three things are deliberately separate here, because conflating them is
	 * what made the old sidebar confusing:
	 *
	 * - **Adding a workspace** is the header's `+`. It asks the machine for a
	 *   directory with the OS's own dialog and starts a session there — that is
	 *   what makes the directory a workspace the backend knows about.
	 * - **Removing a workspace** hides the group. Nothing on disk is touched,
	 *   and it can be brought back, so it needs no confirmation.
	 * - **Deleting a session** destroys a transcript, so it goes through a
	 *   dialog. The previous two-click arm inside the dropdown could never be
	 *   completed: the menu closes on the first click, so the second one had
	 *   nowhere to land and delete silently did nothing.
	 */
	let {
		groups,
		activeId,
		hidden,
		layout = 'workspace',
		allSessions = [],
		onlayout,
		onselect,
		onrename,
		ondelete,
		oncreate,
		onaddworkspace,
		onremoveworkspace,
		onrestoreworkspace,
		onerror,
		onsettings
	}: {
		groups: WorkspaceGroup[];
		activeId: string;
		/** Workspaces the reader put away; offered back in the footer. */
		hidden: string[];
		/** How to arrange the list; the reader picks it from the header. */
		layout?: SidebarLayout;
		/**
		 * Every session, for the status and flat layouts.
		 *
		 * `groups` is already the workspace shape, but the status layout needs
		 * the rows flat — a session's bucket has nothing to do with which repo
		 * it lives in, and re-flattening the groups here would be a second
		 * definition of "all sessions" that could disagree with the store's.
		 */
		allSessions?: Session[];
		onlayout?: (layout: SidebarLayout) => void;
		onselect: (id: string) => void;
		onrename: (id: string, title: string) => void | Promise<void>;
		ondelete: (id: string) => void | Promise<void>;
		oncreate: (cwd: string) => void | Promise<void>;
		/**
		 * Open the native folder picker and start a session there.
		 *
		 * `path` skips the dialog, for the typed-path fallback.
		 */
		onaddworkspace: (path?: string) => void | Promise<void>;
		onremoveworkspace: (name: string) => void;
		onrestoreworkspace: (name: string) => void;
		/** Report a refusal the caller could not apply (a blank title, …). */
		onerror: (message: string) => void;
		onsettings: () => void;
	} = $props();

	/** Groups start open when they hold the active session or have live work. */
	let collapsed = $state<Record<string, boolean>>({});

	const isOpen = (group: WorkspaceGroup) =>
		collapsed[group.name] !== undefined
			? !collapsed[group.name]
			: group.active || group.sessions.some((session) => session.id === activeId);

	function toggle(name: string, open: boolean) {
		collapsed = { ...collapsed, [name]: open };
	}

	/** `both` means the session exists locally and in the remote registry. */
	const sourceLabel = (session: Session) =>
		session.source === 'both' ? 'synced' : session.source === 'remote' ? 'remote' : undefined;

	const total = $derived(groups.reduce((count, group) => count + group.sessions.length, 0));

	/** The status layout's buckets, newest first inside each. */
	const byStatus = $derived(statusGroups(allSessions));

	/** The flat layout's one list, newest first. */
	const flat = $derived(flatSessions(allSessions));

	/**
	 * The workspaces a new session can be started in, for the `+` menu.
	 *
	 * Derived from the same list the sidebar paints, so a directory the reader
	 * just added is offered immediately rather than only after a session
	 * exists in it. A group with no path cannot host a session and is left out.
	 */
	const startable = $derived(groups.filter((group) => Boolean(group.path)));

	/** The layout's own name, for the header control's label. */
	const layoutLabel = $derived(
		SIDEBAR_LAYOUTS.find((entry) => entry.value === layout)?.label ?? 'By workspace'
	);

	/** The id being renamed, and the draft. One at a time — two would race. */
	let renaming = $state<string | undefined>(undefined);
	let draft = $state('');
	let renameInput: HTMLInputElement | null = $state(null);

	/**
	 * The session armed for deletion, shown in the confirmation dialog.
	 *
	 * A dialog rather than an armed menu item: the dropdown closes as soon as
	 * an item is chosen, so a "click again" state inside it is unreachable with
	 * a mouse. The dialog also has room to say what will actually happen.
	 */
	let pendingDelete = $state<Session | undefined>(undefined);
	let deleteOpen = $state(false);
	let deleting = $state(false);
	/** Why the last attempt failed, kept beside the button that failed. */
	let deleteError = $state<string | undefined>(undefined);

	function startRename(session: Session) {
		renaming = session.id;
		draft = session.title;
		void tick().then(() => {
			renameInput?.focus();
			renameInput?.select();
		});
	}

	function commitRename() {
		const id = renaming;
		const next = draft.trim();
		renaming = undefined;
		if (!id) return;
		if (!next) {
			onerror('A session title cannot be blank.');
			return;
		}
		void onrename(id, next);
	}

	function cancelRename() {
		renaming = undefined;
		draft = '';
	}

	function requestDelete(session: Session) {
		pendingDelete = session;
		deleteError = undefined;
		deleteOpen = true;
	}

	async function confirmDelete() {
		const session = pendingDelete;
		if (!session || deleting) return;
		deleting = true;
		deleteError = undefined;
		try {
			await ondelete(session.id);
			deleteOpen = false;
			pendingDelete = undefined;
		} catch (error) {
			// Keep the dialog open with the reason: the row is already back in
			// the list, so closing here would look like a silent no-op.
			deleteError = error instanceof Error ? error.message : 'the agent refused';
		} finally {
			deleting = false;
		}
	}

	/** The directory a new session in this group should use. */
	function groupCwd(group: WorkspaceGroup): string {
		return group.sessions.find((session) => session.id === activeId)?.cwd ?? group.path ?? '';
	}

	function createIn(group: WorkspaceGroup) {
		const cwd = groupCwd(group);
		if (!cwd) {
			onerror('This workspace has no directory to start a session in.');
			return;
		}
		void oncreate(cwd);
	}

	/** An in-flight native dialog, so the button can say so. */
	let adding = $state(false);
	/** The typed-path fallback, shown when the native dialog cannot open. */
	let pathOpen = $state(false);
	let pathDraft = $state('');
	let pathError = $state<string | undefined>(undefined);
	let addingPath = $state(false);
	let pathInput: HTMLInputElement | null = $state(null);

	/**
	 * Ask for a directory, and never fail silently.
	 *
	 * The `+` menu's "Choose another folder…" opens the native dialog — the
	 * ordinary gesture. The dialog is not always available: a headless
	 * `alnair web` has no desktop to draw on, a second concurrent request is
	 * refused (`picker::OPEN` allows one dialog at a time), and a release build
	 * rejects a dev-server Origin outright. Those used to surface as nothing at
	 * all — the button spun and stopped — which reads as a broken control. So a
	 * refusal opens the typed-path dialog instead, and only an explicit Cancel
	 * ends the action.
	 */
	async function browseForWorkspace() {
		if (adding) return;
		adding = true;
		pathError = undefined;
		try {
			await onaddworkspace();
		} catch (error) {
			pathError = error instanceof Error ? error.message : 'the folder picker failed';
			openPathDialog();
		} finally {
			adding = false;
		}
	}

	function openPathDialog() {
		pathDraft = pathDraft || defaultBase();
		pathOpen = true;
		void tick().then(() => {
			pathInput?.focus();
			pathInput?.select();
		});
	}

	/**
	 * A starting point for the typed path.
	 *
	 * The active session's own directory is the only absolute path this page
	 * knows, and a reader adding a workspace is usually doing it next to one
	 * they already have open.
	 */
	function defaultBase(): string {
		const active = groups
			.flatMap((group) => group.sessions)
			.find((session) => session.id === activeId);
		return active?.cwd ?? groups.find((group) => group.path)?.path ?? '';
	}

	async function submitPath() {
		const path = pathDraft.trim();
		if (!path || addingPath) return;
		addingPath = true;
		pathError = undefined;
		try {
			await onaddworkspace(path);
			pathOpen = false;
			pathDraft = '';
		} catch (error) {
			pathError = error instanceof Error ? error.message : 'that directory could not be opened';
		} finally {
			addingPath = false;
		}
	}
</script>

<!--
	One session row, shared by all three layouts.

	A snippet rather than three copies: the row carries rename, the actions
	menu and the status dot, and three diverging copies is how one layout ends
	up without a control the others have.

	`showWorkspace` adds the repo name under the title. The workspace layout
	does not need it — the group header above already says which repo this is —
	but the status and flat layouts do, or the reader loses the one piece of
	context the grouping used to provide.
-->
{#snippet sessionRow(session: Session, showWorkspace = false)}
	{@const active = session.id === activeId}
	{@const source = sourceLabel(session)}
	{@const isRenaming = renaming === session.id}
	<li>
		{#if isRenaming}
			<div class="flex items-center gap-1 rounded-md bg-paper-card px-2 py-1">
				<input
					bind:this={renameInput}
					bind:value={draft}
					class="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none"
					aria-label="Session title"
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							commitRename();
						} else if (event.key === 'Escape') {
							event.preventDefault();
							cancelRename();
						}
					}}
					onblur={() => commitRename()}
				/>
				<button
					type="button"
					class="flex size-4 shrink-0 items-center justify-center rounded text-olive hover:bg-paper"
					aria-label="Save title"
					onmousedown={(event) => event.preventDefault()}
					onclick={commitRename}
				>
					<CheckIcon class="size-3" />
				</button>
				<button
					type="button"
					class="flex size-4 shrink-0 items-center justify-center rounded text-ink-tertiary hover:bg-paper hover:text-ink"
					aria-label="Cancel rename"
					onmousedown={(event) => event.preventDefault()}
					onclick={cancelRename}
				>
					<XIcon class="size-3" />
				</button>
			</div>
		{:else}
			<div
				class={[
					'group/row relative flex w-full items-center gap-1 rounded-md transition-colors',
					active ? 'bg-paper-card' : 'hover:bg-paper-card/60'
				]}
			>
				<button
					type="button"
					class="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left"
					onclick={() => onselect(session.id)}
					aria-current={active ? 'true' : undefined}
					data-session-id={session.id}
				>
					<span class="flex items-center gap-1.5">
						<MessageSquareIcon
							class={['size-3 shrink-0', active ? 'text-olive' : 'text-ink-tertiary/60']}
						/>
						<span
							class="min-w-0 flex-1 truncate text-[12px] leading-snug"
							class:font-medium={active}
							class:text-ink={active}
							class:text-ink-secondary={!active}
						>
							{session.title}
						</span>
						{#if session.status === 'running'}
							<StatusDot status="running" pulse class="shrink-0" />
						{:else if session.status === 'attention'}
							<span class="size-1.5 shrink-0 rounded-full bg-terra" title="Needs input"></span>
						{/if}
					</span>
					<span class="flex items-center gap-1.5 pl-4.5 text-[10px] text-ink-tertiary">
						{#if showWorkspace}
							<span class="min-w-0 truncate font-mono">{workspaceLabelOf(session)}</span>
							<span class="shrink-0 opacity-40">·</span>
						{/if}
						<span class="tabular shrink-0">
							{formatRelative(session.updatedAt)}
						</span>
						{#if session.worktree}
							<span class="shrink-0 rounded-sm bg-paper px-1 font-mono text-[9px]"> worktree </span>
						{/if}
						{#if source}
							<span class="shrink-0 rounded-sm bg-paper px-1 font-mono text-[9px]">
								{source}
							</span>
						{/if}
					</span>
				</button>

				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-ink-tertiary/0 transition-colors group-hover/row:text-ink-tertiary hover:bg-paper hover:text-ink"
								aria-label={`Session actions: ${session.title}`}
							>
								<MoreHorizontalIcon class="size-3.5" />
							</button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start" class="w-52">
						<DropdownMenu.Label class="truncate font-mono text-[10.5px]">
							{session.id.slice(0, 8)} · {session.modelId ?? 'model unknown'}
						</DropdownMenu.Label>
						<DropdownMenu.Separator />
						<DropdownMenu.Item onclick={() => startRename(session)}>
							<PencilIcon class="size-3.5" />
							Rename
						</DropdownMenu.Item>
						<DropdownMenu.Item variant="destructive" onclick={() => requestDelete(session)}>
							<TrashIcon class="size-3.5" />
							Delete session…
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							onclick={() => {
								if (session.cwd) void oncreate(session.cwd);
							}}
						>
							<PlusIcon class="size-3.5" />
							New session in this directory
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		{/if}
	</li>
{/snippet}

<aside class="rule-r flex h-full w-64 shrink-0 flex-col bg-paper-raised">
	<div class="flex items-center gap-2 px-4 pt-4 pb-3">
		<Logo size={26} class="text-ink" />
		<div class="min-w-0">
			<p class="text-[15px] leading-none font-medium tracking-tight">Alnair</p>
			<p class="mt-1 text-[10.5px] leading-none text-ink-tertiary">web harness · live</p>
		</div>
	</div>

	<nav class="mt-1 flex min-h-0 flex-1 flex-col">
		<div class="flex items-center justify-between px-4 pt-1 pb-2">
			<!--
				The layout picker doubles as the section label. A reader who
				never opens it still learns what the list is grouped by, and
				switching is one click from where they are looking rather than
				three through Settings.
			-->
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							type="button"
							class="flex min-w-0 items-center gap-1 rounded text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase transition-colors hover:text-ink"
							aria-label={`Sidebar layout: ${layoutLabel}`}
						>
							<span class="truncate">{layoutLabel}</span>
							<ChevronRightIcon class="size-2.5 shrink-0 rotate-90 opacity-60" />
						</button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-56">
					<DropdownMenu.Label>Arrange sessions</DropdownMenu.Label>
					<DropdownMenu.Separator />
					{#each SIDEBAR_LAYOUTS as option (option.value)}
						<DropdownMenu.Item onclick={() => onlayout?.(option.value)}>
							<span class="flex min-w-0 flex-1 flex-col">
								<span>{option.label}</span>
								<span class="text-[10.5px] text-ink-tertiary">{option.hint}</span>
							</span>
							{#if option.value === layout}
								<CheckIcon class="size-3.5 shrink-0 text-olive" />
							{/if}
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<div class="flex items-center gap-1">
				<span class="tabular font-mono text-[10px] text-ink-tertiary/70">{total}</span>
				<!--
					`+` is a MENU, not a bare picker: a new session needs a
					directory, and the reader usually wants one they already have
					open rather than a fresh browse. "Choose another folder…"
					keeps the old behaviour one item down.
				-->
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="flex size-5 items-center justify-center rounded text-ink-tertiary transition-colors hover:bg-paper-card hover:text-ink disabled:opacity-50"
								aria-label="New session"
								disabled={adding}
							>
								{#if adding}
									<span
										class="size-2.5 animate-spin rounded-full border border-ink-tertiary border-t-transparent"
									></span>
								{:else}
									<PlusIcon class="size-3.5" />
								{/if}
							</button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-64">
						<DropdownMenu.Label>New session in…</DropdownMenu.Label>
						<DropdownMenu.Separator />
						{#if startable.length === 0}
							<DropdownMenu.Item disabled>
								<span class="text-[11px] text-ink-tertiary">No workspace yet</span>
							</DropdownMenu.Item>
						{:else}
							{#each startable as group (group.name)}
								<DropdownMenu.Item onclick={() => createIn(group)}>
									<FolderTreeIcon class="size-3.5 shrink-0" />
									<span class="flex min-w-0 flex-1 flex-col">
										<span class="truncate">{group.name}</span>
										<span class="truncate font-mono text-[10px] text-ink-tertiary">
											{group.path}
										</span>
									</span>
								</DropdownMenu.Item>
							{/each}
						{/if}
						<DropdownMenu.Separator />
						<DropdownMenu.Item onclick={() => void browseForWorkspace()}>
							<PlusIcon class="size-3.5" />
							<span class="flex min-w-0 flex-col">
								<span>Choose another folder…</span>
								<span class="text-[10.5px] text-ink-tertiary">
									browse, or type an absolute path
								</span>
							</span>
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		</div>

		<!--
			No `scroll-fade-y` here. It is a mask over the container, so it dims
			whatever sits at the top edge — which is the first workspace as soon
			as the list overflows. A plain scroller with padding reads cleanly.
		-->
		<div class="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-2 pt-0.5 pb-2">
			{#if layout === 'status'}
				<!--
					Status first, repo on the row. Empty buckets are dropped by
					`statusGroups` rather than painted as headers with nothing
					under them.
				-->
				{#each byStatus as bucket (bucket.bucket)}
					<section class="mb-1.5 first:mt-1">
						<div class="flex w-full items-center gap-1.5 px-1.5 py-1.5">
							{#if bucket.bucket === 'active'}
								<StatusDot status="running" pulse class="shrink-0" />
							{:else}
								<span
									class="size-1.5 shrink-0 rounded-full {bucket.bucket === 'inactive'
										? 'bg-ink-tertiary/30'
										: 'bg-ink-tertiary/60'}"
								></span>
							{/if}
							<span class="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-secondary">
								{bucket.label}
							</span>
							<span class="tabular shrink-0 font-mono text-[10px] text-ink-tertiary/70">
								{bucket.sessions.length}
							</span>
						</div>
						<ul class="ml-4 flex flex-col gap-0.5 border-l border-line pl-1.5">
							{#each bucket.sessions as session (session.id)}
								{@render sessionRow(session, true)}
							{/each}
						</ul>
					</section>
				{/each}
			{:else if layout === 'flat'}
				<ul class="mt-1 flex flex-col gap-0.5">
					{#each flat as session (session.id)}
						{@render sessionRow(session, true)}
					{/each}
				</ul>
			{:else}
				{#each groups as group (group.name)}
					{@const open = isOpen(group)}
					{@const holdsActive = group.sessions.some((session) => session.id === activeId)}
					{@const empty = group.sessions.length === 0}
					<section class="mb-1.5 first:mt-1">
						<div
							class={[
								'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 transition-colors',
								holdsActive ? 'bg-paper-card/50' : 'hover:bg-paper-card/60'
							]}
						>
							<button
								type="button"
								class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
								aria-expanded={open}
								onclick={() => toggle(group.name, open)}
							>
								<ChevronRightIcon
									class="size-3 shrink-0 text-ink-tertiary/70 transition-transform {open
										? 'rotate-90'
										: ''}"
								/>
								<FolderTreeIcon class="size-3.5 shrink-0 text-ink-tertiary" />
								<span
									class="min-w-0 flex-1 truncate text-[12px] font-medium"
									class:text-ink={holdsActive}
									class:text-ink-secondary={!holdsActive}
								>
									{group.name}
								</span>
							</button>
							{#if group.active}
								<StatusDot status="running" pulse class="shrink-0" />
							{/if}
							{#if empty}
								<!--
								A directory the reader just added has no session yet. Saying
								so is honest; a bare `0` would read as a broken workspace.
							-->
								<span class="shrink-0 font-mono text-[9px] text-ink-tertiary/60">empty</span>
							{:else}
								<span class="tabular shrink-0 font-mono text-[10px] text-ink-tertiary/70">
									{group.sessions.length}
								</span>
							{/if}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<button
											{...props}
											type="button"
											class="flex size-4 shrink-0 items-center justify-center rounded text-ink-tertiary/0 transition-colors group-hover:text-ink-tertiary hover:bg-paper hover:text-ink"
											aria-label={`Workspace actions: ${group.name}`}
										>
											<MoreHorizontalIcon class="size-3.5" />
										</button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="start" class="w-60">
									<DropdownMenu.Label class="truncate font-mono text-[10.5px]">
										{group.path ?? group.name}
									</DropdownMenu.Label>
									<DropdownMenu.Separator />
									<DropdownMenu.Item
										disabled={!group.path}
										onclick={() => {
											if (!group.path) return;
											createIn(group);
										}}
									>
										<PlusIcon class="size-3.5" />
										New session here
									</DropdownMenu.Item>
									<DropdownMenu.Item onclick={openPathDialog}>
										<FolderTreeIcon class="size-3.5" />
										<span class="flex min-w-0 flex-col">
											<span>Add workspace by path…</span>
											<span class="text-[10.5px] text-ink-tertiary">
												type an absolute directory instead of browsing
											</span>
										</span>
									</DropdownMenu.Item>
									<DropdownMenu.Separator />
									<DropdownMenu.Item onclick={() => onremoveworkspace(group.name)}>
										<EyeOffIcon class="size-3.5" />
										<span class="flex min-w-0 flex-col">
											<span>Remove workspace</span>
											<span class="text-[10.5px] text-ink-tertiary">
												hides the group; sessions stay on disk
											</span>
										</span>
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>

						{#if open}
							<ul class="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-line pl-1.5">
								{#each group.sessions as session (session.id)}
									{@render sessionRow(session)}
								{/each}
							</ul>
						{/if}
					</section>
				{/each}
			{/if}

			{#if groups.length === 0 && allSessions.length === 0}
				<div class="px-3 py-6 text-center">
					<p class="text-[11.5px] leading-relaxed text-ink-tertiary">
						No workspaces yet. Use <span class="font-mono">+</span> above to pick a directory, or start
						one from the composer.
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						class="mt-3 h-6 text-[11px]"
						onclick={openPathDialog}
					>
						Or type a path…
					</Button>
				</div>
			{/if}
		</div>
	</nav>

	<div class="flex items-center justify-between gap-2 border-t border-line px-2 py-2">
		<p class="min-w-0 truncate pl-2 text-[10.5px] text-ink-tertiary">
			{#if layout === 'workspace'}
				<span class="tabular font-mono">{groups.length}</span>
				workspaces · <span class="tabular font-mono">{total}</span> sessions
			{:else}
				<!--
					The other layouts do not group by repo, so a workspace count
					would describe something the list above is not showing.
				-->
				<span class="tabular font-mono">{total}</span>
				sessions · <span class="tabular font-mono">{groups.length}</span> workspaces
			{/if}
		</p>
		<div class="flex shrink-0 items-center">
			{#if hidden.length > 0}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-ink-tertiary transition-colors hover:bg-paper-card hover:text-ink"
								aria-label={`Hidden workspaces: ${hidden.length}`}
							>
								<EyeOffIcon class="size-3" />
								<span class="tabular font-mono">{hidden.length}</span>
							</button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" side="top" class="w-56">
						<DropdownMenu.Label>Hidden workspaces</DropdownMenu.Label>
						{#each hidden as name (name)}
							<DropdownMenu.Item onclick={() => onrestoreworkspace(name)}>
								<EyeIcon class="size-3.5" />
								<span class="min-w-0 flex-1 truncate">{name}</span>
								<span class="shrink-0 text-[10px] text-ink-tertiary">restore</span>
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-sm"
							class="shrink-0 text-ink-tertiary hover:text-ink"
							aria-label="Settings"
							onclick={onsettings}
						>
							<SettingsIcon />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content><p>Settings</p></Tooltip.Content>
			</Tooltip.Root>
		</div>
	</div>
</aside>

<!--
	The typed-path fallback for "add a workspace".

	It exists because the native dialog can legitimately be unavailable — a
	headless server, a second request while one dialog is open, a refused
	Origin — and every one of those used to make the `+` button do nothing
	visible. A path the reader types is the answer that always works, so the
	control can never be a dead end.
-->
<Dialog.Root bind:open={pathOpen}>
	<Dialog.Content class="max-w-md">
		<div class="flex flex-col gap-4 p-5">
			<div class="flex items-start gap-2.5">
				<FolderTreeIcon class="mt-0.5 size-4 shrink-0 text-ink-tertiary" />
				<div class="min-w-0">
					<Dialog.Title class="text-[13.5px] font-medium">Add a workspace</Dialog.Title>
					<Dialog.Description class="mt-1 text-[11.5px] leading-relaxed text-ink-tertiary">
						Type the absolute path of the directory. A session opens there, which is what puts the
						directory in this list.
					</Dialog.Description>
				</div>
			</div>

			<form
				onsubmit={(event) => {
					event.preventDefault();
					void submitPath();
				}}
			>
				<input
					bind:this={pathInput}
					bind:value={pathDraft}
					class="w-full rounded-md border border-line-strong bg-paper px-2.5 py-1.5 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-tertiary/60 focus:border-olive/60"
					placeholder="D:\dev\my-project"
					aria-label="Workspace directory path"
					spellcheck="false"
					autocomplete="off"
				/>
			</form>

			{#if pathError}
				<p
					class="rounded-md border border-error/40 bg-error/5 px-2.5 py-1.5 text-[11.5px] text-error"
				>
					{pathError}
				</p>
			{/if}

			<div class="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onclick={() => {
						pathOpen = false;
						pathError = undefined;
					}}
				>
					Cancel
				</Button>
				<Button
					type="button"
					variant="default"
					size="sm"
					disabled={!pathDraft.trim() || addingPath}
					onclick={() => void submitPath()}
				>
					{addingPath ? 'Opening…' : 'Add workspace'}
				</Button>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>

<!--
	Deleting a session removes a transcript from disk. The dialog is the only
	confirmation step, and it says exactly what is lost — an armed menu item
	could not: the dropdown closes on the first click, so the second one never
	landed and the action silently did nothing.
-->
<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content class="max-w-md">
		<div class="flex flex-col gap-4 p-5">
			<div class="flex items-start gap-2.5">
				<TrashIcon class="mt-0.5 size-4 shrink-0 text-error" />
				<div class="min-w-0">
					<Dialog.Title class="text-[13.5px] font-medium">Delete this session?</Dialog.Title>
					<Dialog.Description class="mt-1 text-[11.5px] leading-relaxed text-ink-tertiary">
						<span class="text-ink-secondary">{pendingDelete?.title ?? 'This session'}</span>
						and its whole transcript will be removed from disk. This cannot be undone.
					</Dialog.Description>
				</div>
			</div>

			{#if pendingDelete?.cwd}
				<p
					class="truncate rounded-md bg-paper px-2.5 py-1.5 font-mono text-[10.5px] text-ink-tertiary"
				>
					{pendingDelete.cwd}
				</p>
			{/if}

			{#if deleteError}
				<p
					class="rounded-md border border-error/40 bg-error/5 px-2.5 py-1.5 text-[11.5px] text-error"
				>
					{deleteError}
				</p>
			{/if}

			<div class="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={deleting}
					onclick={() => {
						deleteOpen = false;
						pendingDelete = undefined;
						deleteError = undefined;
					}}
				>
					Cancel
				</Button>
				<Button
					type="button"
					variant="destructive"
					size="sm"
					disabled={deleting}
					onclick={() => void confirmDelete()}
				>
					{deleting ? 'Deleting…' : 'Delete session'}
				</Button>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
