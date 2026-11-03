import { createHighlighter } from 'shiki';

/**
 * The highlighter used at BUILD time.
 *
 * The docs are prerendered, so tokens are baked into the HTML once instead of
 * being computed in every reader's browser — the page ships no Shiki runtime.
 * Only the languages the guide actually fences are loaded; the set comes from a
 * survey of the guide, not from guesswork.
 *
 * The theme pair is the app's, so a config snippet on the site and the same
 * snippet in `alnair web` are the same colours.
 */
type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

let highlighter: Promise<Highlighter> | undefined;

const languages = [
	'toml',
	'bash',
	'json',
	'markdown',
	'powershell',
	'typescript',
	'python',
	'lua',
	'yaml'
];

/** Shiki has no `.gitignore` grammar; the files are shell-ish in practice. */
const aliases: Record<string, string> = { gitignore: 'bash' };

function get_highlighter(): Promise<Highlighter> {
	highlighter ??= createHighlighter({
		themes: ['github-light', 'github-dark'],
		langs: languages
	});
	return highlighter;
}

export async function highlight(
	code: string,
	language: string
): Promise<{ html: string } | undefined> {
	const shiki = await get_highlighter();
	const lang = aliases[language] ?? language;
	if (!shiki.getLoadedLanguages().includes(lang)) return undefined;

	return {
		html: shiki.codeToHtml(code, {
			lang,
			themes: { light: 'github-light', dark: 'github-dark' },
			defaultColor: false
		})
	};
}
