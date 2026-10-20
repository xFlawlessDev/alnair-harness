<script lang="ts">
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import { formatRelative } from '#lib/harness/format.js';
	import type { Session, WorkspaceGroup } from '#lib/harness/types.js';
	import Logo from './logo.svelte';
	import StatusDot from './status-dot.svelte';

	/**
	 * The session list, nested the way the backend models it: one row per
	 * workspace, its conversations underneath. `alnair/session/list` returns
	 * flat rows that name their repo; the grouping happens in the store, so
	 * this component only renders what it is given.
	 */
	let {
		groups,
		activeId,
		onselect
	}: {
		groups: WorkspaceGroup[];
		activeId: string;
		onselect: (id: string) => void;
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
</script>

<aside class="rule-r flex h-full w-64 shrink-0 flex-col bg-paper-raised">
	<div class="flex items-center gap-2 px-4 pt-4 pb-3">
		<Logo size={26} class="text-ink" />
		<div class="min-w-0">
			<p class="text-[15px] leading-none font-medium tracking-tight">Alnair</p>
			<p class="mt-1 text-[10.5px] leading-none text-ink-tertiary">web harness · fixtures</p>
		</div>
	</div>

	<nav class="mt-1 flex min-h-0 flex-1 flex-col">
		<div class="flex items-center justify-between px-4 pb-1.5">
			<p class="text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">
				Workspaces
			</p>
			<span class="tabular font-mono text-[10px] text-ink-tertiary/70">{total}</span>
		</div>

		<div class="min-h-0 flex-1 scroll-fade-y scrollbar-thin overflow-y-auto px-2 pb-2">
			{#each groups as group (group.name)}
				{@const open = isOpen(group)}
				{@const holdsActive = group.sessions.some((session) => session.id === activeId)}
				<section class="mb-1">
					<button
						type="button"
						class="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-paper-card/60"
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
						{#if group.active}
							<StatusDot status="running" pulse class="shrink-0" />
						{/if}
						<span class="tabular shrink-0 font-mono text-[10px] text-ink-tertiary/70">
							{group.sessions.length}
						</span>
					</button>

					{#if open}
						<ul class="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-line pl-1.5">
							{#each group.sessions as session (session.id)}
								{@const active = session.id === activeId}
								{@const source = sourceLabel(session)}
								<li>
									<button
										type="button"
										class={[
											'group relative flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
											active ? 'bg-paper-card' : 'hover:bg-paper-card/60'
										]}
										onclick={() => onselect(session.id)}
										aria-current={active ? 'true' : undefined}
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
												<span class="size-1.5 shrink-0 rounded-full bg-terra" title="Needs input"
												></span>
											{/if}
										</span>
										<span class="flex items-center gap-1.5 pl-4.5 text-[10px] text-ink-tertiary">
											<span class="tabular shrink-0">{formatRelative(session.updatedAt)}</span>
											{#if source}
												<span class="shrink-0 rounded-sm bg-paper px-1 font-mono text-[9px]">
													{source}
												</span>
											{/if}
										</span>
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/each}
		</div>
	</nav>

	<div class="flex items-center justify-between border-t border-line px-4 py-2.5">
		<p class="text-[10.5px] text-ink-tertiary">
			<span class="tabular font-mono">{groups.length}</span>
			workspaces · <span class="tabular font-mono">{total}</span> sessions
		</p>
		<span class="font-mono text-[10px] text-ink-tertiary/60">v0.1.20</span>
	</div>
</aside>
