/**
 * The store the UI talks to.
 *
 * One interface, two implementations: the fixture transport replays the
 * scripted transcripts in `fixtures.ts`, and the socket transport
 * speaks JSON-RPC through the shared leader bridge. Both feed the same
 * reducer, so a component cannot tell them apart.
 *
 * Nothing below this line knows what ACP is. Nothing above it knows where the
 * frames come from.
 */

import { setMode } from 'mode-watcher';
import type { GraphInspection, GraphControl, GraphView } from './graph.js';
import { planQuestionTurn } from './fixtures.js';
import {
	initialPlan,
	initialQuestionTranscript,
	initialSubagentTranscript,
	initialTranscript,
	models,
	sessions,
	subagents,
	workspace,
	contextUsage
} from './mock.js';
import {
	acceptedResponse,
	closeTurn,
	emptyAcc,
	graphToState,
	openUserTurn,
	questionFromPayload,
	questionFromRequest,
	reduceAcpUpdate,
	reduceExtUpdate,
	replay,
	resolveCardById,
	sessionStatus
} from './reducer.js';
import type { Acc } from './reducer.js';
import { turnForPrompt } from './fixtures.js';
import type { ScriptedTurn } from './fixtures.js';
import type { ExtSessionUpdate } from './types/ext.js';
import { DEFAULT_SETTINGS } from './settings.js';
import type { SettingsState, SettingValue } from './settings.js';
import { loadHidden, loadSettings, saveHidden, saveSettings } from './preferences.js';
import type { AskUserQuestionRequest, AskUserQuestionResponse } from './types/ext.js';
import type { SessionUpdate } from './types/acp.js';
import type {
	AccessMode,
	AvailableCommand,
	BranchEntry,
	ContextUsage,
	FileEntry,
	GitContext,
	GraphState,
	ModelOption,
	PermissionRequest,
	PlanArtifact,
	QuestionAnswer,
	QuestionRequest,
	Session,
	StorePhase,
	SubagentSummary,
	TodoItem,
	Turn,
	WorkspaceGroup,
	WorkspaceInfo,
	WorktreeEntry
} from './types.js';
import { fromTranscript, mergeSubagents, sortSubagents } from './subagents.js';
import { webCommands } from './commands.js';
import { workspaceView, type WorkspaceView } from './workspace-view.js';
import { admit, beginReplay, endReplay, eventIdOf, liveGate, type GateState } from './dedup.js';
import { applyRosterDelta, isExtMethod, lastSegment, relativeTo, totalTokensOf } from './wire.js';

/** A frame the agent sent, plus the prompt it answers (if any). */
export interface IncomingFrame {
	method: string;
	params: Record<string, unknown>;
}

export interface Transport {
	inspectGraph?(sessionId: string): Promise<GraphInspection>;
	controlGraph?(sessionId: string, graphId: string, action: GraphControl): Promise<void>;
	/**
	 * Start a turn.
	 *
	 * The fixture transport pushes its scripted frames through `onFrame`; the
	 * socket transport ignores that callback and delivers through the sink it
	 * registered with `onFrame(sink)`, because the leader broadcasts to every
	 * client rather than answering this one call.
	 *
	 * `blocks` is the prompt already in ACP shape (`text`, `image`,
	 * `resource`), built by the composer when the draft carries attachments.
	 * A transport that cannot carry them may ignore it and use `prompt`.
	 */
	send(prompt: string, onFrame?: (frame: IncomingFrame) => void, blocks?: unknown[]): void;
	/** Stop the live turn; the transport must not emit more frames. */
	stop(): void;
	/** Answer a parked permission request. */
	respond(toolCallId: string, optionId: string): void;
	/** Answer a parked questionnaire. */
	respondQuestions(toolCallId: string, response: AskUserQuestionResponse): void;

	// --- the socket transport's surface -------------------------------------
	//
	// The fixture transport implements these as no-ops. They exist so a real
	// transport can be swapped in without the components learning anything
	// about ACP; the store calls them, not the UI.
	//
	// Every method here is optional so `FixtureTransport` (which drives a
	// scripted transcript) stays a valid implementation.

	/** Handshake: `initialize` plus the roster. Idempotent on reconnect. */
	connect?(): Promise<void>;
	/** Roster rows, or `undefined` when the transport cannot serve them. */
	listSessions?(): Promise<Session[]>;
	/**
	 * Attach to a session: sends `session/load` and streams the replay through
	 * `onFrame`. The store resets its accumulator first (`beginSessionLoad`).
	 *
	 * `cwd` is the session's OWN directory. The agent resolves the session
	 * directory from `(id, cwd)` and rejects an empty one, so the roster's cwd
	 * must be passed along.
	 *
	 * Returns the session's model catalog and mode, which only the load
	 * response carries.
	 */
	openSession?(sessionId: string, cwd?: string): Promise<SessionOpenResult | void>;
	/** Create a session in `cwd` and return its id. */
	newSession?(cwd: string): Promise<string>;
	/** The exact context snapshot (`alnair/session/info`). */
	sessionContext?(sessionId: string): Promise<ContextUsage | undefined>;
	/** One directory of the workspace (`alnair/fs/list`). */
	fsList?(path: string, sessionId: string): Promise<FileEntry[]>;
	/**
	 * One file's contents (`alnair/fs/read_file`).
	 *
	 * The inspector's preview reads through this rather than through the
	 * transcript: it must show what is on disk now, which is not what the agent
	 * saw when it last opened the file.
	 */
	fsRead?(path: string, sessionId: string): Promise<FilePreview | undefined>;
	/**
	 * Write one file (`alnair/fs/write_file`).
	 *
	 * The same handler the agent's own write tool uses, so an edit made in the
	 * inspector lands exactly as the agent's would. Called only from an explicit
	 * Save, never from a keystroke.
	 */
	fsWrite?(path: string, content: string, sessionId: string): Promise<void>;
	/** The working tree (`alnair/git/status`), for the source-control panel. */
	gitStatus?(sessionId: string): Promise<unknown>;
	/** Fuzzy path search across the workspace (`alnair/fs/search`). */
	fsSearch?(request: {
		sessionId: string;
		path?: string;
		query: string;
		limit?: number;
		dirs?: boolean;
	}): Promise<FileEntry[]>;
	/** Subagents running under a session right now. */
	listSubagents?(sessionId: string): Promise<SubagentSummary[]>;
	/** One subagent's current counters and terminal status. */
	getSubagent?(
		subagentId: string,
		previous?: SubagentSummary
	): Promise<SubagentSummary | undefined>;

	// --- workspace administration -------------------------------------------
	//
	// Session CRUD and git live on the same socket as everything else, so they
	// belong here rather than in a second adapter: the store owns the session
	// list, and a rename that the sidebar did not apply would be a lie.

	/** `alnair/session/rename`: set the session's manual title. */
	renameSession?(sessionId: string, title: string, cwd?: string): Promise<void>;
	/** `alnair/session/delete`: remove the transcript and evict the actor. */
	deleteSession?(sessionId: string, cwd?: string): Promise<void>;
	/** `alnair/git/info`: the repo behind a session. */
	gitInfo?(sessionId: string): Promise<GitContext | undefined>;
	/** `alnair/git/branches`: every branch, local and remote-tracking. */
	gitBranches?(sessionId: string): Promise<BranchEntry[]>;
	/** `alnair/git/checkout`: switch branch, optionally creating it. */
	gitCheckout?(sessionId: string, branch: string, create?: boolean): Promise<void>;
	/** `alnair/git/worktree/list`: the repo's registered worktrees. */
	gitWorktrees?(repo: string): Promise<WorktreeEntry[]>;
	/** `alnair/git/worktree/create`: returns the new worktree's path. */
	gitCreateWorktree?(request: {
		sessionId: string;
		sourcePath: string;
		gitRef?: string;
		label?: string;
	}): Promise<string>;

	/**
	 * Ask the machine for a directory, with its own native dialog.
	 *
	 * Not JSON-RPC: a browser cannot read an absolute path out of a directory
	 * handle, so the dialog runs in the server process (`POST
	 * /api/pick-directory`). `undefined` means the user cancelled.
	 */
	pickDirectory?(): Promise<string | undefined>;

	/** A stored transcript, as `alnair/session/updates` returns it. */
	sessionUpdates?(request: {
		sessionId: string;
		cwd: string;
	}): Promise<{ method: string; params?: unknown; timestamp?: string }[] | undefined>;
	/** The current roster delta stream (`alnair/sessions/changed`). */
	onRosterChanged?(sink: (delta: { upserted?: unknown[]; removed?: string[] }) => void): void;
	/** Abandon the live turn server-side (`session/cancel`). */
	cancelTurn?(): void;
	/** `session/setModel`, with the optional per-session effort. */
	setModel?(modelId: string, effort?: string): void;
	/** `alnair/yolo_mode_changed`: the runtime permission mode. */
	setAccess?(mode: AccessMode): void;
	/** Answer a parked plan-approval request. */
	respondPlan?(toolCallId: string, outcome: PlanOutcome): void;
	/** Register the frame sink. Called once by the store. */
	onFrame?(sink: (sessionId: string, frame: IncomingFrame) => void): void;
	/** The leader relaunched and the transport re-handshook; reload state. */
	onReconnected?(sink: () => void): void;
	/** The socket's health, for the reconnect indicator. */
	onConnection?(sink: (state: 'live' | 'reconnecting' | 'offline') => void): void;
	/**
	 * The socket's own health, for the "reconnecting" indicator.
	 *
	 * Distinct from `onReconnected`: that fires once the leader answers again,
	 * while this reports the attempts in between. A page that silently retries
	 * for ten seconds reads as frozen; the indicator is the difference.
	 */
	onConnection?(sink: (state: 'live' | 'reconnecting' | 'offline') => void): void;

