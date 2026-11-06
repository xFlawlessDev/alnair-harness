<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import ShieldQuestionIcon from '@lucide/svelte/icons/shield-question';
	import Composer from '#lib/components/composer/composer.svelte';
	import QuestionPanel from '#lib/components/composer/question-panel.svelte';
	import PlanApprovalPanel from '#lib/components/composer/plan-approval-panel.svelte';
	import BottomDrawer from '#lib/components/inspector/bottom-drawer.svelte';
	import EditorPane from '#lib/components/inspector/editor-pane.svelte';
	import Inspector from '#lib/components/inspector/inspector.svelte';
	import TerminalPane from '#lib/components/inspector/terminal-pane.svelte';
	import SessionSidebar from '#lib/components/chrome/session-sidebar.svelte';
	import SubagentDialog from '#lib/components/chrome/subagent-dialog.svelte';
	import GraphDialog from '#lib/components/graph/graph-dialog.svelte';
	import ThreadHeader from '#lib/components/chrome/thread-header.svelte';
	import ConnectionBanner from '#lib/components/chrome/connection-banner.svelte';
	import Thread from '#lib/components/thread/thread.svelte';
	import ThreadSkeleton from '#lib/components/thread/thread-skeleton.svelte';
	import TurnStatus from '#lib/components/thread/turn-status.svelte';
	import SettingsDialog from '#lib/components/settings/settings-dialog.svelte';
	import BootSkeleton from '#lib/components/chrome/boot-skeleton.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { useSessionStore } from '#lib/harness/context.js';
	import { suggestions as starterPrompts } from '#lib/harness/mock.js';
	import { loadLayout, saveLayout } from '#lib/harness/preferences.js';
	import { viewPrefs } from '#lib/harness/view-prefs.js';
	import type { SidebarLayout } from '#lib/harness/sidebar-layout.js';
	import type { SubagentSummary } from '#lib/harness/types.js';
	import { touchedFiles } from '#lib/components/inspector/panel-data.js';

	const store = useSessionStore();

	// The right rail starts open only where there is room for three columns; the
	// header toggle wins after that. A remembered choice overrides both, so a
	// reader who closed the rail does not get it back on every reload.
	const WIDE = '(min-width: 1280px)';
	const saved = loadLayout();
	/** Whether the rail's state came from storage rather than the viewport. */
	const rememberedRail = saved?.rail;
	let inspectorOpen = $state(saved?.rail ?? false);
	let settingsOpen = $state(false);
	let graphOpen = $state(false);
	/** The subagent whose detail dialog is open, if any. */
	let picked = $state<SubagentSummary | undefined>(undefined);
	let pickedSessionId = $state('');
	let subagentOpen = $state(false);

	/**
	 * The bottom drawer: a workspace editor and a real terminal.
	 *
	 * Closed until asked for, and remembered across reloads — a reader who
	 * works with a shell open should not have to reopen it every time.
	 */
	let drawerOpen = $state(saved?.drawer ?? false);
	let drawerTab = $state<'terminal' | 'editor'>(saved?.drawerTab ?? 'terminal');
	let drawerHeight = $state(saved?.drawerHeight ?? 320);
	/** A path the Files rail asked the editor to open. */
	let editorRequest = $state<string | undefined>(undefined);
	/**
	 * The session list on a narrow window.
	 *
	 * The sidebar is `hidden md:flex`, so below 768px there was no way to reach
	 * another session — acceptable for a page beside a terminal, not for the
	 * only surface a reader has.
	 */
	let navOpen = $state(false);

	/** How many files the thread has touched, for the drawer's tab badge. */
	const touchedCount = $derived(touchedFiles(store.turns).length);

	/** What each transcript row renders with, from the settings dialog. */
	const prefs = $derived(viewPrefs(store.settings));

	/**
	 * How the sidebar arranges sessions.
	 *
	 * Validated rather than cast: the value comes from storage, so a build that
	 * renamed a mode would otherwise hand the sidebar an unknown string and
	 * paint the fallback silently. An unrecognized value reads as the default.
	 */
	const sidebarLayout = $derived.by((): SidebarLayout => {
		const value = String(store.settings.sidebar_layout ?? 'workspace');
		return value === 'status' || value === 'flat' ? value : 'workspace';
	});

	/**
	 * Starter prompts for an empty thread.
	 *
	 * A fixture list rather than a hardcoded one, so the demo and the live page
	 * offer the same suggestions; `prompt_suggestions` turns them off.
	 */
	const suggestions = $derived(
		store.settings.prompt_suggestions === false ? [] : (starterPrompts as string[])
	);

	// Persist the layout whenever it changes. One effect rather than a write at
	// each mutation site: the drawer is toggled from a chord, a header button
	// and its own close control, and a missed site would silently stop
	// remembering.
	$effect(() => {
		saveLayout({
			rail: inspectorOpen,
			drawer: drawerOpen,
			drawerTab,
			drawerHeight
		});
	});

	function openInEditor(path: string) {
		editorRequest = path;
		drawerTab = 'editor';
		drawerOpen = true;
	}

	function openSubagent(subagent: SubagentSummary) {
		picked = subagent;
		pickedSessionId = store.activeSessionId;
		subagentOpen = true;
	}

	$effect(() => {
		if (!subagentOpen || !picked) return;
		if (pickedSessionId !== store.activeSessionId) {
			subagentOpen = false;
			return;
		}
		const subagent = picked;
		return untrack(() => store.openSubagent(subagent));
	});

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

	/**
	 * Ctrl+` toggles the drawer, `Ctrl+Shift+`` opens the editor.
	 *
	 * The same chord VS Code uses, and the same one the TUI's terminal pane
	 * uses. `event.code` rather than `event.key`: on most layouts the backtick
	 * key produces different characters with modifiers, and the physical key is
	 * what the reader is pressing.
	 */
	function onkeydown(event: KeyboardEvent) {
		if (!(event.ctrlKey || event.metaKey) || event.code !== 'Backquote') return;
		event.preventDefault();
		if (event.shiftKey) {
			drawerTab = 'editor';
			drawerOpen = true;
			return;
		}
		drawerOpen = !drawerOpen;
	}

	onMount(() => {
		const query = window.matchMedia(WIDE);
		// A remembered choice wins over the breakpoint; only a reader who has
		// never touched the rail gets the width-derived default.
		if (saved?.rail === undefined) inspectorOpen = query.matches;
		const onChange = (event: MediaQueryListEvent) => {
			// The breakpoint only drives the FIRST paint, and only when nothing
			// was remembered — otherwise resizing would reopen a rail the reader
			// deliberately closed.
			if (!rememberedRail) inspectorOpen = event.matches;
		};
		query.addEventListener('change', onChange);
		return () => query.removeEventListener('change', onChange);
	});
