/**
 * The socket transport: JSON-RPC over `/ws`, served by `alnair web`.
 *
 * This is the piece the harness was built for. Everything below it is the same
 * reducer the fixture transport feeds, so no component changes.
 *
 * Two design points worth knowing:
 *
 * - **Ids.** Every request gets a local numeric id. The leader rewrites ids on
 *   the way to the agent and restores them on the way back, so a small counter
 *   is safe and keeps response matching trivial.
 * - **Reconnect.** When the bridge says the leader relaunched
 *   (`alnair/leader_reconnected`) the transport re-handshakes and re-loads the
 *   active session. The store resets its accumulator on `openSession`, so the
 *   replay rebuilds the transcript instead of doubling it. This is why the
 *   bridge does not replay server-side, unlike the stdio bridge for IDE clients.
 */

import type { AskUserQuestionResponse } from './types/ext.js';
import type { IncomingFrame, PlanOutcome, Transport } from './session-store.svelte.js';
import type { ContextUsage, ModelOption, Session } from './types.js';
import {
	accessFromSession,
	contextFromInfo,
	modelsFromState,
	sessionsFromRoster,
	unwrapExt,
	type RosterRow
} from './wire.js';

/** What `session/load` (or `session/new`) told us about the session. */
export interface SessionOpenResult {
	models: ModelOption[];
	currentModel?: string;
	access?: 'ask' | 'auto' | 'always-approve';
}

