/**
 * The view model the UI renders.
 *
 * Derived from the wire, never hand-authored: `reducer.ts` folds ACP session
 * updates and Alnair's `_alnair/session/update` notifications into these
 * shapes. That split is the point — a protocol bump touches the reducer, not
 * the components.
 *
 * Fields exist only if something on the wire (or in the catalog) can produce
 * them. Where the agent sends less than the UI would like, the UI says less.
 */

/* ------------------------------------------------------------------ status */

export type TurnRole = 'user' | 'assistant' | 'system';

/** `acp::ToolCallStatus` folded onto the four states a row can show. */
export type PartStatus = 'pending' | 'running' | 'complete' | 'error';

/** `StopReason` plus the pre-response states. */
export type TurnStatus = 'streaming' | 'complete' | 'cancelled' | 'refused' | 'error';

export type SessionStatus = 'running' | 'idle' | 'attention';

/* ------------------------------------------------------------------- files */

/** One line of a file, numbered as it appears on disk. */
export interface NumberedLine {
	n: number;
	text: string;
}

/** One line of a unified diff, carrying its number on each side. */
export interface DiffLine {
	kind: 'context' | 'add' | 'remove';
	/** Line number in the file before the change; absent on added lines. */
	oldNumber?: number;
	/** Line number in the file after the change; absent on removed lines. */
	newNumber?: number;
	text: string;
}

export interface DiffHunk {
	id: string;
	/** The `@@ -a,b +c,d @@` header, shown as the hunk separator. */
	header: string;
	lines: DiffLine[];
}

/** `read` on a text file: the lines the agent actually saw. */
export interface FileReadPart {
	kind: 'file-read';
	id: string;
	path: string;
	language: string;
	lines: NumberedLine[];
	status: PartStatus;
	durationMs?: number;
}

/** `write` on a file: the whole content, numbered. */
export interface FileWritePart {
	kind: 'file-write';
	id: string;
	path: string;
	language: string;
	lines: NumberedLine[];
	/** `false` when the agent overwrote an existing file (it sent an `oldText`). */
	created: boolean;
	status: PartStatus;
	durationMs?: number;
}

/** `edit` on a file: hunks with the line numbers on both sides. */
export interface FileEditPart {
	kind: 'file-edit';
	id: string;
	path: string;
	language: string;
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
	status: PartStatus;
	durationMs?: number;
}

/** `read` on an image: the bytes the agent was given, or a resolvable URI. */
export interface ImageReadPart {
	kind: 'image-read';
	id: string;
	path: string;
	/** Data URL, or a same-origin path when the agent sent a `uri`. */
	src: string;
	mime: string;
	/** Only when the agent reported them; the wire does not require it. */
	width?: number;
	height?: number;
	bytes?: number;
	status: PartStatus;
	durationMs?: number;
}

/* -------------------------------------------------------------------- turn */

export interface TextPart {
	kind: 'text';
	id: string;
	text: string;
}

export interface ReasoningPart {
	kind: 'reasoning';
	id: string;
	text: string;
	status: PartStatus;
	durationMs?: number;
}

/** Any tool call that has no richer row of its own. */
export interface ToolPart {
	kind: 'tool';
	id: string;
	name: string;
	/** The agent's own one-line title, already formatted. */
	summary: string;
	input?: string;
	output?: string;
	status: PartStatus;
	durationMs?: number;
}

/** An `execute` tool call: the command and what it printed. */
export interface TerminalPart {
	kind: 'terminal';
	id: string;
	command: string;
	cwd?: string;
	output: string;
	exitCode?: number;
	status: PartStatus;
	durationMs?: number;
	/** Set when the task outlived the call and kept running. */
	backgrounded?: boolean;
	taskId?: string;
	outputFile?: string;
}

/** A subagent, folded from spawned / progress / finished. */
export interface SubagentPart {
	kind: 'subagent';
	id: string;
	title: string;
	agent: string;
	model?: string;
	status: PartStatus;
	turnCount: number;
	toolCallCount: number;
	tokensUsed: number;
	toolsUsed: string[];
	result?: string;
	error?: string;
}

