/**
 * The reducer: wire in, view model out.
 *
 * One pure function folds every frame the agent sends into the transcript the
 * UI renders. It is deliberately the only place that knows what an ACP
 * `tool_call_update` or an `_alnair/session/update` looks like, so the socket
 * adapter and the fixture transport both feed it and neither one is special.
 *
 * Rules that keep it honest:
 * - Never invent data. A field the wire did not carry stays `undefined`, and
 *   the component decides how to render less.
 * - A tool call is identified by `toolCallId` and updated in place; a row never
 *   changes position once created.
 * - `turn_completed` is the durable terminal, but the `session/prompt` response
 *   also closes the turn. Whichever arrives first wins, and a later one only
 *   refines the status.
 */

import type {
	ContentBlock,
	Diff,
	PlanEntry,
	SessionUpdate,
	ToolCall,
	ToolCallStatus,
	ToolCallUpdateFields
} from './types/acp.js';
import type {
	AskUserQuestionRequest,
	AskUserQuestionResponse,
	ExtSessionUpdate,
	GraphUpdated,
	PendingKind,
	QuestionAnnotation,
	RetryState,
	TaskSnapshot
} from './types/ext.js';
import type {
	AvailableCommand,
	DiffHunk,
	DiffLine,
	FileEditPart,
	FileReadPart,
	FileWritePart,
	GraphState,
	ImageReadPart,
	NumberedLine,
	PartStatus,
	PermissionPart,
	PermissionRequest,
	QuestionAnswer,
	QuestionPart,
	QuestionPrompt,
	QuestionRequest,
	ReasoningPart,
	Session,
	SubagentPart,
	TerminalPart,
	TextPart,
	TodoItem,
	ToolPart,
	Turn,
	TurnPart,
	TurnStatus
} from './types.js';

/* ------------------------------------------------------------- accumulator */

/**
 * A tool call as the reducer tracks it: the wire fields it was given, plus the
 * clock it started on. Content is replaced wholesale on update, per ACP.
 */
export interface ToolState {
	toolCallId: string;
	title: string;
	kind: string;
	status: ToolCallStatus;
	content: unknown[];
	rawInput?: unknown;
	rawOutput?: unknown;
	locations: { path: string; line?: number }[];
	startedAt: number;
	endedAt?: number;
	/** Set when the task outlived the call (`task_backgrounded`). */
	backgrounded?: { taskId: string; outputFile?: string; description?: string };
	/** Set when a permission request gates this call. */
	pendingPermission?: { options: PermissionPart['options'] };
}

export interface SubagentState {
	id: string;
	/**
	 * The child session's id. It is what `alnair/session/updates` takes to read
	 * the subagent's transcript, so it must be carried separately: the wire
	 * happens to send the same value as `subagent_id` today, and depending on
	 * that would break silently the day it does not.
	 */
	childSessionId: string;
	description: string;
	agent: string;
	model?: string;
	status: PartStatus;
	turnCount: number;
	toolCallCount: number;
	tokensUsed: number;
	toolsUsed: string[];
	result?: string;
	error?: string;
	startedAt: number;
	endedAt?: number;
}

export interface Acc {
	turns: Turn[];
	/** The assistant turn currently open, if any. */
	openTurnId?: string;
	/** Prompt text already streamed as `user_message_chunk`, so `send()` can skip it. */
	streamedUserText: string;
	/**
	 * Set by `openUserTurn` while the prompt in flight is already on screen.
	 *
	 * A live send paints the user turn immediately, and the agent then echoes
	 * the same text back as `user_message_chunk`. Replay has no optimistic turn,
	 * so the chunks there are the ONLY source of user turns. One flag
	 * distinguishes the two: while it is set, echoed chunks are swallowed;
	 * when it is clear, they build the transcript.
	 */
	optimisticUserTurn?: boolean;
	/**
	 * The user turn still accepting `user_message_chunk` text.
	 *
	 * A prompt arrives as many chunks and they must join one bubble, but nothing
	 * in a chunk says "this is the last one". Any non-user update closes the
	 * window, which is exactly when the agent has started answering.
	 */
	openUserChunkId?: string;
	tools: Record<string, ToolState>;
	subagents: Record<string, SubagentState>;
	todos: TodoItem[];
	commands: AvailableCommand[];
	/** `graph_updated` as it arrived; the store projects it for the UI. */
	graph?: GraphUpdated;
	permissions: Record<string, PermissionRequest>;
	/** Tool call ids parked on a question or plan approval (not renderable yet). */
	parked: Record<string, PendingKind>;
	lastError?: { title: string; message: string; detail?: string };
	retry?: RetryState;
	contextUsed?: number;
	contextLimit?: number;
	modelId?: string;
	effort?: string;
}

export const emptyAcc = (): Acc => ({
	turns: [],
	streamedUserText: '',
	tools: {},
	subagents: {},
	todos: [],
	commands: [],
	permissions: {},
	parked: {}
});

/* ----------------------------------------------------------------- helpers */

export const statusFromTool = (status: ToolCallStatus): PartStatus =>
	status === 'completed'
		? 'complete'
		: status === 'failed'
			? 'error'
			: status === 'in_progress'
				? 'running'
				: 'pending';

