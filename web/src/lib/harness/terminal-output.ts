/**
 * Terminal output, made safe to render in a browser.
 *
 * The agent already strips ANSI before it hands a command's output to the wire
 * (`alnair-tools` bash/concise/bash.rs), but two other paths reach the same
 * renderer: MCP tools, which run arbitrary programs, and older persisted
 * transcripts. A raw `\u001b[31m` in a `<pre>` is at best noise and at worst a
 * sequence the browser's own escape handling can act on, so this normalizes
 * once, at the boundary, instead of trusting every producer.
 *
 * Two transformations matter for a shell:
 *
 * - **SGR / CSI sequences** are dropped. Colour is not carried on the wire
 *   (there is no style side-channel), so a stripped sequence loses nothing a
 *   reader could have seen.
 * - **Carriage returns collapse.** A progress bar rewrites one line hundreds of
 *   times with `\r`; rendering every intermediate state would print hundreds of
 *   near-identical lines. Only the last segment before the newline is what the
 *   terminal would have shown.
 */

/** CSI / OSC / single-character escape sequences, in one pass. */
const ANSI = new RegExp(
	[
		// CSI: ESC [ … final byte
		'\\u001b\\[[0-?]*[ -/]*[@-~]',
		// OSC: ESC ] … (BEL | ST)
		'\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)',
		// Single-character escapes (ESC 7, ESC =, …)
		'\\u001b[@-Z\\\\-_]'
	].join('|'),
	'g'
);

/** Strip escape sequences from a string. */
export function stripAnsi(value: string): string {
	return value.replace(ANSI, '');
}

/**
 * Collapse `\r`-rewritten lines to the state a terminal would have displayed.
 *
 * `a\rb` is one line reading `b`; a trailing `\r` (a line cleared before its
 * newline) leaves the line as it was last written.
 */
export function collapseCarriageReturns(value: string): string {
	if (!value.includes('\r')) return value;
	return value
		.split('\n')
		.map((line) => {
			if (!line.includes('\r')) return line;
			const parts = line.split('\r').filter((part) => part.length > 0);
			return parts.length > 0 ? parts[parts.length - 1] : '';
		})
		.join('\n');
}

/**
 * The lines a terminal pane would show for a command's output.
 *
 * Trailing blank lines are dropped: a command that ends with `\n` should not
 * paint an empty row, and neither should one that printed nothing at all.
 */
export function terminalLines(output: string): string[] {
	if (!output) return [];
	const normalized = collapseCarriageReturns(stripAnsi(output));
	const lines = normalized.split('\n');
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
	return lines;
}

/**
 * The `$ command` line, on one line.
 *
 * A multi-line command (a heredoc, a `&&` chain) keeps its first line and says
 * how many followed, because the collapsed row is a single line and truncating
 * silently would hide that the command was longer.
 */
export function commandSummary(command: string): { first: string; extra: number } {
	const lines = command.split('\n').filter((line) => line.trim().length > 0);
	const first = lines[0]?.trim() ?? '';
	return { first, extra: Math.max(0, lines.length - 1) };
}
