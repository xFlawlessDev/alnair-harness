<script lang="ts">
	import { onMount } from 'svelte';
	import ShieldQuestionIcon from '@lucide/svelte/icons/shield-question';
	import Composer from '#lib/components/composer/composer.svelte';
	import QuestionPanel from '#lib/components/composer/question-panel.svelte';
	import Inspector from '#lib/components/inspector/inspector.svelte';
	import SessionSidebar from '#lib/components/chrome/session-sidebar.svelte';
	import SubagentDialog from '#lib/components/chrome/subagent-dialog.svelte';
	import ThreadHeader from '#lib/components/chrome/thread-header.svelte';
	import Thread from '#lib/components/thread/thread.svelte';
	import SettingsDialog from '#lib/components/settings/settings-dialog.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { useSessionStore } from '#lib/harness/context.js';
	import { filesByDirectory, suggestions, workspaceFiles } from '#lib/harness/mock.js';
	import type { SubagentSummary } from '#lib/harness/types.js';

	const store = useSessionStore();

	// The inspector starts open only where there is room for three columns; the
	// header toggle wins after that.
	const WIDE = '(min-width: 1280px)';
	let inspectorOpen = $state(false);
	let settingsOpen = $state(false);
	/** The subagent whose detail dialog is open, if any. */
	let picked = $state<SubagentSummary | undefined>(undefined);
	let subagentOpen = $state(false);

	function openSubagent(subagent: SubagentSummary) {
		store.openSubagent(subagent);
		picked = subagent;
		subagentOpen = true;
	}

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
				groups={store.groups}
				activeId={store.activeSessionId}
				onselect={(id) => store.selectSession(id)}
				onsettings={() => (settingsOpen = true)}
			/>
		</div>

		<main class="flex min-w-0 flex-1 flex-col bg-thread">
			<ThreadHeader
				session={store.activeSession}
				graph={store.graph}
				todos={store.todos}
				plan={store.plan ?? null}
				subagents={store.subagents}
				onsubagent={openSubagent}
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

			{#if store.question}
				{@const request = store.question}
				<div class="mx-auto w-full max-w-3xl px-6 pb-2">
					{#key request.toolCallId}
						<QuestionPanel
							{request}
							onanswer={(answers) => store.answerQuestions(answers)}
							oncancel={() => store.cancelQuestions()}
							onchat={() => store.chatAboutQuestion()}
							onskip={() => store.skipQuestions()}
						/>
					{/key}
				</div>
			{:else if store.permission}
				{@const request = store.permission}
				<div class="mx-auto w-full max-w-3xl px-6">
					<div
						class="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-terra/40 bg-terra/5 px-3 py-2"
					>
						<ShieldQuestionIcon class="size-3.5 shrink-0 text-terra" />
						<p class="min-w-0 flex-1 truncate text-[12px] text-ink-secondary">
							The agent is waiting for permission: <span class="font-mono">{request.title}</span>
						</p>
						<div class="flex shrink-0 gap-1.5">
							{#each request.options as option (option.optionId)}
								<Button
									variant={option.kind.startsWith('allow') ? 'default' : 'outline'}
									size="sm"
									class="h-6 text-[11px]"
									onclick={() => store.answerPermission(option.optionId)}
								>
									{option.name}
								</Button>
							{/each}
						</div>
					</div>
				</div>
			{/if}

			<Composer
				models={store.models}
				model={store.model}
				effort={store.effort}
				usage={store.context}
				context={{
					workspace: store.currentWorkspace,
					branch: store.activeSession.branch,
					// The fixture sessions all work on a branch; a worktree or a
					// detached HEAD would come from the session's checkout state.
					checkout: 'branch',
					access: store.access
				}}
				busy={store.busy}
				commands={store.commands}
				files={workspaceFiles}
				onbrowse={(path) => filesByDirectory[path] ?? []}
				onsend={(text) => store.send(text)}
				oncancel={() => store.cancel()}
				onmodel={(id) => store.setModel(id)}
				oneffort={(effort) => store.setEffort(effort)}
				onaccess={(mode) => store.setAccess(mode)}
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

		<SettingsDialog
			bind:open={settingsOpen}
			settings={store.settings}
			onchange={(key, value) => store.setSetting(key, value)}
		/>

		<SubagentDialog
			bind:open={subagentOpen}
			subagent={picked}
			turns={store.subagentTurns}
			session={{
				...store.activeSession,
				id: picked?.childSessionId ?? '',
				title: picked?.description ?? ''
			}}
		/>
	</div>
</Tooltip.Provider>