const newId = () => Math.random().toString(36).slice(2, 10);

const durationOf = (tool: ToolState, now: number) =>
	tool.endedAt !== undefined ? tool.endedAt - tool.startedAt : now - tool.startedAt;

const turnById = (turns: Turn[], id: string | undefined) =>
	id === undefined ? undefined : turns.find((turn) => turn.id === id);

/** Replace one part inside one turn, leaving the rest of the transcript alone. */
function patchPart(
	acc: Acc,
	turnId: string,
	partId: string,
	fn: (part: TurnPart) => TurnPart
): Acc {
	const turns = acc.turns.map((turn) =>
		turn.id === turnId
			? { ...turn, parts: turn.parts.map((part) => (part.id === partId ? fn(part) : part)) }
			: turn
	);
	return { ...acc, turns };
}

/**
 * Fold a replayed `user_message_chunk` into the user turn it belongs to.
 *
 * Consecutive chunks join one bubble; the window closes on the next non-user
 * update (see `openUserChunkId`). This is the replay path only — a live send
 * paints its own turn and swallows the echo.
 */
function appendUserChunk(acc: Acc, chunk: string, at: number): Acc {
	const openId = acc.openUserChunkId;
	if (openId !== undefined) {
		const turns = acc.turns.map((turn) =>
			turn.id === openId
				? {
						...turn,
						parts: turn.parts.map((part) =>
							part.kind === 'text' ? { ...part, text: part.text + chunk } : part
						)
					}
				: turn
		);
		return { ...acc, turns };
	}

	const turn: Turn = {
		id: newId(),
		role: 'user',
		status: 'complete',
		at: new Date(at).toISOString(),
		parts: [{ kind: 'text', id: newId(), text: chunk }]
	};
	// A new prompt ends the previous answer. Without this, the next
	// `agent_message_chunk` joins the turn BEFORE it and the transcript runs
	// out of order. Real transcripts also carry `turn_completed`, but a
	// truncated one (the tail of a crash) does not, and the boundary is
	// unambiguous from the prompt itself.
	const turns =
		acc.openTurnId === undefined
			? acc.turns
			: acc.turns.map((existing) =>
					existing.id === acc.openTurnId && existing.status === 'streaming'
						? { ...existing, status: 'complete' as TurnStatus }
						: existing
				);
	return {
		...acc,
		turns: [...turns, turn],
		openUserChunkId: turn.id,
		openTurnId: undefined
	};
}

/** Append a part to the open turn, creating one if the agent sent updates first. */
function pushPart(acc: Acc, part: TurnPart, at: number): Acc {
	if (acc.openTurnId === undefined) {
		const turn: Turn = {
			id: newId(),
			role: 'assistant',
			status: 'streaming',
			at: new Date(at).toISOString(),
			parts: [part]
		};
		return { ...acc, turns: [...acc.turns, turn], openTurnId: turn.id };
	}
	const turns = acc.turns.map((turn) =>
		turn.id === acc.openTurnId ? { ...turn, parts: [...turn.parts, part] } : turn
	);
	return { ...acc, turns };
}

/**
 * Upsert a part keyed by its id. Streaming chunks and tool updates both land
 * here, so a row that already exists is refined rather than duplicated.
 */
function upsertPart(acc: Acc, id: string, part: TurnPart, at: number): Acc {
	const turn = turnById(acc.turns, acc.openTurnId);
	if (turn?.parts.some((existing) => existing.id === id)) {
		return patchPart(acc, turn.id, id, () => part);
	}
	return pushPart(acc, part, at);
}

/* -------------------------------------------------------------- text parts */

function textOf(block: ContentBlock | unknown): string | undefined {
	if (!block || typeof block !== 'object') return undefined;
	const value = block as { type?: string; text?: string; resource?: { text?: string } };
	if (value.type === 'text') return value.text;
	if (value.type === 'resource' && value.resource?.text) return value.resource.text;
	return undefined;
}

function appendText(acc: Acc, kind: 'text' | 'reasoning', chunk: string, at: number): Acc {
	const turn = turnById(acc.turns, acc.openTurnId);
	const last = turn?.parts.at(-1);
	if (last && last.kind === kind) {
		return patchPart(acc, turn!.id, last.id, (part) =>
			part.kind === 'text' || part.kind === 'reasoning'
				? { ...part, text: part.text + chunk }
				: part
		);
	}
	const part: TextPart | ReasoningPart =
		kind === 'text'
			? { kind: 'text', id: newId(), text: chunk }
			: { kind: 'reasoning', id: newId(), text: chunk, status: 'running' };
	return pushPart(acc, part, at);
}

/* --------------------------------------------------------------- diff rows */

