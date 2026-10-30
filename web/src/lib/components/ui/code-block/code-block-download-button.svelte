<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button, type ButtonProps } from '#lib/components/ui/button/index.js';
	import { downloadText, safeFilename } from '#lib/clipboard.js';
	import { cn } from '#lib/utils.js';

	/**
	 * Save a block's text as a file.
	 *
	 * The browser-native path — a blob URL behind an `<a download>` — because
	 * the content is already in the page: a server endpoint would need an HTTP
	 * surface for something the client holds.
	 *
	 * `name` is a suggestion, not a path. `safeFilename` strips the characters
	 * every OS refuses, so a language label like `ts title="app.ts"` cannot
	 * produce an unopenable file.
	 */
	let {
		ref = $bindable(null),
		class: className,
		value,
		name = 'snippet',
		extension,
		variant = 'ghost',
		size = 'icon-xs',
		...restProps
	}: ButtonProps & {
		value: string;
		/** Base name, without the extension. */
		name?: string;
		/** Extension without the dot, e.g. `ts`; inferred from `name` when absent. */
		extension?: string;
	} = $props();

	function download() {
		const dot = name.lastIndexOf('.');
		const hasExtension = dot > 0 && dot < name.length - 1;
		const base = hasExtension ? name.slice(0, dot) : name;
		const suffix = extension ?? (hasExtension ? name.slice(dot + 1) : 'txt');
		downloadText(`${safeFilename(base, 'snippet')}.${safeFilename(suffix, 'txt')}`, value);
	}
</script>

<Button
	bind:ref
	data-slot="code-block-download-button"
	{variant}
	{size}
	aria-label="Download as a file"
	class={cn(className)}
	onclick={download}
	{...restProps}
>
	<DownloadIcon />
</Button>
