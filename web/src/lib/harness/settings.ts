/**
 * Settings, shaped after the agent's `SettingsRegistry`.
 *
 * Source: `alnair-tui/src/settings/registry.rs` (`SettingMeta`, `SettingKind`)
 * and `defs.rs` (the entries themselves). The registry is the single source of
 * truth for what is tunable, which category it belongs to, and what kind of
 * value it holds — so this file mirrors its shape rather than inventing a
 * settings schema of its own.
 *
 * Only the settings a browser can act on are modelled. Terminal-only entries
 * (mouse scroll speed, vim mode, screen mode) are deliberately absent: they
 * change a TUI the browser does not render.
 */

/** `SettingCategory`, in the registry's render order. */
export type SettingCategory = 'appearance' | 'editor' | 'agent' | 'models' | 'session' | 'advanced';

export interface CategoryMeta {
	id: SettingCategory;
	label: string;
	/** One line explaining what the section governs. */
	description: string;
}

/** `SettingCategory::ALL`, minus the terminal-only sections. */
export const CATEGORIES: CategoryMeta[] = [
	{
		id: 'appearance',
		label: 'Appearance',
		description: 'Theme and how much of the conversation is shown.'
	},
	{
		id: 'editor',
		label: 'Editor & Input',
		description: 'How the prompt input behaves.'
	},
	{
		id: 'agent',
		label: 'Agent & Approval',
		description: 'What the agent may do, and when it must ask.'
	},
	{
		id: 'models',
		label: 'Models',
		description: 'Which model runs, and at what effort.'
	},
	{
		id: 'session',
		label: 'Session',
		description: 'What a new session starts from.'
	},
	{
		id: 'advanced',
		label: 'Advanced',
		description: 'Diagnostics and behaviour that rarely needs changing.'
	}
];

export interface EnumChoice {
	/** Canonical persisted value. */
	value: string;
	/** Display label. */
	label: string;
	/** Sub-text explaining the choice. */
	description?: string;
}

/** `SettingKind`, restricted to the shapes a browser renders. */
export type SettingKind =
	| { kind: 'bool' }
	| { kind: 'enum'; choices: EnumChoice[] }
	| { kind: 'int'; min: number; max: number; step?: number }
	| { kind: 'string'; placeholder?: string };

export interface SettingMeta {
	/** Stable id; also the `config.toml` key. */
	key: string;
	category: SettingCategory;
	label: string;
	description: string;
	kind: SettingKind;
	/**
	 * Extra search terms, mirroring `SettingMeta.keywords` in the registry.
	 * The registry indexes synonyms (`yolo`, `approval`) so a reader who knows
	 * the old name still finds the setting.
	 */
	keywords?: string[];
	/** The value applies on the next session start. */
	restartRequired?: boolean;
}

export type SettingValue = boolean | string | number;

/** Every setting's current value, keyed by `SettingMeta.key`. */
export type SettingsState = Record<string, SettingValue>;

/**
 * The entries the browser can act on, transcribed from `defs.rs`.
 *
 * Labels and descriptions follow the registry's wording, so the dialog and the
 * TUI explain a setting the same way. Entries that only make sense in a
 * terminal are left out rather than shown disabled.
 */
