import type { SiteCopy } from './types';

/**
 * English copy.
 *
 * Terminal mockups stay in English in both dictionaries on purpose: that is
 * what the program prints, and a translated transcript would be a screenshot
 * of a product that does not exist.
 */
export const en = {
	meta: {
		title: 'Alnair — graph engineering for the terminal',
		description:
			'An independent, provider-agnostic coding agent. /graph turns one objective into a dependency graph of self-verifying agent loops — planned, parallelized, adversarially verified, merged back. Apache-2.0, zero telemetry, one binary.'
	},

	nav: {
		features: 'Features',
		graph: 'Graph',
		lessons: 'Lessons',
		providers: 'Providers',
		install: 'Install',
		docs: 'Docs',
		source: 'Source',
		theme: 'Toggle theme',
		language: 'Language',
		menu: 'Menu'
	},

	hero: {
		badge: 'Apache-2.0 · zero telemetry · single binary',
		title: [
			{ text: 'The coding agent that runs ' },
			{ text: 'a graph', accent: true },
			{ text: ', not a loop.' }
		],
		lede: 'Alnair reads the repository, writes the patch, runs the tests, and keeps going while you do something else. /graph turns one objective into a dependency graph of autonomous, self-verifying agent loops — planned, parallelized, adversarially checked, and merged back.',
		primary: 'Install Alnair',
		secondary: 'See how /graph works',
		note: 'One file, no runtime. macOS and Linux on arm64/x86_64, Windows on x86_64, checksummed against the release.',
		demoCaption: 'The TUI, unedited.',
		play: 'Play the demo'
	},

	stats: [
		{ value: '29', label: 'providers compiled in', detail: '5 sign-ins, 24 API keys' },
		{ value: '3', label: 'graph nodes at once', detail: 'default; 1–8 configurable' },
		{ value: '0', label: 'telemetry, ever', detail: 'no analytics, no beacon' },
		{ value: '1', label: 'static binary', detail: 'nothing to install around it' }
	],

	graph: {
		eyebrow: 'Graph engineering',
		title: [{ text: 'One objective in.' }, { text: ' A verified, merged change out.' }],
		lede: 'Every other agent runs a loop: think, act, repeat — one thread, one thing at a time. /graph runs a dependency graph instead. Work that does not block other work happens at the same time, in separate git worktrees, and nothing merges until something else has tried to tear it apart.',
		steps: [
			{
				title: 'Plan, then gate',
				body: 'A planner decomposes the objective into a dependency DAG. A static gate validates it — no cycles, and a terminal verification node that depends on everything else — before a single worker starts.'
			},
			{
				title: 'Fan out',
				body: 'Every ready node runs as a parallel worker in its own git worktree, each one an ordinary agent loop. The edges between nodes stay deterministic Rust.'
			},
			{
				title: 'Try to break it',
				body: 'An adversarial verifier has to fail to break a node before its work merges. The verdict is a terminal contract parsed fail-closed: no verdict, no merge.'
			},
			{
				title: 'Replan, append-only',
				body: 'A worker that finds out-of-scope work says DISCOVERED: and the graph replans around it — append-only, so nothing already agreed gets rewritten, and the final gate cannot be cycled back into.'
			},
			{
				title: 'Merge one at a time',
				body: 'Merge-back is sequential. A conflict fails that node and blocks only its dependents; every other chain keeps running.'
			},
			{
				title: 'Verify the whole thing',
				body: 'A final node rechecks the entire objective on the full agent engine before the graph is allowed to call itself done. A budget trip pauses it; /graph resume --budget picks it back up.'
			}
		],
		commandTitle: 'alnair — graph',
		commandLines: [
			[
				{ text: '❯ ', tone: 'accent' },
				{ text: '/graph', tone: 'accent' },
				{ text: ' ship the billing refactor --budget 500000' }
			],
			[{ text: '  planning · 7 nodes · 4 ready', tone: 'dim' }],
			[
				{ text: '  ✓ gn-plan          ', tone: 'ok' },
				{ text: 'verified  decompose the objective', tone: 'dim' }
			],
			[
				{ text: '  ◉ gn-billing-api   ', tone: 'info' },
				{ text: 'running   worker round 2/3', tone: 'dim' }
			],
			[
				{ text: '  ◉ gn-billing-ui    ', tone: 'info' },
				{ text: 'running   worker round 1/3', tone: 'dim' }
			],
			[
				{ text: '  ◌ gn-billing-tests ', tone: 'dim' },
				{ text: 'waiting   needs gn-billing-api', tone: 'dim' }
			],
			[
				{ text: '  ◇ gn-final         ', tone: 'dim' },
				{ text: 'blocked   verifies the objective', tone: 'dim' }
			]
		],
		state:
			'State lives in .alnair/graph.jsonl, next to your code. Close the laptop, come back tomorrow, /graph resume. A teammate can pick it up from the same file.',
		config:
			'On by default. ALNAIR_GRAPH=0 turns it off; ALNAIR_GRAPH_CONCURRENCY sets how many nodes run at once.',
		diagramCaption:
			'The same graph as /graph show draws it: box drawing in the terminal, no dashboard required.',
		nodes: [
			{ id: 'gn-plan', label: 'gn-plan', note: 'decompose', state: 'verified' },
			{ id: 'gn-api', label: 'gn-api', note: 'routes + schema', state: 'running' },
			{ id: 'gn-ui', label: 'gn-ui', note: 'screens', state: 'running' },
			{ id: 'gn-tests', label: 'gn-tests', note: 'unit + integration', state: 'ready' },
			{ id: 'gn-final', label: 'gn-final', note: 'verify objective', state: 'blocked' }
		],
		states: {
			verified: 'verified',
			running: 'running',
			ready: 'ready',
			blocked: 'blocked'
		}
	},

	lessons: {
		eyebrow: 'Lessons',
		title: [{ text: 'It writes down' }, { text: ' what it got wrong.', accent: true }],
		lede: 'When a goal keeps failing the same way, Alnair already stops and works out why — then used to throw the answer away when the goal ended. Lessons keep it. A lesson records what the harness itself got wrong in this repository and what fixed it, and the next session starts with the three newest.',
		points: [
			{
				title: 'Nothing captured, nothing injected.',
				body: 'An empty store changes your prompt by zero bytes, which is what makes this safe to leave on.'
			},
			{
				title: 'Never in your repo.',
				body: 'Lessons live in ~/.alnair/lessons/, outside version control. A file read into context automatically is a file a hostile checkout could use to steer every future session.'
			},
			{
				title: 'Markdown you can edit.',
				body: 'Disagree with an entry? Delete it. The escape hatch is a text editor — no schema, no migration.'
			}
		],
		snippetTitle: '~/.alnair/lessons/LESSONS.md',
		snippetLines: [
			[{ text: '<harness-lessons>', tone: 'dim' }],
			[{ text: '## Lessons from earlier sessions', tone: 'plain' }],
			[{ text: 'These are notes about how the harness', tone: 'dim' }],
			[{ text: 'worked here, not facts about the code.', tone: 'dim' }],
			[{ text: 'Apply one only when the situation matches.', tone: 'dim' }],
			[{ text: '' }],
			[{ text: '### Verification gaps keep reopening', tone: 'accent' }],
			[
				{
					text: 'Restructure the unit under test rather',
					tone: 'plain'
				}
			],
			[{ text: 'than patching the symptom; split the', tone: 'plain' }],
			[{ text: 'tangled module first. (workflow)', tone: 'plain' }],
			[{ text: '</harness-lessons>', tone: 'dim' }]
		],
		footnote:
			'On by default. ALNAIR_LESSONS=0 turns it off, and [lessons] in config.toml tunes the caps.'
	},

	features: {
		eyebrow: 'Everything else',
		title: [{ text: 'A harness,' }, { text: ' not a chat window.', accent: true }],
		lede: 'The parts you only notice when they are missing.',
		docsLink: 'Read the user guide',
		items: [
			{
				sample: 'dashboard',
				wide: true,
				title: 'One dashboard for every agent',
				body: 'Every session in flight, sorted by state: who needs your input, who is running, what each one is doing right now. Answer a parked permission from the peek panel without opening the conversation.'
			},
			{
				sample: 'tabs',
				wide: true,
				title: 'Tabs that span repositories',
				body: 'Each tab carries the session’s own directory, so a strip can hold three repos at once. F2 opens it; the strip becomes a window that scrolls rather than dropping chips off the edge.'
			},
			{
				sample: 'subagents',
				title: 'Subagents',
				body: 'A child session with its own context window, so research and implementation do not eat the parent’s budget.'
			},
			{
				sample: 'mcp',
				title: 'MCP servers',
				body: 'stdio, SSE and streamable HTTP, managed from the CLI or config.toml. A server that fails to start says so instead of silently removing its tools.'
			},
			{
				sample: 'skills',
				title: 'Skills',
				body: 'Reusable procedures as markdown files. The model reads the description to decide when to load one.'
			},
			{
				sample: 'permission',
				title: 'Permissions',
				body: 'Every tool call that could change something stops here first. Grant one call, one command, a session, or nothing at all.'
			},
			{
				sample: 'hooks',
				title: 'Hooks',
				body: 'Shell commands and HTTP callbacks around tool use and session lifecycle. A PreToolUse hook can veto the call outright.'
			},
			{
				sample: 'sandbox',
				title: 'Sandbox profiles',
				body: 'Filesystem and network isolation enforced by the OS, chosen per session and layered under the permission rules.'
			},
			{
				sample: 'headless',
				title: 'Headless mode',
				body: 'alnair -p answers one prompt and exits with a status, so a CI job can gate on it and a script can pipe it.'
			},
			{
				sample: 'web',
				title: 'A browser view',
				body: 'alnair web serves a client of the same leader process, so a turn streaming in the terminal streams in the browser too.'
			},
			{
				sample: 'theme',
				title: 'Yours to theme',
				body: 'Every theme, syntax palette and glyph is a setting, with a plain mode for terminals that never got a real one.'
			}
		]
	},

	providers: {
		eyebrow: 'Providers',
		title: [{ text: 'Bring the subscription' }, { text: ' you already pay for.', accent: true }],
		lede: 'Sign in once and Alnair uses the plan you already pay for. No API key to copy, no second bill. Each provider’s token is stored under its own key, and one provider’s credentials are never sent to another.',
		signIn: 'Sign in with a subscription',
		signInNote: 'Five providers, each with its own OAuth flow and its own stored scope.',
		rows: [
			{ name: 'Kimi Code', id: 'kimi-code', method: 'Device code' },
			{ name: 'Claude Pro/Max', id: 'claude-pro-max', method: 'Browser · PKCE' },
			{ name: 'ChatGPT Plus/Pro', id: 'openai-codex', method: 'Browser · PKCE' },
			{ name: 'GitHub Copilot', id: 'github-copilot', method: 'Device code' },
			{ name: 'xAI Grok', id: 'xai-grok', method: 'Device code' }
		],
		apiKeys: 'Or bring a key',
		apiKeysNote:
			'Twenty-four more platforms are compiled in. Export the environment variable, or keep the key in config.toml — keys are never logged.',
		keys: [
			'Moonshot',
			'OpenAI',
			'Anthropic',
			'DeepSeek',
			'Google Gemini',
			'Groq',
			'Mistral',
			'OpenRouter',
			'Together',
			'Cerebras',
			'Fireworks',
			'NVIDIA NIM',
			'Vercel AI Gateway',
			'xAI',
			'MiniMax',
			'Z.AI',
			'Qwen',
			'Xiaomi MiMo',
			'Kimi for Coding',
			'…and more'
		],
		customTitle: 'Or point it at your own endpoint',
		customBody:
			'Anything that speaks OpenAI Chat Completions or the Anthropic Messages API works: a gateway, a proxy, Ollama, LM Studio, vLLM. Declare it by base URL, and /model lists whatever it serves.',
		customCode: `[platforms.my-gateway]
base_url = "https://gateway.example.com/v1"
api = "openai"        # or "anthropic"
api_key = "..."       # or store it in ~/.alnair/auth.json`,
		customFile: 'config.toml',
		copied: 'Copied'
	},

	install: {
		eyebrow: 'Install',
		title: [{ text: 'Two commands' }, { text: ' to a working agent.', accent: true }],
		lede: 'One line installs it. One more signs you in. After that it is just alnair.',
		steps: [
			{ label: 'Install', detail: 'A single binary lands in ~/.alnair/bin.' },
			{ label: 'Sign in', detail: 'Pick a provider and authorize it.' },
			{ label: 'Go', detail: 'Point it at a repository.' }
		],
		unix: 'macOS / Linux',
		windows: 'Windows',
		commands: {
			unix: 'curl -fsSL https://raw.githubusercontent.com/xFlawlessDev/alnair-harness/master/install.sh | bash',
			windows:
				'irm https://raw.githubusercontent.com/xFlawlessDev/alnair-harness/master/install.ps1 | iex'
		},
		copy: 'Copy install command',
		copied: 'Copied',
		connect: 'alnair connect',
		go: 'alnair',
		notes: [
			'One file, no runtime, nothing added to your shell but PATH.',
			'macOS arm64/x86_64 · Linux arm64/x86_64 · Windows x86_64.',
			'Verified against the release’s SHA256SUMS; alnair update keeps it current.'
		],
		buildNote: 'Prefer to build it yourself?',
		buildLink: 'Read the build steps'
	},

	faq: {
		eyebrow: 'Questions',
		title: [{ text: 'The things people ask' }, { text: ' first.', accent: true }],
		items: [
			{
				q: 'Is this a rebrand of another CLI?',
				a: 'No. Alnair is an independent coding agent and a hard fork of Kigi-CLI, which is itself a fork of xAI’s Grok Build Open Source. It keeps the Apache-2.0 licence and both upstream attributions, and it has its own binary, its own ~/.alnair, its own keyring entry and its own ALNAIR_* variables. It never reads or writes another CLI’s home directory — the one exception is an opt-in, read-only ~/.kimi import.'
			},
			{
				q: 'What does it send over the network?',
				a: 'Only the APIs you configured, the Alnair release server for updates, your own MCP servers, and provider metadata lookups when a model listing lacks what it needs. No telemetry, no analytics, ever.'
			},
			{
				q: 'Does it work on Windows?',
				a: 'Yes. The installer is PowerShell, the binary is a single static .exe, and the TUI accounts for the Windows console’s keyboard quirks — on a bare ConHost it advertises Alt+Enter for a newline instead of a chord that would never arrive.'
			},
			{
				q: 'Can I run it in CI?',
				a: 'alnair -p runs one prompt headless and exits with the result, so a job can gate on it. Interactive sessions, the dashboard and graph control stay in the TUI or the browser.'
			},
			{
				q: 'Can my editor drive it?',
				a: 'Yes, over the Agent Client Protocol. alnair web goes further: it serves a browser client of the same leader process, so a turn streaming in the terminal streams in the browser too.'
			},
			{
				q: 'How is it licensed?',
				a: 'Apache-2.0. NOTICE carries both upstream attributions, and the --version line states what it is based on.'
			}
		]
	},

	footer: {
		tagline: 'A coding agent for the terminal, provider-agnostic by construction.',
		product: 'Product',
		project: 'Project',
		language: 'Language',
		attribution:
			'An independent coding agent. A hard fork of Kigi-CLI, which is itself a fork of Grok Build Open Source. Based on Grok Build Open Source, Copyright 2025–2026 X.AI Corp. Not affiliated with Moonshot AI or xAI.',
		license: 'Apache-2.0'
	}
} satisfies SiteCopy;
