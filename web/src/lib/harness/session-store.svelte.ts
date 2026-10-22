/**
 * The store the UI talks to.
 *
 * One interface, two implementations: the fixture transport replays the
 * scripted transcripts in `fixtures.ts`, and the socket transport (next
 * milestone) speaks JSON-RPC to `alnair agent serve`. Both feed the same
 * reducer, so a component cannot tell them apart.
 *
 * Nothing below this line knows what ACP is. Nothing above it knows where the
 * frames come from.
 */

import { setMode } from 'mode-watcher';
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
import type { AskUserQuestionRequest, AskUserQuestionResponse } from './types/ext.js';
import type { SessionUpdate } from './types/acp.js';
import type {
	AccessMode,
	AvailableCommand,
	ContextUsage,
	FileEntry,
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
	WorkspaceInfo
} from './types.js';
import { groupByWorkspace } from './workspaces.js';
import { sortSubagents } from './subagents.js';
import { admit, beginReplay, endReplay, eventIdOf, liveGate, type GateState } from './dedup.js';
import { applyRosterDelta, relativeTo } from './wire.js';

/** A frame the agent sent, plus the prompt it answers (if any). */
export interface IncomingFrame {
	method: string;
	params: Record<string, unknown>;
}

export interface Transport {
	/**
	 * Start a turn. Frames arrive through `onFrame` until `stop` is called or
	 * the transport reports the turn closed.
	 */
	send(prompt: string, onFrame: (frame: IncomingFrame) => void): void;
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
}

export type PlanOutcome = 'approved' | 'cancelled' | 'abandoned';

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
	/** Open a subagent's child session and load its transcript. */
	openSubagent(subagent: SubagentSummary): void;
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
	send(text: string): void;
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
}

const STREAM_TICK_MS = 24;

/**
 * Point mode-watcher at the chosen theme. `system` clears the stored
 * preference so the OS decides, which is what the toggle used to do.
 */
