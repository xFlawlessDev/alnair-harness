/**
 * The web client's own settings.
 *
 * This registry is deliberately independent of the TUI's `SettingsRegistry`.
 * The two surfaces are different products: the TUI tunes a terminal renderer
 * (mouse scroll speed, vim mode, screen mode, tool-verb grouping), and the
 * browser has no such surface. Copying those entries across would show rows
 * that cannot do anything here and would tie this file to a schema it does not
 * own.
 *
 * The only shared ground is the runtime's own `PermissionMode`, which the
 * composer's access picker already edits. That one is mirrored here because a
 * reader looks for it in both places, and both write the same runtime value.
 */

/** A section in the dialog's rail. */
export type SettingCategory = 'appearance' | 'conversation' | 'composer' | 'advanced';

export interface CategoryMeta {
	id: SettingCategory;
	label: string;
	/** One line explaining what the section governs. */
	description: string;
}

export const CATEGORIES: CategoryMeta[] = [
	{
		id: 'appearance',
		label: 'Appearance',
		description: 'Theme and how much of the conversation is shown.'
	},
	{
		id: 'conversation',
		label: 'Conversation',
		description: 'What a turn displays as it runs and after it finishes.'
	},
	{
		id: 'composer',
		label: 'Composer',
		description: 'How the prompt input and its menus behave.'
	},
	{
		id: 'advanced',
		label: 'Advanced',
		description: 'Behaviour that rarely needs changing.'
	}
];

export interface EnumChoice {
	/** Canonical value. */
	value: string;
	/** Display label. */
	label: string;
	/** Sub-text explaining the choice. */
	description?: string;
}

/** The value shapes the dialog renders. */
export type SettingKind =
	| { kind: 'bool' }
	| { kind: 'enum'; choices: EnumChoice[] }
	| { kind: 'int'; min: number; max: number; step?: number; suffix?: string }
	| { kind: 'string'; placeholder?: string };

export interface SettingMeta {
	/** Stable id, also the storage key. */
	key: string;
	category: SettingCategory;
	label: string;
	description: string;
	kind: SettingKind;
	/** Extra search terms, so a reader who knows another name still finds it. */
	keywords?: string[];
	/** The value applies on the next reload. */
	restartRequired?: boolean;
}

export type SettingValue = boolean | string | number;

/** Every setting's current value, keyed by `SettingMeta.key`. */
export type SettingsState = Record<string, SettingValue>;

