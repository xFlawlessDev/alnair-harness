import { describe, expect, it } from 'vitest';
import { loadHighlighter } from './highlighter.js';

/**
 * The Shiki wiring, at the one place it has a rule of its own.
 *
 * `loadHighlighter` is async and pulls the grammar lazily, so these are the
 * slowest tests in the suite; they earn it because the ANSI path has a
 * correctness property that no component test can see — colour state crossing
 * a newline.
 */

const GREEN = '\u001b[32m';
const RESET = '\u001b[0m';

describe('highlighter: ANSI is a whole-block language', () => {
	it('marks ansi as needing one pass over the whole block', async () => {
		const ansi = await loadHighlighter('ansi');
		expect(ansi?.wholeBlock).toBe(true);
	});

	it('marks a real grammar as incremental', async () => {
		// Streaming depends on this: a code block tokenizes only its new lines.
		const json = await loadHighlighter('json');
		expect(json?.wholeBlock).toBe(false);
	});

	it('keeps a colour that spans a newline', async () => {
		// The bug: tokenizing per line reset the state machine at every `\n`, so
		// `git log`'s green header block became green on the first line and
		// default-coloured on the rest.
		const ansi = await loadHighlighter('ansi');
		if (!ansi) throw new Error('ansi must load');

		const lines = ansi.highlight(`${GREEN}one\ntwo\nthree${RESET}`).lines;
		const colors = lines
			.filter((line) => Array.isArray(line))
			.map((line) => (line as { style?: string }[])[0]?.style ?? '');

		expect(colors).toHaveLength(3);
		// Every line carries the green, not just the first: the first and the
		// second must agree, which is exactly what per-line tokenizing broke.
		expect(colors[0]).toBe(colors[1]);
		expect(colors[1]).toBe(colors[2]);
		// And green is not the default foreground, or the test would pass on a
		// highlighter that ignored the escape entirely.
		const plain = ansi.highlight('one\ntwo\nthree').lines;
		const plainColor = (plain[0] as { style?: string }[])[0]?.style;
		expect(colors[0]).not.toBe(plainColor);
	});

	it('resets the colour when the escape says so', async () => {
		const ansi = await loadHighlighter('ansi');
		if (!ansi) throw new Error('ansi must load');

		const lines = ansi.highlight(`${GREEN}green${RESET} plain`).lines;
		const tokens = lines[0] as { content: string; style?: string }[];
		const plain = tokens.find((token) => token.content.includes('plain'));

		expect(plain).toBeDefined();
		// The reset must land: a plain token is not the green one.
		expect(plain?.style).not.toBe(tokens[0]?.style);
	});

	it('returns plain strings for a language it does not know', async () => {
		// An unknown fence language must render as text, never throw.
		expect(await loadHighlighter('not-a-language')).toBeNull();
	});
});
