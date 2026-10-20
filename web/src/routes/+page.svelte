<script lang="ts">
	import { onMount } from 'svelte';
	import Composer from '#lib/components/composer/composer.svelte';
	import Inspector from '#lib/components/inspector/inspector.svelte';
	import SessionSidebar from '#lib/components/chrome/session-sidebar.svelte';
	import ThreadHeader from '#lib/components/chrome/thread-header.svelte';
	import Thread from '#lib/components/thread/thread.svelte';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { useSessionStore } from '#lib/harness/context.js';
	import { suggestions } from '#lib/harness/mock.js';

	const store = useSessionStore();

	// The inspector starts open only where there is room for three columns; the
	// header toggle wins after that.
	const WIDE = '(min-width: 1280px)';
	let inspectorOpen = $state(false);

	onMount(() => {
		const query = window.matchMedia(WIDE);
		inspectorOpen = query.matches;
		const onChange = (event: MediaQueryListEvent) => (inspectorOpen = event.matches);
		query.addEventListener('change', onChange);
		return () => query.removeEventListener('change', onChange);
	});
</script>

<Tooltip.Provider>
	<div class="flex h-dvh w-full overflow-hidden bg-paper text-ink">
		<div class="hidden md:flex">
			<SessionSidebar
				sessions={store.sessions}
				activeId={store.activeSessionId}
				workspace={store.workspace}
				onselect={(id) => store.selectSession(id)}
			/>
		</div>

		<main class="flex min-w-0 flex-1 flex-col bg-thread">
			<ThreadHeader
				session={store.activeSession}
				workspace={store.workspace}
				graph={store.graph}
				todos={store.todos}
				plan={store.plan}
				{inspectorOpen}
				oninspector={() => (inspectorOpen = !inspectorOpen)}
			/>

			<div class="min-h-0 flex-1">
				<Thread
					session={store.activeSession}
					turns={store.turns}
					busy={store.busy}
					{suggestions}
					onsuggest={(text) => store.send(text)}
				/>
			</div>

			<Composer
				models={store.models}
				model={store.model}
				effort={store.effort}
				usage={store.context}
				busy={store.busy}
				onsend={(text) => store.send(text)}
				oncancel={() => store.cancel()}
				onmodel={(id) => store.setModel(id)}
				oneffort={(effort) => store.setEffort(effort)}
			/>
		</main>

		{#if inspectorOpen}
			<Inspector
				session={store.activeSession}
				turns={store.turns}
				graph={store.graph}
				context={store.context}
			/>
		{/if}
	</div>
</Tooltip.Provider>
