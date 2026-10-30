<script lang="ts">
	import MessageCircleQuestionIcon from '@lucide/svelte/icons/message-circle-question';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
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
	 * One question is shown at a time: a questionnaire can ask several, and
	 * stacking them forces the reader to scan everything before answering
	 * anything. Back and Next move between them; the draft survives the move,
	 * so an answer can be revised after seeing a later question.
	 *
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
	 * Reading `request.questions` here is therefore deliberate — the initial
	 * value IS the value, and a derived draft would fight the reader's typing.
	 */
	// svelte-ignore state_referenced_locally
	let draft = $state<QuestionDraft>(emptyDraft(request.questions));
	let index = $state(0);

	const total = $derived(request.questions.length);
	const current = $derived(request.questions[index]);
	const isFirst = $derived(index === 0);
	const isLast = $derived(index === total - 1);
	const complete = $derived(isComplete(draft, request.questions));
	const answered = $derived(request.questions.filter((q) => isAnswered(draft, q)).length);

	/** This question and every one before it has an answer, so Next can move on. */
	const answeredSoFar = $derived(
		request.questions.slice(0, index + 1).every((question) => isAnswered(draft, question))
	);

	function submit() {
		if (!complete) return;
		onanswer(answeredOnly(draft, request.questions));
	}

	function next() {
		if (!isLast) index += 1;
	}

	function back() {
		if (!isFirst) index -= 1;
	}
</script>

<div class="flex flex-col gap-3 rounded-xl border border-terra/40 bg-paper px-3.5 py-3">
	<div class="flex items-center gap-2">
		<MessageCircleQuestionIcon class="size-3.5 shrink-0 text-terra" />
		<p class="min-w-0 flex-1 text-[12px] font-medium text-ink-secondary">
			{#if total === 1}
				The agent is asking a question
			{:else}
				Question {index + 1} of {total}
			{/if}
		</p>
		{#if request.mode === 'plan'}
			<span class="rounded-sm bg-paper-card px-1 font-mono text-[9px] text-ink-tertiary">plan</span>
		{/if}
		{#if total > 1}
			<!-- One tick per question: filled when answered, ringed when current. -->
			<span
				class="flex shrink-0 items-center gap-1"
				aria-label={`${answered} of ${total} answered`}
			>
				{#each request.questions as question, position (question.question)}
					<span
						class={[
							'size-1.5 rounded-full transition-colors',
							isAnswered(draft, question)
								? 'bg-olive'
								: position === index
									? 'bg-terra/60'
									: 'bg-line-strong'
						]}
					></span>
				{/each}
			</span>
		{:else}
			<span class="tabular shrink-0 font-mono text-[10px] text-ink-tertiary">
				{answered}/{total}
			</span>
		{/if}
	</div>

	<div class="flex flex-col gap-1.5">
		<p class="text-[12.5px] leading-snug text-ink">{current.question}</p>

		<div class="flex flex-col gap-1">
			{#each current.choices as choice (choice.label)}
				{@const picked = draft[current.question]?.labels.includes(choice.label) ?? false}
				<button
					type="button"
					class={[
						'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors',
						picked
							? 'border-olive/60 bg-olive/10'
							: 'border-line hover:border-line-strong hover:bg-paper-card/60'
					]}
					aria-pressed={picked}
					onclick={() => (draft = toggleChoice(draft, current, choice.label))}
				>
					<span
						class={[
							'mt-px flex size-3.5 shrink-0 items-center justify-center border',
							current.multiSelect ? 'rounded-[3px]' : 'rounded-full',
							picked ? 'border-olive bg-olive text-primary-foreground' : 'border-line-strong'
						]}
					>
						{#if picked}
							<CheckIcon class="size-2.5" />
						{/if}
					</span>
					<span class="flex min-w-0 flex-col gap-0.5">
						<span class="text-[12px] leading-snug text-ink-secondary">{choice.label}</span>
						<span class="text-[11px] leading-snug text-ink-tertiary">{choice.description}</span>
					</span>
				</button>
			{/each}
		</div>

		<InputGroup.Root
			class="h-8 rounded-md border-line bg-paper-raised has-[[data-slot=input-group-control]:focus-visible]:border-olive/60"
		>
			<InputGroup.Input
				value={draft[current.question]?.notes ?? ''}
				placeholder="Other — type an answer"
				aria-label={`Other answer for: ${current.question}`}
				class="px-2 text-[11.5px]"
				oninput={(event) => (draft = setNotes(draft, current, event.currentTarget.value))}
			/>
		</InputGroup.Root>
	</div>

	<div class="flex flex-wrap items-center gap-1.5">
		{#if !isFirst}
			<Button variant="outline" size="sm" class="h-7 gap-1 text-[11.5px]" onclick={back}>
				<ArrowLeftIcon class="size-3" />
				Back
			</Button>
		{/if}

		{#if isLast}
			<Button
				size="sm"
				class="h-7 gap-1 text-[11.5px]"
				disabled={!complete}
				title={complete ? undefined : 'Answer every question to continue'}
				onclick={submit}
			>
				<CheckIcon class="size-3" />
				Accept
			</Button>
		{:else}
			<Button
				size="sm"
				class="h-7 gap-1 text-[11.5px]"
				disabled={!answeredSoFar}
				title={answeredSoFar ? undefined : 'Answer this question to continue'}
				onclick={next}
			>
				Next
				<ArrowRightIcon class="size-3" />
			</Button>
		{/if}

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
