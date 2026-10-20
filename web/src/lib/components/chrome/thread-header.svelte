<script lang="ts">
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import PanelRightIcon from '@lucide/svelte/icons/panel-right';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import type {
		GraphState,
		PlanDocument,
		Session,
		TodoItem,
		WorkspaceInfo
	} from '#lib/harness/types.js';
	import GraphChip from './graph-chip.svelte';
	import PlanPopover from './plan-popover.svelte';
	import StatusDot from './status-dot.svelte';
	import ThemeToggle from './theme-toggle.svelte';
	import TodoPopover from './todo-popover.svelte';

	let {
		session,
		workspace,
		graph,
		todos,
		plan,
		inspectorOpen,
		oninspector
	}: {
		session: Session;
		workspace: WorkspaceInfo;
		graph: GraphState;
		todos: TodoItem[];
		plan: PlanDocument | null;
		inspectorOpen: boolean;
		oninspector: () => void;
	} = $props();
</script>

<header class="rule-b flex h-12 shrink-0 items-center gap-3 bg-paper px-4">
	<div class="flex min-w-0 flex-1 items-center gap-2">
		<h1 class="min-w-0 truncate text-[13px] font-medium">{session.title}</h1>
		{#if session.status === 'running'}
			<span
				class="flex shrink-0 items-center gap-1 rounded-full bg-running/10 px-1.5 py-0.5 whitespace-nowrap"
			>
				<StatusDot status="running" pulse />
				<span class="text-[10px] font-medium text-running">running</span>
			</span>
		{:else if session.status === 'attention'}
			<span
				class="flex shrink-0 items-center gap-1 rounded-full bg-terra/10 px-1.5 py-0.5 whitespace-nowrap"
			>
				<StatusDot status="attention" />
				<span class="text-[10px] font-medium text-terra">needs input</span>
			</span>
		{/if}
	</div>

	<div class="flex shrink-0 items-center gap-1.5">
		{#if plan}
			<PlanPopover {plan} />
		{/if}

		<TodoPopover {todos} />

		<span
			class="ml-1 hidden items-center gap-1 font-mono text-[10.5px] whitespace-nowrap text-ink-tertiary lg:flex"
		>
			<GitBranchIcon class="size-3" />
			{workspace.branch}
			{#if workspace.ahead > 0}
				<span class="text-olive">↑{workspace.ahead}</span>
			{/if}
			{#if workspace.behind > 0}
				<span class="text-terra">↓{workspace.behind}</span>
			{/if}
		</span>

		<GraphChip {graph} />

		<ThemeToggle />

		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon-sm"
						aria-label="Toggle inspector"
						aria-pressed={inspectorOpen}
						class="text-ink-tertiary hover:text-ink aria-pressed:bg-paper-card aria-pressed:text-ink"
						onclick={oninspector}
					>
						<PanelRightIcon />
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content><p>Inspector</p></Tooltip.Content>
		</Tooltip.Root>
	</div>
</header>
