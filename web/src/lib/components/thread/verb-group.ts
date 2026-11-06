import { fileName } from '#lib/harness/format.js';
import type { TurnPart } from '#lib/harness/types.js';

/**
 * Verb-group aggregation: the "Read 3 files, Searched 2 patterns" header for a
 * run of consecutive non-destructive tool calls.
 *
 * This is a port of the TUI's `scrollback/state/verb_group.rs`, and the rules
 * are deliberately the same ones:
 *
 * - only NON-DESTRUCTIVE calls join a run. A shell command, a file edit and an
 *   MCP dispatch are excluded, because folding an action away hides the step
 *   the reader most needs to audit. The TUI calls this
 *   `ToolCallBlock::verb_group_kind`; here it is `verbGroupKindOf`;
 * - subagent rows join too — a fan-out is a step, not an answer;
 * - one member is enough to fold. Waiting for a second would make the header
 *   pop into existence mid-turn, which reads as a layout jump;
 * - the label counts by kind in FIRST-APPEARANCE order, so the header does not
 *   reorder itself as the run grows.
 *
 * The one deliberate difference: the TUI also folds finished collapsed
 * thoughts into a run. The browser hides reasoning rows entirely when
 * `show_thinking` is off, and the reducer settles them when the answer starts,
 * so a thought here is either visible-and-its-own-row or absent. Treating it
 * as transparent (it neither joins nor breaks) reproduces the TUI's behaviour
 * for the case that matters — a thought between two reads must not split the
 * run — without inventing a fold for a row the browser may not render.
 */

/** Semantic class of a verb-groupable run member. Mirrors `VerbGroupKind`. */
export type VerbGroupKind =
	| 'file'
	| 'skill'
	| 'search'
	| 'dir'
	| 'web-fetch'
	| 'web-search'
	| 'memory-search'
	| 'integration-search'
	| 'subagent';

/**
 * The kind of step a part is, when it may join a verb run.
 *
 * `undefined` means "cannot be a member": either destructive, or not a step at
 * all. The mapping follows what the reducer actually produced — a `read` that
 * returned an image is an `image-read`, a `write` is a `file-write`, and so on
 * — so this reads the PART, not the wire tool call.
 */
export function verbGroupKindOf(part: TurnPart): VerbGroupKind | undefined {
	switch (part.kind) {
		case 'file-read':
			return isSkillPath(part.path) ? 'skill' : 'file';
		case 'image-read':
			return 'file';
		case 'subagent':
			return 'subagent';
		// A plain `tool` part is the reducer's fallback, and it covers both
		// non-destructive searches and destructive calls. The name is the only
		// discriminator available, so it is matched explicitly; anything not
		// named stays standalone rather than being folded on a guess.
		case 'tool':
			return kindOfToolName(part.name);
		default:
			return undefined;
	}
}

/**
 * The TUI's `is_skill_read`: a read of a `SKILL.md` under a skills directory.
 *
 * Matching the trailing path segment is what the TUI does, and it is the only
 * signal the browser has — the wire carries a path, not a "this was a skill"
 * flag.
 */
function isSkillPath(path: string): boolean {
	const normalized = path.replace(/\\/g, '/');
	return (
		/(^|\/)skills?\/[^/]+\/SKILL\.md$/i.test(normalized) || /(^|\/)SKILL\.md$/i.test(normalized)
	);
}

/**
 * Classify a fallback tool row by its model-facing name.
 *
 * Only the read-only discovery tools are listed. `run_terminal_command`,
 * `read_file` (which arrives as a `file-read` part, not here), `write_file` and
 * the rest are absent on purpose: an unknown name must never fold, because
 * folding a destructive call into a count is exactly the mistake this feature
 * must not make.
 */
function kindOfToolName(name: string): VerbGroupKind | undefined {
	switch (name) {
		case 'grep':
		case 'glob':
		case 'search_files':
		case 'codebase_search':
			return 'search';
		case 'list_dir':
		case 'list_directory':
		case 'ls':
			return 'dir';
		case 'web_fetch':
			return 'web-fetch';
		case 'web_search':
			return 'web-search';
		case 'memory_search':
			return 'memory-search';
		case 'search_tool':
			return 'integration-search';
		default:
			return undefined;
	}
}

/** Present tense while the run is moving, past once it settles. */
const VERBS: Record<VerbGroupKind, { past: string; present: string }> = {
	file: { past: 'Read', present: 'Reading' },
	skill: { past: 'Read', present: 'Reading' },
	search: { past: 'Searched', present: 'Searching' },
	dir: { past: 'Listed', present: 'Listing' },
	'web-fetch': { past: 'Fetched', present: 'Fetching' },
	'web-search': { past: 'Searched', present: 'Searching' },
	'memory-search': { past: 'Searched', present: 'Searching' },
	'integration-search': { past: 'Searched', present: 'Searching' },
	subagent: { past: 'Ran', present: 'Running' }
};

