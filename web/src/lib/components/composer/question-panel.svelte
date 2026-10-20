<script lang="ts">
	import MessageCircleQuestionIcon from '@lucide/svelte/icons/message-circle-question';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import SkipForwardIcon from '@lucide/svelte/icons/skip-forward';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import type { QuestionRequest } from '#lib/harness/types.js';
	import {
		answeredOnly,
		emptyDraft,
		isAnswered,
		isComplete,
		setNotes,
		toggleChoice,
		type QuestionDraft
	} from '#lib/harness/questions.js';

	/**
	 * The answer surface for a parked `alnair/ask_user_question`.
	 *
	 * One questionnaire is a set of questions; each question is a set of
	 * choices plus an optional freeform line, exactly as the agent sent them.
	 * The buttons follow `mode`: `default` offers Accept and Cancel, `plan`
	 * adds Chat about this and Skip interview.
	 */
	let {
		request,
		onanswer,
		oncancel,
		onchat,
		onskip
	}: {
		request: QuestionRequest;
		/** Every question answered. */
		onanswer: (answers: Record<string, { labels: string[]; notes?: string }>) => void;
		oncancel: () => void;
		/** Plan mode only. */
		onchat?: () => void;
		/** Plan mode only. */
		onskip?: () => void;
	} = $props();

	/**
	 * The draft starts empty and is reset by the `{#key}` wrapper in the page:
	 * a new tool call id remounts the panel, so no effect is needed to clear it.
	 */
	let draft = $state<QuestionDraft>(emptyDraft(request.questions));

	const complete = $derived(isComplete(draft, request.questions));
	const answered = $derived(request.questions.filter((q) => isAnswered(draft, q)).length);

	function submit() {
		if (!complete) return;
		onanswer(answeredOnly(draft, request.questions));
	}
</script>

<div class="flex flex-col gap-3 rounded-xl border border-terra/40 bg-paper px-3.5 py-3">
	<div class="flex items-center gap-2">
		<MessageCircleQuestionIcon class="size-3.5 shrink-0 text-terra" />
		<p class="min-w-0 flex-1 text-[12px] font-medium text-ink-secondary">
			{request.questions.length === 1
				? 'The agent is asking a question'
				: `The agent is asking ${request.questions.length} questions`}
		</p>
		{#if request.mode === 'plan'}
			<span class="rounded-sm bg-paper-card px-1 font-mono text-[9px] text-ink-tertiary">plan</span>
		{/if}
		<span class="tabular shrink-0 font-mono text-[10px] text-ink-tertiary">
			{answered}/{request.questions.length}
		</span>
	</div>

	<!-- The questions scroll inside the panel: a questionnaire must never push
	     the composer off-screen, and the buttons stay pinned below. -->
	<div class="flex max-h-[min(46vh,26rem)] scrollbar-thin flex-col gap-3 overflow-y-auto pr-0.5">
		{#each request.questions as question (question.question)}
			<div class="flex flex-col gap-1.5">
				<p class="text-[12.5px] leading-snug text-ink">{question.question}</p>

				<div class="flex flex-col gap-1">
					{#each question.choices as choice (choice.label)}
						{@const picked = draft[question.question]?.labels.includes(choice.label) ?? false}
						<button
							type="button"
							class={[
								'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors',
								picked
									? 'border-olive/60 bg-olive/10'
									: 'border-line hover:border-line-strong hover:bg-paper-card/60'
							]}
							aria-pressed={picked}
							onclick={() => (draft = toggleChoice(draft, question, choice.label))}
						>
							<span
								class={[
									'mt-px flex size-3.5 shrink-0 items-center justify-center border',
									question.multiSelect ? 'rounded-[3px]' : 'rounded-full',
									picked ? 'border-olive bg-olive text-primary-foreground' : 'border-line-strong'
								]}
							>
								{#if picked}
									<CheckIcon class="size-2.5" />
								{/if}
							</span>
							<span class="flex min-w-0 flex-col gap-0.5">
								<span class="text-[12px] leading-snug text-ink-secondary">{choice.label}</span>
								<span class="text-[11px] leading-snug text-ink-tertiary">
									{choice.description}
								</span>
							</span>
						</button>
					{/each}
				</div>

				<InputGroup.Root
					class="h-8 rounded-md border-line bg-paper-raised has-[[data-slot=input-group-control]:focus-visible]:border-olive/60"
				>
					<InputGroup.Input
						value={draft[question.question]?.notes ?? ''}
						placeholder="Other — type an answer"
						aria-label={`Other answer for: ${question.question}`}
						class="px-2 text-[11.5px]"
						oninput={(event) => (draft = setNotes(draft, question, event.currentTarget.value))}
					/>
				</InputGroup.Root>
			</div>
		{/each}
	</div>

	<div class="flex flex-wrap items-center gap-1.5">
		<Button size="sm" class="h-7 gap-1 text-[11.5px]" disabled={!complete} onclick={submit}>
			<CheckIcon class="size-3" />
			Accept
		</Button>
		<Button variant="outline" size="sm" class="h-7 gap-1 text-[11.5px]" onclick={oncancel}>
			<XIcon class="size-3" />
			Cancel
		</Button>
		{#if request.mode === 'plan'}
			<Button variant="ghost" size="sm" class="h-7 gap-1 text-[11.5px]" onclick={onchat}>
				<MessageSquareIcon class="size-3" />
				Chat about this
			</Button>
			<Button variant="ghost" size="sm" class="h-7 gap-1 text-[11.5px]" onclick={onskip}>
				<SkipForwardIcon class="size-3" />
				Skip interview
			</Button>
		{/if}
	</div>
</div>
