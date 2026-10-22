<script lang="ts">
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { formatDuration } from '#lib/harness/format.js';
	import { commandSummary, terminalLines } from '#lib/harness/terminal-output.js';
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
	 */
	let { part }: { part: TerminalPart } = $props();

	const failed = $derived(
		part.status === 'error' || (part.exitCode !== undefined && part.exitCode !== 0)
	);
	const running = $derived(part.status === 'running' || part.status === 'pending');
	const status = $derived(failed ? 'error' : traceStatus(part.status));

	const heading = $derived.by(() => {
		if (part.backgrounded) return 'Backgrounded';
		if (running) return 'Running';
		if (failed) return 'Failed';
		return 'Ran';
	});

	const summary = $derived(commandSummary(part.command));
	const lines = $derived(terminalLines(part.output));
	/** The last few lines while running; the whole thing once it settles. */
	const shown = $derived(running && lines.length > 12 ? lines.slice(-12) : lines);
	const hidden = $derived(lines.length - shown.length);

	const exitLabel = $derived(
		part.exitCode === undefined
			? undefined
			: part.exitCode === 0
				? 'exit 0'
				: `exit ${part.exitCode}`
	);
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
		{#if part.durationMs}
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
				</div>

				<div class="max-h-80 overflow-auto px-3 py-2.5 font-mono text-[11.5px] leading-[1.55]">
					<!-- The prompt line: `$` then the command as typed, wrapping. -->
					<div class="flex gap-1.5">
						<span class="shrink-0 text-success select-none">$</span>
						<span class="min-w-0 break-all whitespace-pre-wrap text-ink">{part.command}</span>
					</div>

					{#if hidden > 0}
						<p class="mt-1.5 text-ink-tertiary">
							… {hidden} earlier line{hidden === 1 ? '' : 's'} hidden
						</p>
					{/if}

					{#if shown.length > 0}
						<div class="mt-1.5 flex flex-col">
							{#each shown as row, index (index)}
								<span class="break-all whitespace-pre-wrap text-ink-secondary"
									>{row || '\u00a0'}</span
								>
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