	// --- interactive terminal -------------------------------------------------
	//
	// A real PTY, not a mirror of the agent's tool output. The leader stamps
	// `_meta["alnair/leaderClientId"]` onto `pty/create` and `pty/load`, so the
	// output notifications route back to THIS client instead of falling back to
	// `last_active_client` — which is the TUI whenever both are attached.

	/** `alnair/terminal/pty/create`: spawn a shell and return its id. */
	ptyCreate?(request: {
		sessionId: string;
		cwd?: string;
		rows: number;
		cols: number;
	}): Promise<string>;
	/**
	 * `alnair/terminal/pty/load`: re-attach to an existing PTY.
	 *
	 * The server replays its whole ring buffer with `isReplay: true`, so the
	 * emulator must be reset before feeding it — otherwise a reopen appends the
	 * buffer to what the pane already showed.
	 */
	ptyLoad?(terminalId: string): Promise<{
		rows: number;
		cols: number;
		exited: boolean;
		exitCode?: number;
	}>;
	/** `alnair/terminal/pty/input`: keystrokes, base64-encoded bytes. */
	ptyInput?(terminalId: string, data: string): void;
	/** `alnair/terminal/pty/resize`. */
	ptyResize?(terminalId: string, rows: number, cols: number): void;
	/** `alnair/terminal/kill`: end the shell and drop the PTY. */
	ptyClose?(terminalId: string): void;
	/** Output, exit and busy transitions for a PTY this client owns. */
	onPtyEvent?(sink: (terminalId: string, event: Record<string, unknown>) => void): void;
}

export type PlanOutcome = 'approved' | 'cancelled' | 'abandoned';

/**
 * The interactive terminal, as the bottom panel's Terminal tab drives it.
 *
 * The pane owns the emulator; the store owns the transport. Each method is a
 * thin pass-through that also resolves the session's cwd, because a PTY has to
 * start in the directory the agent is working in — a shell in the page's own
 * origin directory would be looking at a different tree.
 *
 * `unavailable` is the reason a shell cannot be offered at all (the fixture
 * transport has no PTY support), so the pane can say why instead of showing a
 * spawn button that throws.
 */
export interface TerminalBridge {
	/** Why no shell can be spawned, or `undefined` when one can. */
	readonly unavailable: string | undefined;
	/** Spawn a shell and return its id. */
	spawn(request: { rows: number; cols: number }): Promise<string>;
	/** Re-attach, replaying the ring buffer. */
	attach(
		terminalId: string
	): Promise<{ rows: number; cols: number; exited: boolean; exitCode?: number }>;
	/** Forward keystrokes (already base64). */
	input(terminalId: string, data: string): void;
	/** Resize the PTY. */
	resize(terminalId: string, rows: number, cols: number): void;
	/** End the shell. */
	close(terminalId: string): void;
	/** Subscribe to output / exit / busy notifications. Returns an unsubscribe. */
	onevent(sink: (terminalId: string, event: Record<string, unknown>) => void): () => void;
}

/** One file as `alnair/fs/read_file` returns it. */
export interface FilePreview {
	/** The text, when the read produced text. */
	text?: string;
	/** Base64 bytes, for a binary or ranged read. */
	base64?: string;
	/** `text`, `binary`, … — the handler's own classification. */
	contentType: string;
	size: number;
	lineCount?: number;
}

/** What `session/load` reported about the session it opened. */
export interface SessionOpenResult {
	models: ModelOption[];
	currentModel?: string;
	access?: AccessMode;
}

/**
 * The context meter before the agent has reported one.
 *
 * Zeroes, not a guess: the meter renders "—" for an unknown limit, and inventing
 * a window would show a percentage of a number the agent never sent.
 */
function emptyContextUsage(): ContextUsage {
	return {
		used: 0,
		limit: 0,
		percent: 0,
		systemPromptTokens: 0,
		toolDefinitionsTokens: 0,
		toolDefinitionsCount: 0,
		messageTokens: 0,
		messageCount: 0,
		turnCount: 0,
		toolCallCount: 0,
		compactionCount: 0,
		freeTokens: 0,
		autoCompactThresholdPercent: 0,
		categories: []
	};
}

export interface SessionStore {
	/** What may be rendered now; `connecting` means "show a skeleton". */
	readonly phase: StorePhase;
	/** Why `phase` is `error`, when it is. */
	readonly phaseDetail: string | undefined;
	/**
	 * Whether the active session's transcript is still arriving.
	 *
	 * `openSession` clears the accumulator and opens a replay window, so between
	 * the click and the flush the thread is genuinely empty — not "a session
	 * with no messages". A reader who clicks a session and sees a blank pane
	 * cannot tell the two apart, so this drives a skeleton instead.
	 */
	readonly loading: boolean;
	/**
	 * Whether the socket is currently healthy.
	 *
	 * `reconnecting` is the state that matters for a browser-only reader: the
	 * page keeps working, the transport keeps retrying, and this is what says
	 * so instead of leaving a frozen-looking UI.
	 */
	readonly connection: 'live' | 'reconnecting' | 'offline';
	readonly workspace: WorkspaceInfo;
	readonly sessions: Session[];
	/** Conversations nested under their workspace; what the sidebar renders. */
	readonly groups: WorkspaceGroup[];
	/** The workspace of the active session, pinned first in `groups`. */
	readonly currentWorkspace: string;
	readonly turns: Turn[];
	readonly models: ModelOption[];
	/** Absent when the agent has no graph running. */
	readonly graph: GraphState | undefined;
	inspectGraph(): Promise<GraphView>;
	controlGraph(graphId: string, action: GraphControl): Promise<void>;
	readonly context: ContextUsage;
	readonly activeSessionId: string;
	readonly activeSession: Session;
	readonly model: string;
	readonly effort: string;
	/** How much the agent may do without asking. */
	readonly access: AccessMode;
	/** Every tunable setting, keyed by the registry's key. */
	readonly settings: SettingsState;
	/** Subagents this session spawned, running ones first. */
	readonly subagents: SubagentSummary[];
	/** The transcript of one subagent, or empty when none is open. */
	readonly subagentTurns: Turn[];
	readonly subagentDetail: SubagentSummary | undefined;
	readonly subagentLoading: boolean;
	readonly subagentError: string | undefined;
	/** Refresh a child's transcript until the returned cleanup is called. */
	openSubagent(subagent: SubagentSummary): () => void;
	readonly busy: boolean;
	/** A parked permission request, if the agent is waiting on the user. */
	readonly permission: PermissionRequest | undefined;
	/** A parked questionnaire, if the agent is waiting on the user. */
	readonly question: QuestionRequest | undefined;
	/** The plan artifact awaiting approval, if the agent asked for one. */
	readonly plan: PlanArtifact | undefined;
	/** The agent's plan, from the ACP `plan` update. */
	readonly todos: TodoItem[];
	/** Slash commands the agent advertised. */
	readonly commands: AvailableCommand[];

	selectSession(id: string): void;
	setModel(id: string): void;
	setEffort(effort: string): void;
	setAccess(mode: AccessMode): void;
	/** Change one setting; the adapter forwards it to `alnair/settings/update`. */
	setSetting(key: string, value: SettingValue): void;
	send(text: string, blocks?: unknown[]): void;
	cancel(): void;
	clear(): void;
	/** Answer the parked permission request. */
	answerPermission(optionId: string): void;
	/** Answer the parked questionnaire. */
	answerQuestions(answers: Record<string, QuestionAnswer>): void;
	/** Dismiss the questionnaire; the agent treats this as a non-error. */
	cancelQuestions(): void;
	/** Plan mode only: leave the interview and discuss instead. */
	chatAboutQuestion(): void;
	/** Plan mode only: accept what is answered and end the interview. */
	skipQuestions(): void;
	/** Answer the parked plan approval. */
	answerPlan(outcome: PlanOutcome): void;
	/** Attach to a session (replay + live); resets the transcript first. */
	openSession(sessionId: string): Promise<void>;
	/** Handshake, roster, and attach to the first session. Called once. */
	bootstrap(): Promise<void>;
	/**
	 * The `@` menu's listing for one directory (`alnair/fs/list`).
	 *
	 * Empty when the transport cannot list files (the fixture transport).
	 */
	listFiles(path: string): Promise<FileEntry[]>;
	/**
	 * The `@` menu's ranked matches across the workspace (`alnair/fs/search`).
	 *
	 * Empty when the transport cannot search files.
	 */
	searchFiles(query: string, dirs?: boolean): Promise<FileEntry[]>;
	/**
	 * Read one file, for the inspector's preview and its editor.
	 *
	 * `undefined` when the transport cannot read files, or when the file is
	 * gone — a preview of a deleted file is an empty pane with a reason, not an
	 * error the page has to survive.
	 */
	readFile(path: string): Promise<FilePreview | undefined>;
	/**
	 * Save one file from the inspector's editor.
	 *
	 * Explicit, and never wired to a keystroke: a side panel that wrote on
	 * every character would race the agent's own edits to the same path.
	 */
	writeFile(path: string, content: string): Promise<void>;
	/**
	 * Scroll the thread to the row a part produced.
	 *
	 * The panel's "show in thread" jumps to a tool call; the thread owns the
	 * scroll container, so this is a request it answers, not a scroll the
	 * store can perform.
	 */
	revealPart(id: string): void;
	/** The part id a reveal is pending for, consumed by the thread. */
	readonly revealId: string | undefined;
	/** Clear a consumed reveal, so the same row can be revealed twice. */
	clearReveal(): void;
	/**
	 * The working tree for the source-control panel.
	 *
	 * Returned raw and parsed by the panel, because the wire shape is git's own
	 * (staged/unstaged lists of `GitFileChange`) and re-typing it here would put
	 * a second description of it in the store.
	 */
	readGitStatus(): Promise<unknown>;
	/**
	 * The interactive terminal, as the bottom panel's Terminal tab drives it.
	 *
	 * A bridge rather than five store methods: the pane owns the PTY's whole
	 * lifecycle — spawn, keys, resize, close — and nothing else in the app has
	 * an opinion about it.
	 */
	readonly terminal: TerminalBridge;

