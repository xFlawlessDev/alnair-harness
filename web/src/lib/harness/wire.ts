/**
 * Wire → view model.
 *
 * Every function here is pure and total: given what the agent actually sends,
 * produce what the UI renders, or `undefined` when the wire carries less. No
 * defaults are invented — a missing field stays missing, and the component
 * decides how to render less. That rule is why this file is separate from the
 * transport: the transport owns sockets and ids, this owns shapes.
 *
 * Sources, so a future field can be checked rather than guessed:
 * - roster: `alnair-shell/src/agent/roster.rs` (`RosterEntry`, snake_case)
 * - session info: `alnair-shell/src/session/acp_types.rs` (`ContextInfo`)
 * - model state: `agent-client-protocol-schema` (`SessionModelState`,
 *   `ModelInfo` — camelCase)
 * - session list: `alnair-shell/src/agent/handlers/session.rs`
 */

import type {
	AccessMode,
	ContextCategory,
	ContextUsage,
	FileEntry,
	ModelOption,
	Session,
	SessionStatus
} from './types.js';

/** The ext-response envelope: `{ result, error }`. */
interface ExtEnvelope<T> {
	result?: T;
	error?: unknown;
}

/**
 * Unwrap an `alnair/*` extension response.
 *
 * Two shapes come back, and both are legitimate:
 *
 * - **Enveloped** — `ExtMethodResult { result, error }`, built by
 *   `to_ext_response`. `alnair/session/info`, `fs/list`, `fs/search` and
 *   `sessions/list` use this, so the payload sits one level below the
 *   JSON-RPC result.
 * - **Raw** — the handler writes its payload straight into the `ExtResponse`
 *   (`to_raw_response`, or a hand-built `ExtResponse::new`).
 *   `alnair/session/updates` and `alnair/commands/list` use this, so the
 *   result IS the payload.
 *
 * The discriminator is the presence of a `result` key: the envelope always
 * serializes it (`Option<T>`, no `skip_serializing_if`), so its absence means
 * the object was never wrapped. Reading only the envelope shape silently
 * turned every `session/updates` reply into `undefined` — a stored transcript
 * that existed on disk and never reached the transcript pane.
 */
export function unwrapExt<T>(raw: unknown): T | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const envelope = raw as ExtEnvelope<T>;
	if ('result' in envelope) return envelope.result ?? undefined;
	return raw as T;
}

/**
 * Normalize one inbound frame to a plain `{ method, params }`.
 *
 * The gateway produces two wire forms for the same logical message, and the
 * difference is invisible until a handler looks for a field and finds nothing:
 *
 * - **direct** — `{ "method": "alnair/foo", "params": { … } }`
 * - **wrapped** — `{ "method": "_alnair/foo",
 *    "params": { "method": "alnair/foo", "params": { … } } }`
 *
 * Ext *notifications* mostly arrive direct (`_alnair/session/update` carries a
 * flat `sessionId`/`update`), while ext *reverse requests* — the blocking ones
 * a client must answer, `ask_user_question` and `exit_plan_mode` — arrive
 * wrapped. Reading the wrapper as if it were the payload yields no
 * `sessionId`, so the frame is dropped before it can reach a component, and
 * the questionnaire never renders.
 *
 * The leading `_` is the gateway's extension marker, not part of the name, so
 * it is stripped: every consumer matches on `alnair/…`. That also fixes a
 * silent drop — `_alnair/session_notification` did not match the extension
 * rail, so `model_changed`, `pending_interaction` and `interaction_resolved`
 * sent that way were decoded as ACP updates and discarded.
 */
export function normalizeFrame(
	method: string,
	params: Record<string, unknown>
): { method: string; params: Record<string, unknown> } {
	const inner = params.params;
	if (typeof params.method === 'string' && inner !== null && typeof inner === 'object') {
		return {
			method: (params.method as string).replace(/^_/, ''),
			params: inner as Record<string, unknown>
		};
	}
	return { method: method.replace(/^_/, ''), params };
}

/**
 * Whether a (normalized) method rides the extension rail.
 *
 * Two methods carry an Alnair extension payload: `alnair/session/update` (the
 * persisted/replay form) and `alnair/session_notification` (the live one-shot
 * form). Everything else is an ACP update. Callers normalize the `_` prefix
 * first, so both spellings collapse here instead of at every call site.
 */
export function isExtMethod(method: string): boolean {
	const name = method.replace(/^_/, '');
	return name === 'alnair/session/update' || name === 'alnair/session_notification';
}

