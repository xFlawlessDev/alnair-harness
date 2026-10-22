import { describe, expect, it } from 'vitest';
import {
	collapseCarriageReturns,
	commandSummary,
	hasAnsi,
	outputText,
	stripAnsi,
	terminalLines
} from './terminal-output.js';

/**
 * The terminal renderer's normalization.
 *
 * These rules exist because the browser is not a terminal: it has no escape
 * interpreter and no carriage-return semantics, so a raw `\u001b[31m` is visible
 * junk and `a\rb` renders as one line containing both. The agent usually strips
 * ANSI before it sends a command's output, but MCP tools and older transcripts
 * reach the same renderer, which is why the boundary normalizes.
 */

describe('stripAnsi', () => {
	it('drops SGR colour sequences', () => {
		expect(stripAnsi('\u001b[31mred\u001b[0m text')).toBe('red text');
	});

	it('drops cursor-movement CSI sequences', () => {
		expect(stripAnsi('\u001b[2K\u001b[1Grewritten')).toBe('rewritten');
	});

	it('drops OSC title sequences terminated by BEL', () => {
		expect(stripAnsi('\u001b]0;a title\u0007output')).toBe('output');
	});

	it('drops OSC sequences terminated by ST', () => {
		expect(stripAnsi('\u001b]8;;https://x\u001b\\link\u001b]8;;\u001b\\')).toBe('link');
	});

	it('leaves ordinary text alone', () => {
		expect(stripAnsi('plain $ text — with unicode')).toBe('plain $ text — with unicode');
	});
});

describe('collapseCarriageReturns', () => {
	it('keeps only the last write of a rewritten line', () => {
		expect(collapseCarriageReturns('10%\r50%\r100%')).toBe('100%');
	});

	it('keeps a line that only moved its cursor before the newline', () => {
		// `\r` moves the cursor to column 0; it does not erase. Only an erase
		// sequence (`\u001b[2K`) clears a line, which `stripAnsi` has already
		// dropped by the time this runs.
		expect(collapseCarriageReturns('working\r\nnext')).toBe('working\nnext');
	});

	it('treats a line rewritten to nothing as empty', () => {
		// A progress bar that clears itself writes text, then `\r` plus spaces.
		expect(collapseCarriageReturns('busy\r   \ndone')).toBe('   \ndone');
	});

	it('leaves text without carriage returns untouched', () => {
		const text = 'a\nb\nc';
		expect(collapseCarriageReturns(text)).toBe(text);
	});
});

describe('outputText', () => {
	it('decodes the byte array a BashOutput actually carries', () => {
		// This is the shape a real transcript holds: `output` is `Vec<u8>`, not a
		// string. Rendering it directly painted `[56,50,97,…]` in the panel.
		const bytes = [...Buffer.from('82a408a fix the web ui\n', 'utf8')];
		expect(outputText({ output: bytes })).toBe('82a408a fix the web ui\n');
	});

	it('prefers the bytes over the model-facing copy', () => {
		// `output_for_prompt` is ANSI-stripped and prefixed with `exit: N`. Taking
		// it lost every colour and printed the status twice — the panel renders
		// the exit code in its own footer.
		expect(
			outputText({
				output_for_prompt: 'exit: 0\nplain text\n',
				output: [...Buffer.from('\u001b[32mgreen\u001b[0m\n')]
			})
		).toBe('\u001b[32mgreen\u001b[0m\n');
	});

	it('falls back to the model-facing copy when there are no bytes', () => {
		expect(outputText({ output_for_prompt: 'exit: 0\nok\n' })).toBe('exit: 0\nok\n');
	});

	it('accepts a plain string in `output`', () => {
		expect(outputText({ output: 'plain' })).toBe('plain');
	});

	it('replaces invalid UTF-8 rather than throwing', () => {
		// A command may emit binary; the panel must still render.
		const bytes = [0x61, 0xff, 0x62];
		expect(outputText({ output: bytes })).toBe('a\ufffdb');
	});

	it('is empty for a missing or non-object payload', () => {
		expect(outputText(undefined)).toBe('');
		expect(outputText(null)).toBe('');
		expect(outputText({})).toBe('');
		expect(outputText({ output: 42 })).toBe('');
	});

	it('decodes multi-byte characters across byte boundaries', () => {
		const bytes = [...Buffer.from('✓ done — café\n', 'utf8')];
		expect(outputText({ output: bytes })).toBe('✓ done — café\n');
	});
});