	// --- workspace administration -------------------------------------------

	/** The repository the active session works in, when it has one. */
	readonly git: GitContext | undefined;
	/** Every branch in that repo; empty until the picker asks for them. */
	readonly branches: BranchEntry[];
	/** The repo's registered worktrees; empty outside a repo. */
	readonly worktrees: WorktreeEntry[];
	/**
	 * Rename the active session.
	 *
	 * The title is trimmed and rejected when blank: the agent refuses a
	 * whitespace-only manual title, and a rename that silently did nothing would
	 * leave the sidebar disagreeing with disk.
	 */
	renameSession(id: string, title: string): Promise<void>;
	/** Delete a session's history and move the view off it. */
	deleteSession(id: string): Promise<void>;
	/** Start a session in `cwd` and make it the active one. */
	createSession(cwd: string): Promise<void>;
	/**
	 * Add a workspace directory: ask the machine, then start a session there.
	 *
	 * Folded into one method rather than two because the two halves are one
	 * action. A directory with no session is not a workspace the backend knows
	 * about, so "add a workspace" IS "start a session in this directory" —
	 * anything else would be a list entry that disappears on reload.
	 *
	 * `path` skips the native dialog. The caller passes it when the dialog is
	 * unavailable — a headless server, a refused gate, a platform with no
	 * chooser — because a typed absolute path is the one answer that always
	 * exists, and without it "add a workspace" would be an action that can
	 * silently do nothing.
	 *
	 * Resolves to the chosen path, or `undefined` when the user cancelled.
	 */
	addWorkspace(path?: string): Promise<string | undefined>;
	/**
	 * Put a workspace away.
	 *
	 * Hides the group; nothing on disk is touched, and its sessions are still
	 * reachable by opening one directly. Removing the SESSIONS is the delete
	 * action, deliberately a different one.
	 */
	removeWorkspace(name: string): void;
	/** Bring a hidden workspace back. */
	restoreWorkspace(name: string): void;
	/** Workspaces the reader put away, so the UI can offer them back. */
	readonly hiddenWorkspaces: string[];
	/** Reload the git context, branches and worktrees for the active session. */
	refreshGit(): Promise<void>;
	/**
	 * Re-read the exact context snapshot (`alnair/session/info`).
	 *
	 * The ring's figure already streams with the conversation; this refreshes
	 * the itemized breakdown, which only the snapshot carries.
	 */
	refreshContext(): Promise<void>;
	/** Check out a branch; `create` makes it at HEAD. */
	checkoutBranch(name: string, create?: boolean): Promise<void>;
	/** Create a worktree and start a session in it. */
	createWorktree(label: string, gitRef?: string): Promise<void>;
}

const STREAM_TICK_MS = 24;

/** Whether a path is rooted (POSIX, Windows drive, or UNC). */
function isAbsolutePath(path: string): boolean {
	return /^([A-Za-z]:[\\/]|[\\/]{1,2})/.test(path);
}

/**
 * Join a relative path onto a base, keeping the base's separator convention.
 *
 * Deliberately not `path.join`: this module has no Node built-ins, and the two
 * separators are all either the transcript or the agent ever sends.
 */
function joinPath(base: string, path: string): string {
	if (!base) return path;
	const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	const trimmed = base.replace(/[\\/]+$/, '');
	return `${trimmed}${separator}${path.replace(/^[\\/]+/, '')}`;
}

/**
 * How many content blocks a prompt carries that are not text.
 *
 * The store only needs the count (to decide whether an attachment-only prompt
 * is sendable and what the optimistic bubble says), so this counts blocks it
 * does not otherwise interpret rather than pulling the ACP types down here.
 */
function attachmentCount(blocks: unknown[] | undefined): number {
	if (!blocks) return 0;
	return blocks.filter((block) => (block as { type?: string }).type !== 'text').length;
}

/**
 * Point mode-watcher at the chosen theme. `system` clears the stored
 * preference so the OS decides, which is what the toggle used to do.
 */ function applyTheme(theme: string) {
	if (theme === 'system') setMode('system');
	else if (theme === 'dark') setMode('dark');
	else setMode('light');
}

/**
 * Replays a scripted turn on a timer so the UI exercises streaming rather than
 * a single state flip. Stops cleanly when the turn is cancelled.
 */
export class FixtureTransport implements Transport {
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private stopped = false;

	send(prompt: string, onFrame: (frame: IncomingFrame) => void) {
		this.stop();
		this.stopped = false;

		const turn: ScriptedTurn = turnForPrompt(prompt);
		let elapsed = 0;

		for (const step of turn.steps) {
			elapsed += step.delay;
			const timer = setTimeout(() => {
				this.timers.delete(timer);
				if (this.stopped) return;
				onFrame({ method: step.method, params: step.params });
			}, elapsed);
			this.timers.add(timer);
		}

		// The prompt response closes the turn even when the script did not send
		// a `turn_completed` frame — that is what the socket does too.
		elapsed += STREAM_TICK_MS * 4;
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (this.stopped) return;
			onFrame({
				method: 'session/prompt:result',
				params: { sessionId: 's-graph', stopReason: turn.stopReason }
			});
		}, elapsed);
		this.timers.add(timer);
	}

	stop() {
		this.stopped = true;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}

	respond() {
		// The scripted turn resumes on its own timer; a real transport would
		// answer the JSON-RPC request here.
	}

	respondQuestions() {
		// Same: the fixture script already carries the follow-up frames.
	}
}

export class HarnessStore implements SessionStore {
	/**
	 * What the UI may render right now.
	 *
	 * `connecting` is the whole reason this exists: the socket transport hands
	 * back a store before the handshake, the roster and the first `session/load`
	 * have landed. Painting the scripted fixtures during that window would show
	 * a conversation that is not the user's, so the page renders a skeleton
	 * instead and swaps it out when the first real state arrives.
	 */
	phase = $state<StorePhase>('ready');
	/** Why `phase` is `error`, when it is. */
	phaseDetail = $state<string | undefined>(undefined);

	/**
	 * Whether a session's transcript is still arriving.
	 *
	 * Set by `beginSessionLoad`, cleared when the replay is folded. The thread
	 * renders a skeleton in between: an empty transcript and a transcript that
	 * has not arrived look identical otherwise.
	 */
	loading = $state(false);

	/**
	 * The socket's health, for the reconnect indicator.
	 *
	 * Starts `live`: the fixture transport has no socket to lose, and the
	 * socket transport reports its first failure through `onConnection` rather
	 * than pre-declaring one.
	 */
	connection = $state<'live' | 'reconnecting' | 'offline'>('live');

	workspace = $state(workspace);
	sessions = $state<Session[]>(sessions);
	models = $state<ModelOption[]>(models);
	context = $state<ContextUsage>(contextUsage);

	activeSessionId = $state(sessions[0].id);
	model = $state(models[0].id);
	effort = $state('high');
	/** The mock starts in `auto`: the mode a fresh interactive session gets. */
	access = $state<AccessMode>('auto');
	settings = $state<SettingsState>({ ...DEFAULT_SETTINGS });
	/**
	 * Subagents this session spawned, running ones first.
	 *
	 * Derived, not stored: the transcript is the durable source (a
	 * `subagent_spawned` frame is persisted, so a reload still knows every
	 * subagent the session started), and the live snapshot from
	 * `alnair/subagent/list_running` adds the counters only a running child
	 * reports. Assigning a single stored list is what made the header empty
	 * after a session switch: `selectSession` cleared it and only a later
	 * `subagent_*` frame ever rebuilt it, so a subagent that was already
	 * running stayed invisible until the frame happened to arrive.
	 */
	get subagents(): SubagentSummary[] {
		if (!this.live) return this.mockSubagents;
		return mergeSubagents(
			Object.values(this.acc.subagents).map(fromTranscript),
			this.liveSubagents[this.activeSessionId] ?? []
		);
	}

	/** The fixture transport's scripted list; the live store never uses it. */
	private mockSubagents = $state<SubagentSummary[]>(sortSubagents(subagents));

	/**
	 * The open subagent's transcript. A subagent is a session, so this is the
	 * same folded view the main thread renders — the child's `updates.jsonl`
	 * read through `alnair/session/updates`, not a separate agent view.
	 */
	subagentTurns = $state<Turn[]>([]);
	subagentLoading = $state(false);
	subagentError = $state<string | undefined>(undefined);
	private pickedSubagent = $state<SubagentSummary | undefined>(undefined);
	private stopSubagentWatch: (() => void) | undefined;

