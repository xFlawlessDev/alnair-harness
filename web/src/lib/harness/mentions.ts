import type { FileEntry, SlashCommand } from './types.js';

/**
 * What the composer should offer while the user types.
 *
 * Two triggers, both at the caret: `/` at the start of the message opens the
 * command menu, `@` anywhere opens the file menu. The token under the caret is
 * what filters the list, and accepting an entry replaces exactly that token.
 *
 * Kept as pure functions so the rules can be tested without a DOM.
 */
export type Trigger =
	| { kind: 'command'; query: string; start: number; end: number }
	| { kind: 'mention'; query: string; start: number; end: number }
	| null;

const isBoundary = (char: string | undefined) => char === undefined || /\s/.test(char);

/**
 * Read the trigger at the caret.
 *
 * `value` is the whole message, `caret` the cursor offset. A `/` only opens the
 * command menu at the start of a line — mid-sentence it is just punctuation.
 */
export function triggerAt(value: string, caret: number): Trigger {
	// Walk back to the start of the token under the caret.
	let start = caret;
	while (start > 0 && !isBoundary(value[start - 1])) start -= 1;

	// Walk forward to the end of that token, so accepting replaces the whole
	// thing even when the caret sits in the middle.
	let end = caret;
	while (end < value.length && !isBoundary(value[end])) end += 1;

	const token = value.slice(start, end);
	if (token.length === 0) return null;

	if (token.startsWith('/')) {
		// Only at the start of a line: `/` inside prose is not a command.
		const atLineStart = start === 0 || value[start - 1] === '\n';
		if (!atLineStart) return null;
		return { kind: 'command', query: token.slice(1), start, end };
	}

	if (token.startsWith('@')) {
		return { kind: 'mention', query: token.slice(1), start, end };
	}

	return null;
}

/**
 * Replace the triggered token with the accepted entry, and put the caret where
 * the user should keep typing: after a command's trailing space, or after a
 * mention's trailing space so several files can be mentioned in a row.
 */
export function insertEntry(
	value: string,
	trigger: NonNullable<Trigger>,
	replacement: string
): { value: string; caret: number } {
	const before = value.slice(0, trigger.start);
	const after = value.slice(trigger.end);
	// Do not double a space the reader already typed after the token.
	const separator = after.startsWith(' ') || after.length === 0 ? '' : ' ';
	const text = `${replacement}${separator}`;
	return { value: `${before}${text}${after}`, caret: before.length + text.length };
}

/** Case-insensitive subsequence match, the shape every picker uses. */
export function fuzzyMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	const haystack = target.toLowerCase();
	let index = 0;
	for (const char of query.toLowerCase()) {
		index = haystack.indexOf(char, index);
		if (index === -1) return false;
		index += 1;
	}
	return true;
}

/**
 * Rank a list for the menu: prefix matches first, then substring, then
 * subsequence. Within a tier the order is alphabetical, so the list never
 * reshuffles between keystrokes for reasons the reader cannot see.
 */
export function rank<T>(items: T[], query: string, key: (item: T) => string): T[] {
	if (query.length === 0) return items;
	const needle = query.toLowerCase();

	const scored = items
		.map((item) => {
			const value = key(item);
			const lower = value.toLowerCase();
			const score = lower.startsWith(needle)
				? 0
				: lower.includes(needle)
					? 1
					: fuzzyMatch(needle, lower)
						? 2
						: -1;
			return { item, value, score };
		})
		.filter((entry) => entry.score >= 0);

	scored.sort((a, b) => a.score - b.score || a.value.localeCompare(b.value));
	return scored.map((entry) => entry.item);
}

/** Files first or directories first? Directories lead: they are the way in. */
export const sortEntries = (entries: FileEntry[]): FileEntry[] =>
	[...entries].sort((a, b) => {
		if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

/** The commands that match what was typed after the slash. */
export const filterCommands = (commands: SlashCommand[], query: string): SlashCommand[] =>
	rank(commands, query, (command) => command.name);

/** The entries that match what was typed after the at-sign. */
export const filterEntries = (entries: FileEntry[], query: string): FileEntry[] =>
	rank(sortEntries(entries), query, (entry) => entry.path);