/** A roster row, as `alnair/sessions/list` sends it. */
export interface RosterRow {
	session_id?: unknown;
	sessionId?: unknown;
	title?: unknown;
	summary?: unknown;
	cwd?: unknown;
	is_worktree?: unknown;
	isWorktree?: unknown;
	model_id?: unknown;
	modelId?: unknown;
	reasoning_effort?: unknown;
	reasoningEffort?: unknown;
	yolo?: unknown;
	activity?: unknown;
	resident?: unknown;
	last_change_unix_ms?: unknown;
	lastChangeUnixMs?: unknown;
	viewed_at?: unknown;
	viewedAt?: unknown;
	origin?: unknown;
}

/**
 * Read a field the wire may spell either way.
 *
 * ACP structs are camelCase; Alnair's own extension *update* payloads are
 * snake_case. The roster is an ext response built from a serde struct, and the
 * live wire spells it camelCase — but a handler that serializes a snake_case
 * struct would flip it. Accepting both costs one lookup and removes a whole
 * class of "the sidebar is empty" bug.
 */
function field<T>(row: Record<string, unknown>, camel: string, snake: string): T | undefined {
	return (row[camel] ?? row[snake]) as T | undefined;
}

/**
 * `activity` on the roster: `working`, `dormant`, or neither.
 *
 * `dormant` is a resident-less row read from disk. It is NOT idle: "idle" means
 * a session this process is holding that has no turn running, while "dormant"
 * means nothing has it loaded at all. The sidebar draws that distinction, so
 * collapsing the two here would erase the only signal it has.
 */
function statusFromActivity(activity: unknown): SessionStatus {
	if (activity === 'working') return 'running';
	if (activity === 'dormant') return 'dormant';
	return 'idle';
}

/** The last path segment, used when the agent sends no repo name. */
export function lastSegment(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** ISO timestamp from unix millis, falling back to now for a missing value. */
function isoFromMillis(value: unknown): string {
	const millis = typeof value === 'number' ? value : Number(value);
	return new Date(Number.isFinite(millis) ? millis : Date.now()).toISOString();
}

/**
 * One roster row → a sidebar session.
 *
 * The roster is deliberately thin: it carries what a session list needs
 * (title, cwd, activity, model) and nothing about the conversation. Fields the
 * row does not carry (`branch`, `numMessages`) stay empty rather than being
 * guessed — they fill in from `alnair/session/info` once a session is open.
 */
export function sessionFromRoster(row: RosterRow): Session | undefined {
	const record = row as Record<string, unknown>;
	const id = field<string>(record, 'sessionId', 'session_id') ?? '';
	if (!id) return undefined;

	const cwd = typeof row.cwd === 'string' ? row.cwd : '';
	const rawTitle =
		field<string>(record, 'title', 'title') ?? field<string>(record, 'summary', 'summary');
	const title = typeof rawTitle === 'string' && rawTitle ? rawTitle : lastSegment(cwd);
	const updatedAt = isoFromMillis(field<number>(record, 'lastChangeUnixMs', 'last_change_unix_ms'));
	const modelId = field<string>(record, 'modelId', 'model_id');

	return {
		id,
		title,
		cwd,
		branch: undefined,
		modelId: typeof modelId === 'string' ? modelId : undefined,
		source: 'local',
		numMessages: 0,
		createdAt: updatedAt,
		updatedAt,
		kind: undefined,
		// The sidebar groups by repo; the roster's `cwd` is the closest thing it
		// sends, and the agent derives `repoName` from the same value.
		workspace: lastSegment(cwd) || cwd,
		gitRootDir: undefined,
		// `yolo` is the session's own runtime mode. It is the only place the
		// browser can learn the mode of a session it did not create: the load
		// response only reports the mode for sessions the leader creates.
		//
		// A missing key means UNKNOWN rather than `false`. `RosterEntry.yolo` is
		// a plain bool, so a full row always carries it — but a thin
		// `sessions/changed` delta may not, and reading absence as "not yolo"
		// would let an unrelated tick clear an always-approve session.
		yolo: typeof row.yolo === 'boolean' ? row.yolo : undefined,
		// `isWorktree` says the session's cwd is a linked worktree. The checkout
		// row reads it to name the checkout honestly; a thin delta may omit it,
		// which stays `undefined` rather than claiming "not a worktree".
		worktree:
			typeof row.isWorktree === 'boolean'
				? row.isWorktree
				: typeof row.is_worktree === 'boolean'
					? row.is_worktree
					: undefined,
		status: statusFromActivity(row.activity)
	};
}

/** Map a whole roster response. */
export function sessionsFromRoster(rows: RosterRow[]): Session[] {
	return rows.map(sessionFromRoster).filter((session): session is Session => session !== undefined);
}

/**
 * Apply a `alnair/sessions/changed` delta.
 *
 * `upserted` rows replace by id (keeping a session the UI already knows about
 * where the delta is thinner), `removed` drops them. Order is preserved for
 * rows that survive, so the sidebar does not reshuffle on every tick.
 */
export function applyRosterDelta(
	current: Session[],
	delta: { upserted?: RosterRow[]; removed?: string[] }
): Session[] {
	const removed = new Set(delta.removed ?? []);
	const byId = new Map(current.map((session) => [session.id, session]));

	for (const row of delta.upserted ?? []) {
		const incoming = sessionFromRoster(row);
		if (!incoming) continue;
		const existing = byId.get(incoming.id);
		// A delta carries less than the full row the UI may already hold (no
		// branch, no message count); keep what is known and take the rest.
		byId.set(incoming.id, existing ? { ...existing, ...stripEmpty(incoming) } : incoming);
	}

	return [...byId.values()].filter((session) => !removed.has(session.id));
}

/** Drop `undefined`/empty-string fields so a thin delta cannot erase state. */
function stripEmpty<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== '')
	) as Partial<T>;
}

