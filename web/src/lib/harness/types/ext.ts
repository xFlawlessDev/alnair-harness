/**
 * Alnair's own wire surface: the parts of the protocol that are not ACP.
 *
 * Source of truth: `alnair-shell/src/extensions/notification.rs`
 * (`SessionUpdate`, serde `tag = "sessionUpdate"`, `rename_all = "snake_case"`),
 * `session/pending_interaction.rs` (`PendingKind`), `terminal/background_task.rs`
 * (`TaskSnapshot`), and the `alnair/*` handlers in
 * `agent/mvp_agent/acp_agent.rs`.
 *
 * Field names are snake_case throughout. That is not a style choice: serde's
 * `rename_all` on an *enum* renames the variants, not the fields, so the
 * variant payloads keep their Rust names (`tool_call_id`, `tokens_used`, …).
 * ACP types are camelCase because their structs carry `rename_all = "camelCase"`.
 *
 * These ride the same JSON-RPC connection as ACP, as `_alnair/session/update`
 * notifications: the method names the envelope, `sessionUpdate` names the
 * variant inside `params.update`.
 */

import type { PromptResponse } from './acp.js';

/** `_alnair/session/update` — one Alnair-specific update. */
export interface ExtSessionNotification<T extends ExtSessionUpdate = ExtSessionUpdate> {
	session_id: string;
	update: T;
	_meta?: Record<string, unknown>;
}

/* --------------------------------------------------------------- turn status */

export interface RetryStateRetrying {
	type: 'retrying';
	attempt: number;
	max_retries: number;
	reason: string;
}

export interface RetryStateExhausted {
	type: 'exhausted';
	attempts: number;
	reason: string;
	is_rate_limited?: boolean;
}

export interface RetryStateFailed {
	type: 'failed';
	error_type: string;
	message: string;
}

export type RetryState = RetryStateRetrying | RetryStateExhausted | RetryStateFailed;

export type PendingKind = 'permission' | 'question' | 'plan_approval';

/* --------------------------------------------------------------- compaction */

export interface AutoCompactStarted {
	sessionUpdate: 'auto_compact_started';
	tokens_used: number;
	context_window: number;
	/** 0–100. */
	percentage: number;
	reason: string;
}

export interface AutoCompactCompleted {
	sessionUpdate: 'auto_compact_completed';
	tokens_before?: number;
	tokens_after: number;
	elapsed_ms?: number;
	summary_preview?: string;
}

/* ------------------------------------------------------------------- tasks */

/** The background-task snapshot carried by `task_completed`. */
export interface TaskSnapshot {
	task_id: string;
	command: string;
	display_command?: string;
	cwd: string;
	start_time: string;
	end_time?: string;
	output: string;
	output_file: string;
	truncated: boolean;
	exit_code?: number;
	signal?: string;
	completed: boolean;
	block_waited: boolean;
	explicitly_killed: boolean;
}

export interface TaskBackgrounded {
	sessionUpdate: 'task_backgrounded';
	tool_call_id: string;
	task_id: string;
	command: string;
	cwd: string;
	output_file: string;
	/** Set for monitors; `None` for an ordinary backgrounded bash command. */
	monitor_description?: string;
	description?: string;
}

export interface TaskCompleted {
	sessionUpdate: 'task_completed';
	task_snapshot: TaskSnapshot;
	will_wake: boolean;
}

export interface MonitorEvent {
	sessionUpdate: 'monitor_event';
	task_id: string;
	description: string;
	/** Raw stdout line, not XML-wrapped. */
	event_text: string;
}

/* --------------------------------------------------------------- subagents */

/**
 * A running subagent, as `alnair/subagent/list_running` returns it.
 * Source: `SubagentLiveSnapshotDto` (camelCase).
 */
export interface SubagentLiveSnapshot {
	subagentId: string;
	parentSessionId: string;
	childSessionId: string;
	/** `general-purpose`, `explore`, `plan`, or a custom type. */
	subagentType: string;
	description: string;
	startedAtEpochMs: number;
	durationMs: number;
	turnCount: number;
	toolCallCount: number;
	tokensUsed: number;
	contextWindowTokens: number;
	contextUsagePct: number;
	toolsUsed: string[];
	errorCount: number;
}

/**
 * One subagent in any state, as `alnair/subagent/get` returns it.
 * Source: `SubagentSnapshotDto`; the status-dependent fields are optional
 * because the agent only sends the ones that apply.
 */
export interface SubagentSnapshot extends SubagentLiveSnapshot {
	/** `running`, `completed`, `failed`, or `cancelled`. */
	status: string;
	output?: string;
	toolCalls?: number;
	turns?: number;
	worktreePath?: string;
	failureError?: string;
	cancelReason?: string;
	forkContextSource?: string;
	forkParentPromptId?: string;
	resumedFrom?: string;
}