export interface DiffPart {
	kind: 'diff';
	id: string;
	path: string;
	patch: string;
	additions: number;
	deletions: number;
}

export interface ErrorPart {
	kind: 'error';
	id: string;
	title: string;
	message: string;
	detail?: string;
}

/**
 * A one-line system notice: a retry, a compaction, a model switch, a recap.
 * Alnair emits these as distinct updates; the UI shows them the same way.
 */
export interface NoticePart {
	kind: 'notice';
	id: string;
	tone: 'info' | 'warning' | 'success';
	title: string;
	detail?: string;
}

/**
 * A blocking permission request. The turn is parked until it is answered, so
 * this part lives in the thread next to the tool call it gates.
 */
export interface PermissionPart {
	kind: 'permission';
	id: string;
	toolCallId: string;
	title: string;
	/** Tool kind, so the card can show the right accent. */
	toolKind: string;
	options: { optionId: string; name: string; kind: string }[];
	/** `true` once the agent reports the interaction resolved. */
	resolved: boolean;
}

/** One selectable choice in a questionnaire. */
export interface QuestionChoice {
	label: string;
	description: string;
	/** A longer explanation shown while the choice is focused. */
	preview?: string;
}

export interface QuestionPrompt {
	/** The question text; also the key the agent reads answers back under. */
	question: string;
	choices: QuestionChoice[];
	/** Zero or more choices may be picked. */
	multiSelect: boolean;
}

/**
 * A parked `alnair/ask_user_question`. The agent blocks until every question
 * it sent is answered or the questionnaire is dismissed.
 */
export interface QuestionPart {
	kind: 'question';
	id: string;
	toolCallId: string;
	questions: QuestionPrompt[];
	/** `default` offers accept/cancel; `plan` adds the two interview exits. */
	mode: 'default' | 'plan';
	resolved: boolean;
}

export type TurnPart =
	| TextPart
	| ReasoningPart
	| ToolPart
	| TerminalPart
	| SubagentPart
	| DiffPart
	| ErrorPart
	| NoticePart
	| PermissionPart
	| QuestionPart
	| FileReadPart
	| FileWritePart
	| FileEditPart
	| ImageReadPart;

export interface Turn {
	id: string;
	role: TurnRole;
	status: TurnStatus;
	/** ISO timestamp. */
	at: string;
	/** Catalog key of the model that ran this turn. */
	modelId?: string;
	effort?: string;
	durationMs?: number;
	/** The `promptId` the agent reported in `turn_completed`. */
	promptId?: string;
	parts: TurnPart[];
}

/* ----------------------------------------------------------------- session */

/**
 * One row of `alnair/session/list`. Every field except `status` comes straight
 * off the wire; `status` is derived from that session's live transcript.
 */
export interface Session {
	id: string;
	/** `summary` on the wire: the generated title, else the first prompt. */
	title: string;
	cwd: string;
	branch?: string;
	/** Catalog key, when the agent reported one. */
	modelId?: string;
	/** `local`, `remote`, or `both`. */
	source: string;
	numMessages: number;
	createdAt: string;
	updatedAt: string;
	/** `alnair/session.kind` from the row envelope. */
	kind?: string;
	/**
	 * The workspace this session belongs to: `repoName` from the wire, which
	 * the agent derives from the cwd (`repo_name_from_cwd`). Sessions with the
	 * same value are one group in the sidebar.
	 */
	workspace: string;
	/** The repo root, when the agent reported one. */
	gitRootDir?: string;
	/** Derived: a live turn, a parked request, or neither. */
	status: SessionStatus;
}

/**
 * A workspace and the conversations inside it. This is the shape the session
 * list has on the wire — flat rows that name their repo — regrouped for the
 * sidebar, which nests conversations under their workspace.
 */
export interface WorkspaceGroup {
	/** `repoName`, or the cwd's last segment when the agent sent none. */
	name: string;
	/** Absolute path of the workspace root, when known. */
	path?: string;
	sessions: Session[];
	/** Newest `updatedAt` in the group; drives group ordering. */
	updatedAt: string;
	/** `true` when one of its sessions has a live turn or a parked request. */
	active: boolean;
}

/* ------------------------------------------------------- plan and todos */