</script>

<svelte:window {onkeydown} />

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
					hidden={store.hiddenWorkspaces}
					layout={sidebarLayout}
					allSessions={store.sessions}
					onlayout={(next) => store.setSetting('sidebar_layout', next)}
					onselect={(id) => store.selectSession(id)}
					onrename={(id, title) => attempt('Rename failed', () => store.renameSession(id, title))}
					ondelete={(id) => attempt('Delete failed', () => store.deleteSession(id))}
					oncreate={(cwd) =>
						attempt('Could not create the session', () => store.createSession(cwd))}
					onaddworkspace={async (path) => {
						// The sidebar owns this error: a refusal has to reach the
						// typed-path dialog it opens, not a banner at the top of the
						// page. `addWorkspace` resolves to the path it used.
						await store.addWorkspace(path);
					}}
					onremoveworkspace={(name) => store.removeWorkspace(name)}
					onrestoreworkspace={(name) => store.restoreWorkspace(name)}
					onerror={(message) => (actionError = message)}
					onsettings={() => (settingsOpen = true)}
				/>
			</div>

			<!--
				The same list, slid over the thread, for a window too narrow for
				the rail. One component rather than a second copy: the sidebar owns
				the grouping, the menus and the dialogs, and a parallel mobile list
				would drift from it.
			-->
			<Dialog.Sheet bind:open={navOpen} title="Sessions">
				<SessionSidebar
					groups={store.groups}
					activeId={store.activeSessionId}
					hidden={store.hiddenWorkspaces}
					layout={sidebarLayout}
					allSessions={store.sessions}
					onlayout={(next) => store.setSetting('sidebar_layout', next)}
					onselect={(id) => {
						store.selectSession(id);
						navOpen = false;
					}}
					onrename={(id, title) => attempt('Rename failed', () => store.renameSession(id, title))}
					ondelete={(id) => attempt('Delete failed', () => store.deleteSession(id))}
					oncreate={(cwd) =>
						attempt('Could not create the session', () => store.createSession(cwd))}
					onaddworkspace={async (path) => {
						await store.addWorkspace(path);
					}}
					onremoveworkspace={(name) => store.removeWorkspace(name)}
					onrestoreworkspace={(name) => store.restoreWorkspace(name)}
					onerror={(message) => (actionError = message)}
					onsettings={() => {
						settingsOpen = true;
						navOpen = false;
					}}
				/>
			</Dialog.Sheet>

			<!--
				The conversation column and its drawer are ONE flex column, so the
				drawer spans the thread's width rather than the whole window: a
				terminal under the sidebar would be a different app's layout.
			-->
			<div class="flex min-h-0 min-w-0 flex-1 flex-col">
				<main class="flex min-h-0 min-w-0 flex-1 flex-col bg-thread">
					{#if store.phase === 'error'}
						<div
							class="mx-6 mt-3 rounded-lg border border-terra/40 bg-terra/5 px-3 py-2 text-[12px] text-ink-secondary"
						>
							The agent is unreachable{store.phaseDetail ? `: ${store.phaseDetail}` : ''}. This page
							retries on its own.
						</div>
					{/if}

					<ConnectionBanner state={store.connection} />

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
						ongraph={() => (graphOpen = true)}
						todos={store.todos}
						plan={store.plan ?? null}
						subagents={store.subagents}
						onsubagent={openSubagent}
						{inspectorOpen}
						oninspector={() => (inspectorOpen = !inspectorOpen)}
						{drawerOpen}
						ondrawer={() => (drawerOpen = !drawerOpen)}
						onnavigate={() => (navOpen = true)}
					/>

					<div class="min-h-0 flex-1">
						{#if store.loading}
							<ThreadSkeleton />
						{:else}
							<Thread
								session={store.activeSession}
								turns={store.turns}
								busy={store.busy}
								revealId={store.revealId}
								onrevealed={() => store.clearReveal()}
								{prefs}
								{suggestions}
								onsuggest={(text) => store.send(text)}
								onopenfile={openInEditor}
							/>
						{/if}
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
					{:else if store.plan}
						<div class="mx-auto w-full max-w-3xl px-6 pb-2">
							<PlanApprovalPanel
								plan={store.plan}
								onanswer={(outcome) => store.answerPlan(outcome)}
							/>
						</div>
					{:else if store.permission}
						{@const request = store.permission}
						<div class="mx-auto w-full max-w-3xl px-6">
							<div
								class="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-terra/40 bg-terra/5 px-3 py-2"
							>
								<ShieldQuestionIcon class="size-3.5 shrink-0 text-terra" />
								<p class="min-w-0 flex-1 truncate text-[12px] text-ink-secondary">
									The agent is waiting for permission:
									<span class="font-mono">{request.title}</span>
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
						enterToSend={store.settings.enter_to_send !== false}
						mentionMenu={store.settings.mention_menu !== false}
						commandMenu={store.settings.command_menu !== false}
						thresholdPercent={Number(store.settings.context_threshold_percent ?? 85)}
						onbrowse={(path) => store.listFiles(path)}
						onsearch={(query) => store.searchFiles(query)}
						onsend={(text, blocks) => store.send(text, blocks)}
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

				<!--
					The bottom panel. Editor and terminal are tabs inside it, the way
					VS Code docks them — and the way `alnair-ai`'s ChatEditorDrawer /
					ChatTerminalDrawer do it — because both need the full width and
					neither belongs in a 288px rail.
				-->
				<BottomDrawer
					bind:open={drawerOpen}
					bind:tab={drawerTab}
					bind:height={drawerHeight}
					badge={{ editor: touchedCount }}
				>
					{#snippet terminal()}
						<TerminalPane terminal={store.terminal} open={drawerOpen && drawerTab === 'terminal'} />
					{/snippet}
					{#snippet editor()}
						<EditorPane
							openFile={editorRequest}
							visible={drawerOpen && drawerTab === 'editor'}
							root={store.activeSession.cwd}
							onbrowse={(path) => store.listFiles(path)}
							onsearch={(query) => store.searchFiles(query)}
							onread={(path) => store.readFile(path)}
							onwrite={(path, text) => store.writeFile(path, text)}
						/>
					{/snippet}
				</BottomDrawer>
			</div>

			{#if inspectorOpen}
				<Inspector
					turns={store.turns}
					git={store.git}
					onrefresh={() => attempt('Could not read the repo', () => store.refreshGit())}
					ongitstatus={() => store.readGitStatus()}
					onopenfile={openInEditor}
				/>
			{/if}

			<SettingsDialog
				bind:open={settingsOpen}
				settings={store.settings}
				onchange={(key, value) => store.setSetting(key, value)}
			/>

			{#key store.activeSessionId}
				<GraphDialog
					bind:open={graphOpen}
					{store}
					onsubagent={(agent) => {
						graphOpen = false;
						openSubagent(agent);
					}}
				/>
			{/key}

			<SubagentDialog
				bind:open={subagentOpen}
				subagent={store.subagentDetail ?? picked}
				turns={store.subagentTurns}
				loading={store.subagentLoading}
				error={store.subagentError}
				session={{
					...store.activeSession,
					id: picked?.childSessionId ?? '',
					title: picked?.description ?? ''
				}}
			/>
		</div>
	</Tooltip.Provider>
{/if}