/** Split a whole-file diff into hunks, with the numbers a reader needs. */
export function diffToHunks(id: string, diff: Diff): DiffHunk[] {
	const before = diff.oldText === undefined ? [] : diff.oldText.split('\n');
	const after = diff.newText.split('\n');

	// Trim the common prefix and suffix so the hunk is the change, not the file.
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix += 1;
	}

	const removed = before.slice(prefix, before.length - suffix);
	const added = after.slice(prefix, after.length - suffix);

	// A naive LCS would be nicer, but for a single contiguous replacement the
	// removed block followed by the added block is what the agent actually did.
	const lines: DiffLine[] = [];
	for (let index = 0; index < removed.length; index += 1) {
		lines.push({ kind: 'remove', oldNumber: prefix + index + 1, text: removed[index] });
	}
	for (let index = 0; index < added.length; index += 1) {
		lines.push({ kind: 'add', newNumber: prefix + index + 1, text: added[index] });
	}

	const header = `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`;
	return [{ id, header, lines }];
}

export const countDiff = (hunks: DiffHunk[]) => {
	let additions = 0;
	let deletions = 0;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.kind === 'add') additions += 1;
			if (line.kind === 'remove') deletions += 1;
		}
	}
	return { additions, deletions };
};

/** The unified patch text, for the collapsed view and for copy. */
export function diffToPatch(path: string, hunks: DiffHunk[]): string {
	const lines = [`--- a/${path}`, `+++ b/${path}`];
	for (const hunk of hunks) {
		lines.push(hunk.header);
		for (const line of hunk.lines) {
			lines.push(`${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`);
		}
	}
	return lines.join('\n');
}

/* -------------------------------------------------------- tool call → parts */

const languageOf = (path: string): string => {
	const dot = path.lastIndexOf('.');
	return dot === -1 ? 'text' : path.slice(dot + 1);
};

const numbered = (value: string, start = 1): NumberedLine[] =>
	value.split('\n').map((line, index) => ({ n: start + index, text: line }));

interface ImageMeta {
	width?: number;
	height?: number;
	bytes?: number;
}

function imagePart(
	tool: ToolState,
	content: ContentBlock & { type: 'image' },
	now: number
): ImageReadPart {
	const meta = (content._meta ?? {}) as ImageMeta;
	const path = content.uri ?? tool.locations[0]?.path ?? tool.title;
	return {
		kind: 'image-read',
		id: tool.toolCallId,
		path,
		src:
			content.uri && !content.uri.startsWith('data:')
				? content.uri
				: `data:${content.mimeType};base64,${content.data}`,
		mime: content.mimeType,
		width: meta.width,
		height: meta.height,
		bytes: meta.bytes,
		status: statusFromTool(tool.status),
		durationMs: durationOf(tool, now)
	};
}

/**
 * Turn a finished tool call into the row that fits it. The agent's `kind` picks
 * the family; the content picks the variant. Nothing here invents a path or a
 * line count — a read that returned an error stays a plain tool row.
 */
export function toolToParts(tool: ToolState, now: number): TurnPart[] {
	const status = statusFromTool(tool.status);
	const durationMs = durationOf(tool, now);
	const content = tool.content as ({ type: string } & Record<string, unknown>)[];

	// A backgrounded execute is a task, not a finished call.
	if (tool.backgrounded) {
		const output = content
			.filter((item) => item.type === 'content')
			.map((item) => textOf((item as unknown as { content: ContentBlock }).content) ?? '')
			.join('');
		const part: TerminalPart = {
			kind: 'terminal',
			id: tool.toolCallId,
			command: String((tool.rawInput as { command?: string })?.command ?? tool.title),
			cwd: (tool.rawInput as { cwd?: string })?.cwd,
			output,
			status: 'running',
			durationMs,
			backgrounded: true,
			taskId: tool.backgrounded.taskId,
			outputFile: tool.backgrounded.outputFile
		};
		return [part];
	}

	// File reads and writes come back as a text block holding the file content.
	const textItem = content.find(
		(item) =>
			item.type === 'content' && (item as { content?: { type?: string } }).content?.type === 'text'
	);
	const textBlock = textItem
		? (textItem as unknown as { content: ContentBlock & { type: 'text' } }).content
		: undefined;
	const imageItem = content.find(
		(item) =>
			item.type === 'content' && (item as { content?: { type?: string } }).content?.type === 'image'
	);

	if (tool.kind === 'read' && imageItem) {
		const block = (imageItem as unknown as { content: ContentBlock & { type: 'image' } }).content;
		return [imagePart(tool, block, now)];
	}

	if (tool.kind === 'read' && textBlock && status !== 'error') {
		const path = tool.locations[0]?.path ?? tool.title;
		const start = tool.locations[0]?.line ?? 1;
		const part: FileReadPart = {
			kind: 'file-read',
			id: tool.toolCallId,
			path,
			language: languageOf(path),
			lines: numbered(textBlock.text, start),
			status,
			durationMs
		};
		return [part];
	}

	// `write` and `edit` both arrive as diffs. An edit carries `oldText`; a
	// brand-new file does not, and that is the only way to tell them apart.
	const diffs = content.filter((item) => item.type === 'diff') as unknown as (Diff & {
		type: 'diff';
	})[];
	if (diffs.length > 0) {
		return diffs.map((diff, index) => {
			const id = diffs.length > 1 ? `${tool.toolCallId}-${index}` : tool.toolCallId;
			const hunks = diffToHunks(`${id}-h0`, diff);
			const created = diff.oldText === undefined;
			const { additions, deletions } = countDiff(hunks);

			if (created) {
				const part: FileWritePart = {
					kind: 'file-write',
					id,
					path: diff.path,
					language: languageOf(diff.path),
					lines: numbered(diff.newText),
					created,
					status,
					durationMs
				};
				return part;
			}

			// An edit that replaced the whole file reads better as a write.
			const replacedWholeFile =
				diff.oldText !== undefined &&
				hunks.every((hunk) => hunk.lines.every((line) => line.kind !== 'context')) &&
				diff.oldText.split('\n').length === deletions;

			if (replacedWholeFile) {
				const part: FileWritePart = {
					kind: 'file-write',
					id,
					path: diff.path,
					language: languageOf(diff.path),
					lines: numbered(diff.newText),
					created: false,
					status,
					durationMs
				};
				return part;
			}

			const part: FileEditPart = {
				kind: 'file-edit',
				id,
				path: diff.path,
				language: languageOf(diff.path),
				hunks,
				additions,
				deletions,
				status,
				durationMs
			};
			return part;
		});
	}

	// A tool whose result never arrived (the turn was cancelled, or the agent is
	// still blocked on permission) has no content to shape. Fall back to the
	// agent's own title rather than inventing a file row with no body.
	if (tool.status === 'pending' && content.length === 0 && tool.kind !== 'execute') {
		return [genericToolPart(tool, status, durationMs)];
	}

	if (tool.kind === 'execute') {
		const command = String((tool.rawInput as { command?: string })?.command ?? tool.title);
		const part: TerminalPart = {
			kind: 'terminal',
			id: tool.toolCallId,
			command,
			cwd: (tool.rawInput as { cwd?: string })?.cwd,
			output: textBlock?.text ?? '',
			status,
			durationMs
		};
		return [part];
	}

	// Everything else: the agent's own title is the summary, and the text block
	// is the output. `rawInput` is shown only when it is short enough to read.
	return [genericToolPart(tool, status, durationMs, textBlock?.text)];
}

