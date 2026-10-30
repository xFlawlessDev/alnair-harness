import type { SlashCommand } from './types.js';

/**
 * Which advertised slash commands the browser may offer.
 *
 * The agent advertises one catalog to every client (`available_commands` in
 * `alnair-shell/src/session/slash_commands.rs`), and those entries work here:
 * each is a *server-side* builtin that answers through `send_slash_command_output`,
 * so its text lands in the transcript exactly as it does in the TUI.
 *
 * The pager, however, also registers a large set of LOCAL commands that never
 * reach ACP — `/model`, `/clear`, `/rewind`, `/theme`, `/vim-mode`,
 * `/terminal-setup` and the rest of `alnair-tui/src/slash/commands/`. They
 * mutate pager state that a browser does not have. Typing one here sends text
 * the shell parses as an unknown command, and the model answers it as prose —
 * a row that looks live and does nothing.
 *
 * So the rule is a DENYLIST, not an allowlist. An unknown name is allowed,
 * because anything the agent advertises that is not listed below is one of its
 * own builtins or an installed skill (which is plain prompt expansion). An
 * allowlist would instead hide every future builtin AND every skill the user
 * installed until someone remembered to add it here.
 *
 * Aliases are denied with their canonical name: the dropdown inserts
 * `/<name>`, so a command denied under only one spelling would still appear
 * under the other.
 */
const TUI_ONLY: ReadonlySet<string> = new Set([
	// Pager chrome: windows, panes, modes, themes, keys, transcripts.
	'auto',
	'btw',
	'cd',
	'chain',
	'clear',
	'compact-mode',
	'config-agents',
	'connect',
	'copy',
	'dashboard',
	'debug',
	'docs',
	'effort',
	'expand',
	'export',
	'find',
	'fork',
	'gboom',
	'help',
	'history',
	'home',
	'import-claude',
	'jump',
	'mcps',
	'model',
	'multiline',
	'new',
	'personas',
	'plan',
	'queue',
	'quit',
	'recap',
	'remember',
	'rename',
	'resume',
	'rewind',
	'scroll-debug',
	'settings',
	'skills',
	'tasks',
	'terminal-setup',
	'theme',
	'timeline',
	'timestamps',
	'toggle-mouse-reporting',
	'transcript',
	'usage',
	'view-plan',
	'vim-mode'
]);

/**
 * Aliases the pager resolves, mapped to the name they resolve to.
 *
 * Spelled completely (including the harmless ones) so a later addition cannot
 * silently fall through: an alias missing here would be judged as an allowed
 * unknown command rather than by its canonical name.
 */
const ALIASES: Record<string, string> = {
	yolo: 'always-approve',
	mem: 'memory',
	info: 'session-info',
	status: 'session-info',
	plugin: 'plugins'
};

/** Lowercase, strip a leading slash, and resolve a known alias. */
export function normalizeCommandName(name: string): string {
	const bare = name.trim().replace(/^\//, '').toLowerCase();
	return ALIASES[bare] ?? bare;
}

/** Whether a name may appear in the browser's `/` menu. */
export function isWebCommand(name: string): boolean {
	const normalized = normalizeCommandName(name);
	return normalized.length > 0 && !TUI_ONLY.has(normalized);
}

/** The commands the dropdown may show, in the agent's own order. */
export function webCommands(commands: SlashCommand[]): SlashCommand[] {
	return commands.filter((command) => isWebCommand(command.name));
}
