<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { systemNoteLabel } from '#lib/harness/system-notes.js';
	import type { SystemPart } from '#lib/harness/types.js';

	/**
	 * A `<system-reminder>` the agent injected, rendered as system chrome.
	 *
	 * It reaches the wire as a `user_message_chunk` — the shell stores injected
	 * context as a synthetic user message so the model reads it as context — and
	 * the old renderer dutifully drew it as a prompt bubble on the right. That
	 * claimed the reader had typed a background-task notification, which is the
	 * one thing a transcript must never get wrong.
	 *
	 * So: a quiet row, a label naming the mechanism, and the body folded away.
	 * The body is model-facing prose (XML-ish envelopes, file listings), so
	 * showing it by default would bury the conversation; hiding it entirely
	 * would hide why the agent suddenly knew something.
	 */
	let { part }: { part: SystemPart } = $props();

	const label = $derived(systemNoteLabel(part.tag));
	/** The first line, as the collapsed preview. */
	const summary = $derived(firstLine(part.body));

	function firstLine(body: string): string {
		const line = body.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
		const trimmed = line.trim();
		return trimmed.length <= 96 ? trimmed : `${trimmed.slice(0, 95)}…`;
	}
</script>

<details class="group/system w-full min-w-0" data-slot="system-note">
	<summary
		class="flex w-fit max-w-full min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 text-[11px] text-ink-tertiary transition-colors outline-none select-none hover:text-ink-secondary focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden"
		aria-label="{label}, injected by the agent"
	>
		<ChevronRightIcon class="size-3 shrink-0 transition-transform group-open/system:rotate-90" />
		<InfoIcon class="size-3 shrink-0 text-system/70" />
		<span class="shrink-0 font-medium">{label}</span>
		<span class="text-ink-tertiary/40">·</span>
		<span class="min-w-0 truncate text-ink-tertiary/80">{summary}</span>
	</summary>

	<pre
		class="mt-1.5 max-h-64 overflow-auto rounded-md border border-line/70 bg-code-surface px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{part.body}</pre>
</details>