/**
 * The fallback row. `name` is the tool the model called when the agent named it
 * in `_meta`; otherwise the title is all there is, and the row shows just that.
 */
function genericToolPart(
	tool: ToolState,
	status: PartStatus,
	durationMs: number,
	output?: string
): ToolPart {
	const meta = tool as ToolState & { _meta?: { toolName?: string } };
	const rawInput = tool.rawInput === undefined ? undefined : JSON.stringify(tool.rawInput, null, 2);
	return {
		kind: 'tool',
		id: tool.toolCallId,
		name: meta._meta?.toolName ?? tool.kind,
		summary: tool.title,
		input: rawInput && rawInput.length <= 400 ? rawInput : undefined,
		output,
		status,
		durationMs
	};
}

/* ------------------------------------------------------------- the reducer */

export interface ReduceContext {
	/** Epoch millis, injected so tests are deterministic. */
	now: number;
	/** The session this transcript belongs to. */
	sessionId: string;
	/** Prompt text the user just sent, if this frame is part of their turn. */
	userText?: string;
	/** Model catalog key for the open turn, when known. */
	modelId?: string;
	effort?: string;
}

/** Fold one ACP `session/update` payload. */
export function reduceAcpUpdate(input: Acc, update: SessionUpdate, ctx: ReduceContext): Acc {
	const { now } = ctx;

	// Frames from a newer agent may carry a variant this build does not know;
	// an unknown or absent discriminator is ignored rather than fatal.
	if (!update || typeof update.sessionUpdate !== 'string') return input;

	// The user-chunk window closes as soon as anything else arrives, which is
	// exactly when the agent has started answering. Closing it here keeps the
	// rule in one place instead of repeating it in every arm below.
	const acc: Acc =
		input.openUserChunkId !== undefined && update.sessionUpdate !== 'user_message_chunk'
			? { ...input, openUserChunkId: undefined }
			: input;

	switch (update.sessionUpdate) {
		case 'user_message_chunk': {
			const chunk = textOf(update.content);
			if (!chunk) return acc;
			// The live path already painted this prompt optimistically; the echo
			// is only bookkeeping for `send()`.
			if (acc.optimisticUserTurn) {
				return { ...acc, streamedUserText: acc.streamedUserText + chunk };
			}
			// Replay has no optimistic turn, so these chunks ARE the user turn.
			return appendUserChunk(acc, chunk, now);
		}

		case 'agent_message_chunk': {
			const chunk = textOf(update.content);
			return chunk ? appendText(acc, 'text', chunk, now) : acc;
		}

		case 'agent_thought_chunk': {
			const chunk = textOf(update.content);
			return chunk ? appendText(acc, 'reasoning', chunk, now) : acc;
		}

		case 'tool_call': {
			const call = update as unknown as ToolCall & { sessionUpdate: string };
			const existing = acc.tools[call.toolCallId];
			const tool: ToolState = {
				toolCallId: call.toolCallId,
				title: call.title,
				kind: call.kind,
				status: call.status,
				content: call.content ?? [],
				rawInput: call.rawInput,
				rawOutput: call.rawOutput,
				locations: call.locations ?? [],
				startedAt: existing?.startedAt ?? now,
				backgrounded: existing?.backgrounded,
				pendingPermission: existing?.pendingPermission
			};
			const next = { ...acc, tools: { ...acc.tools, [call.toolCallId]: tool } };
			// Show the row immediately; it is refined when the call finishes.
			return upsertPart(next, call.toolCallId, toolToParts(tool, now)[0], now);
		}

		case 'tool_call_update': {
			const fields = update as unknown as ToolCallUpdateFields & { toolCallId: string };
			const existing = acc.tools[fields.toolCallId];
			if (!existing) return acc;
			const settled =
				fields.status === 'completed' || fields.status === 'failed' || fields.status === 'pending';
			const tool: ToolState = {
				...existing,
				title: fields.title ?? existing.title,
				kind: fields.kind ?? existing.kind,
				status: fields.status ?? existing.status,
				// ACP replaces collections rather than merging them.
				content: fields.content ?? existing.content,
				rawInput: fields.rawInput ?? existing.rawInput,
				rawOutput: fields.rawOutput ?? existing.rawOutput,
				locations: fields.locations ?? existing.locations,
				endedAt: settled ? (existing.endedAt ?? now) : existing.endedAt
			};
			const next = { ...acc, tools: { ...acc.tools, [fields.toolCallId]: tool } };
			const parts = toolToParts(tool, now);
			return parts.reduce(
				(current, part, index) =>
					index === 0
						? upsertPart(current, fields.toolCallId, part, now)
						: pushPart(current, part, now),
				next
			);
		}

		case 'plan': {
			const entries = (update as unknown as { entries: PlanEntry[] }).entries;
			return { ...acc, todos: planToTodos(entries) };
		}

		case 'available_commands_update': {
			const commands = (
				update as unknown as {
					availableCommands: { name: string; description: string; input?: { hint: string } }[];
				}
			).availableCommands;
			return {
				...acc,
				commands: commands.map((command) => ({
					name: command.name,
					description: command.description,
					hint: command.input?.hint
				}))
			};
		}

		case 'session_info_update': {
			// The title lives on the session row; the store applies it there.
			return acc;
		}

		default:
			// available_commands_update, current_mode_update, and anything newer.
			return acc;
	}
}

