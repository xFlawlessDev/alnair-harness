<script lang="ts">
	import MessageCircleQuestionIcon from '@lucide/svelte/icons/message-circle-question';
	import CheckIcon from '@lucide/svelte/icons/check';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import type { QuestionPart } from '#lib/harness/types.js';
	import { traceStatus } from './status.js';

	/**
	 * A parked `alnair/ask_user_question`, shown where it happened. Like the
	 * permission card it is a marker, not a control: the answers are collected
	 * in the banner above the composer, which is the one place a blocked agent
	 * is always visible.
	 */
	let { part }: { part: QuestionPart } = $props();

	const status = $derived(traceStatus(part.resolved ? 'complete' : 'pending'));
	const count = $derived(part.questions.length);
</script>

<Trace.Root>
	<Trace.Collapsible open={!part.resolved}>
		<Trace.CollapsibleTrigger>
			<Trace.Line {status}>
				<Trace.Icon>
					<MessageCircleQuestionIcon class={part.resolved ? 'text-tool' : 'text-terra'} />
				</Trace.Icon>
				<Trace.Title>
					<span class="text-ink-secondary">
						{part.resolved ? 'Question answered' : 'Question'}
					</span>
					<span class="ml-1.5 text-[12px] text-ink">
						{count === 1 ? part.questions[0].question : `${count} questions`}
					</span>
				</Trace.Title>
				{#if part.mode === 'plan'}
					<Trace.Description>plan mode</Trace.Description>
				{/if}
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-line/80">
			<!-- One line per question, not the whole questionnaire: the choices
			     belong in the panel above the composer, which shows them one at
			     a time. -->
			<ol class="flex flex-col gap-1 pl-1">
				{#each part.questions as question, position (question.question)}
					<li class="flex items-baseline gap-1.5 text-[11.5px] leading-snug">
						<span class="tabular shrink-0 font-mono text-[9.5px] text-ink-tertiary">
							{position + 1}.
						</span>
						<span class="min-w-0 text-ink-secondary">{question.question}</span>
						{#if question.multiSelect}
							<span
								class="shrink-0 rounded-sm bg-paper-card px-1 font-mono text-[9px] text-ink-tertiary"
							>
								multi
							</span>
						{/if}
					</li>
				{/each}
			</ol>

			{#if !part.resolved}
				<p class="mt-2 flex items-center gap-1 pl-1 text-[11px] text-ink-tertiary">
					<CheckIcon class="size-3 text-terra" />
					Answer above the composer to let the agent continue.
				</p>
			{/if}
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
