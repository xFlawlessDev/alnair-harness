<script lang="ts">
	import type { TurnPart } from '#lib/harness/types.js';
	import CheckpointRow from './checkpoint-row.svelte';
	import DiffRow from './diff-row.svelte';
	import ErrorRow from './error-row.svelte';
	import FileEditRow from './file-edit-row.svelte';
	import FileReadRow from './file-read-row.svelte';
	import FileWriteRow from './file-write-row.svelte';
	import ImageReadRow from './image-read-row.svelte';
	import PlanRow from './plan-row.svelte';
	import ReasoningRow from './reasoning-row.svelte';
	import SourcesRow from './sources-row.svelte';
	import SubagentRow from './subagent-row.svelte';
	import TerminalRow from './terminal-row.svelte';
	import TestsRow from './tests-row.svelte';
	import ToolRow from './tool-row.svelte';

	let { part }: { part: TurnPart } = $props();
</script>

{#if part.kind === 'reasoning'}
	<ReasoningRow {part} />
{:else if part.kind === 'tool'}
	<ToolRow {part} />
{:else if part.kind === 'file-read'}
	<FileReadRow {part} />
{:else if part.kind === 'file-write'}
	<FileWriteRow {part} />
{:else if part.kind === 'file-edit'}
	<FileEditRow {part} />
{:else if part.kind === 'image-read'}
	<ImageReadRow {part} />
{:else if part.kind === 'terminal'}
	<TerminalRow {part} />
{:else if part.kind === 'plan'}
	<PlanRow {part} />
{:else if part.kind === 'subagent'}
	<SubagentRow {part} />
{:else if part.kind === 'tests'}
	<TestsRow {part} />
{:else if part.kind === 'sources'}
	<SourcesRow {part} />
{:else if part.kind === 'diff'}
	<DiffRow {part} />
{:else if part.kind === 'error'}
	<ErrorRow {part} />
{:else if part.kind === 'checkpoint'}
	<CheckpointRow {part} />
{/if}
