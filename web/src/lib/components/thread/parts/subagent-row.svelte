<script lang="ts">
	import BotIcon from '@lucide/svelte/icons/bot';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { formatTokens } from '#lib/harness/format.js';
	import type { SubagentPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let { part }: { part: SubagentPart } = $props();

	const status = $derived(traceStatus(part.status));
	const running = $derived(part.status === 'running' || part.status === 'pending');
	const stats = $derived([
		`${part.turnCount} turns`,
		`${part.toolCallCount} tools`,
		`${formatTokens(part.tokensUsed)} tok`
	]);
</script>

{#snippet line()}
	<Trace.Line {status}>
		<Trace.Icon>
			<BotIcon class={running ? 'text-running' : 'text-system'} />
		</Trace.Icon>
		<Trace.Title>
			<span class="text-ink-secondary">Subagent</span>
			<span class="ml-1.5 font-mono text-[11px] text-ink-tertiary">{part.agent}</span>
			<span class="ml-1.5 truncate text-[12px] text-ink">{part.title}</span>
		</Trace.Title>
		<Trace.Description class="tabular">{stats.join(' · ')}</Trace.Description>
	</Trace.Line>
{/snippet}

<Trace.Root>
	<Trace.Collapsible>
		<Trace.CollapsibleTrigger>{@render line()}</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-line/80">
			<div class="flex flex-col gap-2 pl-1">
				{#if part.model}
					<p class="font-mono text-[10.5px] text-ink-tertiary">model {part.model}</p>
				{/if}
				{#if part.toolsUsed.length > 0}
					<div class="flex flex-wrap gap-1">
						{#each part.toolsUsed as tool (tool)}
							<span
								class="rounded-sm bg-paper-card px-1.5 py-0.5 font-mono text-[10px] text-ink-tertiary"
							>
								{tool}
							</span>
						{/each}
					</div>
				{/if}
				{#if part.error}
					<p class="text-[11.5px] text-error">{part.error}</p>
				{:else if part.result}
					<p class="border-l border-line pl-2 text-[11.5px] leading-relaxed text-ink-secondary">
						{part.result}
					</p>
				{:else if running}
					<p class="text-[11px] text-ink-tertiary">Still running…</p>
				{/if}
			</div>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
