<script lang="ts" module>
	// Resolved once per app load. Splitting the renderer out keeps Shiki and the
	// Markdown pipeline off the first paint, which matters on a cold session.
	const markdown = import('./markdown.svelte');
</script>

<script lang="ts">
	let {
		content,
		class: className,
		streaming = false,
		/** Draw Mermaid fences instead of showing their source. */
		mermaid = false
	}: { content: string; class?: string; streaming?: boolean; mermaid?: boolean } = $props();
</script>

{#await markdown}
	<p class={['text-sm leading-relaxed whitespace-pre-wrap', className]}>{content}</p>
{:then { default: Markdown }}
	<Markdown {content} {streaming} {mermaid} class={className} />
{:catch}
	<p class={['text-sm leading-relaxed whitespace-pre-wrap', className]}>{content}</p>
{/await}
