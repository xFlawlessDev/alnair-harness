<script lang="ts">
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import { tick } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { formatRelative } from '#lib/harness/format.js';
	import type { Session, WorkspaceGroup } from '#lib/harness/types.js';
	import Logo from './logo.svelte';
	import StatusDot from './status-dot.svelte';

	/**
	 * The session list, nested the way the backend models it: one row per
	 * workspace, its conversations underneath. `alnair/sessions/list` returns
	 * flat rows that name their repo; the grouping happens in the store, so
	 * this component only renders what it is given.
	 *
	 * The row actions are the session's own CRUD — rename, delete — plus the
	 * two ways to get a new one: in the current workspace, or in a directory
	 * the reader picks. They live behind the row's menu rather than as always-
	 * visible buttons so the list stays a list; the one exception is the
	 * workspace header's `+`, which is the fast path.
	 */
	let {
		groups,
		activeId,
		onselect,
		onrename,
		ondelete,
		oncreate,
		onerror,
		onsettings
	}: {
		groups: WorkspaceGroup[];
		activeId: string;
		onselect: (id: string) => void;
		onrename: (id: string, title: string) => void | Promise<void>;
		ondelete: (id: string) => void | Promise<void>;
		oncreate: (cwd: string) => void | Promise<void>;
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

	/** The id being renamed, and the draft. One at a time — two would race. */
	let renaming = $state<string | undefined>(undefined);
	let draft = $state('');
	let renameInput: HTMLInputElement | null = $state(null);

	/** The id armed for deletion; a second click on the same row confirms. */
	let armed = $state<string | undefined>(undefined);

	function startRename(session: Session) {
		armed = undefined;
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

	/**
	 * Delete, with one confirmation step.
	 *
	 * Deleting a session destroys a transcript on disk, so a single misplaced
	 * click must not do it. The arm expires when the menu closes or another row
	 * is touched, which is what makes it a confirmation rather than a mode.
	 */
	function requestDelete(session: Session) {
		if (armed === session.id) {
			armed = undefined;
			void ondelete(session.id);
			return;
		}
		armed = session.id;
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
</script>

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
			<p class="text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">
				Workspaces
			</p>
			<div class="flex items-center gap-1">
				<span class="tabular font-mono text-[10px] text-ink-tertiary/70">{total}</span>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="flex size-4 items-center justify-center rounded text-ink-tertiary transition-colors hover:bg-paper-card hover:text-ink"
								aria-label="New session in this workspace"
								onclick={() => {
									const group = groups.find((candidate) =>
										candidate.sessions.some((session) => session.id === activeId)
									);
									if (group) createIn(group);
								}}
							>
								<PlusIcon class="size-3" />
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content><p>New session here</p></Tooltip.Content>
				</Tooltip.Root>
			</div>
		</div>

		<!--
			No `scroll-fade-y` here. It is a mask over the container, so it dims
			whatever sits at the top edge — which is the first workspace as soon
			as the list overflows. A plain scroller with padding reads cleanly.
		-->
		<div class="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-2 pt-0.5 pb-2">
			{#each groups as group (group.name)}
				{@const open = isOpen(group)}
				{@const holdsActive = group.sessions.some((session) => session.id === activeId)}
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
						<span class="tabular shrink-0 font-mono text-[10px] text-ink-tertiary/70">
							{group.sessions.length}
						</span>
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
							<DropdownMenu.Content align="start" class="w-56">
								<DropdownMenu.Label class="truncate font-mono text-[10.5px]">
									{group.path ?? group.name}
								</DropdownMenu.Label>
								<DropdownMenu.Separator />
								<DropdownMenu.Item onclick={() => createIn(group)}>
									<PlusIcon class="size-3.5" />
									New session here
								</DropdownMenu.Item>
								<DropdownMenu.Item
									disabled={!group.path}
									onclick={() => {
										if (!group.path) return;
										void oncreate(group.path);
									}}
								>
									<FolderPlusIcon class="size-3.5" />
									<span class="flex min-w-0 flex-col">
										<span>New session in another directory…</span>
										<span class="text-[10.5px] text-ink-tertiary"> ask the agent for a path </span>
									</span>
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					</div>

					{#if open}
						<ul class="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-line pl-1.5">
							{#each group.sessions as session (session.id)}
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
												onclick={() => {
													armed = undefined;
													onselect(session.id);
												}}
												aria-current={active ? 'true' : undefined}
												data-session-id={session.id}
											>
												<span class="flex items-center gap-1.5">
													<MessageSquareIcon
														class={[
															'size-3 shrink-0',
															active ? 'text-olive' : 'text-ink-tertiary/60'
														]}
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
														<span
															class="size-1.5 shrink-0 rounded-full bg-terra"
															title="Needs input"
														></span>
													{/if}
												</span>
												<span
													class="flex items-center gap-1.5 pl-4.5 text-[10px] text-ink-tertiary"
												>
													<span class="tabular shrink-0">
														{formatRelative(session.updatedAt)}
													</span>
													{#if session.worktree}
														<span class="shrink-0 rounded-sm bg-paper px-1 font-mono text-[9px]">
															worktree
														</span>
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
													<DropdownMenu.Item
														class="text-error data-[highlighted]:bg-error/10 data-[highlighted]:text-error"
														onclick={() => requestDelete(session)}
													>
														<TrashIcon class="size-3.5" />
														{armed === session.id ? 'Click again to delete' : 'Delete session…'}
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
							{/each}
						</ul>
					{/if}
				</section>
			{/each}

			{#if groups.length === 0}
				<p class="px-3 py-6 text-center text-[11.5px] leading-relaxed text-ink-tertiary">
					No sessions yet. Start one from the composer, or pick a directory.
				</p>
			{/if}
		</div>
	</nav>

	<div class="flex items-center justify-between gap-2 border-t border-line px-2 py-2">
		<p class="min-w-0 truncate pl-2 text-[10.5px] text-ink-tertiary">
			<span class="tabular font-mono">{groups.length}</span>
			workspaces · <span class="tabular font-mono">{total}</span> sessions
		</p>
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
</aside>