export const SETTINGS: SettingMeta[] = [
	/* ---------------------------------------------------------- appearance */
	{
		key: 'theme',
		category: 'appearance',
		label: 'Theme',
		description: 'Which palette the interface uses.',
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
		kind: { kind: 'bool' }
	},
	{
		key: 'show_thinking_blocks',
		category: 'appearance',
		label: 'Show thinking blocks',
		description: "Show the agent's reasoning as it streams.",
		kind: { kind: 'bool' }
	},
	{
		key: 'compact_mode',
		category: 'appearance',
		label: 'Compact mode',
		description: 'Reduce padding around messages for more content density.',
		kind: { kind: 'bool' }
	},
	{
		key: 'render_mermaid',
		category: 'appearance',
		label: 'Render Mermaid diagrams',
		description: 'Draw Mermaid blocks instead of showing their source.',
		kind: { kind: 'bool' }
	},
	{
		key: 'collapsed_edit_blocks',
		category: 'appearance',
		label: 'Collapse edit blocks',
		description: 'Start file edits collapsed instead of expanded.',
		kind: { kind: 'bool' }
	},
	{
		key: 'group_tool_verbs',
		category: 'appearance',
		label: 'Group tool verbs',
		description: 'Merge consecutive calls of the same tool into one row.',
		kind: { kind: 'bool' }
	},

	/* --------------------------------------------------------------- editor */
	{
		key: 'multiline_mode',
		category: 'editor',
		label: 'Multiline input',
		description: 'Enter inserts a newline; send with the button.',
		kind: { kind: 'bool' }
	},
	{
		key: 'prompt_suggestions',
		category: 'editor',
		label: 'Prompt suggestions',
		description: 'Offer follow-up prompts when the thread is empty.',
		kind: { kind: 'bool' }
	},

	/* ---------------------------------------------------------------- agent */
	{
		key: 'permission_mode',
		category: 'agent',
		label: 'Permission mode',
		description: 'How much the agent may do without asking.',
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
	},
	{
		key: 'remember_tool_approvals',
		category: 'agent',
		label: 'Remember tool approvals',
		description: 'A tool approved once stays approved for the session.',
		kind: { kind: 'bool' }
	},
	{
		key: 'plan_mode',
		category: 'agent',
		label: 'Plan mode',
		description: 'Start sessions in plan mode, where the agent proposes before acting.',
		kind: { kind: 'bool' }
	},
	{
		key: 'toolset.ask_user_question.timeout_enabled',
		category: 'agent',
		label: 'Question timeout',
		description: 'Let a question time out instead of waiting forever.',
		kind: { kind: 'bool' }
	},

	/* --------------------------------------------------------------- models */
	{
		key: 'default_model',
		category: 'models',
		label: 'Default model',
		description: 'The model a new session starts on. Leave empty to inherit.',
		kind: { kind: 'string', placeholder: 'inherit' }
	},
	{
		key: 'fork_secondary_model',
		category: 'models',
		label: 'Fork secondary model',
		description: 'Model used for a forked subagent when the parent has none set.',
		kind: { kind: 'string', placeholder: 'inherit' }
	},

	/* -------------------------------------------------------------- session */
	{
		key: 'auto_compact_threshold_percent',
		category: 'session',
		label: 'Auto-compact threshold',
		description: 'Compact the conversation once this share of the window is used.',
		kind: { kind: 'int', min: 50, max: 95, step: 5 }
	},
	{
		key: 'auto_update',
		category: 'session',
		label: 'Auto-update',
		description: 'Install a downloaded update on the next start.',
		kind: { kind: 'bool' }
	},

	/* ------------------------------------------------------------- advanced */
	{
		key: 'show_tips',
		category: 'advanced',
		label: 'Show tips',
		description: 'Occasional hints about features you have not used.',
		kind: { kind: 'bool' }
	},
	{
		key: 'contextual_hints',
		category: 'advanced',
		label: 'Contextual hints',
		description: 'Inline hints that react to what you are doing.',
		kind: { kind: 'bool' }
	},
	{
		key: 'hunk_tracker_mode',
		category: 'advanced',
		label: 'Hunk tracker mode',
		description: 'How edited hunks are tracked across a session.',
		kind: {
			kind: 'enum',
			choices: [
				{
					value: 'auto',
					label: 'Auto',
					description: 'Track by content, falling back to position.'
				},
				{ value: 'content', label: 'Content', description: 'Match hunks by their text.' },
				{ value: 'line', label: 'Line', description: 'Match hunks by line number.' }
			]
		}
	}
];

/** The values the fixture session starts with. */
export const DEFAULT_SETTINGS: SettingsState = {
	theme: 'system',
	show_timestamps: true,
	show_thinking_blocks: true,
	compact_mode: false,
	render_mermaid: false,
	collapsed_edit_blocks: false,
	group_tool_verbs: true,
	multiline_mode: false,
	prompt_suggestions: true,
	permission_mode: 'auto',
	remember_tool_approvals: true,
	plan_mode: false,
	'toolset.ask_user_question.timeout_enabled': true,
	default_model: '',
	fork_secondary_model: '',
	auto_compact_threshold_percent: 85,
	auto_update: true,
	show_tips: true,
	contextual_hints: true,
	hunk_tracker_mode: 'auto'
};

/** Settings in one category, in declaration order. */
export const settingsByCategory = (category: SettingCategory): SettingMeta[] =>
	SETTINGS.filter((setting) => setting.category === category);

/** Free-text filter across label, key, description, and the registry's keywords. */
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
