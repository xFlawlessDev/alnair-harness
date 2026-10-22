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

import type { AskUserQuestionResponse, SubagentLiveSnapshot } from './types/ext.js';
import type { IncomingFrame, PlanOutcome, Transport } from './session-store.svelte.js';
import type {
	BranchEntry,
	ContextUsage,
	FileEntry,
	GitContext,
	ModelOption,
	Session,
	SubagentSummary,
	WorktreeEntry
} from './types.js';
import {
	accessFromSession,
	branchesFromWire,
	contextFromInfo,
	entriesFromNodes,
	lastSegment,
	modelsFromState,
	sessionsFromRoster,
	unwrapExt,
	worktreesFromWire,
	type FsNode,
	type RosterRow
} from './wire.js';
import { fromLive } from './subagents.js';

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
	 *
	 * `cwd` must be the session's OWN directory, not the pager's: the agent
	 * resolves the session directory from `(id, cwd)` and rejects a relative or
	 * empty path outright ("Path is not absolute"), so a bare id is not enough.
	 */
	async openSession(sessionId: string, cwd?: string): Promise<SessionOpenResult> {
		this.activeSessionId = sessionId;
		const sessionCwd = cwd ?? this.cwd ?? '';
		const result = (await this.request('session/load', {
			sessionId,
			cwd: sessionCwd,
			mcpServers: []
		})) as { models?: unknown; _meta?: Record<string, unknown> } | undefined;

		// Close the replay window. The store opened it before the request went
		// out, so every frame until now applied unconditionally; without this
		// the gate would stay in `replay` for the session's whole life and the
		// watermark would never arm — a reconnect would then replay the whole
		// transcript on top of one that already holds it.
		//
		// The leader forwards buffered live frames AFTER this response, so they
		// are compared against the watermark the replay just established.
		this.frameSink?.(sessionId, { method: 'session/load:result', params: {} });

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
	 *
	 * The handler answers `SessionInfoResponse` — `{ sessionId, cwd, ...data }`,
	 * where `SessionInfoData` is `#[serde(flatten)]`ed, so `context` sits at the
	 * TOP level of the result and there is no `data` wrapper on the wire.
	 */
	async sessionContext(sessionId: string): Promise<ContextUsage | undefined> {
		const raw = await this.ext('alnair/session/info', { sessionId });
		const payload = unwrapExt<Record<string, unknown>>(raw);
		if (!payload) return undefined;
		// An unknown session id answers `{}`; a context is what makes it real.
		const context = payload.context as Record<string, unknown> | undefined;
		return context ? contextFromInfo(context) : undefined;
	}

	/**
	 * One directory of the workspace, for the composer's `@` menu.
	 *
	 * Paths come back as the agent reports them (absolute). The store re-roots
	 * them at the workspace, because a mention token must be relative: the
	 * agent's own tools resolve `@src/x.ts`, not `@/home/me/repo/src/x.ts`.
	 */
	async fsList(path: string, sessionId: string): Promise<FileEntry[]> {
		const raw = await this.ext('alnair/fs/list', { path, sessionId });
		const payload = unwrapExt<{ nodes?: FsNode[] }>(raw);
		return entriesFromNodes(payload?.nodes ?? []);
	}

	/**
	 * Fuzzy path search across the workspace.
	 *
	 * Unlike `fsList` (one directory at a time), this ranks the whole tree, so
	 * the `@` menu can offer a match from any depth without drilling. The agent
	 * keeps the walk alive between calls; `done: false` means it is still
	 * streaming and another call will return more.
	 */
	async fsSearch(request: {
		sessionId: string;
		path?: string;
		query: string;
		limit?: number;
		dirs?: boolean;
	}): Promise<FileEntry[]> {
		const raw = await this.ext('alnair/fs/search', {
			sessionId: request.sessionId,
			...(request.path ? { path: request.path } : {}),
			query: request.query,
			...(request.limit ? { limit: request.limit } : {}),
			...(request.dirs ? { dirs: true } : {})
		});
		const payload = unwrapExt<{ results?: { path?: unknown; type?: unknown }[] }>(raw);
		return (payload?.results ?? [])
			.map((hit): FileEntry | undefined => {
				const path = typeof hit.path === 'string' ? hit.path : '';
				if (!path) return undefined;
				return {
					name: lastSegment(path),
					path,
					type: hit.type === 'directory' ? 'directory' : 'file'
				};
			})
			.filter((entry): entry is FileEntry => entry !== undefined);
	}

	/** Subagents running under a session right now. */
	async listSubagents(sessionId: string): Promise<SubagentSummary[]> {
		const raw = await this.ext('alnair/subagent/list_running', { sessionId });
		const payload = unwrapExt<{ subagents?: SubagentLiveSnapshot[] }>(raw);
		return (payload?.subagents ?? []).map(fromLive);
	}

	// --- Transport: workspace administration --------------------------------

	/**
	 * Rename a session.
	 *
	 * `alnair/session/rename` writes the manual title to the session's summary
	 * and broadcasts `session_summary_generated`, so the TUI's list updates too.
	 * The title is rejected when blank (`Summary.title_is_manual` binds to a real
	 * title), which is why the caller trims before sending.
	 */
	async renameSession(sessionId: string, title: string, cwd?: string): Promise<void> {
		await this.ext('alnair/session/rename', {
			sessionId,
			title,
			...(cwd ? { cwd } : {})
		});
	}

	/**
	 * Delete a session's history.
	 *
	 * This removes the transcript from disk and evicts it from the search index;
	 * a live actor for the id is shut down first, so deleting the session you
	 * are looking at is legal. The caller must then pick another session.
	 */
	async deleteSession(sessionId: string, cwd?: string): Promise<void> {
		await this.ext('alnair/session/delete', {
			sessionId,
			...(cwd ? { cwd } : {})
		});
	}

	/**
	 * The repository behind a session.
	 *
	 * `alnair/git/info` resolves the git root from the session's cwd, so the
	 * caller does not have to know whether it is a worktree. A session outside a
	 * repo answers with an error, which the store treats as "no git context".
	 */
	async gitInfo(sessionId: string): Promise<GitContext | undefined> {
		const raw = await this.ext('alnair/git/info', { sessionId });
		const payload = unwrapExt<{
			root?: unknown;
			currentBranch?: unknown;
			current_branch?: unknown;
			defaultBranch?: unknown;
			default_branch?: unknown;
			remotes?: unknown;
		}>(raw);
		if (!payload || typeof payload.root !== 'string' || !payload.root) return undefined;

		const branch =
			typeof payload.currentBranch === 'string'
				? payload.currentBranch
				: typeof payload.current_branch === 'string'
					? payload.current_branch
					: undefined;
		const defaultBranch =
			typeof payload.defaultBranch === 'string'
				? payload.defaultBranch
				: typeof payload.default_branch === 'string'
					? payload.default_branch
					: undefined;
		const remotes = Array.isArray(payload.remotes)
			? payload.remotes.filter((value): value is string => typeof value === 'string')
			: [];

		return { root: payload.root, branch, defaultBranch, remotes };
	}

	/** Every branch in the session's repo, local and remote-tracking. */
	async gitBranches(sessionId: string): Promise<BranchEntry[]> {
		const raw = await this.ext('alnair/git/branches', { sessionId });
		return branchesFromWire(raw).branches;
	}

	/**
	 * Check out a branch.
	 *
	 * `create: true` makes a new branch at the current HEAD; checking out a
	 * remote-tracking ref needs the same flag with the remote prefix stripped,
	 * which is the caller's decision (it knows what the user picked).
	 */
	async gitCheckout(sessionId: string, branch: string, create = false): Promise<void> {
		await this.ext('alnair/git/checkout', { sessionId, branch, create });
	}

	/**
	 * The worktrees registered for a repo.
	 *
	 * `alnair/git/worktree/list` takes the REPO root, not a session id — unlike
	 * the other `alnair/git/*` methods, which resolve the root from the session.
	 * The caller reads it from `alnair/git/info`.
	 */
	async gitWorktrees(repo?: string): Promise<WorktreeEntry[]> {
		if (!repo) return [];
		const raw = await this.ext('alnair/git/worktree/list', { repo });
		return worktreesFromWire(raw);
	}

	/**
	 * Create a worktree and return its path.
	 *
	 * The agent answers `{ status: 'creating', worktreePath }` and copies ignored
	 * files in the background, so the path is usable immediately. The caller
	 * then starts a session there — this method does not.
	 */
	async gitCreateWorktree(request: {
		sessionId: string;
		sourcePath: string;
		gitRef?: string;
		label?: string;
	}): Promise<string> {
		const raw = await this.ext('alnair/git/worktree/create', {
			sessionId: request.sessionId,
			sourcePath: request.sourcePath,
			...(request.gitRef ? { gitRef: request.gitRef } : {}),
			...(request.label ? { label: request.label } : {})
		});
		const payload = unwrapExt<{ worktreePath?: unknown; status?: unknown }>(raw);
		const path = typeof payload?.worktreePath === 'string' ? payload.worktreePath : '';
		if (!path) throw new Error('the agent did not return a worktree path');
		return path;
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

	/**
	 * Switch the session's model.
	 *
	 * The method is `session/set_model`, not `session/setModel`: ACP names the
	 * model switch with an underscore (the leader's own `AGENT_METHOD_NAMES`
	 * agrees), and the camelCase spelling is answered "Method not found".
	 *
	 * The effort rides in `_meta.reasoningEffort`, which is where
	 * `parse_reasoning_effort_meta` reads it. It is a per-session override, so
	 * it is sent only when the caller named one.
	 */
	setModel(modelId: string, effort?: string): void {
		const sessionId = this.activeSessionId;
		if (!sessionId) return;
		void this.request('session/set_model', {
			sessionId,
			modelId,
			...(effort ? { _meta: { reasoningEffort: effort } } : {})
		}).catch(() => {
			// A rejected switch is surfaced by `model_changed` not arriving.
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

	/**
	 * Fold a notification into the store's frame stream.
	 *
	 * Every notification the agent sends for a session carries a FLAT `params`
	 * with `sessionId` and `update`, whichever method it arrives under:
	 *
	 * - `session/update` — the ACP rail.
	 * - `_alnair/session/update` — the extension rail. The `_` is only the
	 *   gateway's extension marker; the params are not nested one level down.
	 *   A live replay confirmed this: `params` is `{ sessionId, update, _meta }`.
	 *
	 * The method name is passed through verbatim, because the reducer branches
	 * on it to choose the ACP or extension decoder. Rewriting it (or looking for
	 * nested params) silently discards the frame.
	 */
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

		// A model switch made elsewhere (the TUI, another tab) rides this rail
		// rather than `session/update`. It is an extension update, so the store
		// routes it to the extension decoder by method name.
		if (message.method === 'alnair/session_notification') {
			const sessionId = String(params.sessionId ?? '');
			if (!sessionId || !params.update) return;
			this.frameSink?.(sessionId, { method: message.method, params });
			return;
		}

		if (!message.method) return;

		const sessionId = String(params.sessionId ?? params.session_id ?? '');
		if (!sessionId) return;

		// `update` is required for the reducer; anything else is a notification
		// the store has no arm for, and passing it on would be a no-op with
		// extra steps.
		if (!params.update) return;
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
	 * These go out with the `_` prefix and **flat** params. The ACP decoder
	 * strips the prefix and hands the whole `params` object to the handler, so
	 * nesting `{ method, params }` one level down leaves the handler with no
	 * fields of its own. Verified against a live leader: `_alnair/fs/list` with
	 * a flat `{ path }` returns the listing, and the nested form is rejected
	 * with `invalid params: missing field 'path'`.
	 *
	 * (A method that ignores unknown fields, like `sessions/list`, answers
	 * either way — which is exactly how this bug hid.)
	 */
	private ext(method: string, params: Record<string, unknown>): Promise<unknown> {
		return this.request(`_${method}`, params);
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
