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
	import TurnStatus from '#lib/components/thread/turn-status.svelte';
	import SettingsDialog from '#lib/components/settings/settings-dialog.svelte';
	import BootSkeleton from '#lib/components/chrome/boot-skeleton.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { useSessionStore } from '#lib/harness/context.js';
	import { suggestions } from '#lib/harness/mock.js';
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

	/** A refusal from a session action, shown where the action was taken. */
	let actionError = $state<string | undefined>(undefined);

	async function attempt(label: string, action: () => Promise<void>) {
		actionError = undefined;
		try {
			await action();
		} catch (error) {
			actionError = `${label}: ${error instanceof Error ? error.message : 'failed'}`;
		}
	}

	onMount(() => {
		const query = window.matchMedia(WIDE);
		inspectorOpen = query.matches;
		const onChange = (event: MediaQueryListEvent) => (inspectorOpen = event.matches);
		query.addEventListener('change', onChange);
		return () => query.removeEventListener('change', onChange);
	});
</script>

{#if store.phase === 'connecting'}
	<!--
		Nothing is known yet: the handshake, the roster and the first replay are
		still in flight. Painting the shell here would show a conversation the
		user never had, so the page shows the shape of one instead.
	-->
	<BootSkeleton />
{:else}
	<Tooltip.Provider>
		<div class="flex h-dvh w-full overflow-hidden bg-paper text-ink">
			<div class="hidden md:flex">
				<SessionSidebar
					groups={store.groups}
					activeId={store.activeSessionId}
					onselect={(id) => store.selectSession(id)}
					onrename={(id, title) => attempt('Rename failed', () => store.renameSession(id, title))}
					ondelete={(id) => attempt('Delete failed', () => store.deleteSession(id))}
					oncreate={(cwd) =>
						attempt('Could not create the session', () => store.createSession(cwd))}
					onerror={(message) => (actionError = message)}
					onsettings={() => (settingsOpen = true)}
				/>
			</div>

			<main class="flex min-w-0 flex-1 flex-col bg-thread">
				{#if store.phase === 'error'}
					<div
						class="mx-6 mt-3 rounded-lg border border-terra/40 bg-terra/5 px-3 py-2 text-[12px] text-ink-secondary"
					>
						The agent is unreachable{store.phaseDetail ? `: ${store.phaseDetail}` : ''}. This page
						retries on its own.
					</div>
				{/if}

				{#if actionError}
					<div
						class="mx-6 mt-3 flex items-center gap-2 rounded-lg border border-terra/40 bg-terra/5 px-3 py-2 text-[12px] text-ink-secondary"
					>
						<p class="min-w-0 flex-1">{actionError}</p>
						<button
							type="button"
							class="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10.5px] text-ink-tertiary hover:text-ink"
							onclick={() => (actionError = undefined)}
						>
							dismiss
						</button>
					</div>
				{/if}

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

				<!--
					The live turn status sits between the thread and the composer,
					which is where the TUI puts it: above the prompt, outside the
					scroller, so it cannot scroll away while it is needed.
				-->
				<TurnStatus
					turns={store.turns}
					busy={store.busy}
					blocked={Boolean(store.question || store.permission || store.plan)}
					contextUsed={store.context.used}
					oncancel={() => store.cancel()}
				/>

				<Composer
					models={store.models}
					model={store.model}
					effort={store.effort}
					usage={store.context}
					context={{
						workspace: store.currentWorkspace,
						branch: store.git?.branch ?? store.activeSession.branch,
						checkout: store.git?.root ? 'branch' : 'branch',
						access: store.access,
						gitRoot: store.git?.root,
						isWorktree: store.activeSession.worktree === true
					}}
					git={store.git}
					branches={store.branches}
					worktrees={store.worktrees}
					busy={store.busy}
					commands={store.commands}
					onbrowse={(path) => store.listFiles(path)}
					onsearch={(query) => store.searchFiles(query)}
					onsend={(text) => store.send(text)}
					oncancel={() => store.cancel()}
					onmodel={(id) => store.setModel(id)}
					oneffort={(effort) => store.setEffort(effort)}
					onaccess={(mode) => store.setAccess(mode)}
					onbranch={(name, create) =>
						attempt('Could not switch branch', () => store.checkoutBranch(name, create))}
					onworktree={(label, ref) =>
						attempt('Could not create the worktree', () => store.createWorktree(label, ref))}
					onrefreshgit={() => attempt('Could not read the repo', () => store.refreshGit())}
					onrefreshcontext={() =>
						attempt('Could not read the context', () => store.refreshContext())}
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
{/if}
