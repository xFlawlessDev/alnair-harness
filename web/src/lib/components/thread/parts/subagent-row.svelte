<script lang="ts">
	import BotIcon from '@lucide/svelte/icons/bot';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleDotIcon from '@lucide/svelte/icons/circle-dot';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import type { SubagentPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let { part }: { part: SubagentPart } = $props();

	const running = $derived(part.status === 'running' || part.status === 'pending');
	const status = $derived(traceStatus(part.status));
</script>

<Trace.Root>
	<Trace.Collapsible open={running}>
		<Trace.CollapsibleTrigger>
			<Trace.Line {status}>
				<Trace.Icon>
					<BotIcon class="text-system" />
				</Trace.Icon>
				<Trace.Title>{part.title}</Trace.Title>
				<Trace.Description class="font-mono text-[11px]">{part.agent}</Trace.Description>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-line/80">
			<div class="flex flex-col gap-3">
				<ol class="flex flex-col gap-1">
					{#each part.steps as step (step.id)}
						<li class="flex items-center gap-2 text-[13px]">
							{#if step.status === 'complete'}
								<CircleCheckIcon class="size-3.5 shrink-0 text-success" />
							{:else if step.status === 'running'}
								<LoaderIcon class="size-3.5 shrink-0 animate-spin text-system" />
							{:else}
								<CircleDotIcon class="size-3.5 shrink-0 text-ink-tertiary/60" />
							{/if}
							<span class="min-w-0 truncate" class:text-ink-tertiary={step.status === 'pending'}>
								{step.label}
							</span>
							{#if step.detail}
								<span class="ml-auto font-mono text-[11px] text-ink-tertiary">{step.detail}</span>
							{/if}
						</li>
					{/each}
				</ol>
				{#if part.result}
					<div
						class="rounded-md border border-line bg-paper-raised/60 p-3 text-[13px] leading-relaxed"
					>
						{part.result}
					</div>
				{/if}
				<p class="font-mono text-[11px] text-ink-tertiary">model · {part.model}</p>
			</div>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