export function planToTodos(entries: PlanEntry[]): TodoItem[] {
	return entries.map((entry, index) => ({
		id: `plan-${index}`,
		content: entry.content,
		status:
			entry.status === 'in_progress'
				? 'in_progress'
				: entry.status === 'completed'
					? 'completed'
					: 'pending',
		priority: entry.priority,
		detail:
			(entry._meta as { cancelled?: boolean } | undefined)?.cancelled === true
				? 'cancelled'
				: undefined
	}));
}

/** Fold one Alnair `_alnair/session/update` payload. */
export function reduceExtUpdate(acc: Acc, update: ExtSessionUpdate, ctx: ReduceContext): Acc {
	const { now } = ctx;

	switch (update.sessionUpdate) {
		case 'retry_state': {
			const state = update as unknown as RetryState;
			if (state.type === 'retrying') {
				return pushPart(
					acc,
					{
						kind: 'notice',
						id: newId(),
						tone: 'warning',
						title: `Retrying (${state.attempt}/${state.max_retries})`,
						detail: state.reason
					},
					now
				);
			}
			// A cancelled turn reports `exhausted` as well; the prompt response
			// carries the real stop reason, so do not overwrite it here.
			return {
				...acc,
				retry: state,
				lastError:
					state.type === 'exhausted'
						? {
								title: state.is_rate_limited ? 'Rate limited' : 'Retries exhausted',
								message: state.reason
							}
						: { title: state.error_type, message: state.message }
			};
		}

		case 'auto_compact_started': {
			const event = update as unknown as {
				tokens_used: number;
				context_window: number;
				percentage: number;
				reason: string;
			};
			return pushPart(
				acc,
				{
					kind: 'notice',
					id: newId(),
					tone: 'info',
					title: `Compacting context (${event.percentage}%)`,
					detail: event.reason
				},
				now
			);
		}

		case 'auto_compact_completed': {
			const event = update as unknown as {
				tokens_before?: number;
				tokens_after: number;
				elapsed_ms?: number;
				summary_preview?: string;
			};
			return {
				...pushPart(
					acc,
					{
						kind: 'notice',
						id: newId(),
						tone: 'success',
						title: 'Context compacted',
						detail: event.summary_preview
					},
					now
				),
				contextUsed: event.tokens_after
			};
		}

		case 'task_backgrounded': {
			const event = update as unknown as {
				tool_call_id: string;
				task_id: string;
				output_file?: string;
				description?: string;
			};
			const tool = acc.tools[event.tool_call_id];
			if (!tool) return acc;
			const next: ToolState = {
				...tool,
				backgrounded: {
					taskId: event.task_id,
					outputFile: event.output_file,
					description: event.description
				}
			};
			return {
				...acc,
				tools: { ...acc.tools, [event.tool_call_id]: next }
			};
		}

		case 'task_completed': {
			const event = update as unknown as { task_snapshot: TaskSnapshot };
			const snapshot = event.task_snapshot;
			const entry = Object.values(acc.tools).find(
				(tool) => tool.backgrounded?.taskId === snapshot.task_id
			);
			if (!entry) return acc;
			const tool: ToolState = {
				...entry,
				status: snapshot.exit_code === 0 ? 'completed' : 'failed',
				content: [{ type: 'content', content: { type: 'text', text: snapshot.output } }],
				endedAt: now
			};
			const next = { ...acc, tools: { ...acc.tools, [entry.toolCallId]: tool } };
			return upsertPart(next, entry.toolCallId, toolToParts(tool, now)[0], now);
		}

		case 'monitor_event': {
			const event = update as unknown as {
				task_id: string;
				description: string;
				event_text: string;
			};
			const entry = Object.values(acc.tools).find(
				(tool) => tool.backgrounded?.taskId === event.task_id
			);
			if (!entry) return acc;
			const part = turnById(acc.turns, acc.openTurnId)?.parts.find(
				(p) => p.id === entry.toolCallId
			);
			if (!part || part.kind !== 'terminal') return acc;
			return patchPart(acc, acc.openTurnId!, part.id, (current) =>
				current.kind === 'terminal'
					? {
							...current,
							output: `${current.output}${current.output ? '\n' : ''}${event.event_text}`
						}
					: current
			);
		}

		case 'subagent_spawned': {
			const event = update as unknown as {
				subagent_id: string;
				child_session_id: string;
				description: string;
				subagent_type: string;
				model?: string;
			};
			const state: SubagentState = {
				id: event.subagent_id,
				childSessionId: event.child_session_id,
				description: event.description,
				agent: event.subagent_type,
				model: event.model,
				status: 'running',
				turnCount: 0,
				toolCallCount: 0,
				tokensUsed: 0,
				toolsUsed: [],
				startedAt: now
			};
			const next = { ...acc, subagents: { ...acc.subagents, [event.subagent_id]: state } };
			return pushPart(next, subagentPart(state), now);
		}

		case 'subagent_progress': {
			const event = update as unknown as {
				subagent_id: string;
				duration_ms: number;
				turn_count: number;
				tool_call_count: number;
				tokens_used: number;
				tools_used: string[];
			};
			const existing = acc.subagents[event.subagent_id];
			if (!existing) return acc;
			const state: SubagentState = {
				...existing,
				turnCount: event.turn_count,
				toolCallCount: event.tool_call_count,
				tokensUsed: event.tokens_used,
				toolsUsed: event.tools_used
			};
			const next = { ...acc, subagents: { ...acc.subagents, [event.subagent_id]: state } };
			const turn = turnById(acc.turns, acc.openTurnId);
			const card = turn?.parts.find((part) => part.id === event.subagent_id);
			if (!turn || !card) return next;
			return patchPart(next, turn.id, card.id, () => subagentPart(state));
		}

		case 'subagent_finished': {
			const event = update as unknown as {
				subagent_id: string;
				status: string;
				duration_ms: number;
				tokens_used: number;
				tool_calls: number;
				turns: number;
				output?: string;
				error?: string;
			};
			const existing = acc.subagents[event.subagent_id];
			if (!existing) return acc;
			const state: SubagentState = {
				...existing,
				status:
					event.status === 'completed'
						? 'complete'
						: event.status === 'cancelled'
							? 'complete'
							: 'error',
				result: event.output,
				error: event.error,
				tokensUsed: event.tokens_used,
				toolCallCount: event.tool_calls,
				turnCount: event.turns,
				endedAt: now
			};
			const next = { ...acc, subagents: { ...acc.subagents, [event.subagent_id]: state } };
			const turn = turnById(acc.turns, acc.openTurnId);
			const card = turn?.parts.find((part) => part.id === event.subagent_id);
			if (!turn || !card) return next;
			return patchPart(next, turn.id, card.id, () => subagentPart(state));
		}

		case 'graph_updated': {
			const event = update as unknown as GraphUpdated & { sessionUpdate: string };
			if (event.status === 'cleared') {
				const { graph: _dropped, ...rest } = acc;
				return rest;
			}
			return { ...acc, graph: event };
		}

		case 'pending_interaction': {
			const event = update as unknown as { tool_call_id: string; kind: PendingKind };
			const tool = acc.tools[event.tool_call_id];

			if (event.kind === 'plan_approval') {
				// The artifact itself arrives as an `exit_plan_mode` reverse request;
				// this update only marks the session as blocked.
				return { ...acc, parked: { ...acc.parked, [event.tool_call_id]: event.kind } };
			}

			/**
			 * The card belongs at the tail of the thread, not next to the tool it
			 * gates: the tool call may have been announced long before, and a card
			 * buried mid-transcript is a card the user never answers.
			 */
			if (event.kind === 'permission') {
				const options = tool?.pendingPermission?.options ?? defaultPermissionOptions();
				const request: PermissionRequest = {
					toolCallId: event.tool_call_id,
					title: tool?.title ?? 'Tool call',
					options
				};
				const next = {
					...acc,
					permissions: { ...acc.permissions, [event.tool_call_id]: request }
				};
				return pushPart(
					next,
					{
						kind: 'permission',
						id: `perm-${event.tool_call_id}`,
						toolCallId: event.tool_call_id,
						title: request.title,
						toolKind: tool?.kind ?? 'other',
						options,
						resolved: false
					},
					now
				);
			}

			// `question`: the questionnaire itself arrives as the reverse request,
			// so the card is built there; this update only marks the block.
			return { ...acc, parked: { ...acc.parked, [event.tool_call_id]: event.kind } };
		}

		case 'interaction_resolved': {
			const event = update as unknown as { tool_call_id: string };
			const { [event.tool_call_id]: _resolved, ...permissions } = acc.permissions;
			const { [event.tool_call_id]: _parked, ...parked } = acc.parked;
			const next = { ...acc, permissions, parked };
			return resolveCardById(next, `perm-${event.tool_call_id}`);
		}

		case 'turn_completed': {
			const event = update as unknown as { prompt_id: string; stop_reason: string };
			return closeTurn(acc, statusFromStopReason(event.stop_reason), event.prompt_id, now);
		}

		case 'model_changed': {
			const event = update as unknown as {
				model_id: string;
				reasoning_effort?: string;
				context_window?: number;
			};
			return {
				...acc,
				modelId: event.model_id,
				effort: event.reasoning_effort ?? acc.effort,
				contextLimit: event.context_window ?? acc.contextLimit
			};
		}

		case 'model_auto_switched': {
			const event = update as unknown as {
				previous_model_id: string;
				new_model_id: string;
				reason: string;
			};
			return pushPart(
				{ ...acc, modelId: event.new_model_id },
				{
					kind: 'notice',
					id: newId(),
					tone: 'warning',
					title: 'Model switched',
					detail: `${event.previous_model_id} → ${event.new_model_id} (${event.reason})`
				},
				now
			);
		}

		case 'session_recap': {
			const event = update as unknown as { summary: string };
			return pushPart(
				acc,
				{ kind: 'notice', id: newId(), tone: 'info', title: 'Recap', detail: event.summary },
				now
			);
		}

		case 'hook_annotation': {
			const event = update as unknown as { message: string };
			return pushPart(
				acc,
				{ kind: 'notice', id: newId(), tone: 'info', title: event.message },
				now
			);
		}

		default:
			return acc;
	}
}

