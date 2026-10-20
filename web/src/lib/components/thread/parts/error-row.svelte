<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as CodeBlock from '#lib/components/ui/code-block/index.js';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import type { ErrorPart } from '#lib/harness/types.js';

	let { part }: { part: ErrorPart } = $props();
</script>

<Trace.Root>
	<Trace.Collapsible open>
		<Trace.CollapsibleTrigger>
			<Trace.Line status="error">
				<Trace.Icon>
					<TriangleAlertIcon />
				</Trace.Icon>
				<Trace.Title>{part.title}</Trace.Title>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-error/40">
			<p class="text-[13px] leading-relaxed text-error">{part.message}</p>
			{#if part.detail}
				<CodeBlock.Root size="sm" variant="destructive" class="mt-2 bg-code-surface">
					<CodeBlock.Content wrap class="max-h-64" code={part.detail} />
				</CodeBlock.Root>
			{/if}
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
