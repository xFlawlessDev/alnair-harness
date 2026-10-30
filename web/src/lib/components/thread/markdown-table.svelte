<script lang="ts">
	import { onDestroy } from 'svelte';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import MaximizeIcon from '@lucide/svelte/icons/maximize-2';
	import MinimizeIcon from '@lucide/svelte/icons/minimize-2';
	import XIcon from '@lucide/svelte/icons/x';
	import {
		extractTableData,
		tableDataToCSV,
		tableDataToTSV,
		type TableData
	} from 'svelte-streamdown';
	import { copyText, downloadText, safeFilename } from '#lib/clipboard.js';

	/**
	 * A markdown table, with a toolbar that actually works.
	 *
	 * Streamdown ships one (`TableDownload.svelte`), and it has two faults that
	 * matter here:
	 *
	 * - its download revokes the blob URL in the same task as the click, which
	 *   cancels the download in some browsers;
	 * - its copy calls `navigator.clipboard.writeText` directly, which throws
	 *   when the page is not in a secure context — `alnair web --bind 0.0.0.0`
	 *   is not.
	 *
	 * Both go through `#lib/clipboard.ts` here instead, which falls back and
	 * reports failure. The formats are the same four the library offers, so
	 * nothing is lost by replacing it.
	 */
	let {
		token,
		children
	}: {
		/** The lexed table: `raw` is the author's own markdown source. */
		token: { raw: string };
		children: import('svelte').Snippet;
	} = $props();

	/** Which format menu is open, if any. */
	let menu = $state<'download' | 'copy' | undefined>(undefined);
	/** The last action's outcome, so the icon can say "done" or "failed". */
	let outcome = $state<'copied' | 'failed' | undefined>(undefined);
	let expanded = $state(false);
	let host: HTMLDivElement | null = $state(null);

	let timer: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(timer));

	function settle(next: 'copied' | 'failed') {
		outcome = next;
		clearTimeout(timer);
		timer = setTimeout(() => (outcome = undefined), 1_600);
	}

	/** The table as a matrix, read from the DOM so spans are expanded. */
	function data(): TableData | undefined {
		const element = host?.querySelector('table');
		return element ? extractTableData(element) : undefined;
	}

	const base = $derived(
		safeFilename(token.raw.match(/^\|\s*([^|\n]+)/)?.[1]?.trim() ?? 'table', 'table')
	);

	function body(format: 'markdown' | 'html' | 'csv' | 'tsv'): string {
		if (format === 'markdown') {
			// `token.raw` is the author's own source; a DOM round-trip would lose
			// inline formatting (bold in a cell, a link).
			return token.raw;
		}
		if (format === 'html') {
			const element = host?.querySelector('table');
			return element ? cleanHtml(element) : '';
		}
		const table = data();
		if (!table) return '';
		return format === 'csv' ? tableDataToCSV(table) : tableDataToTSV(table);
	}

	/**
	 * The rendered table as portable HTML.
	 *
	 * Class and style attributes are stripped because they are Tailwind
	 * utilities bound to this app's palette: a pasted `<table class="border-line">`
	 * means nothing anywhere else, and the classes are the bulk of the markup.
	 */
	function cleanHtml(element: Element): string {
		const clone = element.cloneNode(true) as HTMLElement;
		for (const node of clone.querySelectorAll('[class], [style]')) {
			node.removeAttribute('class');
			node.removeAttribute('style');
		}
		return clone.outerHTML;
	}

	async function act(format: 'markdown' | 'html' | 'csv' | 'tsv', mode: 'download' | 'copy') {
		const text = body(format);
		menu = undefined;
		if (!text) return settle('failed');
		if (mode === 'copy') {
			settle((await copyText(text)) ? 'copied' : 'failed');
			return;
		}
		const extension = { markdown: 'md', html: 'html', csv: 'csv', tsv: 'tsv' }[format];
		const mime = {
			markdown: 'text/markdown',
			html: 'text/html',
			csv: 'text/csv',
			tsv: 'text/tab-separated-values'
		}[format];
		downloadText(`${base}.${extension}`, text, mime);
		settle('copied');
	}

	const formats = [
		{ id: 'markdown', label: 'Markdown (.md)' },
		{ id: 'html', label: 'HTML (.html)' },
		{ id: 'csv', label: 'CSV (.csv)' },
		{ id: 'tsv', label: 'TSV (.tsv)' }
	] as const;
</script>

<div class="group/table relative my-4">
	<!--
		The toolbar is a sibling of the scroll wrapper and floats over its top
		right corner, appearing on hover — the same pattern the code blocks use.
	-->
	<div
		class="absolute end-2 top-2 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/table:opacity-100 group-hover/table:opacity-100 pointer-coarse:opacity-100"
	>
		<button
			type="button"
			class="flex size-6 items-center justify-center rounded border border-line bg-paper text-ink-tertiary transition-colors hover:text-ink"
			aria-label="Download the table"
			aria-expanded={menu === 'download'}
			onclick={() => (menu = menu === 'download' ? undefined : 'download')}
		>
			{#if outcome === 'failed'}
				<XIcon class="size-3 text-error" />
			{:else if outcome === 'copied'}
				<CheckIcon class="size-3 text-success" />
			{:else}
				<DownloadIcon class="size-3" />
			{/if}
		</button>

		<button
			type="button"
			class="flex size-6 items-center justify-center rounded border border-line bg-paper text-ink-tertiary transition-colors hover:text-ink"
			aria-label="Copy the table"
			aria-expanded={menu === 'copy'}
			onclick={() => (menu = menu === 'copy' ? undefined : 'copy')}
		>
			<CopyIcon class="size-3" />
		</button>

		<button
			type="button"
			class="flex size-6 items-center justify-center rounded border border-line bg-paper text-ink-tertiary transition-colors hover:text-ink"
			aria-label={expanded ? 'Collapse the table' : 'Expand the table'}
			aria-pressed={expanded}
			onclick={() => (expanded = !expanded)}
		>
			{#if expanded}
				<MinimizeIcon class="size-3" />
			{:else}
				<MaximizeIcon class="size-3" />
			{/if}
		</button>
	</div>

	{#if menu}
		<!--
			The format menu. A plain list rather than a portal: the table is
			already the positioned context, and a popover that escaped it would
			need its own click-outside handling for one small menu.
		-->
		<div
			class="absolute end-2 top-9 z-20 flex w-44 flex-col rounded-lg border border-line-strong bg-popover p-1 shadow-lg"
			role="menu"
		>
			{#each formats as format (format.id)}
				<button
					type="button"
					class="rounded px-2 py-1 text-left text-[11.5px] text-ink-secondary transition-colors hover:bg-paper-card hover:text-ink"
					role="menuitem"
					onclick={() => void act(format.id, menu === 'copy' ? 'copy' : 'download')}
				>
					{format.label}
				</button>
			{/each}
		</div>
	{/if}

	<div
		bind:this={host}
		class={[
			'max-w-full overflow-x-auto rounded-lg border border-line',
			expanded ? 'fixed inset-4 z-50 overflow-auto bg-popover p-3 shadow-2xl' : ''
		]}
		role={expanded ? 'dialog' : undefined}
		aria-label={expanded ? 'Table, expanded' : undefined}
	>
		<table class="w-full min-w-full border-collapse text-sm">
			{@render children()}
		</table>
	</div>
</div>
