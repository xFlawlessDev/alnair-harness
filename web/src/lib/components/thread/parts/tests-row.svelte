<script lang="ts">
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import { formatDuration } from '#lib/harness/format.js';
	import type { TestsPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	let { part }: { part: TestsPart } = $props();

	const cases = $derived(part.suites.flatMap((suite) => suite.cases));
	const passed = $derived(cases.filter((c) => c.status === 'passed').length);
	const failed = $derived(cases.filter((c) => c.status === 'failed').length);
	const running = $derived(part.status === 'running' || part.status === 'pending');
	const status = $derived(failed > 0 ? 'error' : traceStatus(part.status));
</script>

<Trace.Root>
	<Trace.Collapsible open={running || failed > 0}>
		<Trace.CollapsibleTrigger>
			<Trace.Line {status}>
				<Trace.Icon>
					<FlaskConicalIcon class={failed > 0 ? 'text-error' : 'text-success'} />
				</Trace.Icon>
				<Trace.Title>{part.title}</Trace.Title>
				<Trace.Description class="tabular">
					{#if running}
						running
					{:else}
						{passed} passed{#if failed > 0}, <span class="text-error">{failed} failed</span>{/if}
					{/if}
				</Trace.Description>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-line/80">
			<div class="flex flex-col gap-3">
				<code class="font-mono text-[11.5px] text-ink-tertiary">{part.command}</code>
				{#each part.suites as suite (suite.id)}
					<div class="flex flex-col gap-1">
						<p class="text-[11px] font-medium tracking-wide text-ink-tertiary uppercase">
							{suite.name}
						</p>
						<ul class="flex flex-col gap-1">
							{#each suite.cases as test (test.name)}
								<li class="flex items-baseline gap-2 text-[13px]">
									{#if test.status === 'passed'}
										<CircleCheckIcon class="size-3.5 shrink-0 translate-y-0.5 text-success" />
									{:else if test.status === 'failed'}
										<CircleXIcon class="size-3.5 shrink-0 translate-y-0.5 text-error" />
									{:else}
										<CircleSlashIcon class="size-3.5 shrink-0 translate-y-0.5 text-ink-tertiary" />
									{/if}
									<span class="min-w-0" class:text-error={test.status === 'failed'}>
										{test.name}
									</span>
									<span class="tabular ml-auto shrink-0 font-mono text-[11px] text-ink-tertiary">
										{formatDuration(test.durationMs)}
									</span>
								</li>
								{#if test.message}
									<li class="pl-6 font-mono text-[11.5px] text-error">{test.message}</li>
								{/if}
							{/each}
						</ul>
					</div>
				{/each}
				{#if running}
					<p class="flex items-center gap-1.5 text-[12px] text-ink-tertiary">
						<LoaderIcon class="size-3 animate-spin" /> still running
					</p>
				{/if}
			</div>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
