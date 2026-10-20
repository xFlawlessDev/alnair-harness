import {
	contextUsage,
	graph,
	models,
	planDocument,
	sessions,
	todos,
	turns,
	workspace
} from './mock.js';
import type {
	ContextUsage,
	GraphState,
	ModelOption,
	PlanDocument,
	Session,
	TodoItem,
	Turn,
	TurnPart,
	WorkspaceInfo
} from './types.js';

/**
 * The seam.
 *
 * Components talk to this interface only. `MockSessionStore` fills it in today;
 * the harness adapter will implement the same surface over ACP session updates,
 * and no component has to change.
 */
export interface SessionStore {
	readonly workspace: WorkspaceInfo;
	readonly sessions: Session[];
	readonly turns: Turn[];
	readonly models: ModelOption[];
	readonly graph: GraphState;
	readonly context: ContextUsage;
	readonly activeSessionId: string;
	readonly activeSession: Session;
	readonly model: string;
	readonly effort: string;
	readonly busy: boolean;
	/** The agent's todo list for the current turn; empty when it has none. */
	readonly todos: TodoItem[];
	/** The plan the agent is working from, if it wrote one. */
	readonly plan: PlanDocument | null;

	selectSession(id: string): void;
	setModel(id: string): void;
	setEffort(effort: string): void;
	send(text: string): void;
	cancel(): void;
	clear(): void;
}

const STREAM_TICK_MS = 28;

/** A canned reply so the composer does something without a backend. */
const REPLY: TurnPart[] = [
	{
		kind: 'reasoning',
		id: 'mock-r1',
		status: 'running',
		text: 'This is a mocked reply. The store streams it part by part so the thread, the trace rows and the scroll anchor can be exercised without a backend.'
	},
	{
		kind: 'text',
		id: 'mock-t1',
		text: ''
	}
];

const REPLY_BODY =
	'Mocked reply. Once the harness adapter lands, this text comes from the sampler and the trace rows fill in from tool calls.';

export class MockSessionStore implements SessionStore {
	workspace = $state(workspace);
	sessions = $state(sessions);
	models = $state(models);
	graph = $state(graph);
	context = $state(contextUsage);
	todos = $state<TodoItem[]>(todos);
	plan = $state<PlanDocument | null>(planDocument);

	/** Only the first session has a scripted transcript; the rest open empty. */
	private transcripts = $state<Record<string, Turn[]>>({ [sessions[0].id]: turns });

	activeSessionId = $state(sessions[0].id);
	model = $state(models[0].id);
	effort = $state('high');
	busy = $state(false);

	private timers = new Set<ReturnType<typeof setTimeout>>();

	get activeSession(): Session {
		return this.sessions.find((s) => s.id === this.activeSessionId) ?? this.sessions[0];
	}

	get turns(): Turn[] {
		return this.transcripts[this.activeSessionId] ?? [];
	}

	get activeModel(): ModelOption {
		return this.models.find((m) => m.id === this.model) ?? this.models[0];
	}

	selectSession(id: string) {
		const next = this.sessions.find((s) => s.id === id);
		if (!next) return;
		this.activeSessionId = id;
		this.model = this.models.find((m) => m.id === next.model)?.id ?? this.model;
		this.busy = false;
		// Only the scripted session has a todo list and a plan; the rest are empty.
		const scripted = id === sessions[0].id;
		this.todos = scripted ? todos : [];
		this.plan = scripted ? planDocument : null;
	}

	setModel(id: string) {
		const next = this.models.find((m) => m.id === id);
		if (!next) return;
		this.model = id;
		if (!next.efforts.includes(this.effort)) {
			this.effort = next.efforts[Math.min(1, next.efforts.length - 1)];
		}
	}

	setEffort(effort: string) {
		this.effort = effort;
	}

