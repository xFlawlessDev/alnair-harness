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
	GraphState,
	ModelOption,
	PermissionRequest,
	PlanArtifact,
	QuestionAnswer,
	QuestionRequest,
	Session,
	SubagentSummary,
	TodoItem,
	Turn,
	WorkspaceGroup,
	WorkspaceInfo
} from './types.js';
import { groupByWorkspace } from './workspaces.js';
import { sortSubagents } from './subagents.js';
import { admit, beginReplay, endReplay, eventIdOf, liveGate, type GateState } from './dedup.js';
import { applyRosterDelta } from './wire.js';

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
	 * Returns the session's model catalog and mode, which only the load
	 * response carries.
	 */
	openSession?(sessionId: string): Promise<SessionOpenResult | void>;
	/** Create a session in `cwd` and return its id. */
	newSession?(cwd: string): Promise<string>;
	/** The exact context snapshot (`alnair/session/info`). */
	sessionContext?(sessionId: string): Promise<ContextUsage | undefined>;
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

export interface SessionStore {
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
	workspace = $state(workspace);
	sessions = $state(sessions);
	models = $state(models);
	context = $state(contextUsage);

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
		this.beginSessionLoad(sessionId);
		const result = await this.transport.openSession(sessionId);

		if (result) {
			if (result.models.length > 0) {
				this.models = result.models;
				if (result.currentModel) this.model = result.currentModel;
			}
			if (result.access) this.access = result.access;
		}

		// The stream carries only `auto_compact_*` deltas; the itemized totals
		// come from `alnair/session/info`, once per attach.
		const context = await this.transport.sessionContext?.(sessionId);
		if (context) this.context = context;
	}

	/**
	 * First load: handshake, roster, then attach to something.
	 *
	 * Called once by the layout. A failure leaves the store empty rather than
	 * throwing into the component tree — the transport reconnects on its own.
	 */
	async bootstrap() {
		if (!this.transport.connect) return;
		try {
			await this.transport.connect();
			const sessions = await this.transport.listSessions?.();
			if (sessions && sessions.length > 0) {
				this.sessions = sessions;
				this.activeSessionId = sessions[0].id;
				await this.openSession(sessions[0].id);
			}
		} catch {
			// Offline, or the leader is still starting. The socket transport
			// retries with backoff; the UI shows its empty state until then.
		}
	}

	private get acc(): Acc {
		return this.accs[this.activeSessionId] ?? emptyAcc();
	}

	get activeSession(): Session {
		const session = this.sessions.find((s) => s.id === this.activeSessionId);
		if (!session) throw new Error('active session is not in the list');
		return { ...session, status: sessionStatus(this.acc) };
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
		// The fixture transport has no child transcript to read.
		if (!this.transport.sessionUpdates) {
			this.subagentTurns = replay(initialSubagentTranscript(subagent), childSessionId).turns;
			return;
		}

		// A child session stores its own `updates.jsonl`; `alnair/session/updates`
		// reads any session by id, including one whose cwd differs from the
		// parent's. The replay is folded by the same reducer the main thread uses,
		// so this is a normal conversation, not a summary.
		const parent = this.activeSession;
		void this.transport
			.sessionUpdates({ sessionId: childSessionId, cwd: parent.cwd })
			.then((envelopes) => {
				if (envelopes) this.subagentTurns = replay(envelopes, childSessionId).turns;
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
		const acc =
			frame.method === '_alnair/session/update'
				? reduceExtUpdate(this.acc, update as ExtSessionUpdate, ctx)
				: reduceAcpUpdate(this.acc, update as SessionUpdate, ctx);
		this.write(acc);
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
