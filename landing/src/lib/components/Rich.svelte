<script lang="ts">
	/**
	 * Renders copy that may contain `code` spans.
	 *
	 * Copy is data, so it cannot hold markup; backticks are the one convention
	 * the dictionaries are allowed. Nothing here goes through `{@html}`, so a
	 * dictionary string can never inject markup.
	 */
	let { text, class: className = '' }: { text: string; class?: string } = $props();

	const parts = $derived(
		text
			.split(/(`[^`]+`)/g)
			.filter(Boolean)
			.map((part) =>
				part.length > 1 && part.startsWith('`') && part.endsWith('`')
					? { code: true, text: part.slice(1, -1) }
					: { code: false, text: part }
			)
	);
</script>

<span class={className}
	>{#each parts as part}{#if part.code}<code class="inline-code">{part.text}</code
			>{:else}{part.text}{/if}{/each}</span
>
