/**
 * The Agent Client Protocol wire, as the Rust side actually emits it.
 *
 * Source of truth: `agent-client-protocol-schema` 0.11.4 (`src/client.rs`,
 * `src/tool_call.rs`, `src/plan.rs`, `src/content.rs`). Field names are the
 * serde-renamed ones — camelCase objects, snake_case enum discriminators —
 * because these types are parsed straight off the socket and never remapped.
 *
 * Nothing in the UI imports this file. The reducer turns it into the view
 * model; keeping the two apart is what stops a protocol bump from reaching
 * every component.
 */

/* ------------------------------------------------------------------ content */

export interface Annotations {
	audience?: ('user' | 'assistant')[];
	priority?: number;
	/** ISO 8601. */
	lastModified?: string;
}

export interface TextContent {
	type: 'text';
	text: string;
	annotations?: Annotations;
	_meta?: Record<string, unknown>;
}

export interface ImageContent {
	type: 'image';
	/** Base64, no `data:` prefix. */
	data: string;
	mimeType: string;
	uri?: string;
	annotations?: Annotations;
	_meta?: Record<string, unknown>;
}

export interface AudioContent {
	type: 'audio';
	data: string;
	mimeType: string;
	annotations?: Annotations;
	_meta?: Record<string, unknown>;
}

export interface ResourceLink {
	type: 'resource_link';
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: Annotations;
	_meta?: Record<string, unknown>;
}

export interface EmbeddedResource {
	type: 'resource';
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
	annotations?: Annotations;
	_meta?: Record<string, unknown>;
}

export type ContentBlock =
	TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource;

/* -------------------------------------------------------------------- tools */

/**
 * `#[serde(other)]` on the Rust side means an unknown kind parses as `other`
 * rather than failing the frame.
 */
export type ToolKind =
	| 'read'
	| 'edit'
	| 'delete'
	| 'move'
	| 'search'
	| 'execute'
	| 'think'
	| 'fetch'
	| 'switch_mode'
	| 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallLocation {
	path: string;
	line?: number;
}

/** A file modification, carried as the two whole sides rather than a patch. */
export interface Diff {
	path: string;
	/** Absent for a new file. */
	oldText?: string;
	newText: string;
	_meta?: Record<string, unknown>;
}

export interface TerminalRef {
	terminalId: string;
}

export type ToolCallContent =
	| { type: 'content'; content: ContentBlock }
	| ({ type: 'diff' } & Diff)
	| ({ type: 'terminal' } & TerminalRef);

export interface ToolCall {
	toolCallId: string;
	title: string;
	kind: ToolKind;
	status: ToolCallStatus;
	content?: ToolCallContent[];
	locations?: ToolCallLocation[];
	rawInput?: unknown;
	rawOutput?: unknown;
	_meta?: Record<string, unknown>;
}

/** Partial update; collections replace rather than extend. */
export interface ToolCallUpdateFields {
	kind?: ToolKind;
	status?: ToolCallStatus;
	title?: string;
	content?: ToolCallContent[];
	locations?: ToolCallLocation[];
	rawInput?: unknown;
	rawOutput?: unknown;
}

export interface ToolCallUpdate extends ToolCallUpdateFields {
	toolCallId: string;
	_meta?: Record<string, unknown>;
}

/* --------------------------------------------------------------------- plan */

export type PlanEntryPriority = 'high' | 'medium' | 'low';
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanEntry {
	content: string;
	priority: PlanEntryPriority;
	status: PlanEntryStatus;
	_meta?: Record<string, unknown>;
}

export interface Plan {
	entries: PlanEntry[];
	_meta?: Record<string, unknown>;
}

/* ---------------------------------------------------------- session updates */

export interface ContentChunk {
	content: ContentBlock;
	_meta?: Record<string, unknown>;
}

export interface AvailableCommand {
	name: string;
	description: string;
	input?: { hint: string };
	_meta?: Record<string, unknown>;
}

export interface AvailableCommandsUpdate {
	availableCommands: AvailableCommand[];
	_meta?: Record<string, unknown>;
}

export interface CurrentModeUpdate {
	currentModeId: string;
	_meta?: Record<string, unknown>;
}

export interface SessionInfoUpdate {
	/** `null` clears the title. */
	title?: string | null;
	updatedAt?: string | null;
	_meta?: Record<string, unknown>;
}

/**
 * `SessionUpdate` is internally tagged on `sessionUpdate`. The agent only ever
 * emits the variants below; anything else must be ignored rather than crash.
 */
export type SessionUpdate =
	| { sessionUpdate: 'user_message_chunk'; content: ContentBlock; _meta?: Record<string, unknown> }
	| { sessionUpdate: 'agent_message_chunk'; content: ContentBlock; _meta?: Record<string, unknown> }
	| { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock; _meta?: Record<string, unknown> }
	| ({ sessionUpdate: 'tool_call' } & ToolCall)
	| ({ sessionUpdate: 'tool_call_update' } & ToolCallUpdate)
	| { sessionUpdate: 'plan'; entries: PlanEntry[]; _meta?: Record<string, unknown> }
	| ({ sessionUpdate: 'available_commands_update' } & AvailableCommandsUpdate)
	| ({ sessionUpdate: 'current_mode_update' } & CurrentModeUpdate)
	| ({ sessionUpdate: 'session_info_update' } & SessionInfoUpdate)
	| { sessionUpdate: string; [key: string]: unknown };

export interface SessionNotification {
	sessionId: string;
	update: SessionUpdate;
	_meta?: Record<string, unknown>;
}

/* --------------------------------------------------------------- permission */

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
	optionId: string;
	name: string;
	kind: PermissionOptionKind;
	_meta?: Record<string, unknown>;
}

/** A reverse request: the agent asks the client, so the client answers it. */
export interface RequestPermissionRequest {
	sessionId: string;
	toolCall: ToolCallUpdate;
	options: PermissionOption[];
	_meta?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ prompts */

export interface PromptRequest {
	sessionId: string;
	prompt: ContentBlock[];
	messageId?: string;
	_meta?: Record<string, unknown>;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PromptResponse {
	stopReason: StopReason;
	userMessageId?: string;
	_meta?: Record<string, unknown>;
}

/** `session/list` (stable) and `alnair/session/list` (the superset row). */
export interface SessionInfo {
	sessionId: string;
	cwd: string;
	title?: string;
	updatedAt?: string;
	_meta?: Record<string, unknown>;
}

/* ------------------------------------------------------------- json-rpc core */

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: number | string;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: '2.0';
	method: string;
	params?: unknown;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: number | string;
	result?: unknown;
	error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * One line of a session's JSONL transcript, as returned by
 * `alnair/session/updates`: the storage envelope, not the bare params.
 */
export interface TranscriptEnvelope {
	timestamp?: string;
	method: string;
	params?: unknown;
}

export const isNotification = (msg: JsonRpcMessage): msg is JsonRpcNotification =>
	'method' in msg && !('id' in msg);

export const isResponse = (msg: JsonRpcMessage): msg is JsonRpcResponse =>
	'id' in msg && ('result' in msg || 'error' in msg);