	get subagentDetail(): SubagentSummary | undefined {
		const picked = this.pickedSubagent;
		return picked ? (this.subagents.find((entry) => entry.id === picked.id) ?? picked) : undefined;
	}

	/**
	 * Whether a turn is in flight.
	 *
	 * Two sources, and the transcript wins: a turn the TUI is driving shows up
	 * here as an open turn, and this tab must render its status even though it
	 * never called `send()`. The local flag covers the gap between the send and
	 * the first frame, when the agent has not acknowledged anything yet.
	 */
	private localBusy = $state(false);

	get busy(): boolean {
		// The transcript is the authority. `turn_completed` closes the turn the
		// moment the agent stops working, while `session/prompt:result` can
		// trail behind a backgrounded task — and a status row that keeps
		// pulsing after the answer already landed reads as a hung request.
		// The local flag therefore only covers the window before the agent has
		// acknowledged anything at all.
		if (this.acc.openTurnId !== undefined) return true;
		return this.localBusy && this.acc.turns.length === 0;
	}

	/**
	 * Whether this store drives a real agent.
	 *
	 * A transport that implements `connect` has a server behind it; the fixture
	 * transport does not, and is the only case where scripted state may be
	 * shown. Everything below keys off this rather than off a URL, so the
	 * decision is made once and cannot drift.
	 */
	private readonly live: boolean;

	/**
	 * Subagent snapshots per session, from `list_running` and the open dialog's `get`.
	 *
	 * Kept per session rather than for the active one alone: the header's list
	 * is the transcript plus these, and switching away and back must not make a
	 * running subagent disappear while the re-read is in flight.
	 */
	private liveSubagents = $state<Record<string, SubagentSummary[]>>({});

	/**
	 * Directories the reader added that no session lives in yet.
	 *
	 * Held separately from `sessions` because they are not sessions: the moment
	 * a session is created there, the session-derived group replaces this entry
	 * (see `workspaceView`). Persisting them would mean inventing a backend
	 * concept for a view preference.
	 */
	private addedWorkspaces = $state<string[]>([]);

	/**
	 * Workspaces the reader put away, by display name.
	 *
	 * Persisted: it is a view preference with no backend concept behind it, and
	 * a reload that resurrected a workspace the reader had hidden would be the
	 * page arguing with them.
	 */
	private hidden = $state<string[]>([]);

	get groups(): WorkspaceGroup[] {
		// Alphabetical, with no session-derived pinning: clicking a conversation
		// must not reorder the list under the pointer. `currentWorkspace` only
		// marks which group is open; it does not move it.
		return this.workspaceLayout.groups;
	}

	/**
	 * The workspace list, including directories the reader added that have no
	 * session yet and excluding the ones they put away.
	 */
	get workspaceLayout(): WorkspaceView {
		return workspaceView(this.sessions, this.addedWorkspaces, this.hiddenWorkspaces);
	}

	get hiddenWorkspaces(): string[] {
		return this.hidden;
	}

	get currentWorkspace(): string {
		const session = this.sessions.find((candidate) => candidate.id === this.activeSessionId);
		return session?.workspace ?? this.sessions[0]?.workspace ?? '';
	}

	/** The folded transcript per session; only the first three are scripted. */
	private accs = $state<Record<string, Acc>>({
		[sessions[0].id]: initialTranscript(),
		[sessions[1].id]: initialQuestionTranscript(),
		[sessions[3].id]: initialQuestionTranscript(planQuestionTurn, sessions[3].id)
	});

	constructor(private transport: Transport = new FixtureTransport()) {
		this.live = typeof transport.connect === 'function';

		// Preferences come from the browser before anything renders, so the
		// first paint is already in the reader's theme and density. The fixture
		// transport skips this: a scripted demo should look the same for
		// everyone, and a test must not inherit a developer's localStorage.
		if (this.live) this.restorePreferences();

		if (this.live) {
			// Nothing is known yet. Every value the fixtures supplied is cleared
			// so a component cannot mistake scripted data for the user's.
			this.phase = 'connecting';
			this.sessions = [];
			this.models = [];
			this.mockSubagents = [];
			this.liveSubagents = {};
			this.accs = {};
			this.activeSessionId = '';
			this.model = '';
			this.effort = '';
			this.access = 'ask';
			this.context = emptyContextUsage();
			this.planArtifact = undefined;
			this.git = undefined;
			this.branches = [];
			this.worktrees = [];
		}

		// A real transport pushes frames for whichever session they belong to,
		// so the store owns the routing (the fixture transport calls back with
		// the session it was started for).
		this.transport.onFrame?.((sessionId, frame) => this.receive(sessionId, frame));
		this.transport.onReconnected?.(() => this.reloadAfterReconnect());
		// A reconnect that shows nothing for ten seconds reads as frozen. The
		// indicator is what makes the retry visible.
		this.transport.onConnection?.((state) => (this.connection = state));
		// The roster is machine-wide and arrives unsolicited; the sidebar must
		// follow it without polling.
		this.transport.onRosterChanged?.((delta) => {
			this.sessions = applyRosterDelta(this.sessions, delta as never);
		});
	}

	/**
	 * Re-establish state after the leader relaunched.
	 *
	 * The bridge tells us the connection is fresh; the transcript is reloaded
	 * from a `session/load` replay rather than patched, because the new leader
	 * may have persisted frames this view never saw.
	 */
	private reloadAfterReconnect() {
		this.localBusy = false;
		this.questionRequest = undefined;
		this.planArtifact = undefined;
		const sessionId = this.activeSessionId;
		void this.openSession(sessionId);
	}

	/**
	 * Attach to a session, making it the one in front.
	 *
	 * Resets the accumulator and opens the replay window BEFORE the request
	 * goes out, so no frame can arrive against a stale watermark. The load
	 * response then fills in what only it knows: the model catalog, the
	 * session's current model, its mode, and the exact context totals.
	 *
	 * The active id is set FIRST, and that ordering is load-bearing: `receive`
	 * drops frames for any session that is not the active one, so a caller that
	 * attached without switching (a fresh `createSession`, the survivor after a
	 * delete) would otherwise open a replay window and then throw the entire
	 * replay away — an empty transcript for a session that has history.
	 */
	async openSession(sessionId: string) {
		if (!this.transport.openSession) return;

		this.activeSessionId = sessionId;
		const session = this.sessions.find((candidate) => candidate.id === sessionId);
		this.beginSessionLoad(sessionId);
		const result = await this.transport.openSession(sessionId, session?.cwd);

		// The load is finished, whichever signal arrived first.
		//
		// The socket transport emits a `session/load:result` frame and flushes
		// there; a transport that resolves without one (a test double, or a
		// future adapter) would otherwise leave the transcript buffered and show
		// an empty thread. `flushReplay` deletes its buffer, so the second call
		// is a no-op.
		this.flushReplay(sessionId);
		this.gates = { ...this.gates, [sessionId]: endReplay(this.gateFor(sessionId)) };
		// Cleared HERE, not inside `flushReplay`: a session with no stored frames
		// returns early from there, and the skeleton would outlive the load.
		this.loading = false;

		if (result) {
			if (result.models.length > 0) {
				this.models = result.models;
				if (result.currentModel) this.model = result.currentModel;
			}
			// The roster carries the session's own `yolo` flag, and it is the
			// ONLY permission bit the wire exposes for an existing session:
			// `auto` lives inside the session actor, is not on the handle, and
			// has no read method. The load response's `_meta.yoloMode` /
			// `autoMode` are injected by the leader into `session/new` only, so
			// they describe a session this client just created.
			//
			// So: trust the roster when it says always-approve, and otherwise
			// keep what the load reported. A session the TUI put in `auto` reads
			// here as `ask`, which is the most restrictive of the three — the
			// safe direction to be wrong in, since a wrong `auto` would silently
			// widen permissions.
			if (session?.yolo === true) this.access = 'always-approve';
			else if (result.access) this.access = result.access;
			this.settings = { ...this.settings, permission_mode: this.access };
		}

		// The stream carries only `auto_compact_*` deltas; the itemized totals
		// come from `alnair/session/info`, once per attach.
		const context = await this.transport.sessionContext?.(sessionId);
		if (context) this.context = context;

		// Subagents running in this session right now. The header's list is the
		// transcript merged with these: a spawn that happened before this tab
		// opened is only visible here, and a spawn that has already finished is
		// only visible in the transcript.
		const running = await this.transport.listSubagents?.(sessionId);
		if (running) {
			this.liveSubagents = {
				...this.liveSubagents,
				[sessionId]: sortSubagents(running)
			};
		}

		// The checkout row reads this: a session's branch, and whether its cwd
		// is a worktree, are properties of the directory rather than of the
		// transcript, so they are fetched on attach and after every checkout.
		await this.refreshGit();

		if (this.phase === 'connecting') this.phase = 'ready';
	}

