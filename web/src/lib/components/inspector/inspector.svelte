<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import { formatDuration } from '#lib/harness/format.js';
	import type { ContextUsage, GraphState, Session, Turn } from '#lib/harness/types.js';
	import FilesPanel from './files-panel.svelte';
	import GraphPanel from './graph-panel.svelte';
	import { inspectorStats } from './stats.js';

	let {
		session,
		turns,
		graph,
		context
	}: { session: Session; turns: Turn[]; graph: GraphState; context: ContextUsage } = $props();

	const stats = $derived(inspectorStats(turns, graph, context, session));
</script>

<aside class="rule-l flex h-full w-72 shrink-0 flex-col bg-paper-raised">
	<div class="rule-b flex h-12 shrink-0 items-center justify-between px-4">
		<p class="text-[11px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">Inspector</p>
		<span class="flex items-center gap-1 font-mono text-[10px] text-ink-tertiary/70">
			<ActivityIcon class="size-3" />
			{stats.parts} parts
		</span>
	</div>

	<div class="flex min-h-0 flex-1 scroll-fade-y scrollbar-thin flex-col gap-6 overflow-y-auto p-4">
		<GraphPanel {graph} />

		<div class="h-px bg-line"></div>

		<FilesPanel {turns} />

		<div class="h-px bg-line"></div>

		<div class="flex flex-col gap-2.5">
			<p class="text-[10px] font-medium tracking-[0.08em] text-ink-tertiary uppercase">Activity</p>
			<dl class="grid grid-cols-2 gap-x-3 gap-y-2">
				<div class="flex flex-col">
					<dt class="text-[10px] text-ink-tertiary">Tool calls</dt>
					<dd class="tabular font-mono text-[12px] text-ink">{stats.toolCalls}</dd>
				</div>
				<div class="flex flex-col">
					<dt class="text-[10px] text-ink-tertiary">Commands</dt>
					<dd class="tabular font-mono text-[12px] text-ink">{stats.terminals}</dd>
				</div>
				<div class="flex flex-col">
					<dt class="text-[10px] text-ink-tertiary">Subagents</dt>
					<dd class="tabular font-mono text-[12px] text-ink">{stats.subagents}</dd>
				</div>
				<div class="flex flex-col">
					<dt class="text-[10px] text-ink-tertiary">Errors</dt>
					<dd
						class="tabular font-mono text-[12px]"
						class:text-error={stats.errors > 0}
						class:text-ink={stats.errors === 0}
					>
						{stats.errors}
					</dd>
				</div>
				<div class="col-span-2 flex flex-col">
					<dt class="text-[10px] text-ink-tertiary">Reasoning time</dt>
					<dd class="tabular font-mono text-[12px] text-ink">
						{formatDuration(stats.reasoningMs) || '—'}
					</dd>
				</div>
			</dl>
		</div>

		<div class="h-px bg-line"></div>

		<dl class="flex flex-col gap-2">
			{#each stats.facts as fact (fact.label)}
				<div class="flex items-baseline justify-between gap-2">
					<dt class="text-[11px] text-ink-tertiary">{fact.label}</dt>
					<dd class="min-w-0 truncate font-mono text-[11px] text-ink-secondary">{fact.value}</dd>
				</div>
			{/each}
		</dl>
	</div>
</aside>
