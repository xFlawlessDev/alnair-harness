<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleDotIcon from '@lucide/svelte/icons/circle-dot';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import type { PlanPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let { part }: { part: PlanPart } = $props();

	const done = $derived(part.steps.filter((step) => step.status === 'complete').length);
	const total = $derived(part.steps.length);
	const allDone = $derived(done === total);
</script>

<Trace.Root>
	<Trace.Collapsible open={!allDone}>
		<Trace.CollapsibleTrigger>
			<Trace.Line status={allDone ? undefined : 'running'}>
				<Trace.Icon>
					<ListChecksIcon class="text-plan" />
				</Trace.Icon>
				<Trace.Title>{part.title}</Trace.Title>
				<Trace.Description class="tabular">{done}/{total}</Trace.Description>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-line/80">
			<ol class="flex flex-col gap-1.5">
				{#each part.steps as step (step.id)}
					{@const status = traceStatus(step.status)}
					<li class="flex items-start gap-2 text-[13px] leading-snug" data-status={status}>
						<span class="mt-px flex size-4 shrink-0 items-center justify-center">
							{#if step.status === 'complete'}
								<CircleCheckIcon class="size-3.5 text-success" />
							{:else if step.status === 'running'}
								<LoaderIcon class="size-3.5 animate-spin text-plan" />
							{:else if step.status === 'error'}
								<CircleDotIcon class="size-3.5 text-error" />
							{:else}
								<CircleDotIcon class="size-3.5 text-ink-tertiary/60" />
							{/if}
						</span>
						<span
							class="min-w-0"
							class:text-ink-tertiary={step.status === 'pending'}
							class:line-through={step.status === 'complete'}
							class:decoration-line-strong={step.status === 'complete'}
						>
							{step.title}
						</span>
					</li>
				{/each}
			</ol>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