	/**
	 * First load: handshake, roster, then attach to something.
	 *
	 * Called once by the layout. A failure moves the store to `error` rather
	 * than throwing into the component tree — the socket transport retries with
	 * backoff, and a later reconnect re-runs `bootstrap`'s tail through
	 * `reloadAfterReconnect`.
	 */
	async bootstrap() {
		if (!this.transport.connect) return;
		try {
			await this.transport.connect();
			const roster = await this.transport.listSessions?.();
			if (roster) this.sessions = roster;

			if (roster && roster.length > 0) {
				this.activeSessionId = roster[0].id;
				await this.openSession(roster[0].id);
			}
			// A connected agent with no sessions is a valid, ready state: the
			// page shows its empty state rather than a skeleton forever.
			if (this.phase === 'connecting') this.phase = 'ready';
		} catch (error) {
			// Offline, or the leader is still starting. The socket transport
			// retries with backoff; the page shows the reason meanwhile.
			if (this.phase === 'connecting') {
				this.phase = 'error';
				this.phaseDetail = error instanceof Error ? error.message : 'the agent is unreachable';
			}
		}
	}

	private get acc(): Acc {
		return this.accs[this.activeSessionId] ?? emptyAcc();
	}

	/**
	 * The session in front.
	 *
	 * Never throws: during `connecting` the roster is still empty and the page
	 * renders a skeleton, but a component that reads this before then must not
	 * take the whole tree down. A placeholder keeps the contract "there is
	 * always something to render".
	 */
	get activeSession(): Session {
		const session = this.sessions.find((s) => s.id === this.activeSessionId);
		if (session) return { ...session, status: sessionStatus(this.acc) };
		return {
			id: this.activeSessionId,
			title: '',
			cwd: '',
			source: 'local',
			numMessages: 0,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			workspace: '',
			status: 'idle'
		};
	}

	get turns(): Turn[] {
		return this.acc.turns;
	}

	get graph(): GraphState | undefined {
		return this.acc.graph ? graphToState(this.acc.graph) : undefined;
	}

	get todos(): TodoItem[] {
		return this.acc.todos;
	}

	get permission(): PermissionRequest | undefined {
		return Object.values(this.acc.permissions)[0];
	}

	get question(): QuestionRequest | undefined {
		return this.questionRequest;
	}

	/** The `alnair/ask_user_question` request the agent is waiting on. */
	private questionRequest = $state<QuestionRequest | undefined>(undefined);

	get plan(): PlanArtifact | undefined {
		return this.planArtifact;
	}

	/** The `alnair/exit_plan_mode` request the agent is waiting on, if any. */
	private planArtifact = $state<PlanArtifact | undefined>(initialPlan);

	/** The tool call id that parked `planArtifact`, needed to answer it. */
	private planToolCallId = $state<string | undefined>(undefined);

	/** Answer the parked plan: approve, send back with feedback, or abandon. */
	answerPlan(outcome: PlanOutcome) {
		if (!this.planArtifact) return;
		this.transport.respondPlan?.(this.planToolCallId ?? '', outcome);
		this.planArtifact = undefined;
		this.planToolCallId = undefined;
	}

	/**
	 * The commands the composer may offer.
	 *
	 * Filtered, not passed through: the agent advertises one catalog for every
	 * client, and the pager's own local commands would be dead rows here (see
	 * `commands.ts`). A skill and every server-side builtin survive the filter.
	 */
	get commands(): AvailableCommand[] {
		return webCommands(this.acc.commands ?? []);
	}

	selectSession(id: string) {
		if (!this.sessions.some((session) => session.id === id)) return;
		if (id === this.activeSessionId) return;
		this.stopSubagentWatch?.();
		this.transport.stop();
		this.localBusy = false;
		this.activeSessionId = id;

		const session = this.sessions.find((s) => s.id === id);
		if (session?.modelId) this.model = session.modelId;

		// Parked state belongs to the session that was open. The replay for the
		// new one re-delivers any interaction still waiting on the agent, so
		// clearing here cannot lose a live modal.
		this.planArtifact = undefined;
		this.planToolCallId = undefined;
		this.questionRequest = undefined;
		// Subagents are per-session, and both of their sources are already keyed
		// that way (`acc.subagents`, `liveSubagents`), so nothing is cleared
		// here: the header reads the new session's rows as soon as the active id
		// moves. Clearing a shared list is what used to hide a running subagent
		// until its next frame arrived.
		this.subagentTurns = [];
		// The git context belongs to the previous session's directory; clearing
		// it now means the checkout row disappears rather than briefly naming
		// another repo's branch. `openSession` re-reads it for this one.
		this.git = undefined;
		this.branches = [];
		this.worktrees = [];

		// Attach for real: `session/load` subscribes this client and replays the
		// transcript. Without it the stream for this session never arrives.
		void this.openSession(id);
	}

	setModel(id: string) {
		const next = this.models.find((model) => model.id === id);
		if (!next) return;
		this.model = id;
		if (next.efforts.length > 0 && !next.efforts.includes(this.effort)) {
			this.effort = next.efforts[Math.min(1, next.efforts.length - 1)];
		}
		// A real transport forwards this to `session/setModel`; the fixture has
		// no server to tell.
		this.transport.setModel?.(this.model, this.effort);
	}

	setEffort(effort: string) {
		const model = this.models.find((candidate) => candidate.id === this.model);
		if (!model?.efforts.includes(effort)) return;
		this.effort = effort;
		this.transport.setModel?.(this.model, effort);
	}

	async inspectGraph(): Promise<GraphView> {
		if (!this.transport.inspectGraph)
			throw new Error('Graph inspection requires a connected leader.');
		const id = this.activeSessionId;
		const [snapshot, running] = await Promise.all([
			this.transport.inspectGraph(id),
			this.transport.listSubagents?.(id) ?? Promise.resolve([])
		]);
		if (id !== this.activeSessionId) throw new Error('Session changed.');
		return { ...snapshot, subagents: mergeSubagents(this.subagents, running) };
	}

	async controlGraph(graphId: string, action: GraphControl): Promise<void> {
		if (!this.transport.controlGraph) throw new Error('Graph controls require a connected leader.');
		await this.transport.controlGraph(this.activeSessionId, graphId, action);
	}

	setAccess(mode: AccessMode) {
		this.access = mode;
		this.settings = { ...this.settings, permission_mode: mode };
		if (this.live) saveSettings(this.settings);
		// The runtime mode is a session setting, not a UI preference: the agent
		// must know, or it keeps asking according to the old mode.
		this.transport.setAccess?.(mode);
	}

	setSetting(key: string, value: SettingValue) {
		if (key === 'permission_mode') {
			if (value === 'ask' || value === 'auto' || value === 'always-approve') {
				this.setAccess(value);
			}
			return;
		}
		this.settings = { ...this.settings, [key]: value };
		if (key === 'theme') applyTheme(String(value));
		// Persisted on every change: the dialog has no Save button, so the
		// stored value must follow the control rather than wait for one.
		if (this.live) saveSettings(this.settings);
		this.applySettingEffects();
	}

	/**
	 * Push the settings that are not read by a component.
	 *
	 * `density` sets a root attribute the layout CSS keys on, so every spacing
	 * token follows without threading the value through the tree. The rest are
	 * read where they are used.
	 */
	private applySettingEffects() {
		if (typeof document === 'undefined') return;
		const density = String(this.settings.density ?? 'comfortable');
		document.documentElement.dataset.density = density;
	}

	/**
	 * Restore the reader's preferences before the first paint.
	 *
	 * Theme, density and settings come back from `localStorage`; without this
	 * every reload re-themed the page and reset the dialog. A stored value that
	 * no longer validates is replaced by its default in `loadSettings`, so an
	 * older build's data cannot reach a component as an unexpected type.
	 */
	private restorePreferences() {
		this.settings = loadSettings();
		this.hidden = loadHidden();
		// The theme is a setting AND a mode-watcher value; applying it here
		// means the first frame is already in the right palette rather than
		// flashing the system default.
		if (typeof this.settings.theme === 'string') applyTheme(this.settings.theme);
		this.applySettingEffects();
	}

	/**
	 * Remember the workspace list's hidden set.
	 *
	 * Called from both mutations rather than from a reactive effect: `hidden`
	 * is written in exactly two places, and an effect would also fire on the
	 * restore above and re-save what was just read.
	 */
	private persistHidden() {
		if (this.live) saveHidden(this.hidden);
	}

	/**
	 * Refresh a subagent's conversation while its dialog is open.
	 *
	 * The child session stores its own `updates.jsonl`, and
	 * `alnair/session/updates` reads any session by id — including one whose
	 * cwd differs from the parent's, which is exactly the subagent case. The
	 * replay is folded by the same reducer the main thread uses, so the agent
	 * view here is a normal conversation, not a summary.
	 * The caller owns cleanup on close, selection change, and unmount.
	 */
	openSubagent(subagent: SubagentSummary): () => void {
		this.stopSubagentWatch?.();
		this.pickedSubagent = subagent;
		this.subagentTurns = [];
		this.subagentError = undefined;
		this.subagentLoading = false;

		const parent = this.activeSession;
		const childSessionId = subagent.childSessionId;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			stopped = true;
			clearTimeout(timer);
			if (this.stopSubagentWatch !== stop) return;
			this.stopSubagentWatch = undefined;
			this.pickedSubagent = undefined;
			this.subagentLoading = false;
		};
		this.stopSubagentWatch = stop;

		// Only the fixture transport has no child transcript to read. A live
		// store must never fall back to the scripted one: it would show a
		// conversation the child never had.
		if (!this.transport.sessionUpdates) {
			if (!this.live) {
				this.subagentTurns = replay(initialSubagentTranscript(subagent), childSessionId).turns;
			}
			return stop;
		}