/**
 * Mark a card resolved wherever it sits, by part id. Returns the accumulator
 * unchanged when the part is not in the transcript.
 */
export function resolveCardById(acc: Acc, partId: string): Acc {
	const turn = acc.turns.find((candidate) => candidate.parts.some((part) => part.id === partId));
	if (!turn) return acc;
	return patchPart(acc, turn.id, partId, (part) =>
		part.kind === 'permission' || part.kind === 'question' ? { ...part, resolved: true } : part
	);
}

/* ------------------------------------------------------------- questions */

/** Project an `alnair/ask_user_question` payload onto the parked request. */
export function questionFromPayload(request: AskUserQuestionRequest): QuestionRequest {
	return {
		toolCallId: request.toolCallId,
		mode: request.mode ?? 'default',
		questions: request.questions.map((question) => ({
			question: question.question,
			multiSelect: question.multiSelect === true,
			choices: question.options.map((option) => ({
				label: option.label,
				description: option.description,
				preview: option.preview
			}))
		}))
	};
}

/**
 * Build the questionnaire card from an `alnair/ask_user_question` request.
 *
 * The card is pushed to the tail of the open turn, like the permission card,
 * because the question is the thing the user has to act on.
 */
export function questionFromRequest(acc: Acc, request: AskUserQuestionRequest, now: number): Acc {
	const projected = questionFromPayload(request);
	const part: QuestionPart = {
		kind: 'question',
		id: `ask-${request.toolCallId}`,
		toolCallId: request.toolCallId,
		mode: projected.mode,
		resolved: false,
		questions: projected.questions
	};
	return pushPart(acc, part, now);
}

