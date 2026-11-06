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
	QuestionChoice,
	QuestionPart,
	QuestionPrompt,
	QuestionRequest,
	ReasoningPart,
	Session,
	SubagentPart,
	SystemPart,
	TerminalPart,
	TextPart,
	TodoItem,
	ToolPart,
	Turn,
	TurnPart,
	TurnStatus
} from './types.js';
import { isExtMethod } from './wire.js';
import { systemEnvelope, type SystemEnvelope } from './system-notes.js';
import { outputText } from './terminal-output.js';

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
	/**
	 * How a backgrounded task ended, kept after `backgrounded` is cleared.
	 *
	 * Clearing the flag is what lets the row stop rendering as running, but it
	 * also erases the only evidence that this was a task rather than an
	 * ordinary command. The TUI leaves a separate `BgTaskBlock::Completed` row
	 * behind; the browser keeps the fact on the row itself.
	 */
	backgroundOutcome?: 'completed' | 'failed';
	/** How long the backgrounded task ran, from its own start/end stamps. */
	backgroundElapsedMs?: number;
	/** Set when a permission request gates this call. */
	pendingPermission?: { options: PermissionPart['options'] };
	/**
	 * The update's `_meta`, kept because it carries the canonical tool identity
	 * (`alnair/tool`: name, kind, label). That is the only reliable way to tell
	 * a subagent spawn from an ordinary tool call: the ACP `kind` is `other`
	 * for every Alnair tool, and the title is model-authored.
	 */
	meta?: Record<string, unknown>;
}

/** The `_meta["alnair/tool"]` envelope, as `CanonicalToolMeta` serializes it. */
export interface CanonicalToolMeta {
	version?: number;
	/** The harness-specific model-facing name, e.g. `spawn_subagent`. */
	name?: string;
	/** The semantic kind, e.g. `task`, `ask_user`, `execute`. */
	kind?: string;
	namespace?: string;
	/** Cross-harness display label, e.g. `Subagent`, `Ask User`. */
	label?: string;
	read_only?: boolean;
	input?: Record<string, unknown>;
}

