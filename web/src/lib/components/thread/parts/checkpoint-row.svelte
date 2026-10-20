<script lang="ts">
	import CircleDotIcon from '@lucide/svelte/icons/circle-dot';
	import * as Marker from '#lib/components/ui/marker/index.js';
	import type { CheckpointPart } from '#lib/harness/types.js';

	let { part }: { part: CheckpointPart } = $props();
</script>

<Marker.Root variant="separator" class="my-1">
	<Marker.Icon>
		<CircleDotIcon class="text-verify" />
	</Marker.Icon>
	<Marker.Content class="flex-none text-[12px]">
		<span class="font-medium text-ink-secondary">{part.label}</span>
		<span class="ml-2 text-ink-tertiary">{part.detail}</span>
	</Marker.Content>
</Marker.Root>
