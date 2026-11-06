<script lang="ts">
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import * as CodeBlock from '#lib/components/ui/code-block/index.js';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { formatDuration } from '#lib/harness/format.js';
	import { commandSummary, hasAnsi, terminalLines } from '#lib/harness/terminal-output.js';
	import { useHighlightedCode } from '#lib/hooks/use-highlighted-code.svelte.js';
	import type { TerminalPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	/**
	 * A shell command, rendered as the terminal session it was.
	 *
	 * The shape follows the TUI's execute block: a one-line header for the
	 * collapsed state, and a panel that reads like a captured terminal — the
	 * `$` prompt, the command, its output, and the exit status — once opened.
	 * The panel is open while the command runs or after it failed, because
	 * those are the two states a reader wants to see without asking.
	 *
	 * Colour comes from the output itself. A shell writes ANSI escapes (`ls`
	 * marks directories, `git` colours diffs, a compiler reddens an error), and
	 * the transcript keeps them, so the panel tokenizes with Shiki's `ansi`
	 * grammar — the same highlighter the markdown code blocks already use.
	 * Output without escapes skips that path entirely: it would produce one
	 * default-coloured token per line and cost a grammar pass for nothing.
	 */
	let { part }: { part: TerminalPart } = $props();

	const failed = $derived(
		part.status === 'error' || (part.exitCode !== undefined && part.exitCode !== 0)
	);
	const running = $derived(part.status === 'running' || part.status === 'pending');
	const status = $derived(failed ? 'error' : traceStatus(part.status));

	const heading = $derived.by(() => {
		if (part.backgrounded) return 'Backgrounded';
		// A task that outlived its call and has since reported: the row keeps
		// saying it was a task, the way the TUI leaves a `BgTaskBlock` behind.
		if (part.backgroundOutcome === 'completed') return 'Background task finished';
		if (part.backgroundOutcome === 'failed') return 'Background task failed';
		if (running) return 'Running';
		if (failed) return 'Failed';
		return 'Ran';
	});

	const summary = $derived(commandSummary(part.command));
	/** Kept escaped, because the highlighter reads the escapes as colour. */
	const lines = $derived(terminalLines(part.output, true));
	/** The tail while running, the whole capture once it settles. */
	const shown = $derived(running && lines.length > 14 ? lines.slice(-14) : lines);
	const hidden = $derived(lines.length - shown.length);
	const colored = $derived(shown.some(hasAnsi));

	// `streaming = false`: a command's output arrives in bursts and is
	// re-rendered as a whole, so the incremental path's prefix assumption does
	// not hold. ANSI is a whole-block language anyway.
	const highlighted = useHighlightedCode(
		() => shown.join('\n'),
		() => (colored ? 'ansi' : 'text'),
		false
	);

	const exitLabel = $derived(
		part.exitCode === undefined
			? undefined
			: part.exitCode === 0
				? 'exit 0'
				: `exit ${part.exitCode}`
	);

	/** A running command's output pane follows its tail, like a real terminal. */
	let body: HTMLDivElement | null = $state(null);
	$effect(() => {
		// Reading the line count subscribes the effect to new output.
		const lineCount = shown.length;
		if (!running || !body || lineCount === 0) return;
		body.scrollTop = body.scrollHeight;
	});
</script>

{#snippet line()}
	<Trace.Line {status}>
		<Trace.Icon>
			<TerminalIcon class={running ? 'text-running' : failed ? 'text-error' : 'text-tool'} />
		</Trace.Icon>
		<Trace.Title>
			<span class="text-ink-secondary">{heading}</span>
			<code class="ml-1 font-mono text-[12.5px] text-ink">
				<span class="text-ink-tertiary">$ </span>{summary.first}
			</code>
			{#if summary.extra > 0}
				<span class="ml-1 font-mono text-[10.5px] text-ink-tertiary">
					+{summary.extra} line{summary.extra === 1 ? '' : 's'}
				</span>
			{/if}
		</Trace.Title>
		{#if part.backgrounded}
			<Trace.Description class="text-running">task {part.taskId}</Trace.Description>
		{/if}
		{#if exitLabel}
			<Trace.Description class={failed ? 'text-error' : 'tabular'}>
				{exitLabel}
			</Trace.Description>
		{/if}
		{#if part.backgroundElapsedMs !== undefined}
			<!--
				The TASK's wall clock, not the call's. `durationMs` stops when the
				call returned, which for a backgrounded task is the moment it was
				handed off — reporting that as the run time would understate a
				long build by minutes.
			-->
			<Trace.Description class="tabular">
				{formatDuration(part.backgroundElapsedMs)}
			</Trace.Description>
		{:else if part.durationMs}
			<Trace.Description class="tabular">{formatDuration(part.durationMs)}</Trace.Description>
		{/if}
	</Trace.Line>
{/snippet}

<Trace.Root>
	<Trace.Collapsible open={running || failed}>
		<Trace.CollapsibleTrigger>{@render line()}</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-line/80">
			<!--
				The panel: a fixed dark surface with its own chrome, so a command's
				output reads as terminal capture rather than as markdown code. The
				header is the terminal's title bar (cwd or output file), the body
				holds the prompt line and the output.
			-->
			<div
				class="overflow-hidden rounded-lg border border-line-strong/60 bg-code-surface"
				data-slot="terminal-panel"
			>
				<div
					class="flex items-center gap-2 border-b border-line/60 px-2.5 py-1 font-mono text-[10.5px] text-ink-tertiary"
				>
					<span class="flex items-center gap-1" aria-hidden="true">
						<span class="size-1.5 rounded-full bg-error/50"></span>
						<span class="size-1.5 rounded-full bg-plan/50"></span>
						<span class="size-1.5 rounded-full bg-success/50"></span>
					</span>
					<span class="min-w-0 flex-1 truncate">{part.cwd ?? part.outputFile ?? 'shell'}</span>
					{#if part.backgrounded}
						<span class="shrink-0 text-running">background</span>
					{/if}
					{#if running}
						<span class="shrink-0 text-running">running</span>
					{/if}
					{#if lines.length > 0}
						<span class="tabular shrink-0 text-ink-tertiary/60">{lines.length} lines</span>
					{/if}
				</div>

				<!--
					`whitespace-pre` and no wrapping: a terminal does not reflow a
					long line, it scrolls sideways. Wrapping would also break column
					alignment in `git log --graph` and in tables.
				-->
				<div
					bind:this={body}
					class="max-h-80 scrollbar-thin overflow-auto px-3 py-2.5 font-mono text-[11.5px] leading-[1.5]"
					data-slot="terminal-body"
				>
					<!-- The prompt line: `$` then the command as typed. -->
					<div class="flex gap-1.5">
						<span class="shrink-0 text-success select-none">$</span>
						<span class="min-w-0 whitespace-pre text-ink">{part.command}</span>
					</div>

					{#if hidden > 0}
						<p class="mt-1.5 text-ink-tertiary/70">
							… {hidden} earlier line{hidden === 1 ? '' : 's'} hidden
						</p>
					{/if}

					{#if shown.length > 0}
						<!--
							One span per line, with the highlighter's tokens inside.
							`CodeBlock.Line` is the same renderer the markdown blocks
							use, so a colour here and a colour there come from the same
							theme and cannot drift.
						-->
						<div class="mt-1 flex flex-col">
							{#each highlighted.current as line, index (index)}
								<CodeBlock.Line code={line} class="-mx-0 px-0" />
							{/each}
						</div>
					{:else if !running}
						<p class="mt-1.5 text-ink-tertiary italic">
							{part.backgrounded
								? 'No output yet — still running.'
								: 'The command printed nothing.'}
						</p>
					{/if}

					{#if running}
						<div class="mt-1.5 flex items-center gap-1 text-running" aria-label="Command running">
							<span class="size-1.5 animate-pulse rounded-full bg-running"></span>
							<span class="size-1.5 animate-pulse rounded-full bg-running [animation-delay:150ms]"
							></span>
							<span class="size-1.5 animate-pulse rounded-full bg-running [animation-delay:300ms]"
							></span>
						</div>
					{:else if exitLabel}
						<p class={['mt-1.5', failed ? 'text-error' : 'text-ink-tertiary']}>{exitLabel}</p>
					{/if}
				</div>
			</div>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
