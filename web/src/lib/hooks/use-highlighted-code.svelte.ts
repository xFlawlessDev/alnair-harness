import { loadHighlighter, type Highlighter, type HighlightedLine } from '#lib/highlighter.js';
import type { GrammarState } from 'shiki/core';

/**
 * Highlights `code` in `language`. `current` holds one entry per line: a plain
 * string until the highlighter loads, then the line's tokens. Pass each one to
 * the `code` prop of a `CodeBlock.Line`.
 *
 * ```svelte
 * <script lang="ts">
 * 	const lines = useHighlightedCode(() => code, () => "json");
 * </script>
 *
 * {#each lines.current as line, index (index)}
 * 	<CodeBlock.Line code={line} />
 * {/each}
 * ```
 *
 * `streaming` is the one knob. When the value only ever grows (a reply being
 * written), the incremental path tokenizes just the new lines, starting from
 * the grammar state of the last one. A caller whose text is REPLACED rather
 * than appended — a command's output arriving in bursts, a re-rendered
 * transcript — passes `false` and gets a single pass over the whole value,
 * which is both simpler and immune to a prefix that no longer matches.
 */
export function useHighlightedCode(value: () => string, language: () => string, streaming = true) {
	let loaded = $state.raw<{
		language: string;
		highlighter: Highlighter | null;
	} | null>(null);

	$effect(() => {
		const lang = language();
		let cancelled = false;

		loadHighlighter(lang)
			.then((next) => {
				if (!cancelled) {
					loaded = { language: lang, highlighter: next };
				}
			})
			.catch(() => {});

		return () => {
			cancelled = true;
		};
	});

	// The complete lines, highlighted. While the code streams, only the new
	// lines are tokenized, starting from the grammar state of the last one.
	let done: {
		highlighter: Highlighter | null;
		text: string;
		lines: HighlightedLine[];
		state?: GrammarState;
	} = { highlighter: null, text: '', lines: [] };

	const lines = $derived.by((): HighlightedLine[] => {
		const raw = value();
		// A trailing newline would render as an extra empty line.
		const code = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
		const lang = language();
		const highlighter = loaded?.language === lang ? loaded.highlighter : null;

		if (!highlighter) {
			return code.split('\n');
		}

		// A whole-block language (ANSI) is never spliced: its escapes are
		// stateful, so tokenizing a slice would restart the state machine.
		if (!streaming || highlighter.wholeBlock) {
			done = { highlighter: null, text: '', lines: [] };
			return highlighter.highlight(code).lines;
		}

		let next = done;

		if (next.highlighter !== highlighter || !code.startsWith(next.text)) {
			next = { highlighter, text: '', lines: [] };
		}

		const end = code.lastIndexOf('\n') + 1;

		if (end > next.text.length) {
			const result = highlighter.highlight(code.slice(next.text.length, end - 1), next.state);

			next = {
				highlighter,
				text: code.slice(0, end),
				lines: [...next.lines, ...result.lines],
				state: result.state
			};
		}
		done = next;

		// The last line is still being written, so it is tokenized every time.
		const tail = code.slice(end);

		return [...next.lines, highlighter.highlight(tail, next.state).lines[0]];
	});

	return {
		get current() {
			return lines;
		}
	};
}
