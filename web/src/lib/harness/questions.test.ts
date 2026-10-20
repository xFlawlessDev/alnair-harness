import { describe, expect, it } from 'vitest';
import { acceptedResponse } from './reducer.js';
import { answeredOnly, emptyDraft, isComplete, setNotes, toggleChoice } from './questions.js';
import type { QuestionPrompt } from './types.js';

const single: QuestionPrompt = {
	question: 'Which one?',
	multiSelect: false,
	choices: [
		{ label: 'A', description: 'first', preview: 'preview-a' },
		{ label: 'B', description: 'second' }
	]
};

const multi: QuestionPrompt = {
	question: 'Which ones?',
	multiSelect: true,
	choices: [
		{ label: 'A', description: 'first' },
		{ label: 'B', description: 'second' }
	]
};

describe('question draft', () => {
	it('keeps a single-select answer to one label', () => {
		let draft = emptyDraft([single]);
		draft = toggleChoice(draft, single, 'A');
		draft = toggleChoice(draft, single, 'B');
		expect(draft[single.question].labels).toEqual(['B']);
	});

	it('lets a single-select answer be unpicked by clicking it again', () => {
		let draft = toggleChoice(emptyDraft([single]), single, 'A');
		draft = toggleChoice(draft, single, 'A');
		expect(draft[single.question].labels).toEqual([]);
	});

	it('accumulates multi-select labels in click order', () => {
		let draft = emptyDraft([multi]);
		draft = toggleChoice(draft, multi, 'B');
		draft = toggleChoice(draft, multi, 'A');
		expect(draft[multi.question].labels).toEqual(['B', 'A']);
	});

	it('toggles a multi-select label back off', () => {
		let draft = toggleChoice(emptyDraft([multi]), multi, 'A');
		draft = toggleChoice(draft, multi, 'A');
		expect(draft[multi.question].labels).toEqual([]);
	});

	it('keeps labels when free text is typed', () => {
		let draft = toggleChoice(emptyDraft([single]), single, 'A');
		draft = setNotes(draft, single, 'some context');
		expect(draft[single.question]).toEqual({ labels: ['A'], notes: 'some context' });
	});

	it('treats free text alone as an answer, and whitespace as none', () => {
		const draft = setNotes(emptyDraft([single]), single, '   ');
		expect(isComplete(draft, [single])).toBe(false);
		expect(answeredOnly(draft, [single])).toEqual({});

		const typed = setNotes(emptyDraft([single]), single, 'typed');
		expect(isComplete(typed, [single])).toBe(true);
	});

	it('keeps a later answer intact when an earlier one is revised', () => {
		// The panel shows one question at a time; moving between them must not
		// disturb a draft the reader already filled in.
		let draft = emptyDraft([single, multi]);
		draft = toggleChoice(draft, single, 'A');
		draft = toggleChoice(draft, multi, 'B');
		draft = toggleChoice(draft, single, 'B');
		expect(draft[single.question].labels).toEqual(['B']);
		expect(draft[multi.question].labels).toEqual(['B']);
	});
});

describe('acceptedResponse', () => {
	it('omits unanswered questions', () => {
		const draft = toggleChoice(emptyDraft([single, multi]), single, 'A');
		const response = acceptedResponse([single, multi], answeredOnly(draft, [single, multi]));
		if (response.outcome !== 'accepted') throw new Error('unreachable');
		expect(Object.keys(response.answers)).toEqual([single.question]);
		expect(response.answers[single.question]).toEqual(['A']);
	});

	it('sends a multi-select answer as one element per label', () => {
		let draft = emptyDraft([multi]);
		draft = toggleChoice(draft, multi, 'A');
		draft = toggleChoice(draft, multi, 'B');
		const response = acceptedResponse([multi], answeredOnly(draft, [multi]));
		expect(response.outcome).toBe('accepted');
		if (response.outcome !== 'accepted') throw new Error('unreachable');
		expect(response.answers[multi.question]).toEqual(['A', 'B']);
	});

	it('uses the literal Other label for a freeform-only answer', () => {
		const draft = setNotes(emptyDraft([single]), single, 'a fourth option');
		const response = acceptedResponse([single], answeredOnly(draft, [single]));
		if (response.outcome !== 'accepted') throw new Error('unreachable');
		expect(response.answers[single.question]).toEqual(['Other']);
		expect(response.annotations?.[single.question]).toEqual({ notes: 'a fourth option' });
	});

	it('echoes preview for a single-select pick and never for multi-select', () => {
		const picked = toggleChoice(emptyDraft([single]), single, 'A');
		const withPreview = acceptedResponse([single], answeredOnly(picked, [single]));
		if (withPreview.outcome !== 'accepted') throw new Error('unreachable');
		expect(withPreview.annotations?.[single.question]).toEqual({ preview: 'preview-a' });

		const both = toggleChoice(toggleChoice(emptyDraft([multi]), multi, 'A'), multi, 'B');
		const multiResponse = acceptedResponse([multi], answeredOnly(both, [multi]));
		if (multiResponse.outcome !== 'accepted') throw new Error('unreachable');
		expect(multiResponse.annotations).toBeUndefined();
	});

	it('carries notes alongside a picked label', () => {
		let draft = toggleChoice(emptyDraft([single]), single, 'B');
		draft = setNotes(draft, single, 'but also this');
		const response = acceptedResponse([single], answeredOnly(draft, [single]));
		if (response.outcome !== 'accepted') throw new Error('unreachable');
		expect(response.answers[single.question]).toEqual(['B']);
		expect(response.annotations?.[single.question]).toEqual({ notes: 'but also this' });
	});
});
