<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import Markdown from '#lib/components/thread/markdown-lazy.svelte';
	import type { PlanArtifact } from '#lib/harness/types.js';
	import type { PlanOutcome } from '#lib/harness/session-store.svelte.js';

	let {
		plan,
		onanswer
	}: {
		plan: PlanArtifact;
		onanswer: (outcome: PlanOutcome) => void;
	} = $props();
</script>

<section aria-label="Plan approval" class="rounded-lg border border-line bg-paper">
	<div class="border-b border-line px-4 py-3">
		<h2 class="text-sm font-medium">{plan.title}</h2>
		<p class="text-xs text-ink-secondary">Review the plan before implementation.</p>
	</div>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll long plans.) -->
	<div
		role="region"
		class="max-h-[35vh] overflow-y-auto px-4 py-3"
		tabindex="0"
		aria-label="Plan content"
	>
		<Markdown content={plan.markdown} />
	</div>
	<div class="flex flex-wrap gap-2 border-t border-line px-4 py-3">
		<Button size="sm" onclick={() => onanswer('approved')}>Approve plan</Button>
		<Button variant="outline" size="sm" onclick={() => onanswer('cancelled')}>Reject plan</Button>
		<Button variant="ghost" size="sm" onclick={() => onanswer('abandoned')}>Leave plan mode</Button>
	</div>
</section>