/**
 * Turn the UI's answers into the response the agent parses.
 *
 * The rules come from the Rust side (`question_view::build_accepted_response`):
 * unanswered questions are omitted, a multi-select answer is one element per
 * label, a freeform-only answer is `["Other"]` with the text in `annotations`,
 * and `preview` is echoed back for single-select answers only.
 */
export function acceptedResponse(
	questions: QuestionPrompt[],
	answers: Record<string, QuestionAnswer>
): AskUserQuestionResponse {
	const payload: Record<string, string[]> = {};
	const annotations: Record<string, QuestionAnnotation> = {};

	for (const question of questions) {
		const answer = answers[question.question];
		if (!answer) continue;

		const notes = answer.notes?.trim();
		const hasNotes = notes !== undefined && notes.length > 0;
		const labels = answer.labels;

		if (labels.length === 0 && !hasNotes) continue;

		// A freeform-only answer is the literal label `Other`.
		payload[question.question] = labels.length === 0 ? ['Other'] : labels;

		const preview =
			question.multiSelect || labels.length !== 1
				? undefined
				: question.choices.find((choice) => choice.label === labels[0])?.preview;

		if (preview !== undefined || hasNotes) {
			annotations[question.question] = {
				...(preview !== undefined ? { preview } : {}),
				...(hasNotes ? { notes } : {})
			};
		}
	}

	return {
		outcome: 'accepted',
		answers: payload,
		...(Object.keys(annotations).length > 0 ? { annotations } : {})
	};
}