function applyTheme(theme: string) {
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
	subagents = $state<SubagentSummary[]>(sortSubagents(subagents));
	/**
	 * The open subagent's transcript. A subagent is a session, so this is the
	 * same folded view the main thread renders — the child's `updates.jsonl`
	 * read through `alnair/session/updates`, not a separate agent view.
	 */
	subagentTurns = $state<Turn[]>([]);
	busy = $state(false);

	/**
	 * Whether this store drives a real agent.
	 *
	 * A transport that implements `connect` has a server behind it; the fixture
	 * transport does not, and is the only case where scripted state may be
	 * shown. Everything below keys off this rather than off a URL, so the
	 * decision is made once and cannot drift.
	 */
	private readonly live: boolean;

	get groups(): WorkspaceGroup[] {
		// Alphabetical, with no session-derived pinning: clicking a conversation
		// must not reorder the list under the pointer. `currentWorkspace` only
		// marks which group is open; it does not move it.
		return groupByWorkspace(this.sessions);
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

		if (this.live) {
			// Nothing is known yet. Every value the fixtures supplied is cleared
			// so a component cannot mistake scripted data for the user's.
			this.phase = 'connecting';
			this.sessions = [];
			this.models = [];
			this.subagents = [];
			this.accs = {};
			this.activeSessionId = '';
			this.model = '';
			this.effort = '';
			this.access = 'ask';
			this.context = emptyContextUsage();
			this.planArtifact = undefined;
		}

		// A real transport pushes frames for whichever session they belong to,
		// so the store owns the routing (the fixture transport calls back with
		// the session it was started for).
		this.transport.onFrame?.((sessionId, frame) => this.receive(sessionId, frame));
		this.transport.onReconnected?.(() => this.reloadAfterReconnect());
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
		this.busy = false;
		this.questionRequest = undefined;
		this.planArtifact = undefined;
		const sessionId = this.activeSessionId;
		void this.openSession(sessionId);
	}

	/**
	 * Attach to a session.
	 *
	 * Resets the accumulator and opens the replay window BEFORE the request
	 * goes out, so no frame can arrive against a stale watermark. The load
	 * response then fills in what only it knows: the model catalog, the
	 * session's current model, its mode, and the exact context totals.
	 */
	async openSession(sessionId: string) {
		if (!this.transport.openSession) return;

		const session = this.sessions.find((candidate) => candidate.id === sessionId);
		this.beginSessionLoad(sessionId);
		const result = await this.transport.openSession(sessionId, session?.cwd);

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
		}

		// The stream carries only `auto_compact_*` deltas; the itemized totals
		// come from `alnair/session/info`, once per attach.
		const context = await this.transport.sessionContext?.(sessionId);
		if (context) this.context = context;

		// Subagents running in this session right now. A spawn that happened
		// before this tab opened is only visible here; later ones arrive as
		// `subagent_spawned` frames.
		const running = await this.transport.listSubagents?.(sessionId);
		if (running) this.subagents = sortSubagents(running);

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

	get commands(): AvailableCommand[] {
		return this.acc.commands ?? [];
	}

	selectSession(id: string) {
		if (!this.sessions.some((session) => session.id === id)) return;
		if (id === this.activeSessionId) return;
		this.transport.stop();
		this.busy = false;
		this.activeSessionId = id;

		const session = this.sessions.find((s) => s.id === id);
		if (session?.modelId) this.model = session.modelId;

		// Parked state belongs to the session that was open. The replay for the
		// new one re-delivers any interaction still waiting on the agent, so
		// clearing here cannot lose a live modal.
		this.planArtifact = undefined;
		this.planToolCallId = undefined;
		this.questionRequest = undefined;
		// Subagents are per-session too. The new session's running set is
		// re-read by `openSession`, so clearing here only drops the old rows.
		this.subagents = [];
		this.subagentTurns = [];

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
		this.effort = effort;
	}

	setAccess(mode: AccessMode) {
		this.access = mode;
		// The runtime mode is a session setting, not a UI preference: the agent
		// must know, or it keeps asking according to the old mode.
		this.transport.setAccess?.(mode);
	}

	setSetting(key: string, value: SettingValue) {
		this.settings = { ...this.settings, [key]: value };
		// The composer's access control and the settings dialog edit the same
		// runtime mode; keep them from disagreeing.
		if (key === 'permission_mode' && typeof value === 'string') {
			this.access = value as AccessMode;
		}
		if (key === 'theme') applyTheme(String(value));
	}

	/**
	 * Load a subagent's conversation.
	 *
	 * The child session stores its own `updates.jsonl`, and
	 * `alnair/session/updates` reads any session by id — including one whose
	 * cwd differs from the parent's, which is exactly the subagent case. The
	 * replay is folded by the same reducer the main thread uses, so the agent
	 * view here is a normal conversation, not a summary.
	 */
	openSubagent(subagent: SubagentSummary) {
		const childSessionId = subagent.childSessionId;
		// Only the fixture transport has no child transcript to read. A live
		// store must never fall back to the scripted one: it would show a
		// conversation the child never had.
		if (!this.transport.sessionUpdates) {
			this.subagentTurns = replay(initialSubagentTranscript(subagent), childSessionId).turns;
			return;
		}

		// A child session stores its own `updates.jsonl`; `alnair/session/updates`
		// reads any session by id, including one whose cwd differs from the
		// parent's. The replay is folded by the same reducer the main thread uses,
		// so this is a normal conversation, not a summary.
		const parent = this.activeSession;
		this.subagentTurns = [];
		void this.transport
			.sessionUpdates({ sessionId: childSessionId, cwd: parent.cwd })
			.then((envelopes) => {
				this.subagentTurns = envelopes ? replay(envelopes, childSessionId).turns : [];
			})
			.catch(() => {
				this.subagentTurns = [];
			});
	}

	send(text: string) {
		const prompt = text.trim();
		if (!prompt || this.busy) return;

		const sessionId = this.activeSessionId;
		const now = Date.now();
		this.write({ ...this.acc, ...openUserTurn(this.acc, prompt, now, this.model, this.effort) });
		this.busy = true;
		this.markSession(sessionId, { updatedAt: new Date(now).toISOString() });

		this.transport.send(prompt, (frame) => this.receive(sessionId, frame));
	}

	cancel() {
		if (!this.busy) return;
		this.transport.stop();
		// Tell the agent too: a viewer may be watching a turn the TUI drives,
		// and stopping only the local stream would leave that turn running.
		this.transport.cancelTurn?.();
		const acc = closeTurn(this.acc, 'cancelled', undefined, Date.now());
		this.write(acc);
		this.busy = false;
	}

	clear() {
		this.transport.stop();
		this.write(emptyAcc());
		this.busy = false;
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
	}

	private receive(sessionId: string, frame: IncomingFrame) {
		if (sessionId !== this.activeSessionId) return;

		// The `session/load` response closes the replay window: everything
		// after it is compared against the watermark instead of applied blindly.
		if (frame.method === 'session/load:result') {
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
			this.busy = false;
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
		this.gates = { ...this.gates, [sessionId]: verdict.state };

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
	 * `_alnair/session/update` is the replay/persisted form; the live one-shot
	 * rail is `alnair/session_notification`. Both carry the extension payload,
	 * and the ACP rail is the only one that does not.
	 */
	private isExtFrame(method: string): boolean {
		return method === '_alnair/session/update' || method === 'alnair/session_notification';
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
			case 'model_changed': {
				const event = update as unknown as {
					model_id?: string;
					reasoning_effort?: string;
				};
				if (event.model_id) this.model = event.model_id;
				if (event.reasoning_effort) this.effort = event.reasoning_effort;
				return;
			}
			case 'subagent_spawned':
			case 'subagent_progress':
			case 'subagent_finished': {
				// The reducer folds these into the transcript card; the header's
				// list is the same data in a different shape. Re-derive it from
				// the accumulator so the two can never disagree.
				this.subagents = sortSubagents(
					Object.values(this.acc.subagents).map((state) => ({
						id: state.id,
						agent: state.agent,
						description: state.description,
						childSessionId: state.childSessionId,
						status:
							state.status === 'running'
								? 'running'
								: state.status === 'error'
									? 'failed'
									: 'completed',
						startedAt: state.startedAt,
						durationMs: (state.endedAt ?? Date.now()) - state.startedAt,
						turnCount: state.turnCount,
						toolCallCount: state.toolCallCount,
						tokensUsed: state.tokensUsed,
						contextWindowTokens: 0,
						contextUsagePct: 0,
						toolsUsed: state.toolsUsed,
						errorCount: state.error ? 1 : 0,
						output: state.result,
						failureError: state.error,
						model: state.model
					}))
				);
				return;
			}
			default:
				return;
		}
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