/**
 * One entry of the agent's plan — the ACP `plan` update, which is what the
 * `todo_write` tool produces. The header popover reads this.
 */
export interface TodoItem {
	/** Stable index within the plan; `PlanEntry` carries no id of its own. */
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
	priority: 'high' | 'medium' | 'low';
	detail?: string;
}

/**
 * The plan document under review (`alnair/exit_plan_mode`). Distinct from the
 * todo list: this is the artifact the user approves, not the step tracker.
 */
export interface PlanArtifact {
	title: string;
	path?: string;
	updatedAt?: string;
	markdown: string;
}

/* ------------------------------------------------------------------ graph */

/**
 * `graph_updated` is a summary, not a DAG: counts, the current node, and the
 * budget. The inspector renders exactly this.
 */
export interface GraphState {
	id: string;
	objective: string;
	/** Goal vocabulary: `active`, paused variants, `budget_limited`, `complete`. */
	status: string;
	/** `idle`, `planning`, or `executing`. */
	phase: string;
	planVersion: number;
	total: number;
	achieved: number;
	failed: number;
	running: number;
	currentNode?: string;
	currentNodeTitle?: string;
	tokenBudget?: number;
	tokensSpent: number;
	lastEvent?: string;
	pauseMessage?: string;
}

/* ----------------------------------------------------------------- models */

export interface ModelOption {
	/** Catalog key, e.g. `kimi-code/kimi-k2-turbo-preview`. */
	id: string;
	label: string;
	provider: string;
	/** Canonical efforts the model accepts; empty when it has none. */
	efforts: string[];
	contextWindow: number;
}

/**
 * Context usage. The wire sends a total and the window, not a per-category
 * breakdown, so there is no `segments` here.
 */
export interface ContextUsage {
	used: number;
	limit: number;
	/** 0–100. */
	percent: number;
}

/**
 * How much the agent may do without asking. These are the three modes the
 * runtime actually has (`PermissionMode` in `alnair-config-types`), not a UI
 * invention.
 */
export type AccessMode = 'ask' | 'auto' | 'always-approve';

/** The composer's view of the workspace and the agent's access. */
export interface ComposerContext {
	/** `repoName`, or the cwd's last segment. */
	workspace: string;
	branch?: string;
	/** Branch, checkout, or worktree — the source of the code being edited. */
	checkout: 'branch' | 'worktree' | 'detached';
	access: AccessMode;
}

export interface WorkspaceInfo {
	name: string;
	path: string;
	branch?: string;
	ahead: number;
	behind: number;
	dirty: boolean;
}

/* ------------------------------------------------------------------ store */

/** A parked permission request, surfaced above the composer. */
export interface PermissionRequest {
	toolCallId: string;
	title: string;
	options: { optionId: string; name: string; kind: string }[];
}

/** A parked questionnaire, surfaced above the composer. */
export interface QuestionRequest {
	toolCallId: string;
	questions: QuestionPrompt[];
	mode: 'default' | 'plan';
}

/* ------------------------------------------------------- mention & command */

/**
 * A file or directory the `@` menu can insert.
 *
 * Source: `alnair/fs/list`, whose `FsListNode` carries `name`, `path`, `type`
 * (`file` | `directory`), and optional `size`. The menu lists one directory at
 * a time, so a directory row is a drill-down rather than an insertable mention.
 */
export interface FileEntry {
	name: string;
	/** Path relative to the workspace root, as the agent reports it. */
	path: string;
	type: 'file' | 'directory';
	size?: number;
}

/**
 * A slash command the agent advertised. Source: ACP
 * `available_commands_update`, whose `AvailableCommand` carries `name`,
 * `description`, and an optional `input.hint`.
 */
export interface SlashCommand {
	/** Without the leading slash. */
	name: string;
	description: string;
	/** Placeholder for the argument, e.g. `<path>`. */
	hint?: string;
}

/** One question's answer, in the shape the agent reads back. */
export interface QuestionAnswer {
	/** Labels in the order the user picked them. */
	labels: string[];
	/** Free text typed into the freeform input, when it was used. */
	notes?: string;
}

export interface AvailableCommand {
	name: string;
	description: string;
	hint?: string;
}
