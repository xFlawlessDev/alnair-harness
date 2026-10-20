/**
 * Wire-shaped types for the web harness.
 *
 * These are deliberately *not* the Rust ACP types: they are the view model the
 * UI renders, and the mock layer fills them in today. When the harness is wired
 * up, an adapter maps ACP session updates onto these shapes and nothing in the
 * components below has to change.
 */

export type TurnRole = 'user' | 'assistant' | 'system';

export type PartStatus = 'pending' | 'running' | 'complete' | 'error';

export type TurnStatus = 'queued' | 'streaming' | 'complete' | 'error' | 'cancelled';

export interface PlanStep {
	id: string;
	title: string;
	status: PartStatus;
}

export interface Source {
	id: string;
	title: string;
	url: string;
	host: string;
	snippet?: string;
}

export interface TestCase {
	name: string;
	status: 'passed' | 'failed' | 'skipped';
	durationMs: number;
	message?: string;
}

export interface TestSuite {
	id: string;
	name: string;
	status: 'passed' | 'failed' | 'running';
	cases: TestCase[];
}

export interface SubagentStep {
	id: string;
	label: string;
	detail?: string;
	status: PartStatus;
}

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

export interface ToolPart {
	kind: 'tool';
	id: string;
	name: string;
	/** One-line summary of the call, already formatted for display. */
	summary: string;
	input?: string;
	output?: string;
	status: PartStatus;
	durationMs?: number;
}

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
	/** Total lines in the file, when the read was a window into it. */
	totalLines?: number;
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
	/** Set when the preview is capped below the real file length. */
	hiddenLines?: number;
	/** `false` for an overwrite of an existing file. */
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

/** `read` on an image: a preview plus the metadata the agent was given. */
export interface ImageReadPart {
	kind: 'image-read';
	id: string;
	path: string;
	/** Data URL or a same-origin path. */
	src: string;
	mime: string;
	width: number;
	height: number;
	bytes: number;
	status: PartStatus;
	durationMs?: number;
}

export interface TodoItem {
	id: string;
	title: string;
	status: PartStatus;
	/** Optional note shown under the title. */
	detail?: string;
}

export interface PlanDocument {
	title: string;
	/** Path of the plan file, as the agent wrote it. */
	path: string;
	updatedAt: string;
	markdown: string;
}

export interface TerminalPart {
	kind: 'terminal';
	id: string;
	command: string;
	cwd: string;
	output: string;
	exitCode?: number;
	status: PartStatus;
	durationMs?: number;
}

export interface PlanPart {
	kind: 'plan';
	id: string;
	title: string;
	steps: PlanStep[];
}

export interface SubagentPart {
	kind: 'subagent';
	id: string;
	title: string;
	agent: string;
	model: string;
	steps: SubagentStep[];
	result?: string;
	status: PartStatus;
}

export interface TestsPart {
	kind: 'tests';
	id: string;
	title: string;
	command: string;
	suites: TestSuite[];
	status: PartStatus;
}

export interface CheckpointPart {
	kind: 'checkpoint';
	id: string;
	label: string;
	detail: string;
}

export interface SourcesPart {
	kind: 'sources';
	id: string;
	title: string;
	sources: Source[];
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

export type TurnPart =
	| TextPart
	| ReasoningPart
	| ToolPart
	| TerminalPart
	| PlanPart
	| SubagentPart
	| TestsPart
	| CheckpointPart
	| SourcesPart
	| DiffPart
	| ErrorPart
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
	model?: string;
	effort?: string;
	durationMs?: number;
	parts: TurnPart[];
}

export type SessionStatus = 'running' | 'idle' | 'attention';

export interface Session {
	id: string;
	title: string;
	cwd: string;
	branch: string;
	model: string;
	status: SessionStatus;
	updatedAt: string;
	/** Total tokens billed in this session so far. */
	tokens: number;
	unread?: boolean;
}

export type GraphNodeStatus = 'pending' | 'ready' | 'running' | 'achieved' | 'blocked' | 'failed';

export interface GraphNode {
	id: string;
	title: string;
	status: GraphNodeStatus;
	dependsOn: string[];
	/** Fraction of the node's own budget already spent, 0–1. */
	budgetUsed?: number;
}

export interface GraphState {
	id: string;
	objective: string;
	planVersion: number;
	status: 'running' | 'paused' | 'achieved';
	concurrency: number;
	nodes: GraphNode[];
}

export interface ModelOption {
	id: string;
	label: string;
	provider: string;
	efforts: string[];
	contextWindow: number;
}

export interface ContextUsage {
	used: number;
	limit: number;
	/** Breakdown in tokens; rendered as a small stacked bar. */
	segments: { label: string; tokens: number }[];
}

export interface WorkspaceInfo {
	name: string;
	path: string;
	branch: string;
	ahead: number;
	behind: number;
	dirty: boolean;
}