export interface ListRunningSubagentsResponse {
	subagents: SubagentLiveSnapshot[];
}

export interface GetSubagentResponse {
	snapshot?: SubagentSnapshot;
}

export interface SubagentSpawned {
	sessionUpdate: 'subagent_spawned';
	subagent_id: string;
	parent_session_id: string;
	parent_prompt_id?: string;
	child_session_id: string;
	/** `general-purpose`, `explore`, `plan`, or a custom type. */
	subagent_type: string;
	description: string;
	effective_context_source?: string;
	context_normalized?: boolean;
	capability_mode?: string;
	persona?: string;
	role?: string;
	model?: string;
	resumed_from?: string;
}

export interface SubagentProgress {
	sessionUpdate: 'subagent_progress';
	subagent_id: string;
	parent_session_id: string;
	child_session_id: string;
	duration_ms: number;
	turn_count: number;
	tool_call_count: number;
	tokens_used: number;
	context_window_tokens: number;
	context_usage_pct: number;
	tools_used: string[];
	error_count: number;
}

export interface SubagentFinished {
	sessionUpdate: 'subagent_finished';
	subagent_id: string;
	child_session_id: string;
	/** `completed`, `failed`, or `cancelled`. */
	status: string;
	error?: string;
	tool_calls: number;
	turns: number;
	duration_ms: number;
	tokens_used: number;
	output?: string;
	will_wake: boolean;
}

/* ------------------------------------------------------------------- graph */

/**
 * The pager-facing graph badge. `status` uses the goal vocabulary plus the
 * `cleared` sentinel; `phase` is `idle | planning | executing`.
 *
 * Deliberately a summary, not the DAG: the wire carries counts and the current
 * node, so the web inspector renders exactly this rather than a topology it
 * invented.
 */
export interface GraphUpdated {
	sessionUpdate: 'graph_updated';
	graph_id: string;
	objective: string;
	status: string;
	phase: string;
	plan_version: number;
	total_nodes: number;
	achieved_nodes: number;
	failed_nodes: number;
	running_nodes: number;
	current_node?: string;
	current_node_title?: string;
	token_budget?: number;
	tokens_spent: number;
	last_event?: string;
	pause_message?: string;
}

/* ------------------------------------------------------------- interaction */

/**
 * A blocking reverse request is parked. Fire-and-forget and never persisted,
 * so a viewer that attaches late learns it only from the live stream.
 */
export interface PendingInteraction {
	sessionUpdate: 'pending_interaction';
	tool_call_id: string;
	kind: PendingKind;
}

export interface InteractionResolved {
	sessionUpdate: 'interaction_resolved';
	tool_call_id: string;
}

/**
 * The durable turn terminal. Rides the persisted rail, so a viewer that
 * attaches mid-turn can finalize from replay instead of staying on "waiting".
 */
export interface TurnCompleted {
	sessionUpdate: 'turn_completed';
	prompt_id: string;
	stop_reason: string;
	agent_result?: string;
	usage?: unknown;
}

/* ------------------------------------------------------------------ models */

export interface ModelChanged {
	sessionUpdate: 'model_changed';
	model_id: string;
	reasoning_effort?: string;
	context_window?: number;
}

export interface ModelAutoSwitched {
	sessionUpdate: 'model_auto_switched';
	previous_model_id: string;
	new_model_id: string;
	reason: string;
}

/* ---------------------------------------------------------------- the union */

export type ExtSessionUpdate =
	| { sessionUpdate: 'retry_state'; type: RetryState['type']; [key: string]: unknown }
	| AutoCompactStarted
	| AutoCompactCompleted
	| { sessionUpdate: 'auto_compact_failed'; error: string }
	| { sessionUpdate: 'auto_compact_cancelled'; reason: string }
	| { sessionUpdate: 'auto_continue_completed'; total_tokens: number }
	| TaskBackgrounded
	| TaskCompleted
	| MonitorEvent
	| SubagentSpawned
	| SubagentProgress
	| SubagentFinished
	| GraphUpdated
	| PendingInteraction
	| InteractionResolved
	| TurnCompleted
	| ModelChanged
	| ModelAutoSwitched
	| { sessionUpdate: 'session_summary_generated'; session_summary: string }
	| { sessionUpdate: 'session_recap'; summary: string; auto: boolean }
	| { sessionUpdate: 'hook_annotation'; message: string }
	| { sessionUpdate: string; [key: string]: unknown };

/* --------------------------------------------------- extension RPC shapes */