/** `alnair/session/info` → the context meter. */
export interface SessionInfoPayload {
	session_id?: unknown;
	cwd?: unknown;
	data?: {
		context?: Record<string, unknown>;
		model_id?: unknown;
		model_display_name?: unknown;
	} & Record<string, unknown>;
}

/** One itemized context row. */
interface UsageCategory {
	label?: unknown;
	tokens?: unknown;
	detail?: unknown;
}

/**
 * `ContextInfo` → the meter.
 *
 * Field names are the Rust ones (`used`, `total`, `usage_pct`, …). The view
 * model renames only where the UI's vocabulary is clearer (`limit` for
 * `total`, `percent` for `usage_pct`).
 */
export function contextFromInfo(info: Record<string, unknown>): ContextUsage | undefined {
	const get = (camel: string, snake: string) => info[camel] ?? info[snake];

	const used = get('used', 'used');
	const total = get('total', 'total');
	if (typeof used !== 'number' || typeof total !== 'number') return undefined;

	const categories: ContextCategory[] = Array.isArray(get('usageCategories', 'usage_categories'))
		? (get('usageCategories', 'usage_categories') as UsageCategory[])
				.filter((row) => typeof row.label === 'string')
				.map((row) => ({
					label: String(row.label),
					tokens: typeof row.tokens === 'number' ? row.tokens : 0,
					detail: typeof row.detail === 'string' ? row.detail : undefined
				}))
		: [];

	const numberOr = (camel: string, snake: string): number => {
		const value = get(camel, snake);
		return typeof value === 'number' ? value : 0;
	};

	return {
		used,
		limit: total,
		percent: numberOr('usagePct', 'usage_pct'),
		systemPromptTokens: numberOr('systemPromptTokens', 'system_prompt_tokens'),
		toolDefinitionsTokens: numberOr('toolDefinitionsTokens', 'tool_definitions_tokens'),
		toolDefinitionsCount: numberOr('toolDefinitionsCount', 'tool_definitions_count'),
		messageTokens: numberOr('messageTokens', 'message_tokens'),
		messageCount: numberOr('messageCount', 'message_count'),
		turnCount: numberOr('turnCount', 'turn_count'),
		toolCallCount: numberOr('toolCallCount', 'tool_call_count'),
		compactionCount: numberOr('compactionCount', 'compaction_count'),
		freeTokens: numberOr('freeTokens', 'free_tokens'),
		autoCompactThresholdPercent: numberOr(
			'autoCompactThresholdPercent',
			'auto_compact_threshold_percent'
		),
		categories
	};
}

/** A `ModelInfo` as the catalog reports it. */
export interface WireModelInfo {
	modelId?: unknown;
	name?: unknown;
	description?: unknown;
	_meta?: Record<string, unknown>;
}

/**
 * `SessionModelState` → the picker's options.
 *
 * `modelId` is the catalog key the auth layer routes on
 * (`<platform>/<model>`), which is exactly what `setModel` must send back. The
 * provider comes from `_meta.provider` (stamped by the managed catalog) and
 * falls back to the key's platform segment.
 */