/** Project the wire's snake_case badge onto the view model's names. */
export function graphToState(event: GraphUpdated): GraphState {
	return {
		id: event.graph_id,
		objective: event.objective,
		status: event.status,
		phase: event.phase,
		planVersion: event.plan_version,
		total: event.total_nodes,
		achieved: event.achieved_nodes,
		failed: event.failed_nodes,
		running: event.running_nodes,
		currentNode: event.current_node,
		currentNodeTitle: event.current_node_title,
		tokenBudget: event.token_budget,
		tokensSpent: event.tokens_spent,
		lastEvent: event.last_event,
		pauseMessage: event.pause_message
	};
}

function subagentPart(state: SubagentState): SubagentPart {
	return {
		kind: 'subagent',
		id: state.id,
		title: state.description,
		agent: state.agent,
		model: state.model,
		status: state.status,
		turnCount: state.turnCount,
		toolCallCount: state.toolCallCount,
		tokensUsed: state.tokensUsed,
		toolsUsed: state.toolsUsed,
		result: state.result,
		error: state.error
	};
}

/** ACP only sends the option kinds; the agent's own labels arrive separately. */
function defaultPermissionOptions(): PermissionPart['options'] {
	return [
		{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
		{ optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
		{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
	];
}

export const statusFromStopReason = (reason: string): TurnStatus => {
	switch (reason) {
		case 'cancelled':
			return 'cancelled';
		case 'refusal':
			return 'refused';
		case 'max_tokens':
		case 'max_turn_requests':
			return 'complete';
		default:
			return 'complete';
	}
};

/** Close the open turn with a terminal status. */
export function closeTurn(
	acc: Acc,
	status: TurnStatus,
	promptId: string | undefined,
	now: number
): Acc {
	const turn = turnById(acc.turns, acc.openTurnId);
	if (!turn) return { ...acc, openTurnId: undefined };
	const turns = acc.turns.map((current) =>
		current.id === turn.id
			? {
					...current,
					status,
					promptId: promptId ?? current.promptId,
					durationMs: now - new Date(current.at).getTime(),
					parts: current.parts.map((part) =>
						'status' in part && part.status === 'running'
							? { ...part, status: 'complete' as PartStatus }
							: part
					)
				}
			: current
	);
	return {
		...acc,
		turns,
		openTurnId: undefined,
		streamedUserText: '',
		// The turn is over, so the next prompt's echo must build its own turn
		// again if this accumulator is ever replayed.
		optimisticUserTurn: undefined
	};
}

/* -------------------------------------------------------------- entrypoints */

/**
 * Open a new user turn, then fold a frame into the assistant turn it starts.
 *
 * Any turn still marked open is closed first. Without that, the reply to this
 * prompt is appended to the PREVIOUS assistant turn — which sits earlier in the
 * list — and the answer renders above the question. That happens whenever a
 * replay leaves a turn open (a transcript whose last turn never got a
 * `turn_completed`), and the reader sees the conversation run backwards.
 */
export function openUserTurn(
	acc: Acc,
	text: string,
	at: number,
	modelId?: string,
	effort?: string
): Acc {
	const turns = acc.openTurnId
		? acc.turns.map((turn) =>
				turn.id === acc.openTurnId && turn.status === 'streaming'
					? { ...turn, status: 'complete' as TurnStatus }
					: turn
			)
		: acc.turns;

	const turn: Turn = {
		id: newId(),
		role: 'user',
		status: 'complete',
		at: new Date(at).toISOString(),
		parts: [{ kind: 'text', id: newId(), text }]
	};
	return {
		...acc,
		turns: [...turns, turn],
		openTurnId: undefined,
		// The prompt is on screen; the agent's echo of it must not add a second
		// bubble. Cleared when the turn closes.
		optimisticUserTurn: true,
		modelId,
		effort
	};
}

/** Replay a whole transcript, as `alnair/session/updates` returns it. */
export function replay(
	envelopes: { method: string; params?: unknown; timestamp?: string }[],
	sessionId: string
): Acc {
	let acc = emptyAcc();
	for (const envelope of envelopes) {
		const params = envelope.params as
			{ sessionId?: string; update?: Record<string, unknown> } | undefined;
		if (!params?.update) continue;
		const now = envelope.timestamp ? new Date(envelope.timestamp).getTime() : Date.now();
		const ctx: ReduceContext = { now, sessionId };
		if (envelope.method === '_alnair/session/update') {
			acc = reduceExtUpdate(acc, params.update as ExtSessionUpdate, ctx);
		} else {
			acc = reduceAcpUpdate(acc, params.update as SessionUpdate, ctx);
		}
	}
	return acc;
}

/** The session's derived status: a parked request outranks a live turn. */
export function sessionStatus(acc: Acc): Session['status'] {
	if (Object.keys(acc.permissions).length > 0 || Object.keys(acc.parked).length > 0)
		return 'attention';
	if (acc.openTurnId !== undefined) return 'running';
	return 'idle';
}
