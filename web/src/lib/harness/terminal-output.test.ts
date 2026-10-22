import { describe, expect, it } from 'vitest';
import {
	collapseCarriageReturns,
	commandSummary,
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