export function modelsFromState(state: unknown): {
	models: ModelOption[];
	current?: string;
} {
	if (!state || typeof state !== 'object') return { models: [] };
	const wire = state as { currentModelId?: unknown; availableModels?: unknown };
	const rows = Array.isArray(wire.availableModels) ? (wire.availableModels as WireModelInfo[]) : [];

	const models = rows
		.map((row): ModelOption | undefined => {
			const id = typeof row.modelId === 'string' ? row.modelId : '';
			if (!id) return undefined;
			const platform = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
			const meta = row._meta ?? {};
			return {
				id,
				label: typeof row.name === 'string' && row.name ? row.name : id,
				// `description` carries the provider display name in a managed
				// catalog; `_meta.provider` is the explicit field. The key's
				// platform segment is the last resort.
				provider:
					typeof meta.provider === 'string' && meta.provider
						? meta.provider
						: typeof row.description === 'string' && row.description
							? row.description
							: platform || 'Model',
				efforts: effortsFromMeta(meta),
				contextWindow: contextWindowFromMeta(meta)
			};
		})
		.filter((model): model is ModelOption => model !== undefined);

	return {
		models,
		current: typeof wire.currentModelId === 'string' ? wire.currentModelId : undefined
	};
}

/** Canonical effort levels a model accepts, from `_meta`. */
function effortsFromMeta(meta: Record<string, unknown>): string[] {
	// `reasoningEfforts` is the accepted set; `reasoningEffort` is the current
	// selection and must not be mistaken for it.
	const list = meta.reasoningEfforts ?? meta.reasoning_efforts;
	if (!Array.isArray(list)) return [];

	// The wire sends objects (`{ id, value, label, description, default }`), not
	// bare strings; a plain string is accepted too so an older catalog still
	// renders.
	return list
		.map((entry) => {
			if (typeof entry === 'string') return entry;
			if (entry && typeof entry === 'object') {
				const record = entry as Record<string, unknown>;
				const value = record.value ?? record.id;
				return typeof value === 'string' ? value : undefined;
			}
			return undefined;
		})
		.filter((entry): entry is string => entry !== undefined);
}

/** Context window from `_meta`, when the catalog served one. */
function contextWindowFromMeta(meta: Record<string, unknown>): number {
	for (const key of ['contextWindow', 'context_window', 'totalContextTokens', 'maxInputTokens']) {
		const value = meta[key];
		if (typeof value === 'number' && value > 0) return value;
	}
	return 0;
}

/**
 * The accumulated token count a session update carries.
 *
 * Every persisted frame is stamped with `_meta.totalTokens` — the TUI reads it
 * from the same place (`acp/meta.rs`) to keep its context bar live. That makes
 * the meter realtime without polling `alnair/session/info`: the itemized
 * breakdown still comes from the snapshot, but the figure the meter shows moves
 * with the stream.
 */
