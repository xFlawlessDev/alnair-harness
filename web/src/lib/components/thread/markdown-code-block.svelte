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
		</CodeBlock.Actions>
	</CodeBlock.Header>
	<CodeBlock.Content>
		{#each lines.current as line, index (index)}
			<CodeBlock.Line code={line} />
		{/each}
	</CodeBlock.Content>
</CodeBlock.Root>
