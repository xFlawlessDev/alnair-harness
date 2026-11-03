/**
 * The content model.
 *
 * Every string the page renders lives in `en.ts` and `id.ts`, and both are
 * declared `satisfies SiteCopy`. Adding a section without translating it is a
 * type error, not an English paragraph on the Indonesian page.
 *
 * Command output and the demo stay in English in both languages: that is what
 * the program prints, and a translated transcript would be a picture of a
 * product that does not exist.
 */

/** A heading fragment. `accent` marks the phrase that language emphasises. */
export interface Phrase {
	text: string;
	accent?: boolean;
}

export type TermTone = 'plain' | 'dim' | 'muted' | 'accent' | 'ok' | 'info' | 'err';

/** One line of a terminal mockup, split into coloured spans. */
export type TermLine = { text: string; tone?: TermTone }[];

export interface StatCopy {
	value: string;
	label: string;
	detail: string;
}

/**
 * Which UI sample a feature card carries. The ids are the card's contract with
 * `FeaturesSection`: adding one here without a component there is a type error,
 * and the sample itself is never copy — it is chrome, so it is not translated.
 */
export type FeatureSample =
	| 'dashboard'
	| 'tabs'
	| 'subagents'
	| 'mcp'
	| 'skills'
	| 'permission'
	| 'hooks'
	| 'sandbox'
	| 'headless'
	| 'theme'
	| 'web';

export interface FeatureItem {
	sample: FeatureSample;
	title: string;
	body: string;
	/** A card that spans two columns on a wide grid, for the samples that need width. */
	wide?: boolean;
}

export interface SiteCopy {
	meta: {
		title: string;
		description: string;
	};

	nav: {
		features: string;
		graph: string;
		lessons: string;
		providers: string;
		install: string;
		docs: string;
		source: string;
		theme: string;
		language: string;
		menu: string;
	};

	hero: {
		badge: string;
		title: Phrase[];
		lede: string;
		primary: string;
		secondary: string;
		note: string;
		demoCaption: string;
		play: string;
	};

	stats: StatCopy[];

	graph: {
		eyebrow: string;
		title: Phrase[];
		lede: string;
		steps: { title: string; body: string }[];
		commandTitle: string;
		commandLines: TermLine[];
		state: string;
		config: string;
		diagramCaption: string;
		nodes: {
			id: string;
			label: string;
			note: string;
			state: 'verified' | 'running' | 'ready' | 'blocked';
		}[];
		states: Record<'verified' | 'running' | 'ready' | 'blocked', string>;
	};

	lessons: {
		eyebrow: string;
		title: Phrase[];
		lede: string;
		points: { title: string; body: string }[];
		snippetTitle: string;
		snippetLines: TermLine[];
		footnote: string;
	};

	features: {
		eyebrow: string;
		title: Phrase[];
		lede: string;
		items: FeatureItem[];
		docsLink: string;
	};

	providers: {
		eyebrow: string;
		title: Phrase[];
		lede: string;
		signIn: string;
		signInNote: string;
		rows: { name: string; id: string; method: string }[];
		apiKeys: string;
		apiKeysNote: string;
		keys: string[];
		customTitle: string;
		customBody: string;
		customCode: string;
		customFile: string;
		copied: string;
	};

	install: {
		eyebrow: string;
		title: Phrase[];
		lede: string;
		steps: { label: string; detail: string }[];
		unix: string;
		windows: string;
		commands: { unix: string; windows: string };
		copy: string;
		copied: string;
		connect: string;
		go: string;
		notes: string[];
		buildNote: string;
		buildLink: string;
	};

	faq: {
		eyebrow: string;
		title: Phrase[];
		items: { q: string; a: string }[];
	};

	footer: {
		tagline: string;
		product: string;
		project: string;
		language: string;
		attribution: string;
		license: string;
	};
}