/** The entries this client owns. */
export const SETTINGS: SettingMeta[] = [
	/* ---------------------------------------------------------- appearance */
	{
		key: 'theme',
		category: 'appearance',
		label: 'Theme',
		description: 'Which palette the interface uses.',
		keywords: ['dark', 'light', 'colour', 'color', 'appearance'],
		kind: {
			kind: 'enum',
			choices: [
				{ value: 'system', label: 'System', description: 'Follow the operating system.' },
				{ value: 'light', label: 'Light', description: 'White paper, gray chrome.' },
				{ value: 'dark', label: 'Dark', description: 'Black ground, one lime accent.' }
			]
		}
	},
	{
		key: 'show_timestamps',
		category: 'appearance',
		label: 'Show timestamps',
		description: 'Show clock time next to user messages and agent responses.',
		keywords: ['time', 'clock', 'date'],
		kind: { kind: 'bool' }
	},
	{
		key: 'density',
		category: 'appearance',
		label: 'Density',
		description: 'How much padding surrounds messages and trace rows.',
		keywords: ['compact', 'padding', 'spacing', 'tight'],
		kind: {
			kind: 'enum',
			choices: [
				{ value: 'comfortable', label: 'Comfortable', description: 'The default spacing.' },
				{ value: 'compact', label: 'Compact', description: 'Fits more of the thread on screen.' }
			]
		}
	},
	{
		key: 'sidebar_layout',
		category: 'appearance',
		label: 'Sidebar layout',
		description: 'How the session list is arranged: by repo, by status, or as one flat list.',
		keywords: ['sidebar', 'sessions', 'group', 'status', 'active', 'idle', 'layout'],
		kind: {
			kind: 'enum',
			choices: [
				{
					value: 'workspace',
					label: 'By workspace',
					description: 'One group per repo, its sessions underneath.'
				},
				{
					value: 'status',
					label: 'By status',
					description: 'Active, idle and inactive first, the repo named on each row.'
				},
				{ value: 'flat', label: 'Flat list', description: 'Newest first, with no groups at all.' }
			]
		}
	},

	/* -------------------------------------------------------- conversation */
	{
		key: 'show_thinking',
		category: 'conversation',
		label: 'Show thinking',
		description: "Show the agent's reasoning as it streams.",
		keywords: ['reasoning', 'thought', 'thinking'],
		kind: { kind: 'bool' }
	},
	{
		key: 'collapse_edits',
		category: 'conversation',
		label: 'Collapse file edits',
		description: 'Start a file diff folded, so a long edit does not bury the reply.',
		keywords: ['diff', 'edit', 'collapse'],
		kind: { kind: 'bool' }
	},
	{
		key: 'group_tool_verbs',
		category: 'conversation',
		label: 'Group tool calls',
		description:
			'Fold runs of reads, searches and subagents into one summary line, like the terminal does.',
		keywords: ['group', 'tool', 'verb', 'fold', 'trace'],
		kind: { kind: 'bool' }
	},
	{
		key: 'render_mermaid',
		category: 'conversation',
		label: 'Render Mermaid diagrams',
		description: 'Draw Mermaid blocks instead of showing their source.',
		keywords: ['diagram', 'mermaid', 'graph'],
		kind: { kind: 'bool' }
	},
	{
		key: 'context_threshold_percent',
		category: 'conversation',
		label: 'Context warning threshold',
		description: 'Colour the context meter as a warning once this share of the window is used.',
		keywords: ['context', 'warning', 'threshold', 'compact'],
		kind: { kind: 'int', min: 50, max: 95, step: 5, suffix: '%' }
	},

	/* ------------------------------------------------------------ composer */
	{
		key: 'enter_to_send',
		category: 'composer',
		label: 'Enter sends',
		description: 'Enter submits the prompt; Shift+Enter inserts a newline.',
		keywords: ['multiline', 'newline', 'submit', 'keyboard'],
		kind: { kind: 'bool' }
	},
	{
		key: 'prompt_suggestions',
		category: 'composer',
		label: 'Prompt suggestions',
		description: 'Offer follow-up prompts when the thread is empty.',
		keywords: ['suggestions', 'starters', 'empty'],
		kind: { kind: 'bool' }
	},
	{
		key: 'mention_menu',
		category: 'composer',
		label: 'Mention menu',
		description: 'Open the file menu when you type `@`.',
		keywords: ['mention', 'file', 'at', 'autocomplete'],
		kind: { kind: 'bool' }
	},
	{
		key: 'command_menu',
		category: 'composer',
		label: 'Command menu',
		description: 'Open the command menu when you type `/` at the start of a message.',
		keywords: ['command', 'slash', 'autocomplete'],
		kind: { kind: 'bool' }
	},

	/* ------------------------------------------------------------ advanced */
	{
		key: 'permission_mode',
		category: 'advanced',
		label: 'Permission mode',
		description: 'How much the agent may do without asking. Mirrors the composer control.',
		keywords: ['approval', 'yolo', 'auto', 'access', 'safety', 'permission'],
		kind: {
			kind: 'enum',
			choices: [
				{
					value: 'ask',
					label: 'Ask first',
					description: 'Every write and command needs approval.'
				},
				{ value: 'auto', label: 'Auto', description: 'Safe edits run; risky ones still ask.' },
				{
					value: 'always-approve',
					label: 'Full access',
					description: 'Nothing asks. Equivalent to yolo mode.'
				}
			]
		}
	}
];

/**
 * The values the client starts with.
 *
 * `collapse_edits` defaults to `true` because that is what the thread already
 * did: a diff opened folded. A default of `false` would have made the setting's
 * first effect a visual regression for everyone who never touched it.
 *
 * `group_tool_verbs` also defaults to `true`, matching the TUI's own default:
 * the fold is what keeps a long run of reads from burying the answer, and a
 * reader who never opens Settings gets the compact transcript either way.
 */
export const DEFAULT_SETTINGS: SettingsState = {
	theme: 'system',
	show_timestamps: true,
	density: 'comfortable',
	sidebar_layout: 'workspace',
	show_thinking: true,
	collapse_edits: true,
	group_tool_verbs: true,
	render_mermaid: false,
	context_threshold_percent: 85,
	enter_to_send: true,
	prompt_suggestions: true,
	mention_menu: true,
	command_menu: true,
	permission_mode: 'auto'
};

/** Settings in one category, in declaration order. */
export const settingsByCategory = (category: SettingCategory): SettingMeta[] =>
	SETTINGS.filter((setting) => setting.category === category);

/** Free-text filter across label, key, description, and keywords. */
export function filterSettings(query: string): SettingMeta[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return SETTINGS;
	return SETTINGS.filter(
		(setting) =>
			setting.label.toLowerCase().includes(needle) ||
			setting.key.toLowerCase().includes(needle) ||
			setting.description.toLowerCase().includes(needle) ||
			(setting.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(needle))
	);
}
