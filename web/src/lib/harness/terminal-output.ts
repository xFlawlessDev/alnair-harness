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

/** The same pattern, global, for collecting every escape in a string. */
const ANSI_ALL = new RegExp(ANSI.source, 'g');

/** Strip escape sequences from a string. */
export function stripAnsi(value: string): string {
	return value.replace(ANSI, '');
}

/**
 * Whether a string carries an ANSI escape sequence.
 *
 * A cheap pre-check for a caller that would otherwise tokenize every plain
 * command's output through the ANSI grammar for no visible change: without
 * escapes the highlighter produces one default-coloured token per line, which
 * is exactly what a plain `<span>` already renders.
 */
export function hasAnsi(value: string): boolean {
	return value.includes('\u001b');
}

/**
 * Collapse `\r`-rewritten lines to the state a terminal would have displayed.
 *
 * `a\rb` is one line reading `b`; a trailing `\r` (a line cleared before its
 * newline) leaves the line as it was last written.
 *
 * SGR sequences written BEFORE a `\r` still apply to what follows: `\r` moves
 * the cursor, it does not reset colour. So every escape from the discarded
 * writes is replayed ahead of the survivor — otherwise a coloured progress bar
 * would lose its colour at the exact moment it finished.
 */
export function collapseCarriageReturns(value: string): string {
	if (!value.includes('\r')) return value;
	return value
		.split('\n')
		.map((line) => {
			if (!line.includes('\r')) return line;
			const parts = line.split('\r');

			// The last non-empty write is what the terminal ended up showing.
			let survivor = parts.length - 1;
			while (survivor > 0 && parts[survivor].length === 0) survivor -= 1;

			const escapes = parts
				.slice(0, survivor)
				.flatMap((part) => part.match(ANSI_ALL) ?? [])
				.join('');
			return `${escapes}${parts[survivor]}`;
		})
		.join('\n');
}

/**
 * The text a `BashOutput` actually printed.
 *
 * `rawOutput.output` is a **byte array**, not a string: the shell serializes
 * `Vec<u8>` (see `BashOutput` in `alnair-tools`), because a command's output is
 * not guaranteed to be UTF-8. Rendering it directly produced `[56,50,97,...]`
 * in the panel — or nothing, when a caller stringified it into a `<pre>` and
 * the browser showed a wall of numbers.
 *
 * The byte array is preferred over `output_for_prompt`, for two reasons that
 * both showed up in a real transcript:
 *
 * - `output_for_prompt` is **ANSI-stripped** (`format_default_prompt` runs
 *   `strip_str` before storing it), so it is the one copy that has already lost
 *   the colours a terminal would show.
 * - It is prefixed with an `exit: N` header, which the panel renders in its own
 *   footer — taking this copy printed the status twice.
 *
 * `output_for_prompt` remains the fallback for a payload that carries no bytes,
 * and a plain string is accepted so an older or synthetic shape still renders.
 */
export function outputText(rawOutput: unknown): string {
	if (!rawOutput || typeof rawOutput !== 'object') return '';
	const record = rawOutput as {
		output_for_prompt?: unknown;
		output?: unknown;
	};

	const bytes = record.output;
	if (typeof bytes === 'string') return bytes;
	if (Array.isArray(bytes)) {
		return new TextDecoder('utf-8', { fatal: false }).decode(
			Uint8Array.from(bytes.filter((value): value is number => typeof value === 'number'))
		);
	}

	if (typeof record.output_for_prompt === 'string') return record.output_for_prompt;
	return '';
}

/**
 * The lines a terminal pane would show for a command's output.
 *
 * Trailing blank lines are dropped: a command that ends with `\n` should not
 * paint an empty row, and neither should one that printed nothing at all.
 *
 * `stripAnsi` is what a plain-text renderer wants. A caller that can colour
 * the output (the terminal panel does, through Shiki's ANSI grammar) asks for
 * `keepColor` and gets the escapes back, with only the cursor rewrites
 * collapsed.
 */
export function terminalLines(output: string, keepColor = false): string[] {
	if (!output) return [];
	const normalized = collapseCarriageReturns(keepColor ? output : stripAnsi(output));
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
