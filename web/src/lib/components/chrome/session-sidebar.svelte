<script lang="ts">
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import { formatRelative, formatTokens } from '#lib/harness/format.js';
	import type { Session, WorkspaceInfo } from '#lib/harness/types.js';
	import Logo from './logo.svelte';
	import StatusDot from './status-dot.svelte';

	let {
		sessions,
		activeId,
		workspace,
		onselect
	}: {
		sessions: Session[];
		activeId: string;
		workspace: WorkspaceInfo;
		onselect: (id: string) => void;
	} = $props();

	const statusOf = (session: Session) =>
		session.status === 'running'
			? 'running'
			: session.status === 'attention'
				? 'attention'
				: 'idle';
</script>

<aside class="rule-r flex h-full w-64 shrink-0 flex-col bg-paper-raised">
	<div class="flex items-center gap-2 px-4 pt-4 pb-3">
		<Logo size={26} class="text-ink" />
		<div class="min-w-0">
			<p class="text-[15px] leading-none font-medium tracking-tight">Alnair</p>
			<p class="mt-1 text-[10.5px] leading-none text-ink-tertiary">web harness · mock</p>
		</div>
	</div>

	<button
		type="button"
		class="mx-3 flex items-center gap-2 rounded-lg border border-line bg-paper px-2.5 py-2 text-left transition-colors hover:border-line-strong"
		aria-label="Switch workspace"
	>
		<FolderTreeIcon class="size-3.5 shrink-0 text-ink-tertiary" />
		<span class="min-w-0 flex-1">
			<span class="block truncate text-[12.5px] font-medium">{workspace.name}</span>
			<span class="mt-0.5 flex items-center gap-1 text-[10.5px] text-ink-tertiary">
				<GitBranchIcon class="size-2.5" />
				<span class="truncate">{workspace.branch}</span>
			</span>
		</span>
		{#if workspace.dirty}
			<span class="size-1.5 shrink-0 rounded-full bg-terra" title="Uncommitted changes"></span>
		{/if}
	</button>

	<nav class="mt-4 flex min-h-0 flex-1 flex-col">
		<div class="flex items-center justify-between px-4 pb-1.5">
			<p class="text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">Sessions</p>
			<span class="tabular font-mono text-[10px] text-ink-tertiary/70">{sessions.length}</span>
		</div>

		<div class="min-h-0 flex-1 scroll-fade-y scrollbar-thin overflow-y-auto px-2 pb-2">
			<ul class="flex flex-col gap-0.5">
				{#each sessions as session (session.id)}
					{@const active = session.id === activeId}
					<li>
						<button
							type="button"
							class={[
								'group relative flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors',
								active ? 'bg-paper-card' : 'hover:bg-paper-card/60'
							]}
							onclick={() => onselect(session.id)}
							aria-current={active ? 'true' : undefined}
						>
							{#if active}
								<span
									class="absolute inset-y-2 left-0 w-0.5 rounded-full bg-olive"
									aria-hidden="true"
								></span>
							{/if}
							<span class="flex items-center gap-1.5">
								<StatusDot status={statusOf(session)} pulse={session.status === 'running'} />
								<span
									class="min-w-0 flex-1 truncate text-[12.5px] leading-snug"
									class:font-medium={active}
									class:text-ink={active}
									class:text-ink-secondary={!active}
								>
									{session.title}
								</span>
								{#if session.unread}
									<span class="size-1.5 shrink-0 rounded-full bg-terra" title="Needs attention"
									></span>
								{/if}
							</span>
							<span class="flex items-center gap-1.5 pl-3.5 text-[10.5px] text-ink-tertiary">
								<span class="truncate font-mono">{session.branch}</span>
								<span class="text-ink-tertiary/40">·</span>
								<span class="tabular shrink-0">{formatRelative(session.updatedAt)}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	</nav>

	<div class="flex items-center justify-between border-t border-line px-4 py-2.5">
		<p class="text-[10.5px] text-ink-tertiary">
			<span class="tabular font-mono"
				>{formatTokens(sessions.reduce((sum, s) => sum + s.tokens, 0))}</span
			>
			tokens this week
		</p>
		<span class="font-mono text-[10px] text-ink-tertiary/60">v0.1.20</span>
	</div>
</aside>