const NOUNS: Record<VerbGroupKind, { one: string; many: string }> = {
	file: { one: 'file', many: 'files' },
	skill: { one: 'skill', many: 'skills' },
	search: { one: 'pattern', many: 'patterns' },
	dir: { one: 'dir', many: 'dirs' },
	'web-fetch': { one: 'website', many: 'websites' },
	'web-search': { one: 'website', many: 'websites' },
	'memory-search': { one: 'memory', many: 'memories' },
	'integration-search': { one: 'MCP tool', many: 'MCP tools' },
	subagent: { one: 'subagent', many: 'subagents' }
};

/** One bucket of the aggregated label. */
export interface VerbGroupBucket {
	kind: VerbGroupKind;
	count: number;
}

export interface VerbGroupLabel {
	/** `Read 3 files, Searched 2 patterns`, in first-appearance order. */
	text: string;
	/** Any member still running — the header wears the running accent. */
	running: boolean;
	/** How many members failed; the header appends `· N failed`. */
	failed: number;
}

/** A run of consecutive verb-groupable parts. */
export interface VerbRun {
	/** The member parts, in order. */
	members: TurnPart[];
	/** The aggregated label. */
	label: VerbGroupLabel;
}

/**
 * Whether a part may join a run, and under which bucket.
 *
 * A part that is not a member but also must not BREAK the run — a reasoning
 * row, which the browser may render between two reads — returns `'transparent'`.
 * Everything else breaks it.
 */
export type RunStep =
	{ kind: 'member'; bucket: VerbGroupKind } | { kind: 'transparent' } | { kind: 'break' };

export function runStepOf(part: TurnPart): RunStep {
	if (part.kind === 'reasoning') return { kind: 'transparent' };
	const bucket = verbGroupKindOf(part);
	return bucket ? { kind: 'member', bucket } : { kind: 'break' };
}

/**
 * Build the label for a run of members.
 *
 * Counts are per kind in first-appearance order. A subagent is counted by its
 * own row rather than by child session, because the browser's `SubagentPart` is
 * already one row per subagent — the TUI's distinct-source override exists to
 * collapse a started row and a terminal row that the browser never produces.
 */
export function verbGroupLabel(members: TurnPart[]): VerbGroupLabel {
	const buckets: VerbGroupBucket[] = [];
	let running = false;
	let failed = 0;

	for (const part of members) {
		const kind = verbGroupKindOf(part);
		if (!kind) continue;
		const found = buckets.find((bucket) => bucket.kind === kind);
		if (found) found.count += 1;
		else buckets.push({ kind, count: 1 });

		if ('status' in part && (part.status === 'running' || part.status === 'pending'))
			running = true;
		if ('status' in part && part.status === 'error') failed += 1;
	}

	const text = buckets
		.map((bucket) => {
			const verb = VERBS[bucket.kind][running ? 'present' : 'past'];
			const noun = NOUNS[bucket.kind][bucket.count === 1 ? 'one' : 'many'];
			return `${verb} ${bucket.count} ${noun}`;
		})
		.join(', ');

	return { text, running, failed };
}

/**
 * Group a flat part list into runs of verb-groupable members.
 *
 * Returns the segments in order, where each entry is either a `run` (folded
 * into one header row) or a `single` part (rendered on its own). Transparent
 * parts are emitted as singles so they keep their own row inside the run, which
 * is what the TUI does with a visible thought.
 *
 * The caller decides whether to fold at all — this is pure structure, so a
 * setting that turns grouping off simply does not call it.
 */
export type VerbSegment = { kind: 'run'; run: VerbRun } | { kind: 'single'; part: TurnPart };

export function groupVerbRuns(parts: TurnPart[]): VerbSegment[] {
	const segments: VerbSegment[] = [];
	let run: TurnPart[] = [];

	const flush = () => {
		if (run.length > 0) {
			segments.push({ kind: 'run', run: { members: run, label: verbGroupLabel(run) } });
			run = [];
		}
	};

	for (const part of parts) {
		const step = runStepOf(part);
		if (step.kind === 'member') {
			run.push(part);
			continue;
		}
		if (step.kind === 'transparent') {
			// A thought between two reads must not split the run, and it keeps
			// its own row. The run SO FAR has to be emitted first, or the members
			// before the thought would be folded into a segment that comes after
			// it — the header would appear below the rows it summarizes.
			flush();
			segments.push({ kind: 'single', part });
			continue;
		}
		flush();
		segments.push({ kind: 'single', part });
	}

	flush();
	return segments;
}

/** The first member's own one-line detail, for a collapsed header. */
export function verbGroupDetail(run: VerbRun): string | undefined {
	const first = run.members[0];
	if (!first) return undefined;
	if (first.kind === 'file-read' || first.kind === 'file-write' || first.kind === 'file-edit') {
		return fileName(first.path);
	}
	if (first.kind === 'image-read') return fileName(first.path);
	if (first.kind === 'subagent') return first.title;
	if (first.kind === 'tool') return first.summary;
	return undefined;
}
