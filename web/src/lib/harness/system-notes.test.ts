import { describe, expect, it } from 'vitest';
import { isSystemEnvelope, systemEnvelope, systemNoteLabel } from './system-notes.js';

describe('systemEnvelope', () => {
	it('unwraps a system-reminder and keeps the body', () => {
		const envelope = systemEnvelope(
			'<system-reminder>\nBackground task "x" completed.\n</system-reminder>'
		);
		expect(envelope).toEqual({
			tag: 'system-reminder',
			body: 'Background task "x" completed.'
		});
	});

	it('accepts the other wrappers the harness injects', () => {
		for (const tag of [
			'memory-context',
			'harness-lessons',
			'agent_skills',
			'goal-state',
			'skill_information'
		]) {
			const envelope = systemEnvelope(`<${tag}>\nbody\n</${tag}>`);
			expect(envelope?.tag, tag).toBe(tag);
		}
	});

	it('accepts an unknown wrapper, because a future injection is still chrome', () => {
		// The dangerous direction is rendering injected context as a user
		// bubble; an unrecognised wrapper is more likely a newer injection than
		// something the reader typed.
		expect(systemEnvelope('<future-note>\nhello\n</future-note>')).toEqual({
			tag: 'future-note',
			body: 'hello'
		});
	});

	it('leaves an ordinary prompt alone', () => {
		expect(systemEnvelope('fix the failing test')).toBeUndefined();
		expect(systemEnvelope('')).toBeUndefined();
	});

	it('leaves a prompt that merely MENTIONS the tag alone', () => {
		// A question about the mechanism must stay a question. Both ends have to
		// be anchored for this to hold.
		expect(systemEnvelope('why does <system-reminder> show up in my chat?')).toBeUndefined();
		expect(
			systemEnvelope('<system-reminder> is the tag, and here is more text after it')
		).toBeUndefined();
	});

	it('leaves a prompt with text on both sides of a wrapper alone', () => {
		expect(
			systemEnvelope('look at this: <system-reminder>x</system-reminder> — is it right?')
		).toBeUndefined();
	});

	it('rejects mismatched closers', () => {
		expect(systemEnvelope('<system-reminder>body</other>')).toBeUndefined();
	});

	it('rejects an empty wrapper', () => {
		// An empty wrapper has nothing to show, and treating it as a note would
		// silently drop the message instead of rendering the (empty) bubble.
		expect(systemEnvelope('<system-reminder>\n\n</system-reminder>')).toBeUndefined();
	});

	it('handles a wrapper with no surrounding whitespace', () => {
		expect(systemEnvelope('<system-reminder>tight</system-reminder>')?.body).toBe('tight');
	});

	it('handles a body that itself contains markup', () => {
		const body = 'a <b>bold</b> claim\nand a second line';
		expect(systemEnvelope(`<system-reminder>\n${body}\n</system-reminder>`)?.body).toBe(body);
	});

	it('trims the padding the shell writes', () => {
		expect(systemEnvelope('<system-reminder>\n\n  body  \n\n</system-reminder>')?.body).toBe(
			'body'
		);
	});
});

describe('isSystemEnvelope', () => {
	it('is the cheap predicate over the same rule', () => {
		expect(isSystemEnvelope('<system-reminder>x</system-reminder>')).toBe(true);
		expect(isSystemEnvelope('hello')).toBe(false);
	});
});

describe('systemNoteLabel', () => {
	it('names the known mechanisms', () => {
		expect(systemNoteLabel('system-reminder')).toBe('System reminder');
		expect(systemNoteLabel('memory-context')).toBe('Memory');
		expect(systemNoteLabel('harness-lessons')).toBe('Harness lessons');
	});

	it('falls back to the tag with its separators opened up', () => {
		expect(systemNoteLabel('some-future_note')).toBe('some future note');
	});
});