		this.subagentLoading = true;
		let transcript = '';
		const refresh = async () => {
			const [updates, detail] = await Promise.allSettled([
				this.transport.sessionUpdates!({ sessionId: childSessionId, cwd: parent.cwd }),
				this.transport.getSubagent?.(subagent.id, this.subagentDetail)
			]);
			// A late response must not replace a different dialog or session.
			if (stopped || this.activeSessionId !== parent.id) return;

			if (updates.status === 'fulfilled' && updates.value) {
				const next = JSON.stringify(updates.value);
				if (next !== transcript) {
					this.subagentTurns = replay(updates.value, childSessionId).turns;
					transcript = next;
				}
				this.subagentError = undefined;
			} else {
				this.subagentError = 'Could not refresh this subagent. Retrying…';
			}
			if (detail.status === 'fulfilled' && detail.value) {
				this.liveSubagents = {
					...this.liveSubagents,
					[parent.id]: mergeSubagents(this.liveSubagents[parent.id] ?? [], [detail.value])
				};
			}
			this.subagentLoading = false;
			// Schedule after completion so slow reads never overlap. Keep reading
			// after finish too, so a final transcript append is not missed.
			timer = setTimeout(() => void refresh(), 1_000);
		};
		void refresh();
		return stop;
	}

	send(text: string, blocks?: unknown[]) {
		const prompt = text.trim();
		// An attachment-only prompt is a legitimate turn ("what is wrong with
		// this?" is often a screenshot and nothing else), so the emptiness
		// check is on the payload, not on the text.
		const attachments = attachmentCount(blocks);
		if ((!prompt && attachments === 0) || this.busy) return;

		const sessionId = this.activeSessionId;
		const now = Date.now();
		// The transcript has no wire equivalent for "this prompt carried a
		// picture", so the bubble says so in words the reader can check.
		const shown = prompt || `${attachments} attachment${attachments === 1 ? '' : 's'}`;
		this.write({ ...this.acc, ...openUserTurn(this.acc, shown, now, this.model, this.effort) });
		this.localBusy = true;
		this.markSession(sessionId, { updatedAt: new Date(now).toISOString() });

		this.transport.send(prompt, (frame) => this.receive(sessionId, frame), blocks);
	}

	cancel() {
		if (!this.busy) return;
		this.transport.stop();
		// Tell the agent too: a viewer may be watching a turn the TUI drives,
		// and stopping only the local stream would leave that turn running.
		this.transport.cancelTurn?.();
		const acc = closeTurn(this.acc, 'cancelled', undefined, Date.now());
		this.write(acc);
		this.localBusy = false;
	}

	clear() {
		this.transport.stop();
		this.write(emptyAcc());
		this.localBusy = false;
	}

	/**
	 * The `@` menu's listing for one directory.
	 *
	 * An empty path means the workspace root: the agent resolves a relative path
	 * against the session cwd, so the root's own cwd is the natural "here".
	 *
	 * Rows are re-rooted at the workspace before they reach the menu, because
	 * `fs/list` reports absolute paths and a mention token must be relative —
	 * the agent's own tools resolve `@src/x.ts`, never `@/home/me/repo/src/x.ts`.
	 */
	async listFiles(path: string): Promise<FileEntry[]> {
		const sessionId = this.activeSessionId;
		if (!this.transport.fsList || !sessionId) return [];
		const root = this.activeSession.cwd;
		const target = path || root;
		if (!target) return [];
		try {
			const entries = await this.transport.fsList(target, sessionId);
			return root
				? entries.map((entry) => ({ ...entry, path: relativeTo(root, entry.path) }))
				: entries;
		} catch {
			// A directory that vanished mid-typing is not an error worth a card.
			return [];
		}
	}

	/**
	 * Read one file for the inspector's preview.
	 *
	 * The path is resolved against the session's own cwd when it is relative,
	 * because that is what a transcript's `file-read` part reports and what the
	 * panel passes back.
	 */
	async readFile(path: string): Promise<FilePreview | undefined> {
		const sessionId = this.activeSessionId;
		if (!this.transport.fsRead || !sessionId || !path) return undefined;
		const target = isAbsolutePath(path) ? path : joinPath(this.activeSession.cwd, path);
		if (!target) return undefined;
		try {
			return await this.transport.fsRead(target, sessionId);
		} catch {
			// A file that vanished between the click and the read is not an
			// error the page should take down; the panel says it could not open.
			return undefined;
		}
	}

	/** The part id a reveal is pending for; the thread consumes and clears it. */
	revealId = $state<string | undefined>(undefined);

	revealPart(id: string) {
		this.revealId = id;
	}

	clearReveal() {
		this.revealId = undefined;
	}

	/**
	 * The interactive terminal.
	 *
	 * A getter, not a stored object: it closes over `this`, so the session id
	 * and cwd it resolves are read at CALL time. A snapshot taken at
	 * construction would keep spawning shells in whichever directory happened
	 * to be active when the page loaded.
	 */
	get terminal(): TerminalBridge {
		const transport = this.transport;
		return {
			unavailable: transport.ptyCreate ? undefined : 'this build cannot spawn a shell',
			spawn: async (request) => {
				if (!transport.ptyCreate) throw new Error('this build cannot spawn a shell');
				const sessionId = this.activeSessionId;
				if (!sessionId) throw new Error('no session is open');
				return transport.ptyCreate({
					sessionId,
					cwd: this.activeSession.cwd || undefined,
					rows: request.rows,
					cols: request.cols
				});
			},
			attach: async (terminalId) => {
				if (!transport.ptyLoad) throw new Error('this build cannot attach a shell');
				return transport.ptyLoad(terminalId);
			},
			input: (terminalId, data) => transport.ptyInput?.(terminalId, data),
			resize: (terminalId, rows, cols) => transport.ptyResize?.(terminalId, rows, cols),
			close: (terminalId) => transport.ptyClose?.(terminalId),
			onevent: (sink) => {
				transport.onPtyEvent?.(sink);
				return () => transport.onPtyEvent?.(() => {});
			}
		};
	}

	/** Save one file, resolving the path the same way `readFile` does. */
	async writeFile(path: string, content: string): Promise<void> {
		const sessionId = this.activeSessionId;
		if (!this.transport.fsWrite || !sessionId || !path) {
			throw new Error('this build cannot write files');
		}
		const target = isAbsolutePath(path) ? path : joinPath(this.activeSession.cwd, path);
		if (!target) throw new Error('the session has no directory to resolve the path against');
		await this.transport.fsWrite(target, content, sessionId);
	}

	/** The working tree, for the source-control panel. */
	async readGitStatus(): Promise<unknown> {
		const sessionId = this.activeSessionId;
		if (!this.transport.gitStatus || !sessionId) return undefined;
		try {
			return await this.transport.gitStatus(sessionId);
		} catch {
			return undefined;
		}
	}

	/** Ranked matches across the workspace, for the `@` menu's typed query. */
	async searchFiles(query: string, dirs = false): Promise<FileEntry[]> {
		const sessionId = this.activeSessionId;
		if (!this.transport.fsSearch || !sessionId) return [];
		try {
			// `fs/search` already answers root-relative paths, so no re-rooting.
			return await this.transport.fsSearch({
				sessionId,
				path: this.activeSession.cwd || undefined,
				query,
				dirs
			});
		} catch {
			return [];
		}
	}

	// --- workspace administration -------------------------------------------

	/**
	 * The active session's repository.
	 *
	 * Held as store state rather than re-read by every component: the checkout
	 * row, the branch picker and the worktree list all answer from it, and they
	 * must agree. `undefined` means "not a git repo", which the UI renders by
	 * hiding the row rather than by pretending the checkout is a branch.
	 */
	git = $state<GitContext | undefined>(undefined);
	branches = $state<BranchEntry[]>([]);
	worktrees = $state<WorktreeEntry[]>([]);

	/**
	 * Rename a session.
	 *
	 * Applied optimistically: the sidebar is the surface the user is looking at,
	 * and waiting for a round trip to redraw one string reads as a dropped
	 * keystroke. A rejection puts the old title back.
	 */
	async renameSession(id: string, title: string): Promise<void> {
		const next = title.trim();
		if (!next) return;
		const session = this.sessions.find((candidate) => candidate.id === id);
		if (!session) return;

		const previous = session.title;
		this.markSession(id, { title: next });
		if (!this.transport.renameSession) return;

		try {
			await this.transport.renameSession(id, next, session.cwd);
		} catch {
			this.markSession(id, { title: previous });
		}
	}

	/**
	 * Delete a session.
	 *
	 * The view moves off it first: deleting the transcript out from under the
	 * open pane would leave the reducer folding frames for a session that no
	 * longer exists. The row is dropped optimistically for the same reason the
	 * rename is — but restored if the agent refuses, because a session that is
	 * still on disk must stay in the list.
	 *
	 * A refusal is re-thrown. Swallowing it is what made "delete does nothing"
	 * invisible: the row disappeared, the delete never happened, and only a
	 * reload revealed the session still existed.
	 */
	async deleteSession(id: string): Promise<void> {
		const session = this.sessions.find((candidate) => candidate.id === id);
		if (!session) return;

		const remaining = this.sessions.filter((candidate) => candidate.id !== id);
		this.sessions = remaining;

		if (id === this.activeSessionId) {
			const next = remaining[0];
			if (next) await this.openSession(next.id);
			else {
				this.activeSessionId = '';
				this.accs = {};
			}
		}

		if (!this.transport.deleteSession) return;
		try {
			await this.transport.deleteSession(id, session.cwd);
		} catch (error) {
			// Refused: put the row back exactly where it was, and let the
			// caller say why.
			this.sessions = [...this.sessions, session].sort(
				(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
			);
			throw error;
		}
	}

	/**
	 * Add a workspace: ask the machine for a directory, then start a session
	 * there.
	 *
	 * The two halves are one action. A workspace the backend does not know
	 * about has no sessions, and a session is the only thing that puts a
	 * directory in the roster — so "add a workspace" is "start a session in
	 * this directory". The alternative (a sidebar-only entry) would vanish on
	 * the next reload, which reads as the action having failed.
	 *
	 * Resolves to the chosen path, or `undefined` when the dialog was cancelled.
	 */
	async addWorkspace(path?: string): Promise<string | undefined> {
		let chosen = path?.trim() || undefined;
		if (!chosen) {
			if (!this.transport.pickDirectory) return undefined;
			chosen = await this.transport.pickDirectory();
			if (!chosen) return undefined;
		}
		await this.createSession(chosen);
		return chosen;
	}

	/**
	 * Put a workspace away.
	 *
	 * Nothing on disk is touched and the sessions stay in `sessions`, so the
	 * group comes back intact when restored. Hiding rather than deleting is the
	 * whole point: "remove workspace" must not be a way to lose transcripts by
	 * accident.
	 */
	removeWorkspace(name: string): void {
		if (!name || this.hidden.includes(name)) return;
		this.hidden = [...this.hidden, name];
		this.persistHidden();
	}

	/** Bring a hidden workspace back into the list. */
	restoreWorkspace(name: string): void {
		this.hidden = this.hidden.filter((candidate) => candidate !== name);
		this.persistHidden();
	}

	/**
	 * Start a session in `cwd` and attach to it.
	 *
	 * The agent creates the session; the roster broadcast is what usually adds
	 * the row, but the new id is known here, so the row is inserted directly and
	 * the later delta refines it. Attaching immediately is what makes the new
	 * session usable: without a `session/load` the stream never arrives.
	 */
	async createSession(cwd: string): Promise<void> {
		if (!this.transport.newSession) return;
		const sessionId = await this.transport.newSession(cwd);
		const now = new Date().toISOString();
		const created: Session = {
			id: sessionId,
			title: lastSegment(cwd) || 'New session',
			cwd,
			source: 'local',
			numMessages: 0,
			createdAt: now,
			updatedAt: now,
			workspace: lastSegment(cwd) || cwd,
			status: 'idle'
		};
		if (!this.sessions.some((session) => session.id === sessionId)) {
			this.sessions = [created, ...this.sessions];
		}
		await this.openSession(sessionId);
	}

	/**
	 * Reload the git context for the active session.
	 *
	 * Three reads, one failure mode: a session outside a repo answers every one
	 * of them with an error, and the checkout row disappears. Branches and
	 * worktrees are fetched here rather than lazily because both menus open
	 * instantly and an empty menu would read as "no branches exist".
	 */
	async refreshGit(): Promise<void> {
		const sessionId = this.activeSessionId;
		if (!sessionId || !this.transport.gitInfo) {
			this.git = undefined;
			this.branches = [];
			this.worktrees = [];
			return;
		}

		try {
			this.git = await this.transport.gitInfo(sessionId);
		} catch {
			this.git = undefined;
		}
		if (!this.git) {
			this.branches = [];
			this.worktrees = [];
			return;
		}

		const [branches, worktrees] = await Promise.all([
			this.transport.gitBranches?.(sessionId).catch(() => [] as BranchEntry[]) ?? [],
			this.transport.gitWorktrees?.(this.git.root).catch(() => [] as WorktreeEntry[]) ?? []
		]);
		this.branches = branches;
		this.worktrees = worktrees;
	}

	/**
	 * Re-read the exact context snapshot.
	 *
	 * Called when the meter opens, so the itemized rows describe the session
	 * now rather than when the tab attached. A failed read keeps the previous
	 * snapshot: the streamed `used` figure is still correct, and blanking the
	 * panel would be worse than showing a slightly old breakdown.
	 */
	async refreshContext(): Promise<void> {
		const sessionId = this.activeSessionId;
		if (!sessionId || !this.transport.sessionContext) return;
		try {
			const context = await this.transport.sessionContext(sessionId);
			if (context) this.context = context;
		} catch {
			// Keep the last known snapshot.
		}
	}

	/**
	 * Check out a branch.
	 *
	 * A remote-tracking ref cannot be checked out directly; git wants a local
	 * branch tracking it. Stripping the remote prefix and creating the branch is
	 * what the TUI's own branch picker does, and doing it here keeps the rule in
	 * one place instead of in each menu.
	 */
	async checkoutBranch(name: string, create = false): Promise<void> {
		const sessionId = this.activeSessionId;
		if (!sessionId || !this.transport.gitCheckout) return;

		const entry = this.branches.find((branch) => branch.name === name);
		const local = entry?.remote ? name.split('/').slice(1).join('/') : name;
		const shouldCreate = create || entry?.remote === true;

		await this.transport.gitCheckout(sessionId, local, shouldCreate);
		// The checkout changes the branch AND the file listing the `@` menu
		// shows; refreshing both keeps the composer honest.
		await this.refreshGit();
		const session = this.sessions.find((candidate) => candidate.id === sessionId);
		if (session) this.markSession(sessionId, { branch: local });
	}

	/**
	 * Create a worktree and start a session in it.
	 *
	 * The worktree is created from the active session's cwd, so a session
	 * already inside a worktree branches from that worktree — which is what the
	 * TUI's dashboard does. The new session is a normal one; nothing about it
	 * records that it lives in a worktree except its cwd, and that is enough
	 * because `alnair/git/info` resolves the root from the cwd.
	 */
	async createWorktree(label: string, gitRef?: string): Promise<void> {
		const sessionId = this.activeSessionId;
		if (!sessionId || !this.transport.gitCreateWorktree) return;
		const sourcePath = this.activeSession.cwd;
		if (!sourcePath) return;

		const path = await this.transport.gitCreateWorktree({
			sessionId,
			sourcePath,
			gitRef,
			label: label.trim() || undefined
		});
		await this.createSession(path);
		await this.refreshGit();
	}

	answerPermission(optionId: string) {
		const request = this.permission;
		if (!request) return;
		this.transport.respond(request.toolCallId, optionId);
		// The agent confirms with `interaction_resolved`; optimistically drop the
		// card so the composer is usable while that round-trips.
		const { [request.toolCallId]: _answered, ...permissions } = this.acc.permissions;
		this.write({ ...this.acc, permissions });
		this.resolvePermissionCard(request.toolCallId);
	}

	/** Mark the in-thread card answered, so it stops offering buttons. */
	private resolvePermissionCard(toolCallId: string) {
		this.write(resolveCardById(this.acc, `perm-${toolCallId}`));
	}

	answerQuestions(answers: Record<string, QuestionAnswer>) {
		const request = this.questionRequest;
		if (!request) return;
		const response = acceptedResponse(request.questions, answers);
		this.transport.respondQuestions(request.toolCallId, response);
		this.finishQuestion(request.toolCallId);
	}

	cancelQuestions() {
		const request = this.questionRequest;
		if (!request) return;
		this.transport.respondQuestions(request.toolCallId, { outcome: 'cancelled' });
		this.finishQuestion(request.toolCallId);
	}

	chatAboutQuestion() {
		const request = this.questionRequest;
		if (!request) return;
		this.transport.respondQuestions(request.toolCallId, {
			outcome: 'chat_about_this',
			partialAnswers: {}
		});
		this.finishQuestion(request.toolCallId);
	}

	skipQuestions() {
		const request = this.questionRequest;
		if (!request) return;
		this.transport.respondQuestions(request.toolCallId, {
			outcome: 'skip_interview',
			partialAnswers: {}
		});
		this.finishQuestion(request.toolCallId);
	}

	/** Clear the parked request and mark its card answered. */
	private finishQuestion(toolCallId: string) {
		this.questionRequest = undefined;
		this.write(resolveCardById(this.acc, `ask-${toolCallId}`));
	}

	/** Replay/live watermark per session; see `dedup.ts` for the rule. */
	private gates = $state<Record<string, GateState>>({});

	private gateFor(sessionId: string): GateState {
		return this.gates[sessionId] ?? liveGate();
	}

	/**
	 * Start (or restart) a session's transcript from a `session/load` replay.
	 *
	 * Resets the accumulator and opens the replay window, so the frames that
	 * follow rebuild the view instead of being deduped against a stale
	 * watermark. A transport calls this immediately before sending the request.
	 */
	beginSessionLoad(sessionId: string) {
		this.gates = { ...this.gates, [sessionId]: beginReplay() };
		this.accs = { ...this.accs, [sessionId]: emptyAcc() };
		// Frames are collected, not folded: see `flushReplay`.
		this.replayBuffers.set(sessionId, []);
		// Only the session in front shows a skeleton; a background load (a
		// subagent's transcript) must not blank the thread.
		if (sessionId === this.activeSessionId) this.loading = true;
	}

	/**
	 * Frames received during a `session/load`, folded in one pass when it ends.
	 *
	 * A transcript is replayed as hundreds of individual notifications, and
	 * folding each one as it arrived meant the reader watched the conversation
	 * rebuild itself turn by turn — a replay, not a load. Worse, every frame
	 * was its own `write()`, so a long session produced a render per chunk.
	 *
	 * Collecting them costs one array and buys two things: the transcript
	 * appears at once, and the whole replay is a single accumulator update
	 * (`reduceAcpUpdate` is pure, so folding N frames into one `write` is
	 * exactly what the incremental path would have produced, minus N-1
	 * renders).
	 *
	 * A Map rather than `$state`: this is transient plumbing, and making it
	 * reactive would re-run every reader of the store on each push.
	 */
	private replayBuffers = new Map<string, IncomingFrame[]>();

	/** Fold a finished replay into the accumulator with a single write. */
	private flushReplay(sessionId: string) {
		const frames = this.replayBuffers.get(sessionId);
		this.replayBuffers.delete(sessionId);

		// Cleared before the early return: a session with no stored frames is a
		// finished load too, and leaving the skeleton up for it would show a
		// loading state forever on every brand-new session.
		if (sessionId === this.activeSessionId) this.loading = false;
		if (!frames || frames.length === 0) return;

		// The frames were already admitted when they arrived (the replay branch
		// in `receive` advances the watermark as it collects), so this pass is
		// pure folding. Re-running `admit` here would be a second, differently
		// timed evaluation of the same rule.
		let acc = this.acc;
		let tokens: number | undefined;
		const now = Date.now();

		for (const frame of frames) {
			const update = frame.params.update as Record<string, unknown> | undefined;
			if (!update) continue;

			// Last figure wins: the meter wants where the transcript ended, not
			// every intermediate value it passed through on the way there.
			const frameTokens = totalTokensOf(frame.params._meta);
			if (frameTokens !== undefined) tokens = frameTokens;

			const ctx = { now, sessionId, modelId: this.model, effort: this.effort };
			acc = this.isExtFrame(frame.method)
				? reduceExtUpdate(acc, update as ExtSessionUpdate, ctx)
				: reduceAcpUpdate(acc, update as SessionUpdate, ctx);
		}

		this.write(acc);
		if (tokens !== undefined) this.applyContextUsed(tokens);

		// Model switches and the like are chrome state, not transcript state;
		// the last one the replay carried is the one in force now.
		const last = frames.at(-1);
		const lastUpdate = last?.params.update as Record<string, unknown> | undefined;
		if (lastUpdate) this.syncFromUpdate(lastUpdate as ExtSessionUpdate);
	}

	private receive(sessionId: string, frame: IncomingFrame) {
		if (sessionId !== this.activeSessionId) return;

		// The `session/load` response closes the replay window: everything
		// after it is compared against the watermark instead of applied blindly.
		if (frame.method === 'session/load:result') {
			// Fold everything the replay delivered, in one write, so the
			// transcript appears whole instead of assembling itself frame by
			// frame in front of the reader.
			this.flushReplay(sessionId);
			this.gates = {
				...this.gates,
				[sessionId]: endReplay(this.gateFor(sessionId))
			};
			return;
		}

		if (frame.method === 'session/prompt:result') {
			const stopReason = String(frame.params.stopReason ?? 'end_turn');
			const status =
				stopReason === 'cancelled'
					? 'cancelled'
					: stopReason === 'refusal'
						? 'refused'
						: 'complete';
			this.write(closeTurn(this.acc, status, undefined, Date.now()));
			this.localBusy = false;
			return;
		}

		// A reverse request: the agent is blocked until the user answers.
		if (frame.method === 'alnair/exit_plan_mode') {
			this.planArtifact = {
				title: 'Plan for approval',
				markdown: String(frame.params.planContent ?? '')
			};
			// Kept so the approval can be addressed back to the request that
			// parked it; the tool call id is the wire's correlation key.
			this.planToolCallId = String(frame.params.toolCallId ?? '');
			return;
		}

		if (frame.method === 'alnair/ask_user_question') {
			const request = frame.params as unknown as AskUserQuestionRequest;
			this.questionRequest = questionFromPayload(request);
			this.write(questionFromRequest(this.acc, request, Date.now()));
			return;
		}

		const update = frame.params.update as Record<string, unknown> | undefined;
		if (!update) return;

		// Dedup across reconnects. The leader only dedups WITHIN one load; a
		// second `session/load` replays the whole transcript into an accumulator
		// that may already hold part of it. Unsequenced frames always apply.
		const gate = this.gateFor(sessionId);
		const verdict = admit(gate, eventIdOf(frame.params));
		if (!verdict.apply) return;

		/**
		 * During a replay the frame is COLLECTED rather than folded.
		 *
		 * A transcript arrives as hundreds of notifications; folding each one
		 * on arrival is what made opening a session look like watching it be
		 * replayed. `flushReplay` folds them in one pass when the load
		 * response lands, which is a load.
		 *
		 * The watermark is still advanced here, so the gate above is the same
		 * rule it always was — only the render is deferred.
		 */
		if (gate.phase === 'replay') {
			this.gates = { ...this.gates, [sessionId]: verdict.state };
			const buffer = this.replayBuffers.get(sessionId);
			if (buffer) buffer.push(frame);
			return;
		}

		this.gates = { ...this.gates, [sessionId]: verdict.state };

		// The context meter follows the stream, not the attach snapshot: every
		// persisted frame carries `_meta.totalTokens`, which is the same figure
		// the TUI's context bar reads. Applied only for frames that survived the
		// dedup gate, so a stale replay cannot pull the count backwards.
		const tokens = totalTokensOf(frame.params._meta);
		if (tokens !== undefined) this.applyContextUsed(tokens);

		const ctx = { now: Date.now(), sessionId, modelId: this.model, effort: this.effort };
		const acc = this.isExtFrame(frame.method)
			? reduceExtUpdate(this.acc, update as ExtSessionUpdate, ctx)
			: reduceAcpUpdate(this.acc, update as SessionUpdate, ctx);
		this.write(acc);

		// The composer's picker and the header's subagent list are store state,
		// not transcript state: the reducer keeps them in the accumulator for
		// the thread, and these mirror the parts the chrome reads.
		this.syncFromUpdate(update as ExtSessionUpdate);
	}

	/**
	 * Whether a frame rides the extension rail.
	 *
	 * `alnair/session/update` is the replay/persisted form; the live one-shot
	 * rail is `alnair/session_notification`. The transport normalizes the
	 * gateway's `_` prefix away, so both arrive unprefixed and this is the only
	 * place the distinction is drawn. Getting it wrong is silent: the extension
	 * payload would be handed to the ACP decoder, which does not recognize
	 * `model_changed` or `interaction_resolved` and drops them.
	 */
	private isExtFrame(method: string): boolean {
		return isExtMethod(method);
	}

	/**
	 * Mirror the extension updates the chrome reads into store state.
	 *
	 * The thread renders from the accumulator, so a component inside it needs
	 * nothing here. These four are outside it: the model picker, the context
	 * meter, the subagent list in the header, and the session row's status.
	 */
	private syncFromUpdate(update: ExtSessionUpdate) {
		switch (update.sessionUpdate) {
			case 'interaction_resolved': {
				if (update.tool_call_id === this.planToolCallId) {
					this.planArtifact = undefined;
					this.planToolCallId = undefined;
				}
				return;
			}
			case 'model_changed': {
				const event = update as unknown as {
					model_id?: string;
					reasoning_effort?: string;
					context_window?: number;
				};
				if (event.model_id) this.model = event.model_id;
				if (event.reasoning_effort) this.effort = event.reasoning_effort;
				// A model switch changes the window; the snapshot still holds the
				// old one until the next `session/info`. The update carries the
				// resolved figure, so the meter can move immediately.
				if (typeof event.context_window === 'number' && event.context_window > 0) {
					this.context = { ...this.context, limit: event.context_window };
				}
				return;
			}
			case 'subagent_spawned':
			case 'subagent_progress':
			case 'subagent_finished': {
				// Nothing to mirror: the reducer folds these into
				// `acc.subagents`, and the header's list is DERIVED from that
				// (plus the live snapshots) by the `subagents` getter. Assigning
				// a copy here is what made the list a second source of truth —
				// and the reason a session switch could blank it.
				return;
			}
			default:
				return;
		}
	}

	/**
	 * Update the meter's used figure from a live frame.
	 *
	 * Mirrors the TUI's `AgentView::apply_context_used`: only `used` moves, and
	 * the derived figures (`percent`, `freeTokens`) are recomputed against the
	 * window already known. The itemized breakdown stays at its last snapshot
	 * value on purpose — the wire does not re-send it per frame, and the panel
	 * has an `Overhead` row that absorbs the difference, so growth shows up
	 * honestly instead of being spread across categories that did not change.
	 *
	 * A zero window (no snapshot yet) is not guessed at: the figure is recorded
	 * and the meter still renders `—` until `session/info` says how big the
	 * window is.
	 */
	private applyContextUsed(used: number) {
		const limit = this.context.limit;
		if (limit <= 0) {
			this.context = { ...this.context, used };
			return;
		}
		this.context = {
			...this.context,
			used,
			percent: Math.min(100, Math.round((used / limit) * 100)),
			freeTokens: Math.max(0, limit - used)
		};
	}

	private write(acc: Acc) {
		this.accs = { ...this.accs, [this.activeSessionId]: acc };
	}

	private markSession(sessionId: string, patch: Partial<Session>) {
		this.sessions = this.sessions.map((session) =>
			session.id === sessionId ? { ...session, ...patch } : session
		);
	}
}