export function totalTokensOf(meta: unknown): number | undefined {
	if (!meta || typeof meta !== 'object') return undefined;
	const value = (meta as { totalTokens?: unknown }).totalTokens;
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The reasoning effort a model switch reported, if any. */
export function reasoningEffortOf(update: unknown): string | undefined {
	if (!update || typeof update !== 'object') return undefined;
	const record = update as { reasoning_effort?: unknown; reasoningEffort?: unknown };
	const value = record.reasoning_effort ?? record.reasoningEffort;
	return typeof value === 'string' && value ? value : undefined;
}

/**
 * One branch from `alnair/git/branches`.
 *
 * `GitBranchListData` is camelCase: `{ currentBranch, repoRoot, branches }`,
 * each entry `{ name, current, remote }`.
 */
export interface GitBranch {
	name: string;
	current: boolean;
	remote: boolean;
}

export interface GitBranchesPayload {
	currentBranch?: string;
	repoRoot?: string;
	branches: GitBranch[];
}

export function branchesFromWire(raw: unknown): GitBranchesPayload {
	const payload = unwrapExt<{
		currentBranch?: unknown;
		current_branch?: unknown;
		repoRoot?: unknown;
		repo_root?: unknown;
		branches?: unknown;
	}>(raw);
	if (!payload || typeof payload !== 'object') return { branches: [] };

	const list = Array.isArray(payload.branches) ? payload.branches : [];
	const branches = list
		.map((entry): GitBranch | undefined => {
			if (!entry || typeof entry !== 'object') return undefined;
			const row = entry as Record<string, unknown>;
			const name = typeof row.name === 'string' ? row.name : '';
			if (!name) return undefined;
			return { name, current: row.current === true, remote: row.remote === true };
		})
		.filter((branch): branch is GitBranch => branch !== undefined);

	return {
		currentBranch:
			typeof payload.currentBranch === 'string'
				? payload.currentBranch
				: typeof payload.current_branch === 'string'
					? payload.current_branch
					: undefined,
		repoRoot:
			typeof payload.repoRoot === 'string'
				? payload.repoRoot
				: typeof payload.repo_root === 'string'
					? payload.repo_root
					: undefined,
		branches
	};
}

/**
 * One worktree from `alnair/git/worktree/list`.
 *
 * The DB row is `WorktreeRecord`-shaped; only the fields the picker needs are
 * read, and a row missing its path is dropped rather than rendered as a blank
 * line.
 */
export interface WorktreeEntry {
	path: string;
	branch?: string;
	label?: string;
	/** `true` for the worktree the session's cwd lives in. */
	current: boolean;
}

export function worktreesFromWire(raw: unknown): WorktreeEntry[] {
	const payload = unwrapExt<{ worktrees?: unknown; entries?: unknown }>(raw);
	const list = Array.isArray(payload?.worktrees)
		? payload.worktrees
		: Array.isArray(payload?.entries)
			? payload.entries
			: Array.isArray(raw)
				? raw
				: [];

	return list
		.map((entry): WorktreeEntry | undefined => {
			if (!entry || typeof entry !== 'object') return undefined;
			const row = entry as Record<string, unknown>;
			const path =
				typeof row.path === 'string'
					? row.path
					: typeof row.worktreePath === 'string'
						? row.worktreePath
						: typeof row.worktree_path === 'string'
							? row.worktree_path
							: '';
			if (!path) return undefined;
			return {
				path,
				branch:
					typeof row.branch === 'string'
						? row.branch
						: typeof row.gitRef === 'string'
							? row.gitRef
							: undefined,
				label: typeof row.label === 'string' ? row.label : undefined,
				current: row.current === true || row.isCurrent === true
			};
		})
		.filter((entry): entry is WorktreeEntry => entry !== undefined);
}

/** The permission mode the runtime is actually in.
 *
 * `yolo` wins over `auto`: the leader injects both into `session/new`, and a
 * client that advertised neither stays on `ask`.
 */
export function accessFromSession(yolo: unknown, auto: unknown): AccessMode {
	if (yolo === true) return 'always-approve';
	if (auto === true) return 'auto';
	return 'ask';
}

/**
 * A node from `alnair/fs/list`.
 *
 * `FsListNode` is snake_case in Rust but its `type` is renamed, and the live
 * wire sends `name`, `path`, `type`, `size`, `modifiedAt` — camelCase, because
 * the struct is serialized with the extension's own convention. Accepting both
 * spellings costs one lookup per field and keeps a serialization change from
 * emptying the menu.
 */
export interface FsNode {
	name?: unknown;
	path?: unknown;
	type?: unknown;
	size?: unknown;
}

/** `alnair/fs/list` nodes → the composer's `@` menu rows. */
export function entriesFromNodes(nodes: FsNode[]): FileEntry[] {
	return nodes
		.map((node): FileEntry | undefined => {
			const path = typeof node.path === 'string' ? node.path : '';
			if (!path) return undefined;
			const name = typeof node.name === 'string' && node.name ? node.name : lastSegment(path);
			return {
				name,
				path,
				type: node.type === 'directory' ? 'directory' : 'file',
				...(typeof node.size === 'number' ? { size: node.size } : {})
			};
		})
		.filter((entry): entry is FileEntry => entry !== undefined);
}

/**
 * Re-root an absolute path at `root`, with `/` separators.
 *
 * A mention token has to be relative for the agent's own tools to resolve it.
 * A path outside the root is returned unchanged rather than guessed at: a
 * worktree session can legitimately list a directory its cwd does not contain,
 * and inventing `../../` would be worse than leaving it absolute.
 */
export function relativeTo(root: string, path: string): string {
	const normalizedRoot = root.replace(/[\\/]+$/, '');
	if (!path.startsWith(normalizedRoot)) return path.replace(/\\/g, '/');
	return path
		.slice(normalizedRoot.length)
		.replace(/^[\\/]+/, '')
		.replace(/\\/g, '/');
}
