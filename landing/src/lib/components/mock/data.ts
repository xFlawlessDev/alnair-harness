/**
 * Mockup tokens.
 *
 * Every card in the Features section shows a piece of the real interface, so
 * the mockups read the same strings the terminal does. Those strings do not
 * get translated — they are what the program prints — which is why they live
 * here rather than in `content/`: the dictionaries hold prose, this holds
 * chrome.
 *
 * Layout numbers are the ones the TUI actually uses where they matter (status
 * glyphs, the `❯` prompt marker, the `repo ⎇ branch` tab label); anything
 * smaller is stylistic and marked as such.
 */

export type Tone = 'plain' | 'dim' | 'muted' | 'accent' | 'ok' | 'info' | 'err' | 'warn' | 'user';

export const toneClass: Record<Tone, string> = {
	plain: 'mk-plain',
	dim: 'mk-dim',
	muted: 'mk-muted',
	accent: 'mk-accent',
	ok: 'mk-ok',
	info: 'mk-info',
	err: 'mk-err',
	warn: 'mk-warn',
	user: 'mk-user'
};

/** The state glyphs the dashboard and tab strip paint, named for their meaning. */
export const glyph = {
	working: '⣾',
	needsInput: '●',
	idle: '○',
	inactive: '⋅',
	pending: '◐',
	running: '◉',
	queued: '◌',
	verified: '✓',
	failed: '✗',
	add: '+',
	close: '×',
	branch: '⎇',
	prompt: '❯'
} as const;

/** A session row, as the dashboard draws it. */
export interface SessionRow {
	glyph: string;
	tone: Tone;
	title: string;
	activity: string;
	activityTone: Tone;
	age: string;
	selected?: boolean;
}

export const dashboardRows: SessionRow[] = [
	{
		glyph: glyph.needsInput,
		tone: 'warn',
		title: 'reviewer · audit token flow',
		activity: 'Awaiting your input',
		activityTone: 'warn',
		age: '2m',
		selected: true
	},
	{
		glyph: glyph.working,
		tone: 'info',
		title: 'implementer · fix login bug',
		activity: 'Running: cargo test',
		activityTone: 'muted',
		age: '12m'
	},
	{
		glyph: glyph.working,
		tone: 'info',
		title: 'explorer · map the auth crate',
		activity: 'Responding…',
		activityTone: 'muted',
		age: '24m'
	},
	{
		glyph: glyph.idle,
		tone: 'dim',
		title: 'housekeeping',
		activity: 'idle',
		activityTone: 'dim',
		age: '1h'
	}
];

/** A permission card. `[1]`…`[9]` are the keys that answer it. */
export interface PermissionOption {
	key: string;
	label: string;
	tone: Tone;
}

export const permissionOptions: PermissionOption[] = [
	{ key: '1', label: 'Allow once', tone: 'ok' },
	{ key: '2', label: 'Reject once', tone: 'err' },
	{ key: '3', label: 'Always allow: cargo test', tone: 'muted' },
	{ key: '4', label: 'Enable always-approve mode', tone: 'muted' }
];

/** One chip in the session tab strip. */
export interface TabChip {
	index: string;
	title: string;
	detail: string;
	active?: boolean;
	dot?: Tone;
}

export const tabChips: TabChip[] = [
	{ index: '1', title: 'fix login bug', detail: 'alnair ⎇ main', active: true, dot: 'info' },
	{ index: '2', title: 'audit token flow', detail: 'api ⎇ feat/auth', dot: 'warn' },
	{ index: '3', title: 'docs pass', detail: 'alnair ⎇ main', dot: 'dim' }
];

/** A subagent row in the parent's transcript. */
export interface SubagentRow {
	label: string;
	detail: string;
	tone: Tone;
	done?: boolean;
}

export const subagentRows: SubagentRow[] = [
	{
		label: 'explore · map the auth crate',
		detail: '12 files read · 3 findings',
		tone: 'ok',
		done: true
	},
	{
		label: 'implementer · extract the token store',
		detail: 'running · 4/7 steps',
		tone: 'info'
	},
	{
		label: 'verify · try to break the patch',
		detail: 'queued · waits on implementer',
		tone: 'dim'
	}
];

/** One MCP server row, from `alnair mcp list`. */
export interface McpRow {
	name: string;
	transport: string;
	tools: string;
	state: Tone;
	stateLabel: string;
}

export const mcpRows: McpRow[] = [
	{
		name: 'filesystem',
		transport: 'stdio',
		tools: '12 tools',
		state: 'ok',
		stateLabel: 'connected'
	},
	{ name: 'sentry', transport: 'http', tools: '6 tools', state: 'ok', stateLabel: 'connected' },
	{ name: 'postgres', transport: 'stdio', tools: '—', state: 'warn', stateLabel: 'starting' },
	{ name: 'tauri', transport: 'stdio', tools: '—', state: 'err', stateLabel: 'failed' }
];

/** A skill row, as `/skills` lists them. */
export interface SkillRow {
	name: string;
	description: string;
	active?: boolean;
}

export const skillRows: SkillRow[] = [
	{
		name: 'commit',
		description: 'Conventional commits from staged changes',
		active: true
	},
	{ name: 'review-pr', description: 'Read a PR diff and report findings' },
	{ name: 'deploy', description: 'Build, verify and ship a release' }
];

/** The hook lifecycle the mockup draws, in firing order. */
export const hookRows = [
	{ event: 'PreToolUse', matcher: 'Bash', action: 'block git push --force', tone: 'err' as Tone },
	{ event: 'PostToolUse', matcher: 'Edit|Write', action: 'cargo fmt --check', tone: 'ok' as Tone },
	{
		event: 'SessionStart',
		matcher: '*',
		action: 'inject branch + issue context',
		tone: 'info' as Tone
	}
];

/** A sandbox profile row, from `/sandbox` and the docs' profile table. */
export const sandboxRows = [
	{ profile: 'read-only', files: 'read', network: 'blocked', tone: 'dim' as Tone },
	{ profile: 'workspace-write', files: 'workspace', network: 'blocked', tone: 'ok' as Tone },
	{ profile: 'danger-full-access', files: 'everything', network: 'open', tone: 'err' as Tone }
];
