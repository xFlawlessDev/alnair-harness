import { describe, expect, it } from 'vitest';
import type { FileReadPart, PartStatus, TurnPart } from '#lib/harness/types.js';
import {
	groupVerbRuns,
	verbGroupDetail,
	verbGroupKindOf,
	verbGroupLabel,
	runStepOf
} from './verb-group.js';

/**
 * The verb-group rules.
 *
 * These mirror the TUI's `verb_group.rs` tests on purpose: the two surfaces
 * must fold the same runs and print the same label, or the same transcript
 * reads differently depending on which one the reader opened.
 */

const read = (id: string, path = `${id}.ts`): FileReadPart => ({
	kind: 'file-read',
	id,
	path,
	language: 'typescript',
	lines: [],
	status: 'complete'
});

const image = (id: string): TurnPart => ({
	kind: 'image-read',
	id,
	path: `${id}.png`,
	src: 'data:image/png;base64,AA',
	mime: 'image/png',
	status: 'complete'
});

const tool = (id: string, name: string, status: PartStatus = 'complete'): TurnPart => ({
	kind: 'tool',
	id,
	name,
	summary: `${name} ran`,
	status
});

const terminal = (id: string): TurnPart => ({
	kind: 'terminal',
	id,
	command: 'cargo check',
	output: '',
	status: 'complete'
});

const edit = (id: string): TurnPart => ({
	kind: 'file-edit',
	id,
	path: `${id}.ts`,
	language: 'typescript',
	hunks: [],
	additions: 1,
	deletions: 0,
	status: 'complete'
});

const subagent = (id: string, title = 'scan the palette'): TurnPart => ({
	kind: 'subagent',
	id,
	title,
	agent: 'explore',
	status: 'complete',
	turnCount: 1,
	toolCallCount: 2,
	tokensUsed: 100,
	toolsUsed: []
});

const reasoning = (id: string): TurnPart => ({
	kind: 'reasoning',
	id,
	text: 'hmm',
	status: 'complete'
});

describe('verbGroupKindOf', () => {
	it('classifies reads, searches and subagents', () => {
		expect(verbGroupKindOf(read('a'))).toBe('file');
		expect(verbGroupKindOf(tool('b', 'grep'))).toBe('search');
		expect(verbGroupKindOf(tool('c', 'list_dir'))).toBe('dir');
		expect(verbGroupKindOf(subagent('d'))).toBe('subagent');
	});

	it('reads a SKILL.md as a skill, not a plain file', () => {
		expect(verbGroupKindOf(read('s', '/repo/.alnair/skills/deploy/SKILL.md'))).toBe('skill');
	});

	it('never folds a command, an edit or an unknown tool', () => {
		// The whole point of the fold is that it only hides steps a reader does
		// not need to audit. A destructive call folded into a count would be
		// the one mistake this feature must not make.
		expect(verbGroupKindOf(terminal('t'))).toBeUndefined();
		expect(verbGroupKindOf(edit('e'))).toBeUndefined();
		expect(verbGroupKindOf(tool('u', 'run_terminal_command'))).toBeUndefined();
		expect(verbGroupKindOf(tool('v', 'write_file'))).toBeUndefined();
	});
});

describe('runStepOf', () => {
	it('treats a thought as transparent rather than a break', () => {
		// A thought between two reads must not split the run into two headers.
		expect(runStepOf(reasoning('r'))).toEqual({ kind: 'transparent' });
	});

	it('breaks on a command', () => {
		expect(runStepOf(terminal('t'))).toEqual({ kind: 'break' });
	});
});

describe('verbGroupLabel', () => {
	it('buckets in first-appearance order with plurality', () => {
		const label = verbGroupLabel([read('a'), tool('b', 'grep'), read('c'), tool('d', 'list_dir')]);
		expect(label.text).toBe('Read 2 files, Searched 1 pattern, Listed 1 dir');
		expect(label.running).toBe(false);
		expect(label.failed).toBe(0);
	});

	it('separates skills from plain files', () => {
		const label = verbGroupLabel([read('a'), read('s', '/repo/skills/deploy/SKILL.md'), read('b')]);
		expect(label.text).toBe('Read 2 files, Read 1 skill');
	});

	it('counts an image read as a file', () => {
		expect(verbGroupLabel([read('a'), image('i')]).text).toBe('Read 2 files');
	});

	it('flips tense while any member is running', () => {
		const label = verbGroupLabel([read('a'), tool('b', 'grep', 'running')]);
		expect(label.text).toBe('Reading 1 file, Searching 1 pattern');
		expect(label.running).toBe(true);
	});

	it('counts failures so the header can say so', () => {
		const label = verbGroupLabel([read('a'), { ...read('b'), status: 'error' }]);
		expect(label.failed).toBe(1);
	});
	it('counts subagents by their own row', () => {
		expect(verbGroupLabel([subagent('a'), subagent('b')]).text).toBe('Ran 2 subagents');
	});
});

describe('groupVerbRuns', () => {
	it('folds a run of reads into one segment', () => {
		const segments = groupVerbRuns([read('a'), read('b'), read('c')]);
		expect(segments).toHaveLength(1);
		expect(segments[0].kind).toBe('run');
		if (segments[0].kind !== 'run') return;
		expect(segments[0].run.members.map((part) => part.id)).toEqual(['a', 'b', 'c']);
	});

	it('folds a single member too, so the header does not pop in later', () => {
		const segments = groupVerbRuns([read('a')]);
		expect(segments).toHaveLength(1);
		expect(segments[0].kind).toBe('run');
	});

	it('ends the run at a command and starts a new one after it', () => {
		const segments = groupVerbRuns([read('a'), terminal('t'), read('b')]);
		expect(segments.map((segment) => segment.kind)).toEqual(['run', 'single', 'run']);
	});

	it('keeps a thought as its own row without splitting the run', () => {
		// Two runs would mean two headers for what the reader sees as one block
		// of work.
		const segments = groupVerbRuns([read('a'), reasoning('r'), read('b')]);
		expect(segments.map((segment) => segment.kind)).toEqual(['run', 'single', 'run']);
		const runs = segments.filter((segment) => segment.kind === 'run');
		expect(runs).toHaveLength(2);
	});

	it('leaves an edit standalone', () => {
		const segments = groupVerbRuns([read('a'), edit('e'), read('b')]);
		expect(segments.map((segment) => segment.kind)).toEqual(['run', 'single', 'run']);
	});

	it('returns nothing for an empty list', () => {
		expect(groupVerbRuns([])).toEqual([]);
	});
});

describe('verbGroupDetail', () => {
	it('names the first member', () => {
		const [first] = groupVerbRuns([read('a', 'src/deep/file.ts')]);
		if (first.kind !== 'run') throw new Error('expected a run');
		expect(verbGroupDetail(first.run)).toBe('file.ts');
	});

	it('uses the subagent title', () => {
		const [first] = groupVerbRuns([subagent('a', 'scan the palette')]);
		if (first.kind !== 'run') throw new Error('expected a run');
		expect(verbGroupDetail(first.run)).toBe('scan the palette');
	});
});