describe('terminalLines', () => {
	it('returns nothing for empty output', () => {
		expect(terminalLines('')).toEqual([]);
	});

	it('drops the trailing blank line a final newline produces', () => {
		expect(terminalLines('one\ntwo\n')).toEqual(['one', 'two']);
	});

	it('normalizes ANSI and carriage returns in one pass', () => {
		expect(terminalLines('\u001b[32mok\u001b[0m\r\ndone\r\n')).toEqual(['ok', 'done']);
	});

	it('collapses a progress bar to its final state', () => {
		expect(terminalLines('0%\r50%\r100%\ndone')).toEqual(['100%', 'done']);
	});
});

describe('commandSummary', () => {
	it('keeps a single-line command whole', () => {
		expect(commandSummary('git status')).toEqual({ first: 'git status', extra: 0 });
	});

	it('reports how many lines followed a multi-line command', () => {
		expect(commandSummary('cat <<EOF\nbody\nEOF')).toEqual({ first: 'cat <<EOF', extra: 2 });
	});

	it('ignores blank lines when counting', () => {
		expect(commandSummary('a\n\n\nb\n\n')).toEqual({ first: 'a', extra: 1 });
	});

	it('is empty for a blank command', () => {
		expect(commandSummary('   ')).toEqual({ first: '', extra: 0 });
	});
});

/**
 * Colour handling.
 *
 * A shell writes ANSI escapes, and the transcript keeps them (only the
 * `output_for_prompt` copy is stripped). The terminal panel renders the real
 * escapes through Shiki's `ansi` grammar, so it must ask for them intact —
 * while every other consumer still wants them gone.
 */
describe('hasAnsi', () => {
	it('detects a colour sequence', () => {
		expect(hasAnsi('\u001b[32mok\u001b[0m')).toBe(true);
	});

	it('detects a cursor sequence, which is also an escape', () => {
		expect(hasAnsi('\u001b[2Krewritten')).toBe(true);
	});

	it('is false for plain output', () => {
		expect(hasAnsi('82a408a fix the web ui\n')).toBe(false);
		expect(hasAnsi('')).toBe(false);
	});
});

describe('terminalLines with colour kept', () => {
	it('preserves the escapes the highlighter reads as colour', () => {
		// `ls` marks directories; the panel colours them from these bytes.
		const output = '\u001b[34msrc\u001b[0m  \u001b[34mlib\u001b[0m\n';
		expect(terminalLines(output, true)).toEqual(['\u001b[34msrc\u001b[0m  \u001b[34mlib\u001b[0m']);
	});

	it('strips them by default, which is what a plain renderer wants', () => {
		expect(terminalLines('\u001b[34msrc\u001b[0m\n')).toEqual(['src']);
	});

	it('still collapses a coloured progress bar to its final write', () => {
		// `\r` moves the cursor; it does not clear the colour.
		const output = '\u001b[32m0%\r50%\r100%\u001b[0m\n';
		expect(terminalLines(output, true)).toEqual(['\u001b[32m100%\u001b[0m']);
	});

	it('carries every escape from the discarded writes', () => {
		// A bar that recolours itself (green → yellow → red) keeps the last
		// colour, not the first, because the survivor is what was displayed.
		const output = '\u001b[32m10%\r\u001b[33m60%\r\u001b[31m99%\u001b[0m\n';
		expect(terminalLines(output, true)).toEqual(['\u001b[32m\u001b[33m\u001b[31m99%\u001b[0m']);
	});

	it('drops the trailing blank line with colour kept', () => {
		expect(terminalLines('\u001b[32mok\u001b[0m\n', true)).toEqual(['\u001b[32mok\u001b[0m']);
	});

	it('leaves plain output byte-identical', () => {
		expect(terminalLines('one\ntwo\n', true)).toEqual(['one', 'two']);
	});
});
