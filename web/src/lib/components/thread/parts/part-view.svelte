<script lang="ts">
	import type { TurnPart } from '#lib/harness/types.js';
	import DiffRow from './diff-row.svelte';
	import ErrorRow from './error-row.svelte';
	import FileEditRow from './file-edit-row.svelte';
	import FileReadRow from './file-read-row.svelte';
	import FileWriteRow from './file-write-row.svelte';
	import ImageReadRow from './image-read-row.svelte';
	import ReasoningRow from './reasoning-row.svelte';
	import SubagentRow from './subagent-row.svelte';
	import SystemRow from './system-row.svelte';
	import TerminalRow from './terminal-row.svelte';
	import ToolRow from './tool-row.svelte';

	let {
		part,
		turnClosed = false,
		collapseEdits = true
	}: {
		part: TurnPart;
		/**
		 * Whether the owning turn has finished.
		 *
		 * Only the reasoning row uses it: a thought inside a closed turn is over
		 * by definition, and saying "Thinking" there would be a claim about a
		 * finished turn that the reader can see is false.
		 */
		turnClosed?: boolean;
		/** Whether a diff starts folded; the `collapse_edits` setting. */
		collapseEdits?: boolean;
	} = $props();
</script>

{#if part.kind === 'reasoning'}
	<ReasoningRow {part} {turnClosed} />
{:else if part.kind === 'tool'}
	<ToolRow {part} />
{:else if part.kind === 'file-read'}
	<FileReadRow {part} />
{:else if part.kind === 'file-write'}
	<FileWriteRow {part} />
{:else if part.kind === 'file-edit'}
	<FileEditRow {part} collapse={collapseEdits} />
{:else if part.kind === 'image-read'}
	<ImageReadRow {part} />
{:else if part.kind === 'terminal'}
	<TerminalRow {part} />
{:else if part.kind === 'subagent'}
	<SubagentRow {part} />
{:else if part.kind === 'diff'}
	<DiffRow {part} />
{:else if part.kind === 'error'}
	<ErrorRow {part} />
{:else if part.kind === 'system'}
	<SystemRow {part} />
{/if}
