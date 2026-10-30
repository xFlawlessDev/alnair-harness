<script lang="ts">
	import * as Bubble from '#lib/components/ui/bubble/index.js';
	import * as Message from '#lib/components/ui/message/index.js';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { formatClock, formatWorked } from '#lib/harness/format.js';
	import { DEFAULT_VIEW_PREFS } from '#lib/harness/view-prefs.js';
	import type { Turn, ViewPrefs } from '#lib/harness/types.js';
	import Markdown from './markdown-lazy.svelte';
	import NoticeRow from './parts/notice-row.svelte';
	import PartView from './parts/part-view.svelte';
	import PermissionRow from './parts/permission-row.svelte';
	import QuestionRow from './parts/question-row.svelte';
	import SystemRow from './parts/system-row.svelte';
	import { groupParts, splitFinalWork } from './segments.js';
	import TurnChanges from './turn-changes.svelte';
	import { turnChanges } from './turn-changes.js';
	import TurnMeta from './turn-meta.svelte';
	import WorkSummary from './work-summary.svelte';

	let {
		turn,
		streaming = false,
		forcedOpen,
		onretry,
		prefs = DEFAULT_VIEW_PREFS,
		onopenfile
	}: {
		turn: Turn;
		streaming?: boolean;
		/**
		 * A token that renders the folded work open, because the inspector
		 * asked to show a row inside it.
		 *
		 * A NUMBER rather than a boolean: revealing a second row in the same
		 * turn must re-open a turn the reader has since collapsed, and an
		 * unchanged `true` would produce no update at all.
		 */
		forcedOpen?: number;
		onretry?: () => void;
		/** What each row renders with, projected from the settings registry. */
		prefs?: ViewPrefs;
		/** Open a changed file in the editor panel. */
		onopenfile?: (path: string) => void;
	} = $props();

	const userText = $derived(
		turn.parts
			.filter((part) => part.kind === 'text')
			.map((part) => part.text)
			.join('\n\n')
	);

	/**
	 * A finished turn is split into the work it took and the answer it gave.
	 *
	 * `undefined` while the turn is running: the reader is watching the work
	 * happen, and folding it away mid-turn would hide the step that is actually
	 * moving. `splitFinalWork` returns `work: []` for a turn with no answer, so
	 * a cancelled or tool-only turn keeps its whole trace expanded.
	 */
	const split = $derived(
		!streaming && turn.status !== 'streaming' ? splitFinalWork(turn.parts) : undefined
	);

	const collapsed = $derived(split !== undefined && split.work.length > 0);

	/**
	 * The parts left to render inline, once the work is folded away.
	 *
	 * `show_thinking` filters reasoning parts here rather than inside the row:
	 * a hidden row still occupies a `<details>` and still answers a click, and
	 * "hide the agent's thinking" means the row is gone, not collapsed.
	 */
	const visible = $derived.by(() => {
		const base =
			collapsed && split ? [...(split.answer ? [split.answer] : []), ...split.tail] : turn.parts;
		return prefs.thinking ? base : base.filter((part) => part.kind !== 'reasoning');
	});

	const segments = $derived(groupParts(visible));

	const worked = $derived(collapsed ? formatWorked(turn.durationMs) : '');

	/**
	 * Whether this turn has stopped producing anything.
	 *
	 * A reasoning row inside a closed turn is over by definition, so it says
	 * `Thought` even if its own status never got updated — which is what a
	 * transcript replayed from before the reducer learned to settle contains.
	 */
	const turnClosed = $derived(!streaming && turn.status !== 'streaming');

	/**
	 * Whether a diff starts folded.
	 *
	 * The setting is "collapse file edits", so its own default is `true` — the
	 * registry says so, and the thread already folds a finished turn's work.
	 * Reading it here rather than inside the row keeps `PartView` a pure
	 * dispatcher.
	 */
	const collapseEdits = $derived(prefs.collapseEdits);

	/**
	 * The files this turn changed, in order.
	 *
	 * Computed once per turn rather than inside the list: the summary needs the
	 * counts whether or not the reader opens it, and a derived value keeps the
	 * grouping out of the render path.
	 */
	const changes = $derived(turnChanges(turn));
</script>

