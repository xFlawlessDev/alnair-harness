import type { QuestionAnswer, QuestionPrompt } from './types.js';

/**
 * Draft answers for one questionnaire.
 *
 * Kept as plain functions rather than component state so the rules — which are
 * the agent's rules, not a UI preference — can be unit-tested:
 * - a single-select question holds at most one label;
 * - a multi-select question toggles labels and keeps them in click order;
 * - free text is held per question and does not clear the labels.
 */
export type QuestionDraft = Record<string, { labels: string[]; notes: string }>;

export const emptyDraft = (questions: QuestionPrompt[]): QuestionDraft =>
	Object.fromEntries(questions.map((question) => [question.question, { labels: [], notes: '' }]));

/** Pick or unpick a choice, honouring the question's arity. */
export function toggleChoice(
	draft: QuestionDraft,
	question: QuestionPrompt,
	label: string
): QuestionDraft {
	const current = draft[question.question] ?? { labels: [], notes: '' };

	if (!question.multiSelect) {
		// Clicking the selected option again clears it, so a misclick is undoable.
		const labels = current.labels[0] === label ? [] : [label];
		return { ...draft, [question.question]: { ...current, labels } };
	}

	const labels = current.labels.includes(label)
		? current.labels.filter((existing) => existing !== label)
		: [...current.labels, label];
	return { ...draft, [question.question]: { ...current, labels } };
}

/** Record free text without disturbing the selected labels. */
export function setNotes(
	draft: QuestionDraft,
	question: QuestionPrompt,
	notes: string
): QuestionDraft {
	const current = draft[question.question] ?? { labels: [], notes: '' };
	return { ...draft, [question.question]: { ...current, notes } };
}

export const isAnswered = (draft: QuestionDraft, question: QuestionPrompt): boolean => {
	const entry = draft[question.question];
	if (!entry) return false;
	return entry.labels.length > 0 || entry.notes.trim().length > 0;
};

/** Every question the agent asked has an answer. */
export const isComplete = (draft: QuestionDraft, questions: QuestionPrompt[]): boolean =>
	questions.every((question) => isAnswered(draft, question));

/** Drop the untouched entries so the payload never carries an empty answer. */
export const answeredOnly = (
	draft: QuestionDraft,
	questions: QuestionPrompt[]
): Record<string, QuestionAnswer> => {
	const out: Record<string, QuestionAnswer> = {};
	for (const question of questions) {
		if (!isAnswered(draft, question)) continue;
		const entry = draft[question.question];
		out[question.question] = {
			labels: entry.labels,
			...(entry.notes.trim().length > 0 ? { notes: entry.notes.trim() } : {})
		};
	}
	return out;
};
