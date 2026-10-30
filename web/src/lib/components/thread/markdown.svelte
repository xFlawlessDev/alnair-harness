<script lang="ts">
	import { Streamdown, shadcnTheme, type Theme } from 'svelte-streamdown';
	import MarkdownCodeBlock from './markdown-code-block.svelte';
	import MarkdownTable from './markdown-table.svelte';

	let {
		content,
		class: className,
		streaming = false,
		/**
		 * Whether to draw Mermaid fences.
		 *
		 * Off by default: the renderer (`pele`) is a large dependency and a
		 * diagram is rare in a coding conversation, so a reader opts in from
		 * Settings. Off, a Mermaid fence renders as an ordinary code block —
		 * the source, which is still useful and costs nothing.
		 */
		mermaid = false
	}: { content: string; class?: string; streaming?: boolean; mermaid?: boolean } = $props();

	/** One level of overrides is all the theme needs; every entry is a flat class map. */
	type ThemeOverride = { [K in keyof Theme]?: Partial<Theme[K]> };

	/**
	 * Streamdown's shadcn theme, re-pointed at the Alnair paper palette. The
	 * defaults reach for `bg-gray-100` and friends; everything here resolves
	 * through our own tokens so dark mode comes for free.
	 */
	const theme: ThemeOverride = {
		...shadcnTheme,
		paragraph: { base: 'text-foreground leading-relaxed' },
		h1: { base: 'mt-6 mb-2 text-xl font-semibold tracking-tight text-foreground' },
		h2: { base: 'mt-5 mb-2 text-lg font-semibold tracking-tight text-foreground' },
		h3: { base: 'mt-4 mb-1.5 text-base font-semibold text-foreground' },
		h4: { base: 'mt-4 mb-1.5 text-sm font-semibold text-foreground' },
		ul: { base: 'my-2 ml-4 list-outside list-disc space-y-1 text-foreground' },
		ol: { base: 'my-2 ml-4 list-outside list-decimal space-y-1 text-foreground' },
		li: { base: 'pl-1 leading-relaxed marker:text-ink-tertiary', checkbox: 'mr-2' },
		codespan: {
			base: 'rounded-[4px] bg-code-surface px-1.5 py-0.5 font-mono text-[0.86em] text-ink ring-1 ring-line'
		},
		blockquote: { base: 'my-3 border-l-2 border-olive/50 pl-4 text-ink-secondary italic' },
		table: {
			base: 'my-4 max-w-full overflow-x-auto rounded-lg border border-line',
			table: 'w-full min-w-full border-collapse text-sm',
			expanded: 'overflow-auto bg-popover p-2 pt-10 shadow-2xl'
		},
		thead: { base: 'bg-paper-raised' },
		th: { base: 'border-b border-line px-3 py-2 text-left font-medium text-ink' },
		td: { base: 'border-b border-line/60 px-3 py-2 align-top' },
		hr: { base: 'my-5 border-line' },
		strong: { base: 'font-semibold text-ink' },
		link: { base: 'text-system underline underline-offset-2 hover:text-system/80' },
		code: { container: 'my-3 overflow-hidden rounded-lg border border-line bg-code-surface' }
	};

	const cls = $derived(['min-w-0 text-sm leading-relaxed', className].filter(Boolean).join(' '));
</script>

<Streamdown
	{content}
	{theme}
	baseTheme="shadcn"
	controls={{ code: true, table: false, mermaid: mermaid }}
	parseIncompleteMarkdown={streaming}
	class={cls}
	components={{ code: MarkdownCodeBlock }}
>
	{#snippet codespan({ children })}
		<code
			class="rounded-[4px] bg-code-surface px-1.5 py-0.5 font-mono text-[0.86em] text-ink ring-1 ring-line"
		>
			{@render children()}
		</code>
	{/snippet}

	<!--
		The library's own table is replaced, not merely restyled: its toolbar
		revokes the blob URL in the same task as the click (which cancels the
		download in some browsers) and copies through `navigator.clipboard`
		directly (which throws outside a secure context, so `--bind 0.0.0.0`
		got a dead button). `markdown-table.svelte` goes through
		`#lib/clipboard.ts` instead and keeps the same four formats.
	-->
	{#snippet table({ token, children })}
		<MarkdownTable {token} {children} />
	{/snippet}
</Streamdown>