{#if turn.role === 'user'}
	<Message.Root align="end">
		<Message.Content class="items-end gap-1.5">
			<Bubble.Root align="end" variant="paper" class="max-w-[min(46rem,88%)]">
				<Bubble.Content
					class="rounded-2xl rounded-br-md px-4 py-2.5 whitespace-pre-wrap shadow-none"
				>
					{userText}
				</Bubble.Content>
			</Bubble.Root>
			<span class="tabular px-1 font-mono text-[10.5px] text-ink-tertiary/80">
				{#if prefs.timestamps}{formatClock(turn.at)}{/if}
			</span>
		</Message.Content>
	</Message.Root>
{:else if turn.role === 'system'}
	<!--
		A standalone system turn: an injected reminder that arrived with no turn
		open, or a recap. It renders its own rows rather than the joined text a
		user turn uses, because the parts are the point — a `system` part names
		the wrapper it came from.
	-->
	<div class="flex flex-col gap-1.5">
		{#each groupParts(turn.parts) as segment, index (index)}
			{#if segment.kind === 'trace'}
				<Trace.Root class="gap-1.5">
					{#each segment.parts as part (part.id)}
						<PartView {part} {turnClosed} {collapseEdits} />
					{/each}
				</Trace.Root>
			{:else if segment.kind === 'notice'}
				<NoticeRow part={segment.part} />
			{:else if segment.kind === 'system'}
				<SystemRow part={segment.part} />
			{:else if segment.kind === 'permission'}
				<PermissionRow part={segment.part} />
			{:else if segment.kind === 'question'}
				<QuestionRow part={segment.part} />
			{:else if segment.part.text}
				<p class="text-[12px] leading-relaxed text-ink-tertiary">{segment.part.text}</p>
			{/if}
		{/each}
	</div>
{:else}
	<Message.Root>
		<Message.Content class="gap-3">
			{#if collapsed && split}
				<!--
					The work folds into one line and the answer stays below it. The
					children are the SAME trace the unfolded turn renders, so
					expanding restores it exactly rather than re-deriving a second
					view that could drift.
				-->
				<WorkSummary parts={split.work} {worked} {forcedOpen}>
					<Trace.Root class="gap-1.5">
						{#each groupParts(split.work) as segment, index (index)}
							{#if segment.kind === 'trace'}
								{#each segment.parts as part (part.id)}
									<PartView {part} {turnClosed} {collapseEdits} />
								{/each}
							{:else if segment.kind === 'notice'}
								<NoticeRow part={segment.part} />
							{:else if segment.kind === 'system'}
								<SystemRow part={segment.part} />
							{:else if segment.kind === 'permission'}
								<PermissionRow part={segment.part} />
							{:else if segment.kind === 'question'}
								<QuestionRow part={segment.part} />
							{:else}
								<Markdown content={segment.part.text} mermaid={prefs.mermaid} />
							{/if}
						{/each}
					</Trace.Root>
				</WorkSummary>
			{/if}

			{#each segments as segment, index (index)}
				{#if segment.kind === 'trace'}
					<Trace.Root class="gap-1.5">
						{#each segment.parts as part (part.id)}
							<PartView {part} {turnClosed} {collapseEdits} />
						{/each}
					</Trace.Root>
				{:else if segment.kind === 'notice'}
					<NoticeRow part={segment.part} />
				{:else if segment.kind === 'system'}
					<SystemRow part={segment.part} />
				{:else if segment.kind === 'permission'}
					<PermissionRow part={segment.part} />
				{:else if segment.kind === 'question'}
					<QuestionRow part={segment.part} />
				{:else if segment.part.text}
					<Markdown content={segment.part.text} {streaming} mermaid={prefs.mermaid} />
				{:else if streaming}
					<div class="flex items-center gap-1 py-1" aria-label="Waiting for the reply">
						<span
							class="size-1.5 animate-bounce rounded-full bg-ink-tertiary [animation-delay:-0.3s]"
						></span>
						<span
							class="size-1.5 animate-bounce rounded-full bg-ink-tertiary [animation-delay:-0.15s]"
						></span>
						<span class="size-1.5 animate-bounce rounded-full bg-ink-tertiary"></span>
					</div>
				{/if}
			{/each}

			<!--
				What this turn changed, at the end of it.
				
				Per turn, not merged with the session: a reader auditing a long
				conversation needs "what did THIS turn touch", which is the unit
				they can check or revert. The right rail keeps the merged view for
				browsing; this is the audit trail.
			-->
			{#if changes.length > 0 && !streaming}
				<TurnChanges {changes} onopen={(path) => onopenfile?.(path)} />
			{/if}

			{#if turn.status === 'cancelled'}
				<p class="text-[11.5px] text-ink-tertiary italic">Stopped by the user.</p>
			{:else if turn.status === 'refused'}
				<p class="text-[11.5px] text-terra italic">The agent declined to continue.</p>
			{:else if turn.status === 'error'}
				<p class="text-[11.5px] text-error italic">The turn ended with an error.</p>
			{:else if !streaming}
				<TurnMeta {turn} {onretry} showDuration={!collapsed} />
			{/if}
		</Message.Content>
	</Message.Root>
{/if}
