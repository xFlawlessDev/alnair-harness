<script lang="ts">
	/**
	 * One line of terminal output, coloured by tone.
	 *
	 * A line arrives as spans rather than a string because a real transcript
	 * colours one token inside a row — the `✓` and the node id are different
	 * colours on the same line.
	 */
	import type { TermLine } from '$lib/content/types';

	let { line }: { line: TermLine } = $props();

	const toneClass: Record<string, string> = {
		plain: 'tone-plain',
		dim: 'tone-dim',
		muted: 'tone-muted',
		accent: 'tone-accent',
		ok: 'tone-ok',
		info: 'tone-info',
		err: 'tone-err'
	};

	/**
	 * A wrapped continuation line has to read as a continuation, not as a new
	 * row. The indent is measured from the line's own leading whitespace, so a
	 * transcript stays aligned the way a terminal's soft wrap keeps it.
	 */
	const indent = $derived(line[0]?.text.match(/^ */)?.[0].length ?? 0);
</script>

<span class="line" style:--hang="{indent}ch"
	>{#each line as span}<span class={toneClass[span.tone ?? 'plain']}>{span.text}</span>{/each}</span
>

<style>
	.line {
		display: block;
		min-height: 1.55em;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		/* The first line already carries its real leading spaces in the text, so
		   only the wrapped continuations get pushed — that is what makes a
		   transcript read as aligned instead of ragged. */
		padding-inline-start: var(--hang);
		text-indent: calc(-1 * var(--hang));
	}

	.tone-plain {
		color: var(--ink);
	}

	.tone-dim {
		color: var(--ink-tertiary);
	}

	.tone-muted {
		color: var(--ink-secondary);
	}

	.tone-accent {
		color: var(--olive);
	}

	.tone-ok {
		color: var(--accent-success);
	}

	.tone-info {
		color: var(--accent-running);
	}

	.tone-err {
		color: var(--accent-error);
	}
</style>