/** `alnair/session/list` — the superset row, `MergedSession` flattened. */
export interface AlnairSessionRow {
	sessionId: string;
	/** Generated title; falls back to the first prompt on the agent side. */
	summary: string;
	firstPrompt?: string;
	updatedAt: string;
	createdAt: string;
	cwd: string;
	hostname?: string;
	/** `local`, `remote`, or `both`. */
	source: string;
	modelId?: string;
	numMessages: number;
	lastActiveAt?: string;
	branch?: string;
	repoName?: string;
	worktreeLabel?: string;
	gitRootDir?: string;
	gitRemotes?: string[];
	sourceWorkspaceDir?: string;
	sessionKind?: string;
	/** The `alnair/session` envelope: kind plus facets. */
	_meta?: {
		'alnair/session'?: {
			kind?: string;
			facets?: Record<string, unknown>;
		};
	};
}

export interface AlnairSessionListRequest {
	cwd?: string;
	query?: string;
	cursor?: string;
	limit?: number;
}

export interface AlnairSessionListResponse {
	sessions: AlnairSessionRow[];
	nextCursor?: string;
}

/** `alnair/session/updates` — the replay of a stored transcript. */
export interface SessionUpdatesRequest {
	sessionId: string;
	cwd: string;
	/** Negative counts from the end. */
	offset?: number;
	limit?: number;
	stream?: boolean;
	chunkSize?: number;
	turnIndex?: number;
}

export interface SessionUpdatesResponse {
	/** Each entry is the storage envelope: `{ timestamp, method, params }`. */
	updates: { timestamp?: string; method: string; params?: unknown }[];
	totalCount: number;
	hasMore: boolean;
	promptStarts?: number[];
}

/**
 * `alnair/exit_plan_mode` — a reverse request carrying the plan under review.
 * The response is one of the three outcomes below.
 */
export interface ExitPlanModeRequest {
	sessionId: string;
	toolCallId: string;
	planContent?: string;
}

export type ExitPlanModeResponse =
	{ outcome: 'approved' } | { outcome: 'cancelled'; feedback?: string } | { outcome: 'abandoned' };

/**
 * `alnair/ask_user_question` — a reverse request carrying the questionnaire.
 *
 * Source: `alnair-tools/src/implementations/alnair/ask_user_question/types.rs`
 * (`#[serde(rename_all = "camelCase")]`, so this one *is* camelCase) and
 * `mod.rs` for `Question` / `QuestionOption`.
 */
export interface QuestionOption {
	/** Option text shown to the user. A few words at most. */
	label: string;
	/** What picking this option means or implies. Required on the wire. */
	description: string;
	/** Verbatim preview, echoed back for single-select answers. */
	preview?: string;
	/** Opaque id, hidden from the model; Alnair leaves it unset. */
	id?: string;
}

export interface Question {
	question: string;
	options: QuestionOption[];
	/** Let the user pick more than one option (default false). */
	multiSelect?: boolean;
	id?: string;
}

/**
 * `default` offers Accept and Cancel; `plan` adds Chat about this and
 * Skip interview.
 */
export type AskUserQuestionMode = 'default' | 'plan';

export interface AskUserQuestionRequest {
	sessionId: string;
	toolCallId: string;
	questions: Question[];
	mode: AskUserQuestionMode;
}

/** Extra context carried alongside a selected label. */
export interface QuestionAnnotation {
	/** The selected option's `preview`, single-select only. */
	preview?: string;
	/** Free text the user typed into the freeform input. */
	notes?: string;
}

/**
 * The answer, internally tagged on `outcome`.
 *
 * Rules the agent relies on:
 * - Only answered questions appear; unanswered ones are omitted.
 * - A multi-select answer carries one element per label.
 * - A freeform-only answer is `["Other"]` with the text in `annotations[q].notes`.
 * - `ChatAboutThis` and `SkipInterview` are plan mode only.
 */
export type AskUserQuestionResponse =
	| {
			outcome: 'accepted';
			/** Keyed by the question's exact text. */
			answers: Record<string, string[]>;
			annotations?: Record<string, QuestionAnnotation>;
	  }
	| { outcome: 'chat_about_this'; partialAnswers?: Record<string, string> }
	| { outcome: 'skip_interview'; partialAnswers?: Record<string, string> }
	| { outcome: 'cancelled' };

/** `alnair/queue/*` — the prompt queue the TUI shows above the input. */
export interface QueuedPrompt {
	id: string;
	text: string;
	createdAt?: string;
}

export interface QueueChanged {
	sessionId: string;
	queue: QueuedPrompt[];
}

/** Re-exported so callers do not have to reach into the ACP module. */
export type { PromptResponse };
