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

import {
	initialPlan,
	initialTranscript,
	models,
	sessions,
	workspace,
	contextUsage
} from './mock.js';
import {
	closeTurn,
	emptyAcc,
	graphToState,
	openUserTurn,
	reduceAcpUpdate,
	reduceExtUpdate,
	sessionStatus
} from './reducer.js';
import type { Acc } from './reducer.js';
import { turnForPrompt } from './fixtures.js';
import type { ScriptedTurn } from './fixtures.js';
import type { ExtSessionUpdate } from './types/ext.js';
import type { SessionUpdate } from './types/acp.js';
import type {
	AvailableCommand,
	ContextUsage,
	GraphState,
	ModelOption,
	PermissionRequest,
	PlanArtifact,
	Session,
	TodoItem,
	Turn,
	WorkspaceInfo
} from './types.js';

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
}

export interface SessionStore {
	readonly workspace: WorkspaceInfo;
	readonly sessions: Session[];
	readonly turns: Turn[];
	readonly models: ModelOption[];
	/** Absent when the agent has no graph running. */
	readonly graph: GraphState | undefined;
	readonly context: ContextUsage;
	readonly activeSessionId: string;
	readonly activeSession: Session;
	readonly model: string;
	readonly effort: string;
	readonly busy: boolean;
	/** A parked permission request, if the agent is waiting on the user. */
	readonly permission: PermissionRequest | undefined;
	/** The plan artifact awaiting approval, if the agent asked for one. */
	readonly plan: PlanArtifact | undefined;
	/** The agent's plan, from the ACP `plan` update. */
	readonly todos: TodoItem[];
	/** Slash commands the agent advertised. */
	readonly commands: AvailableCommand[];

	selectSession(id: string): void;
	setModel(id: string): void;
	setEffort(effort: string): void;
	send(text: string): void;
	cancel(): void;
	clear(): void;
	/** Answer the parked permission request. */
	answerPermission(optionId: string): void;
}

const STREAM_TICK_MS = 24;

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
}

export class HarnessStore implements SessionStore {
	workspace = $state(workspace);
	sessions = $state(sessions);
	models = $state(models);
	context = $state(contextUsage);

	activeSessionId = $state(sessions[0].id);
	model = $state(models[0].id);
	effort = $state('high');
	busy = $state(false);

	/** The folded transcript per session; only the first one is scripted. */
	private accs = $state<Record<string, Acc>>({ [sessions[0].id]: initialTranscript() });

	constructor(private transport: Transport = new FixtureTransport()) {}

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

	get plan(): PlanArtifact | undefined {
		return this.planArtifact;
	}

	/** The `alnair/exit_plan_mode` request the agent is waiting on, if any. */
	private planArtifact = $state<PlanArtifact | undefined>(initialPlan);

	get commands(): AvailableCommand[] {
		return this.acc.commands ?? [];
	}

	selectSession(id: string) {
		if (!this.sessions.some((session) => session.id === id)) return;
		this.transport.stop();
		this.busy = false;
		this.activeSessionId = id;
		const session = this.sessions.find((s) => s.id === id);
		if (session?.modelId) this.model = session.modelId;
		// Only the scripted session has a plan awaiting approval.
		this.planArtifact = id === sessions[0].id ? initialPlan : undefined;
	}

	setModel(id: string) {
		const next = this.models.find((model) => model.id === id);
		if (!next) return;
		this.model = id;
		if (next.efforts.length > 0 && !next.efforts.includes(this.effort)) {
			this.effort = next.efforts[Math.min(1, next.efforts.length - 1)];
		}
	}

	setEffort(effort: string) {
		this.effort = effort;
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
		const id = `perm-${toolCallId}`;
		const acc = this.acc;
		const turn = acc.turns.find((candidate) => candidate.parts.some((part) => part.id === id));
		if (!turn) return;
		this.write({
			...acc,
			turns: acc.turns.map((candidate) =>
				candidate.id === turn.id
					? {
							...candidate,
							parts: candidate.parts.map((part) =>
								part.id === id && part.kind === 'permission' ? { ...part, resolved: true } : part
							)
						}
					: candidate
			)
		});
	}

	private receive(sessionId: string, frame: IncomingFrame) {
		if (sessionId !== this.activeSessionId) return;

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
			return;
		}

		const update = frame.params.update as Record<string, unknown> | undefined;
		if (!update) return;

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
