<script lang="ts">
	import * as CodeBlock from '#lib/components/ui/code-block/index.js';
	import { useHighlightedCode } from '#lib/hooks/use-highlighted-code.svelte.js';

	let {
		token,
		incomplete = false
	}: {
		token: { text: string; lang?: string };
		incomplete?: boolean;
	} = $props();

	// `ts title="app.ts"` and friends: keep the first word only.
	const language = $derived(token.lang?.split(/[\s{:]/)[0]?.trim() || 'text');
	/**
	 * The filename a fenced block declared, when it declared one.
	 *
	 * ` ```ts title="src/app.ts" ` is a common convention, and the name is what
	 * a download should be called. Parsed leniently: no name is a normal case,
	 * not an error.
	 */
	const declaredName = $derived(
		/title=(?:"([^"]+)"|'([^']+)')/.exec(token.lang ?? '')?.[1] ?? undefined
	);
	const lines = useHighlightedCode(
		() => token.text,
		() => language
	);
</script>

<CodeBlock.Root class="bg-code-surface">
	<CodeBlock.Header>
		<CodeBlock.Title class="font-mono text-xs text-ink-secondary">{language}</CodeBlock.Title>
		<CodeBlock.Actions>
			<CodeBlock.CopyButton value={token.text} disabled={incomplete} />
			<CodeBlock.DownloadButton
				value={token.text}
				name={declaredName ?? 'snippet'}
				extension={language === 'text' || language === 'plaintext' ? 'txt' : language}
				disabled={incomplete}
			/>
		</CodeBlock.Actions>
	</CodeBlock.Header>
	<CodeBlock.Content>
		{#each lines.current as line, index (index)}
			<CodeBlock.Line code={line} />
		{/each}
	</CodeBlock.Content>
</CodeBlock.Root>