	send(text: string) {
		const trimmed = text.trim();
		if (!trimmed || this.busy) return;

		const stamp = new Date().toISOString();
		const sessionId = this.activeSessionId;
		const userTurn: Turn = {
			id: `u-${Date.now()}`,
			role: 'user',
			status: 'complete',
			at: stamp,
			parts: [{ kind: 'text', id: `u-${Date.now()}-p`, text: trimmed }]
		};

		const assistantId = `a-${Date.now()}`;
		const assistantTurn: Turn = {
			id: assistantId,
			role: 'assistant',
			status: 'streaming',
			at: stamp,
			model: this.activeModel.label,
			effort: this.effort,
			parts: REPLY.map((part) => ({ ...part, id: `${assistantId}-${part.id}` }))
		};

		this.write(sessionId, [...this.turns, userTurn, assistantTurn]);
		this.busy = true;
		this.markSession(sessionId, { status: 'running', updatedAt: stamp });

		this.runMockStream(sessionId, assistantId);
	}

	cancel() {
		if (!this.busy) return;
		const sessionId = this.activeSessionId;
		this.clearTimers();

		const last = this.turns.at(-1);
		if (last?.role === 'assistant') {
			this.write(
				sessionId,
				this.turns.map((turn) =>
					turn.id === last.id
						? {
								...turn,
								status: 'cancelled',
								parts: turn.parts.map((part) =>
									'status' in part && part.status === 'running'
										? { ...part, status: 'complete' }
										: part
								)
							}
						: turn
				)
			);
		}

		this.busy = false;
		this.markSession(sessionId, { status: 'idle' });
	}

	clear() {
		this.clearTimers();
		this.write(this.activeSessionId, []);
		this.busy = false;
	}

	/** Restores the scripted transcript; used by the empty-state action. */
	reset() {
		this.clearTimers();
		this.write(this.activeSessionId, turns);
		this.busy = false;
	}

	private write(sessionId: string, next: Turn[]) {
		this.transcripts = { ...this.transcripts, [sessionId]: next };
	}

	private markSession(sessionId: string, patch: Partial<Session>) {
		this.sessions = this.sessions.map((session) =>
			session.id === sessionId ? { ...session, ...patch } : session
		);
	}

	private clearTimers() {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}

	private later(fn: () => void, ms: number) {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			fn();
		}, ms);
		this.timers.add(timer);
	}

	/**
	 * Streams the canned reply: reasoning first, then the text, word by word.
	 * Deliberately dumb — it exists to make the UI move.
	 */
	private runMockStream(sessionId: string, assistantId: string) {
		// Part ids are namespaced per turn, so the patch keys match what was rendered.
		const reasoningId = `${assistantId}-mock-r1`;
		const textId = `${assistantId}-mock-t1`;

		this.later(() => {
			this.patch(sessionId, assistantId, reasoningId, (part) =>
				part.kind === 'reasoning' ? { ...part, status: 'complete', durationMs: 1_400 } : part
			);
		}, 900);

		const words = REPLY_BODY.split(' ');
		words.forEach((_, index) => {
			this.later(
				() => {
					this.patch(sessionId, assistantId, textId, (part) =>
						part.kind === 'text' ? { ...part, text: words.slice(0, index + 1).join(' ') } : part
					);
				},
				1_000 + index * STREAM_TICK_MS
			);
		});

		this.later(
			() => {
				this.write(
					sessionId,
					(this.transcripts[sessionId] ?? []).map((turn) =>
						turn.id === assistantId
							? {
									...turn,
									status: 'complete',
									durationMs: 1_000 + words.length * STREAM_TICK_MS
								}
							: turn
					)
				);
				this.busy = false;
				this.markSession(sessionId, { status: 'idle' });
			},
			1_000 + words.length * STREAM_TICK_MS + 300
		);
	}

	private patch(
		sessionId: string,
		turnId: string,
		partId: string,
		fn: (part: TurnPart) => TurnPart
	) {
		this.write(
			sessionId,
			(this.transcripts[sessionId] ?? []).map((turn) =>
				turn.id === turnId
					? { ...turn, parts: turn.parts.map((part) => (part.id === partId ? fn(part) : part)) }
					: turn
			)
		);
	}
}
