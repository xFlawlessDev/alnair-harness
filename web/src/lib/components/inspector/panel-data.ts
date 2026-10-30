import { fileName } from '#lib/harness/format.js';
import type { GitContext, Turn, TurnPart } from '#lib/harness/types.js';

/**
 * A file the thread touched, and what the reader can do with it now.
 *
 * Both panels read the same list: "Files" shows what changed, and "Preview"
 * opens the one that was picked. It is derived from the transcript rather than
 * from git, because a turn's edits exist even outside a repository — and a
 * second, git-shaped list would disagree with the thread about what changed.
 */
export interface TouchedFile {
	/** As the part reported it: absolute, or relative to the workspace. */
	path: string;
	/** `read`, `edit`, `write`, `overwrite`, `read image`. */
	action: string;
	additions: number;
	deletions: number;
	/**
	 * The newest content the transcript carries for this file, when it does.
	 *
	 * A `file-read` and a `file-write` both carry the file's lines; an `edit`
	 * carries only hunks. So this is present for two of the three and the
	 * preview falls back to the diff when it is not.
	 */
	content?: string;
	/** Lines for the numbered preview, already in order. */
	lines?: { n: number; text: string }[];
	/** The unified patch, for a file whose only record is an edit. */
	patch?: string;
	kind: 'file' | 'image';
	/** An image's data URL, when the agent sent the bytes. */
	src?: string;
	language: string;
}

/**
 * Every file the thread mentions, newest record winning.
 *
 * "Newest" matters: a file read at the start and edited at the end must show
 * the edit, or the preview would offer the reader the stale copy the agent saw
 * before it changed anything.
 */
export function touchedFiles(turns: Turn[]): TouchedFile[] {
	const byPath = new Map<string, TouchedFile>();

	for (const turn of turns) {
		for (const part of turn.parts) {
			const file = touchedFileFrom(part);
			if (!file) continue;
			byPath.set(file.path, mergeTouched(byPath.get(file.path), file));
		}
	}

	return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function touchedFileFrom(part: TurnPart): TouchedFile | undefined {
	switch (part.kind) {
		case 'file-read':
			return {
				path: part.path,
				action: 'read',
				additions: 0,
				deletions: 0,
				content: part.lines.map((line) => line.text).join('\n'),
				lines: part.lines,
				kind: 'file',
				language: part.language
			};
		case 'file-write':
			return {
				path: part.path,
				action: part.created ? 'write' : 'overwrite',
				additions: part.lines.length,
				deletions: 0,
				content: part.lines.map((line) => line.text).join('\n'),
				lines: part.lines,
				kind: 'file',
				language: part.language
			};
		case 'file-edit':
			return {
				path: part.path,
				action: 'edit',
				additions: part.additions,
				deletions: part.deletions,
				patch: part.hunks
					.map(
						(hunk) =>
							`${hunk.header}\n${hunk.lines
								.map(
									(line) =>
										`${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`
								)
								.join('\n')}`
					)
					.join('\n'),
				kind: 'file',
				language: part.language
			};
		case 'image-read':
			return {
				path: part.path,
				action: 'read image',
				additions: 0,
				deletions: 0,
				kind: 'image',
				src: part.src,
				language: 'image'
			};
		default:
			return undefined;
	}
}

/**
 * Combine two records of the same path.
 *
 * A later record with content wins outright. A later record WITHOUT content (an
 * edit, which carries only hunks) must not erase the content an earlier read
 * already gave — but its counts are the newer truth, so they are kept.
 */
function mergeTouched(previous: TouchedFile | undefined, next: TouchedFile): TouchedFile {
	if (!previous) return next;
	return {
		...previous,
		...next,
		content: next.content ?? previous.content,
		lines: next.lines ?? previous.lines,
		src: next.src ?? previous.src,
		patch: next.patch ?? previous.patch,
		kind: next.kind
	};
}

/** The file's extension, which is what both the highlighter and Monaco key on. */
export function extensionOf(path: string): string {
	const base = fileName(path);
	const dot = base.lastIndexOf('.');
	return dot <= 0 ? '' : base.slice(dot + 1);
}

/**
 * One entry of the working tree, as `alnair/git/status` reports it.
 *
 * The two lists the wire sends (`staged`, `unstaged`) are flattened into one,
 * because a reader looking at "what changed" wants the file once, not twice
 * under two headings they did not ask for.
 */
export interface GitChange {
	path: string;
	/** `added`, `modified`, `deleted`, `renamed`, `untracked`, … */
	type: string;
	staged: boolean;
	additions: number;
	deletions: number;
}

interface RawChange {
	path?: unknown;
	oldPath?: unknown;
	type?: unknown;
	staged?: unknown;
	additions?: unknown;
	deletions?: unknown;
}

/** Flatten `GitStatusData`'s two lists into one, keyed by path. */
export function gitChanges(status: unknown): GitChange[] {
	if (!status || typeof status !== 'object') return [];
	const record = status as { staged?: unknown; unstaged?: unknown };
	const byPath = new Map<string, GitChange>();

	const read = (list: unknown, staged: boolean) => {
		if (!Array.isArray(list)) return;
		for (const entry of list as RawChange[]) {
			const path = typeof entry.path === 'string' ? entry.path : '';
			if (!path) continue;
			const change: GitChange = {
				path,
				type: typeof entry.type === 'string' ? entry.type : 'modified',
				staged,
				additions: typeof entry.additions === 'number' ? entry.additions : 0,
				deletions: typeof entry.deletions === 'number' ? entry.deletions : 0
			};
			const existing = byPath.get(path);
			// A file can be both staged and modified again; staged is the more
			// useful half to report, and the counts are summed so nothing hides.
			byPath.set(
				path,
				existing
					? {
							...existing,
							staged: existing.staged || staged,
							additions: existing.additions + change.additions,
							deletions: existing.deletions + change.deletions
						}
					: change
			);
		}
	};

	read(record.staged, true);
	read(record.unstaged, false);
	return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The repository a session works in, or `undefined` outside one. */
export function repoLabel(git: GitContext | undefined): string {
	return git?.root ? fileName(git.root) || git.root : '';
}