/** Read the canonical identity the agent stamped onto a tool call, if any. */
export function toolMetaOf(
	meta: Record<string, unknown> | undefined
): CanonicalToolMeta | undefined {
	const value = meta?.['alnair/tool'];
	return value && typeof value === 'object' ? (value as CanonicalToolMeta) : undefined;
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
	/**
	 * Epoch millis when the prompt behind the open turn was sent.
	 *
	 * The assistant turn is created by its FIRST part, which arrives after the
	 * model has already been thinking. Timing a turn from that first part
	 * therefore loses every second spent before the first token — the "worked
	 * for 0s" that a quick tool-only turn produced. This is the anchor the
	 * turn's `startedAt` and `durationMs` are measured from instead, and it is
	 * cleared on the same path that closes the turn.
	 */
	promptStartedAt?: number;
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
	/**
	 * The `_meta.promptIndex` the open user bubble was started with.
	 *
	 * A prompt index is the server's own turn key, and it is the durable way to
	 * tell two prompts apart: a cancelled prompt and the retry the user typed
	 * afterwards carry the same text but different indices. Without this, a
	 * transcript whose only separator is `turn_completed` (an extension frame)
	 * joins both into one bubble — the "hi test sub agenthi test sub agent"
	 * that appeared after reloading a stopped turn.
	 */
	openUserChunkPromptIndex?: number;
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

/** When a turn's work began: the prompt it answers, else its own first part. */
const turnStartOf = (turn: Turn): number => turn.startedAt ?? new Date(turn.at).getTime();

/**
 * Close a turn that was superseded rather than reported.
 *
 * A transcript whose tail lost its `turn_completed` still has a durable
 * boundary: the next prompt. Settling here is what keeps such a turn from
 * showing no duration at all — and it is measured from the same anchor
 * `closeTurn` uses, so the two paths cannot disagree about what "worked for"
 * means.
 */
function settleTurn(turn: Turn, endAt: number): Turn {
	const durationMs = turn.durationMs ?? Math.max(0, endAt - turnStartOf(turn));
	return { ...turn, status: 'complete', durationMs };
}

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
 *
 * A chunk carrying a `promptIndex` that differs from the open bubble's starts a
 * NEW bubble even when the window is still open. That is the durable turn
 * boundary, and it is what keeps a cancelled prompt and the retry that follows
 * it from being concatenated: `turn_completed` is an extension frame, so it
 * never closed this window, and the two prompts share their text.
 */
function appendUserChunk(acc: Acc, chunk: string, at: number, promptIndex?: number): Acc {
	const openId = acc.openUserChunkId;
	const samePrompt =
		openId !== undefined &&
		(promptIndex === undefined || acc.openUserChunkPromptIndex === promptIndex);
	if (openId !== undefined && samePrompt) {
		// A chunk that is itself a whole envelope cannot extend a prompt
		// bubble: it arrives after the prompt, in the same window, and joining
		// it would append the reminder's text to what the reader typed.
		const envelope = systemEnvelope(chunk);
		if (!envelope) {
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
		return pushSystemNote(acc, envelope, at);
	}

	// The shell stores injected context as a synthetic USER message, so it
	// arrives on this rail. Rendering it as a prompt bubble claims the reader
	// wrote it; a system row says what it actually is.
	const envelope = systemEnvelope(chunk);
	if (envelope) return pushSystemNote(acc, envelope, at);

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
						? settleTurn(existing, at)
						: existing
				);
	return {
		...acc,
		turns: [...turns, turn],
		openUserChunkId: turn.id,
		openUserChunkPromptIndex: promptIndex,
		openTurnId: undefined,
		// The prompt's own chunk timestamp is the closest thing a replayed
		// transcript has to "when the user sent this", so the answer that
		// follows is measured from it rather than from its first token. Later
		// chunks of the SAME bubble keep it (see the branch above).
		promptStartedAt: at
	};
}

/**
 * Append a system note as its own row.
 *
 * It joins the OPEN assistant turn when one is running — the injection happened
 * during that turn, and a standalone row between the question and its answer
 * would break the thread's shape — and otherwise stands alone as a `system`
 * turn. It never joins a user turn: that is the bug this whole path exists to
 * fix.
 */
function pushSystemNote(acc: Acc, envelope: SystemEnvelope, at: number): Acc {
	const part: SystemPart = {
		kind: 'system',
		id: newId(),
		tag: envelope.tag,
		body: envelope.body
	};
	return pushPart(acc, part, at);
}

/** Append a part to the open turn, creating one if the agent sent updates first. */
function pushPart(acc: Acc, part: TurnPart, at: number): Acc {
	// Any part that is not reasoning ends the thinking phase. Doing it here
	// rather than at each call site means a tool call, a notice, a subagent
	// spawn and a plain text chunk all close it the same way.
	const settled = part.kind === 'reasoning' ? acc : settleReasoning(acc);

	if (settled.openTurnId === undefined) {
		// An ambient part — a notice, an error — is system chatter, not the
		// agent working. Opening a turn for it would leave a turn marked
		// `streaming` that no `turn_completed` will ever close, and the UI
		// would show a spinner and a stop button for a session that is idle.
		// That is exactly what a replay ending in `session_recap` produced.
		//
		// It joins the previous turn when there is one (a recap belongs after
		// the turn it recaps), and otherwise becomes a standalone `system`
		// turn that never streams.
		if (isAmbient(part)) {
			// Attach to the nearest assistant/system turn, never to a user
			// prompt: a recap under a prompt the user just sent would read as
			// the agent's reply.
			const host = [...settled.turns].reverse().find((turn) => turn.role !== 'user');
			if (host) {
				const turns = settled.turns.map((turn) =>
					turn.id === host.id ? { ...turn, parts: [...turn.parts, part] } : turn
				);
				return { ...settled, turns };
			}
			const turn: Turn = {
				id: newId(),
				role: 'system',
				status: 'complete',
				at: new Date(at).toISOString(),
				parts: [part]
			};
			return { ...settled, turns: [...settled.turns, turn] };
		}

		const turn: Turn = {
			id: newId(),
			role: 'assistant',
			status: 'streaming',
			at: new Date(at).toISOString(),
			// Measured from the prompt when one is known, so the time the model
			// spent thinking before its first token counts as work.
			startedAt: settled.promptStartedAt ?? at,
			parts: [part]
		};
		return { ...settled, turns: [...settled.turns, turn], openTurnId: turn.id };
	}
	const turns = settled.turns.map((turn) =>
		turn.id === settled.openTurnId ? { ...turn, parts: [...turn.parts, part] } : turn
	);
	return { ...settled, turns };
}

/**
 * Whether a part describes the SYSTEM rather than the agent's work.
 *
 * A notice, an error or an injected reminder can arrive with no turn open — a
 * recap, a retry banner, a compaction line, a background-task completion.
 * Those must not be mistaken for the start of a turn.
 */
function isAmbient(part: TurnPart): boolean {
	return part.kind === 'notice' || part.kind === 'error' || part.kind === 'system';
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

/**
 * Remove every part a tool call projected.
 *
 * A call can start as one kind of row and become another: a subagent spawn is
 * announced before its identity is stamped, and once it is, the tool row must
 * give way to the subagent card rather than sit beside it. Multi-diff calls
 * project several parts, all sharing the call id as a prefix.
 */
function dropToolParts(acc: Acc, toolCallId: string): Acc {
	const owned = (id: string) => id === toolCallId || id.startsWith(`${toolCallId}-`);
	const turns = acc.turns.map((turn) => {
		const parts = turn.parts.filter((part) => !owned(part.id));
		return parts.length === turn.parts.length ? turn : { ...turn, parts };
	});
	return { ...acc, turns };
}

/* -------------------------------------------------------------- text parts */

function textOf(block: ContentBlock | unknown): string | undefined {
	if (!block || typeof block !== 'object') return undefined;
	const value = block as { type?: string; text?: string; resource?: { text?: string } };
	if (value.type === 'text') return value.text;
	if (value.type === 'resource' && value.resource?.text) return value.resource.text;
	return undefined;
}

/**
 * The server's turn key for a user chunk, when it carries one.
 *
 * `_meta.promptIndex` is stamped by the shell on every prompt echo (see
 * `turn.rs`: it is the same counter rewind and fork truncate on), so it is the
 * authoritative boundary between two prompts. It is absent on older frames and
 * on phantoms, which is why the window still falls back to its positional rule.
 */
function promptIndexOf(update: SessionUpdate): number | undefined {
	const meta = (update as { _meta?: Record<string, unknown> })._meta;
	const value = meta?.promptIndex ?? meta?.prompt_index;
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
	// Reasoning is over the moment anything else starts arriving. Without this
	// the row kept its `running` status for the rest of the turn and the UI
	// showed a spinner and "Thinking" over a thought that had finished — the
	// one thing a finished turn must not claim. `pushPart` is the funnel every
	// new part goes through, so the rule lives there (see `settleReasoning`).
	const part: TextPart | ReasoningPart =
		kind === 'text'
			? { kind: 'text', id: newId(), text: chunk }
			: { kind: 'reasoning', id: newId(), text: chunk, status: 'running' };
	return pushPart(acc, part, at);
}

/**
 * Close every reasoning part still marked running.
 *
 * A thought is a PHASE, and the phase ends when the next thing arrives — a
 * message chunk, a tool call, a subagent spawn. The wire never says so: there
 * is no `thought_completed` update, and `turn_completed` is far too late (the
 * turn can run for minutes after thinking stops). So the boundary is derived
 * from the next part, exactly as the TUI's own tracker derives it.
 */
function settleReasoning(acc: Acc): Acc {
	const turn = turnById(acc.turns, acc.openTurnId);
	if (!turn || !turn.parts.some((part) => part.kind === 'reasoning' && part.status === 'running')) {
		return acc;
	}
	const turns = acc.turns.map((candidate) =>
		candidate.id === turn.id
			? {
					...candidate,
					parts: candidate.parts.map((part) =>
						part.kind === 'reasoning' && part.status === 'running'
							? { ...part, status: 'complete' as PartStatus }
							: part
					)
				}
			: candidate
	);
	return { ...acc, turns };
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

const numbered = (value: string, start = 1): NumberedLine[] => {
	// A file that ends in a newline is not a file with a blank last line: the
	// terminal newline terminates the previous line. Splitting naively would
	// paint a phantom numbered row at the end of every file the agent writes.
	const text = value.endsWith('\n') ? value.slice(0, -1) : value;
	return text.split('\n').map((line, index) => ({ n: start + index, text: line }));
};

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
 *
 * Two families are identified by the canonical `_meta["alnair/tool"]` identity
 * rather than by the ACP kind, because Alnair stamps every one of its own tools
 * as `other`: a subagent spawn and a questionnaire are both `other` on the wire
 * and only their identity says what they are.
 */
export function toolToParts(tool: ToolState, now: number): TurnPart[] {
	const status = statusFromTool(tool.status);
	const durationMs = durationOf(tool, now);
	const content = tool.content as ({ type: string } & Record<string, unknown>)[];
	const identity = toolMetaOf(tool.meta);

	// A subagent spawn has its own card, folded from `subagent_spawned` /
	// `_progress` / `_finished`. The tool call itself would duplicate it with a
	// worse row, so it is dropped — the same rule the TUI applies in
	// `is_task_tool`. The spawn event is persisted alongside the call, so a
	// replay keeps the card.
	if (identity?.kind === 'task' || identity?.kind === 'agent_swarm') {
		return [];
	}

	// A questionnaire is a card, not a tool row. The id matches the one
	// `questionFromRequest` uses, so a live reverse request refines this card
	// instead of adding a second one.
	if (identity?.kind === 'ask_user') {
		return [questionPartFromTool(tool, status)];
	}

	// A backgrounded execute is a task, not a finished call.
	if (tool.backgrounded) {
		const blockText = content
			.filter((item) => item.type === 'content')
			.map((item) => textOf((item as unknown as { content: ContentBlock }).content) ?? '')
			.join('');
		const part: TerminalPart = {
			kind: 'terminal',
			id: tool.toolCallId,
			command: String((tool.rawInput as { command?: string })?.command ?? tool.title),
			cwd: (tool.rawInput as { cwd?: string })?.cwd,
			// The same byte-array shape as a finished call, and the same fix:
			// a backgrounded task's `rawOutput` is where its output lives.
			output: outputText(tool.rawOutput) || blockText,
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
			// `rawOutput` is the authority for a finished command: `content`
			// carries the same text, but the byte form is the complete stream
			// (a large output is truncated in `content` and complete here).
			output: outputText(tool.rawOutput) || textBlock?.text || '',
			exitCode: exitCodeOf(tool.rawOutput),
			status,
			durationMs,
			// A task that was backgrounded and has since reported keeps the fact
			// after `backgrounded` is cleared, so the row can still say it was a
			// task and how long it ran.
			backgroundOutcome: tool.backgroundOutcome,
			backgroundElapsedMs: tool.backgroundElapsedMs
		};
		return [part];
	}

	// Everything else: the agent's own title is the summary, and the text block
	// is the output. `rawInput` is shown only when it is short enough to read.
	return [genericToolPart(tool, status, durationMs, textBlock?.text)];
}

/**
 * How long a backgrounded task ran, from its own start and end stamps.
 *
 * Both are ISO strings on the snapshot. Either missing means the elapsed time
 * is unknown, and `undefined` is the honest answer — the row then shows the
 * outcome without a duration rather than inventing one from the tool call's
 * own clock, which stopped when the CALL returned, not when the task did.
 */
function backgroundElapsedOf(snapshot: TaskSnapshot): number | undefined {
	const start = snapshot.start_time ? Date.parse(snapshot.start_time) : Number.NaN;
	const end = snapshot.end_time ? Date.parse(snapshot.end_time) : Number.NaN;
	if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
	const elapsed = end - start;
	return elapsed >= 0 ? elapsed : undefined;
}

/**
 * The exit code an execute call reported.
 *
 * `BashOutput` carries `exit_code` (snake_case, because it is a Rust struct
 * serialized without a rename). A backgrounded or still-running task has none,
 * which is why this returns `undefined` rather than 0: an absent code means
 * "not known", and painting `exit 0` on a running command would claim success
 * before it finished.
 */
function exitCodeOf(rawOutput: unknown): number | undefined {
	if (!rawOutput || typeof rawOutput !== 'object') return undefined;
	const record = rawOutput as { exit_code?: unknown; exitCode?: unknown };
	const value = record.exit_code ?? record.exitCode;
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
	// The model-facing name lives in the canonical identity; `kind` is the ACP
	// fallback (`other` for every Alnair tool), so it is the last resort.
	const identity = toolMetaOf(tool.meta);
	const rawInput = tool.rawInput === undefined ? undefined : JSON.stringify(tool.rawInput, null, 2);
	return {
		kind: 'tool',
		id: tool.toolCallId,
		name: identity?.name ?? tool.kind,
		summary: tool.title,
		input: rawInput && rawInput.length <= 400 ? rawInput : undefined,
		output,
		status,
		durationMs
	};
}

/**
 * Build the questionnaire card from an `ask_user_question` tool call.
 *
 * The live path gets a richer card from the reverse request (`questionFromRequest`),
 * which also carries the plan-mode flag. This one exists for replay, where the
 * reverse request was never persisted and the tool call is all that is left —
 * and so a card that was answered still renders as answered instead of
 * vanishing from the transcript.
 *
 * The id matches `questionFromRequest`'s, so whichever arrives second refines
 * the same card rather than adding a duplicate.
 */
function questionPartFromTool(tool: ToolState, status: PartStatus): QuestionPart {
	const raw = (tool.rawInput ?? {}) as { questions?: unknown; variant?: unknown };
	const list = Array.isArray(raw.questions) ? raw.questions : [];

	const questions: QuestionPrompt[] = list
		.map((entry): QuestionPrompt | undefined => {
			if (!entry || typeof entry !== 'object') return undefined;
			const record = entry as Record<string, unknown>;
			const question = typeof record.question === 'string' ? record.question : '';
			if (!question) return undefined;
			const options = Array.isArray(record.options) ? record.options : [];
			return {
				question,
				multiSelect: record.multiSelect === true || record.multi_select === true,
				choices: options
					.map((option): QuestionChoice | undefined => {
						if (!option || typeof option !== 'object') return undefined;
						const choice = option as Record<string, unknown>;
						const label = typeof choice.label === 'string' ? choice.label : '';
						if (!label) return undefined;
						return {
							label,
							description: typeof choice.description === 'string' ? choice.description : '',
							preview: typeof choice.preview === 'string' ? choice.preview : undefined
						};
					})
					.filter((choice): choice is QuestionChoice => choice !== undefined)
			};
		})
		.filter((question): question is QuestionPrompt => question !== undefined);

	return {
		kind: 'question',
		id: `ask-${tool.toolCallId}`,
		toolCallId: tool.toolCallId,
		questions,
		mode: 'default',
		// The call is only done once the agent has the answers; a pending or
		// failed call means the user never answered, which is still "resolved"
		// for rendering purposes — the card must not claim the agent is waiting
		// on a call that will never be answered.
		resolved: status !== 'running' && status !== 'pending'
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
			? { ...input, openUserChunkId: undefined, openUserChunkPromptIndex: undefined }
			: input;

	switch (update.sessionUpdate) {
		case 'user_message_chunk': {
			const chunk = textOf(update.content);
			if (!chunk) return acc;
			// Injected context shares this rail with real prompts (the shell
			// stores it as a synthetic USER message), so it is checked FIRST —
			// before the optimistic-echo guard below. That guard swallows every
			// user chunk until the turn closes, which would eat a mid-turn
			// reminder into `streamedUserText` and lose it entirely.
			const envelope = systemEnvelope(chunk);
			if (envelope) return pushSystemNote(acc, envelope, now);
			// The live path already painted this prompt optimistically; the echo
			// is only bookkeeping for `send()`.
			if (acc.optimisticUserTurn) {
				return { ...acc, streamedUserText: acc.streamedUserText + chunk };
			}
			// Replay has no optimistic turn, so these chunks ARE the user turn.
			return appendUserChunk(acc, chunk, now, promptIndexOf(update));
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
				pendingPermission: existing?.pendingPermission,
				meta: call._meta ?? existing?.meta
			};
			const next = { ...acc, tools: { ...acc.tools, [call.toolCallId]: tool } };
			// Show the row immediately; it is refined when the call finishes.
			// A subagent spawn has no row of its own (the subagent card covers
			// it), so an empty projection must not create a turn.
			const parts = toolToParts(tool, now);
			return parts.reduce((current, part) => upsertPart(current, part.id, part, now), next);
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
				// `_meta` is merged by the agent across updates, but a later
				// update may omit it entirely; keep what the first one carried.
				meta: (fields as { _meta?: Record<string, unknown> })._meta ?? existing.meta,
				// A backgrounded task that reports a terminal status is over.
				// Leaving the flag set would keep the row painting as a running
				// task — the spinner that never stops after a failed or
				// cancelled background command.
				backgrounded:
					fields.status === 'failed' || fields.status === 'completed'
						? undefined
						: existing.backgrounded,
				endedAt: settled ? (existing.endedAt ?? now) : existing.endedAt
			};
			const next = { ...acc, tools: { ...acc.tools, [fields.toolCallId]: tool } };
			const parts = toolToParts(tool, now);
			// A part that no longer applies (a subagent call, which the card
			// covers) must not leave its old row behind.
			const current = parts.length === 0 ? dropToolParts(next, fields.toolCallId) : next;
			return parts.reduce((acc, part) => upsertPart(acc, part.id, part, now), current);
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

/** Fold one Alnair `alnair/session/update` payload. */
export function reduceExtUpdate(input: Acc, update: ExtSessionUpdate, ctx: ReduceContext): Acc {
	const { now } = ctx;

	// The user-chunk window closes here too. An extension frame is what usually
	// follows a prompt when the turn ends without an assistant reply — a
	// `turn_completed` after a cancel, a `retry_state` — and leaving the window
	// open joined the NEXT prompt's echo onto the previous bubble, so a stopped
	// turn reloaded as "hi test sub agenthi test sub agent".
	const acc: Acc =
		input.openUserChunkId !== undefined
			? { ...input, openUserChunkId: undefined, openUserChunkPromptIndex: undefined }
			: input;

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

		case 'auto_compact_failed':
		case 'auto_compact_cancelled': {
			const failed = update.sessionUpdate === 'auto_compact_failed';
			const event = update as { error?: string; reason?: string };
			return pushPart(
				acc,
				{
					kind: 'notice',
					id: newId(),
					tone: failed ? 'warning' : 'info',
					title: failed ? 'Context compaction failed' : 'Context compaction cancelled',
					detail: (failed ? event.error : event.reason) ?? ''
				},
				now
			);
		}

		case 'auto_recovery_started':
		case 'auto_recovery_exhausted': {
			const exhausted = update.sessionUpdate === 'auto_recovery_exhausted';
			const event = update as { attempt?: number; max_retries?: number; error: string };
			return pushPart(
				acc,
				{
					kind: 'notice',
					id: newId(),
					tone: exhausted ? 'warning' : 'info',
					title: exhausted
						? 'Session recovery failed'
						: `Recovering session (attempt ${event.attempt}/${event.max_retries})`,
					detail: event.error
				},
				now
			);
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
			// Re-project the row: a backgrounded execute is a running task, and
			// the row must say so (its `status` becomes `running` and it carries
			// the task id) rather than staying a completed call.
			const withTool = { ...acc, tools: { ...acc.tools, [event.tool_call_id]: next } };
			const parts = toolToParts(next, now);
			return parts.reduce((current, part) => upsertPart(current, part.id, part, now), withTool);
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
				// `toolToParts` reads the exit code off `rawOutput`, so the
				// snapshot's own code has to be stamped there or the settled row
				// shows no status at all.
				rawOutput: { exit_code: snapshot.exit_code, output: snapshot.output },
				// The task is over: clearing the flag is what lets the row settle
				// to `Ran`/`Failed` instead of reading as a running task forever.
				// The outcome and the elapsed time survive it, so the row can
				// still say it was a background task and how long it took.
				backgrounded: undefined,
				backgroundOutcome: snapshot.exit_code === 0 ? 'completed' : 'failed',
				backgroundElapsedMs: backgroundElapsedOf(snapshot),
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
			// Both card kinds are keyed by the tool call; resolve whichever one
			// this call produced.
			const withPermission = resolveCardById(next, `perm-${event.tool_call_id}`);
			return resolveCardById(withPermission, `ask-${event.tool_call_id}`);
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
	// The same tool call may already have projected a card from its `rawInput`
	// (replay, or the `tool_call` frame that preceded this request). Upserting
	// keeps one card and lets this richer version — which knows the mode and
	// the agent's own option text — replace it.
	return upsertPart(acc, part.id, part, now);
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
	if (!turn) return { ...acc, openTurnId: undefined, promptStartedAt: undefined };
	const turns = acc.turns.map((current) =>
		current.id === turn.id
			? {
					...current,
					status,
					promptId: promptId ?? current.promptId,
					durationMs: Math.max(0, now - turnStartOf(current)),
					parts: current.parts.map((part) =>
						'status' in part &&
						part.status === 'running' &&
						!('backgrounded' in part && part.backgrounded)
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
		promptStartedAt: undefined,
		streamedUserText: '',
		// A turn boundary is also a prompt boundary: the next echo must start
		// its own bubble rather than extending this prompt's.
		openUserChunkId: undefined,
		openUserChunkPromptIndex: undefined,
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
				turn.id === acc.openTurnId && turn.status === 'streaming' ? settleTurn(turn, at) : turn
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
		// The clock the answer's "worked for" is measured from: this prompt,
		// not the first token the model eventually emits.
		promptStartedAt: at,
		// The prompt is on screen; the agent's echo of it must not add a second
		// bubble. Cleared when the turn closes.
		optimisticUserTurn: true,
		// A new prompt also ends the previous prompt's chunk window, or its
		// echo would be appended to the bubble above this one.
		openUserChunkId: undefined,
		openUserChunkPromptIndex: undefined,
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
		if (isExtMethod(envelope.method)) {
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
