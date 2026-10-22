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
 * Ext handlers answer `ExtMethodResult { result, error }`, so the payload is
 * one level below the JSON-RPC `result`. A handler that reports a partial
 * failure still carries `result`, which is worth rendering.
 */
export function unwrapExt<T>(raw: unknown): T | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const envelope = raw as ExtEnvelope<T>;
	return envelope.result ?? undefined;
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

/** `activity` on the roster: `working`, `dormant`, or neither. */
function statusFromActivity(activity: unknown): SessionStatus {
	// `dormant` is a resident-less row read from disk; it is idle for our
	// purposes. `working` is the only state that means a turn is running.
	return activity === 'working' ? 'running' : 'idle';
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
 * The permission mode the runtime is actually in.
 *
 * `yolo` wins over `auto`: the leader injects both into `session/new`, and a
 * client that advertised neither stays on `ask`.
 */
export function accessFromSession(yolo: unknown, auto: unknown): AccessMode {
	if (yolo === true) return 'always-approve';
	if (auto === true) return 'auto';
	return 'ask';
}
