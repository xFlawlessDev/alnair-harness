<script lang="ts">
	import { untrack } from 'svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { graphCommand, nodeTone, type GraphControl, type GraphView } from '#lib/harness/graph.js';
	import { formatDuration, formatTokens } from '#lib/harness/format.js';
	import type { SessionStore } from '#lib/harness/session-store.svelte.js';
	import type { SubagentSummary } from '#lib/harness/types.js';
	import GraphCanvas from './graph-canvas.svelte';
	import NodeDetail from './node-detail.svelte';

	let {
		open = $bindable(false),
		store,
		onsubagent
	}: {
		open: boolean;
		store: SessionStore;
		onsubagent: (agent: SubagentSummary) => void;
	} = $props();
	let data = $state<GraphView>();
	let error = $state<string>();
	let actionError = $state<string>();
	let loading = $state(true);
	let acting = $state(false);
	let selected = $state('');
	let query = $state('');
	let objective = $state('');
	let creating = $state(false);
	let budget = $state('');
	let clearConfirm = $state<string>();
	let refresh = $state(0);
	let updatedAt = $state('');
	const graph = $derived(data?.graph);
	const node = $derived(graph?.nodes.find((candidate) => candidate.id === selected));
	const filtered = $derived(
		graph?.nodes.filter((candidate) =>
			`${candidate.title} ${candidate.id} ${candidate.status}`
				.toLowerCase()
				.includes(query.toLowerCase())
		) ?? []
	);
	const achieved = $derived(
		graph?.nodes.filter((candidate) => candidate.status === 'achieved').length ?? 0
	);
	const canResume = $derived(graph && graph.status !== 'active' && graph.status !== 'complete');

	$effect(() => {
		if (!open) return;
		const sessionId = store.activeSessionId;
		const revision = refresh;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		async function read() {
			try {
				const next = await store.inspectGraph();
				if (!disposed && store.activeSessionId === sessionId && revision === refresh) {
					data = next;
					updatedAt = new Date().toLocaleTimeString();
					error = undefined;
					if (!next.graph?.nodes.some((item) => item.id === selected))
						selected = next.graph?.current_node ?? next.graph?.nodes[0]?.id ?? '';
				}
			} catch (cause) {
				if (!disposed) error = cause instanceof Error ? cause.message : 'Could not load graph.';
			} finally {
				if (!disposed) {
					loading = false;
					timer = setTimeout(read, 2000);
				}
			}
		}
		untrack(() => void read());
		return () => {
			disposed = true;
			clearTimeout(timer);
		};
	});

	async function control(action: GraphControl) {
		if (!graph || acting) return;
		acting = true;
		actionError = undefined;
		try {
			await store.controlGraph(graph.graph_id, action);
			clearConfirm = undefined;
			refresh += 1;
		} catch (cause) {
			actionError = cause instanceof Error ? cause.message : 'Graph action failed.';
		} finally {
			acting = false;
		}
	}
	function start(action: 'start' | 'resume') {
		if (store.busy) return;
		try {
			store.send(graphCommand(action, objective, budget));
			creating = false;
			actionError = undefined;
			refresh += 1;
		} catch (cause) {
			actionError = cause instanceof Error ? cause.message : 'Invalid graph command.';
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="h-[min(52rem,94dvh)] w-[min(90rem,96vw)] max-w-[min(90rem,96vw)]">
		<header class="border-b border-line px-4 py-3 pr-12">
			<Dialog.Title>Graph</Dialog.Title>
			<Dialog.Description
				>Plan dependencies and track each node's work and verification.</Dialog.Description
			>
		</header>
		<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
				<Button variant="outline" size="sm" disabled={acting} onclick={() => (refresh += 1)}
					>Refresh</Button
				>
				<span
					class="order-last basis-full text-xs text-ink-tertiary sm:order-none sm:flex-1 sm:basis-auto"
					>{loading
						? 'Loading graph…'
						: `Updates every 2 seconds${updatedAt ? ` · last read ${updatedAt}` : ''}`}</span
				>
				{#if graph}
					{#if graph.status === 'complete' && !creating}<Button
							variant="outline"
							size="sm"
							disabled={store.busy}
							onclick={() => (creating = true)}>New graph</Button
						>{/if}
					{#if graph.status === 'active' && data?.source === 'session'}<Button
							variant="outline"
							size="sm"
							disabled={acting}
							onclick={() => control('pause')}>Pause after current work</Button
						>{/if}
					{#if store.busy}<Button variant="outline" size="sm" onclick={() => store.cancel()}
							>Stop running turn</Button
						>{/if}
					{#if data?.source === 'session'}<Button
							variant="outline"
							size="sm"
							disabled={store.busy || acting}
							onclick={() => (clearConfirm = graph.graph_id)}>Clear graph</Button
						>{/if}
				{/if}
			</div>
			{#if error}<p role="alert" class="border-b border-line px-4 py-2 text-sm text-error">
					{error}
				</p>{/if}
			{#if actionError}<p role="alert" class="border-b border-line px-4 py-2 text-sm text-error">
					{actionError}
				</p>{/if}
			{#if graph && clearConfirm === graph.graph_id}
				<div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 text-sm">
					<p class="flex-1">
						Clear this graph's orchestration state? The session transcript and working files are
						kept.
					</p>
					<Button
						variant="destructive"
						size="sm"
						disabled={store.busy || acting}
						onclick={() => control('clear')}>Confirm clear</Button
					><Button variant="ghost" size="sm" onclick={() => (clearConfirm = undefined)}
						>Keep graph</Button
					>
				</div>
			{/if}
			{#if data?.source === 'project'}<p
					class="border-b border-line px-4 py-2 text-xs text-ink-secondary"
				>
					Project graph: read-only in this session. Resume here to request ownership; the runtime
					refuses while another session holds the writer lock.
				</p>{/if}
			{#if data && !data.enabled}<p class="px-4 py-2 text-sm text-ink-secondary">
					Graph execution is disabled by the runtime configuration. Existing progress can still be
					inspected.
				</p>{/if}
			{#if graph && !creating}
				<section
					class="flex flex-col gap-2 border-b border-line px-4 py-3"
					aria-label="Graph summary"
				>
					<h2 class="text-sm font-medium">{graph.objective}</h2>
					<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-secondary">
						<span>{graph.status.replaceAll('_', ' ')} · {graph.phase}</span><span
							>{achieved}/{graph.nodes.length} nodes achieved</span
						><span>Plan v{graph.plan_version} · {graph.replan_runs} revisions</span><span
							>{formatDuration(graph.elapsed_ms) || '—'}</span
						><span
							>{formatTokens(graph.tokens_spent_nodes)} recorded tokens{graph.token_budget
								? ` / ${formatTokens(graph.token_budget)} budget`
								: ''}</span
						>
					</div>
					<progress
						max={Math.max(1, graph.nodes.length)}
						value={achieved}
						aria-label="Completed graph nodes"
						class="h-1.5 w-full accent-olive"
					></progress>
					{#if graph.pause_message}<p class="text-sm text-ink-secondary">
							{graph.pause_message}
						</p>{/if}
					{#if canResume || (data?.source === 'project' && graph.status !== 'complete')}
						<div class="flex flex-wrap items-end gap-2">
							<div class="flex flex-col gap-1">
								<Label for="graph-extra-budget">Additional token budget (optional)</Label><Input
									id="graph-extra-budget"
									inputmode="numeric"
									bind:value={budget}
									placeholder="e.g. 50000"
								/>
							</div>
							<Button
								size="sm"
								disabled={store.busy || acting || !data?.enabled}
								onclick={() => start('resume')}>Resume graph</Button
							>
						</div>
					{/if}
				</section>
				<div
					class="grid flex-none grid-cols-1 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_22rem]"
				>
					<Tabs.Root
						value="dag"
						class="flex h-[26rem] min-h-80 flex-col gap-0 overflow-hidden lg:h-auto"
					>
						<Tabs.List class="mx-3 mt-2 w-fit"
							><Tabs.Trigger value="dag">Dependencies</Tabs.Trigger><Tabs.Trigger value="nodes"
								>Nodes</Tabs.Trigger
							><Tabs.Trigger value="history">History</Tabs.Trigger></Tabs.List
						>
						<Tabs.Content value="dag" class="flex min-h-0 flex-1 flex-col"
							><GraphCanvas {graph} {selected} onselect={(id) => (selected = id)} /></Tabs.Content
						>
						<Tabs.Content value="nodes" class="min-h-0 flex-1 overflow-y-auto p-3">
							<Input
								aria-label="Filter graph nodes"
								placeholder="Filter by title, id, or status"
								bind:value={query}
								class="mb-2"
							/>
							<ul class="flex flex-col gap-1">
								{#each filtered as item (item.id)}<li>
										<button
											type="button"
											class="flex w-full items-center gap-2 rounded-md border border-line px-3 py-2 text-left text-sm hover:bg-paper-card focus-visible:outline-olive"
											aria-pressed={selected === item.id}
											onclick={() => (selected = item.id)}
											><span class="min-w-0 flex-1 truncate">{item.title}</span><span
												class={nodeTone(item.status)}>{item.status}</span
											><span class="font-mono text-xs text-ink-tertiary"
												>{item.rounds} rounds · {formatTokens(item.tokens_used)}</span
											></button
										>
									</li>{:else}<li class="p-3 text-sm text-ink-tertiary">
										No nodes match this filter.
									</li>{/each}
							</ul>
						</Tabs.Content>
						<Tabs.Content value="history" class="min-h-0 flex-1 overflow-y-auto p-4">
							{#if graph.pending_discoveries?.length}<h3 class="mb-2 text-sm font-medium">
									Discoveries awaiting replan
								</h3>
								<ul class="mb-4 flex flex-col gap-2 text-sm">
									{#each graph.pending_discoveries as discovery, index (index)}<li>
											<Button
												variant="link"
												size="sm"
												onclick={() => (selected = discovery.from_node)}
												>{discovery.from_node}</Button
											>{discovery.description}
										</li>{/each}
								</ul>{/if}
							<h3 class="mb-2 text-sm font-medium">Graph history</h3>
							<ol class="flex flex-col gap-3 text-sm">
								{#each graph.history.toReversed() as event, index (`${event.timestamp}:${index}`)}<li
									>
										<time datetime={event.timestamp} class="text-xs text-ink-tertiary"
											>{new Date(event.timestamp).toLocaleString()}</time
										>
										<p>
											{event.event.replaceAll('_', ' ')}{#if event.node_id}<Button
													variant="link"
													size="sm"
													onclick={() => (selected = event.node_id ?? '')}>{event.node_id}</Button
												>{/if}
										</p>
										{#if event.detail}<p class="whitespace-pre-wrap text-ink-secondary">
												{event.detail}
											</p>{/if}
									</li>{:else}<li>No history yet.</li>{/each}
							</ol>
						</Tabs.Content>
					</Tabs.Root>
					{#if node && data}<NodeDetail
							{node}
							{data}
							onselect={(id) => (selected = id)}
							{onsubagent}
						/>{:else}<p class="p-4 text-sm text-ink-tertiary">
							{graph.phase === 'planning'
								? 'The planner is building the graph. Nodes appear as soon as the plan passes validation.'
								: 'Select a node to inspect its progress.'}
						</p>{/if}
				</div>
			{:else if data}
				<form
					class="mx-auto flex w-full max-w-xl flex-col gap-4 p-6"
					onsubmit={(event) => {
						event.preventDefault();
						start('start');
					}}
				>
					<h2 class="text-base font-medium">Start a graph</h2>
					{#if creating}<Button variant="ghost" size="sm" onclick={() => (creating = false)}
							>Back to graph</Button
						>{/if}
					<p class="text-sm text-ink-secondary">
						Describe the objective. The agent builds a dependency plan, runs its nodes and verifies
						the final result.
					</p>
					<div class="flex flex-col gap-2">
						<Label for="graph-objective">Objective</Label><Textarea
							id="graph-objective"
							bind:value={objective}
							required
							rows={4}
						/>
					</div>
					<div class="flex flex-col gap-2">
						<Label for="graph-budget">Token budget (optional)</Label><Input
							id="graph-budget"
							inputmode="numeric"
							bind:value={budget}
							placeholder="e.g. 100000"
						/>
					</div>
					<Button type="submit" disabled={store.busy || !data.enabled}>Start graph</Button>
				</form>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