/** A JSON-RPC message, loosely typed: the wire is the contract. */
type Rpc = {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

/** How long a request may wait before it is rejected. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Backoff for reconnecting to the *local* server (not the leader). */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export class WebSocketTransport implements Transport {
	private socket: WebSocket | undefined;
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (e: Error) => void }
	>();

	/** The session the user is looking at, so a reconnect can reload it. */
	private activeSessionId: string | undefined;
	/** Whether `initialize` has completed on the current socket. */
	private ready = false;

	private frameSink: ((sessionId: string, frame: IncomingFrame) => void) | undefined;
	private reconnectedSink: (() => void) | undefined;
	private rosterSink: ((delta: { upserted?: unknown[]; removed?: string[] }) => void) | undefined;

	/** Backoff state for the local-server reconnect loop. */
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private closedByUs = false;

	constructor(
		/** Opens a fresh socket. A closed socket cannot be reopened, so the
		 * transport asks for a new one on every reconnect. */
		private readonly connectSocket: () => WebSocket,
		/** Where the agent should create sessions; the leader resolves it. */
		private readonly cwd: string = ''
	) {}

	// --- Transport: lifecycle ------------------------------------------------

	onFrame(sink: (sessionId: string, frame: IncomingFrame) => void) {
		this.frameSink = sink;
	}

	onReconnected(sink: () => void) {
		this.reconnectedSink = sink;
	}

	async connect(): Promise<void> {
		await this.openSocket();
		await this.initialize();
	}

	/**
	 * The roster, from `alnair/sessions/list`.
	 *
	 * Rows are snake_case (see `alnair-shell/src/agent/roster.rs`); the store's
	 * `Session` is the view model, so the mapping lives here.
	 */
	async listSessions(): Promise<Session[]> {
		const raw = await this.ext('alnair/sessions/list', {});
		const payload =
			unwrapExt<{ sessions?: RosterRow[] }>(raw) ?? (raw as { sessions?: RosterRow[] });
		return sessionsFromRoster(payload.sessions ?? []);
	}

	/**
	 * Attach to a session.
	 *
	 * `session/load` makes this client a subscriber: the leader then broadcasts
	 * every delta of the running turn here, and replays the transcript first
	 * with `isReplay: true`. The store has already reset its accumulator.
	 *
	 * The response carries the session's model catalog and mode state, which is
	 * where the composer's picker and access control come from.
	 */
	async openSession(sessionId: string): Promise<SessionOpenResult> {
		this.activeSessionId = sessionId;
		const result = (await this.request('session/load', {
			sessionId,
			cwd: this.cwd,
			mcpServers: []
		})) as { models?: unknown; _meta?: Record<string, unknown> } | undefined;

		const { models, current } = modelsFromState(result?.models);
		const meta = result?._meta ?? {};
		return {
			models,
			currentModel: current,
			access: accessFromSession(meta.yoloMode, meta.autoMode)
		};
	}

	async newSession(cwd: string): Promise<string> {
		const result = (await this.request('session/new', {
			cwd,
			mcpServers: []
		})) as { sessionId?: string };
		if (!result.sessionId) throw new Error('session/new returned no session id');
		return result.sessionId;
	}

	/**
	 * The context snapshot.
	 *
	 * `alnair/session/info` is the only place the exact totals live; the stream
	 * only carries `auto_compact_*` deltas. Read once on attach and on demand.
	 * The payload nests `context` under `data` in the Rust struct but the ext
	 * response flattens `data` onto the result, so both are accepted.
	 */
	async sessionContext(sessionId: string): Promise<ContextUsage | undefined> {
		const raw = await this.ext('alnair/session/info', { sessionId });
		const payload = unwrapExt<Record<string, unknown>>(raw);
		if (!payload) return undefined;
		const context =
			(payload.context as Record<string, unknown> | undefined) ??
			(payload.data as { context?: Record<string, unknown> } | undefined)?.context;
		return context ? contextFromInfo(context) : undefined;
	}

	// --- Transport: turns ----------------------------------------------------

	/**
	 * Send a prompt.
	 *
	 * Frames arrive through the frame sink, not this callback: a prompt is
	 * fire-and-forget here because the response only carries the stop reason,
	 * and the transcript is built from the broadcast stream.
	 */
	send(prompt: string): void {
		const sessionId = this.activeSessionId;
		if (!sessionId) return;
		void this.request('session/prompt', {
			sessionId,
			prompt: [{ type: 'text', text: prompt }]
		})
			.then((result) => {
				const stopReason = (result as { stopReason?: string }).stopReason ?? 'end_turn';
				this.frameSink?.(sessionId, {
					method: 'session/prompt:result',
					params: { stopReason }
				});
			})
			.catch(() => {
				// The turn ended without a response (disconnect, cancel). The
				// broadcast `turn_completed` is authoritative; nothing to do.
			});
	}

	cancelTurn(): void {
		const sessionId = this.activeSessionId;
		if (!sessionId) return;
		// A notification, not a request: `session/cancel` has no response.
		this.notify('session/cancel', { sessionId });
	}

	/**
	 * `stop` only detaches the local stream.
	 *
	 * Cancelling the turn is `cancelTurn`; the store calls both, because a
	 * viewer stopping its view must not silently kill work the TUI is driving
	 * any more than it must leave a turn running when the user asked to stop.
	 */
	stop(): void {
		// Nothing to unwind: frames keep arriving on the shared socket, and the
		// store ignores sessions it is not showing.
	}

	setModel(modelId: string, effort?: string): void {
		const sessionId = this.activeSessionId;
		if (!sessionId) return;
		void this.request('session/setModel', {
			sessionId,
			modelId,
			...(effort ? { _meta: { reasoningEffort: effort } } : {})
		}).catch(() => {
			// A rejected model switch is surfaced by `model_changed` not arriving.
		});
	}

	/**
	 * Change the runtime permission mode.
	 *
	 * A notification, not a request: `alnair/yolo_mode_changed` is what the TUI
	 * sends too, and the agent fans the new mode out to matching sessions. The
	 * leader's `extract_yolo_mode_change` reads it to keep the client's own
	 * capabilities in step, so `session/new` created later inherits it.
	 */
	setAccess(mode: 'ask' | 'auto' | 'always-approve'): void {
		this.notify('alnair/yolo_mode_changed', {
			permission_mode: mode,
			yolo_mode: mode === 'always-approve',
			auto_mode: mode === 'auto',
			...(this.activeSessionId ? { sessionId: this.activeSessionId } : {})
		});
	}

	/**
	 * A stored transcript (`alnair/session/updates`).
	 *
	 * Each element is the storage envelope — `{ timestamp, method, params }` —
	 * which is exactly what the reducer's `replay()` folds.
	 */
	async sessionUpdates(request: {
		sessionId: string;
		cwd: string;
	}): Promise<{ method: string; params?: unknown; timestamp?: string }[] | undefined> {
		const raw = await this.ext('alnair/session/updates', {
			sessionId: request.sessionId,
			cwd: request.cwd
		});
		const payload = unwrapExt<{
			updates?: { method: string; params?: unknown; timestamp?: string }[];
		}>(raw);
		return payload?.updates;
	}

	/** Subscribe to the machine-wide roster deltas. */
	onRosterChanged(sink: (delta: { upserted?: unknown[]; removed?: string[] }) => void): void {
		this.rosterSink = sink;
	}

	// --- Transport: parked interactions --------------------------------------

	/**
	 * Answer a permission request.
	 *
	 * These arrive as reverse requests carrying an `id`; the answer is the
	 * response to that same id, so it is sent as a result, not a new request.
	 */
	respond(toolCallId: string, optionId: string): void {
		this.respondToParked(toolCallId, {
			outcome: { outcome: 'selected', optionId }
		});
	}

	respondQuestions(toolCallId: string, response: AskUserQuestionResponse): void {
		this.respondToParked(toolCallId, response);
	}

	respondPlan(toolCallId: string, outcome: PlanOutcome): void {
		this.respondToParked(toolCallId, { outcome });
	}

	/**
	 * Reverse requests are keyed by tool call id, but JSON-RPC needs the
	 * request id. The store only knows the former, so the transport remembers
	 * the pairing when the request arrived.
	 */
	private parked = new Map<string, number>();

	private respondToParked(toolCallId: string, result: unknown) {
		const id = this.parked.get(toolCallId);
		if (id === undefined) return;
		this.parked.delete(toolCallId);
		this.sendRaw({ jsonrpc: '2.0', id, result });
	}

	// --- wire plumbing -------------------------------------------------------

	private async openSocket(): Promise<void> {
		const socket = this.connectSocket();
		this.socket = socket;

		if (socket.readyState === WebSocket.OPEN) return;

		await new Promise<void>((resolve, reject) => {
			socket.addEventListener('open', () => resolve(), { once: true });
			socket.addEventListener('error', () => reject(new Error('websocket failed')), {
				once: true
			});
		});

		socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
		socket.addEventListener('close', () => this.onClose());
	}

	/** ACP handshake. Idempotent: re-run after a leader relaunch. */
	private async initialize(): Promise<void> {
		await this.request('initialize', {
			protocolVersion: 1,
			// The browser has no filesystem or terminal to offer, so the agent
			// must use its own. Claiming these would route tool calls here and
			// they would hang.
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false
			}
		});
		this.ready = true;
	}

	private onMessage(raw: string) {
		let message: Rpc;
		try {
			message = JSON.parse(raw) as Rpc;
		} catch {
			return;
		}

		// A response to one of our requests.
		if (message.id !== undefined && message.method === undefined) {
			const id = typeof message.id === 'number' ? message.id : Number(message.id);
			const waiter = this.pending.get(id);
			if (!waiter) return;
			this.pending.delete(id);
			if (message.error) waiter.reject(new Error(message.error.message));
			else waiter.resolve(message.result);
			return;
		}

		// A reverse request: the agent is blocked until we answer.
		if (message.method && message.id !== undefined) {
			this.onReverseRequest(message);
			return;
		}

		// A notification.
		if (message.method === 'alnair/leader_reconnected') {
			void this.rehandshake();
			return;
		}

		this.dispatch(message);
	}

	/** Fold a notification into the store's frame stream. */
	private dispatch(message: Rpc) {
		const params = (message.params ?? {}) as Record<string, unknown>;

		// Machine-wide roster delta: no session id, and the sidebar owns it.
		if (message.method === 'alnair/sessions/changed') {
			this.rosterSink?.({
				upserted: Array.isArray(params.upserted) ? params.upserted : [],
				removed: Array.isArray(params.removed)
					? params.removed.filter((id): id is string => typeof id === 'string')
					: []
			});
			return;
		}

		// Ext notifications arrive wrapped: the real method and params sit one
		// level down under `params`. Unwrap so the store sees one shape.
		if (message.method?.startsWith('_')) {
			const inner = (params.params ?? {}) as Record<string, unknown>;
			const sessionId = String(inner.sessionId ?? params.sessionId ?? '');
			if (!sessionId) return;
			this.frameSink?.(sessionId, {
				method: inner.method ? `_${inner.method}` : (message.method ?? ''),
				params: inner
			});
			return;
		}

		const sessionId = String(params.sessionId ?? params.session_id ?? '');
		if (!sessionId || !message.method) return;
		this.frameSink?.(sessionId, { method: message.method, params });
	}

	private onReverseRequest(message: Rpc) {
		const method = message.method ?? '';
		const params = (message.params ?? {}) as Record<string, unknown>;
		const sessionId = String(params.sessionId ?? '');
		// A permission request nests the call under `toolCall`; the ext methods
		// (`ask_user_question`, `exit_plan_mode`) carry `toolCallId` directly.
		const toolCall = params.toolCall as Record<string, unknown> | undefined;
		const toolCallId = String(
			params.toolCallId ?? params.tool_call_id ?? toolCall?.toolCallId ?? toolCall?.id ?? ''
		);

		if (toolCallId) this.parked.set(toolCallId, Number(message.id));
		if (!sessionId) return;
		this.frameSink?.(sessionId, { method, params });
	}

	/** Re-run the handshake after the leader relaunched, then reload. */
	private async rehandshake() {
		this.ready = false;
		// Requests in flight belong to the old leader; fail them rather than
		// leaving the UI waiting on a response that can never arrive.
		for (const [, waiter] of this.pending) {
			waiter.reject(new Error('leader reconnected'));
		}
		this.pending.clear();
		this.parked.clear();

		await this.initialize();
		this.reconnectedSink?.();
	}

	private onClose() {
		this.socket = undefined;
		this.ready = false;
		for (const [, waiter] of this.pending) {
			waiter.reject(new Error('socket closed'));
		}
		this.pending.clear();

		if (this.closedByUs) return;
		this.scheduleReconnect();
	}

	private scheduleReconnect() {
		if (this.reconnectTimer !== undefined) return;
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect()
				.then(() => {
					this.reconnectAttempt = 0;
					this.reconnectedSink?.();
				})
				.catch(() => this.scheduleReconnect());
		}, delay);
	}

	/** Close the socket without scheduling a reconnect. */
	close() {
		this.closedByUs = true;
		if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
		this.socket?.close();
		this.socket = undefined;
	}

	private request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return;
				reject(new Error(`${method} timed out`));
			}, REQUEST_TIMEOUT_MS);

			// The timer must fire against the same entry the response resolves,
			// so it is cleared inside the settle wrappers rather than alongside
			// a second `pending.set`.
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				}
			});
			this.sendRaw({ jsonrpc: '2.0', id, method, params });
		});
	}

	private notify(method: string, params: Record<string, unknown>) {
		this.sendRaw({ jsonrpc: '2.0', method, params });
	}

	/**
	 * Call an `alnair/*` extension method.
	 *
	 * These must go out **wrapped**: the gateway routes a top-level
	 * `_alnair/<name>` method and reads the real method plus params one level
	 * down. A plain `alnair/<name>` request is answered "Method not found" —
	 * verified against a live leader, where the plain form failed and this one
	 * returned the roster.
	 */
	private ext(method: string, params: Record<string, unknown>): Promise<unknown> {
		return this.request(`_${method}`, { method, params });
	}

	private sendRaw(message: Rpc) {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		this.socket.send(JSON.stringify(message));
	}

	/** Whether the handshake has completed; useful for a connection banner. */
	get isReady() {
		return this.ready;
	}
}
