import type * as Monaco from 'monaco-editor';

/**
 * The code editor, loaded once and shared.
 *
 * Two things make Monaco usable inside `alnair web` at all:
 *
 * - **It must be dynamic.** The editor and its language grammars are several
 *   megabytes; a reader who never opens the inspector must not download any of
 *   it. Every entry point here is a dynamic `import()`, so the chunk is fetched
 *   on the first panel open and cached afterwards.
 * - **Workers are mandatory.** Monaco runs its tokenizer and (for JSON/TS/CSS)
 *   its language service in a Web Worker, and Vite serves it as a separate
 *   file. Without `MonacoEnvironment.getWorker` pointing at the `?worker`
 *   bundle, the FIRST parse throws — not a degraded render, a blank editor.
 *
 * Only the plain editor worker is wired. That covers every grammar this app
 * uses (the `basic-languages` tokenizers are synchronous and worker-free); the
 * TypeScript/JSON/CSS *language services* are deliberately not registered,
 * because they would add four more worker bundles to serve diagnostics a
 * read-mostly preview panel never shows.
 */
export type MonacoApi = typeof Monaco;

let api: Promise<MonacoApi> | undefined;

export function loadMonaco(): Promise<MonacoApi> {
	api ??= (async () => {
		const [monaco, worker] = await Promise.all([
			import('monaco-editor'),
			import('monaco-editor/esm/vs/editor/editor.worker?worker')
		]);

		// One worker factory for every language id: this build registers no
		// per-language service, so there is nothing to dispatch on.
		(globalThis as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
			getWorker: () => new worker.default()
		};

		defineThemes(monaco.editor);
		return monaco as unknown as MonacoApi;
	})();
	return api;
}

/**
 * Two transparent themes, one per reading mode.
 *
 * A solid `editor.background` would paint a foreign rectangle inside the
 * panel; the app's own surface shows through instead, and the syntax colours
 * come from the standard light/dark rules.
 */
function defineThemes(editor: MonacoApi['editor']) {
	for (const [name, base] of [
		['alnair-light', 'vs'],
		['alnair-dark', 'vs-dark']
	] as const) {
		editor.defineTheme(name, {
			base,
			inherit: true,
			rules: [],
			colors: { 'editor.background': '#00000000' }
		});
	}
}

/** The theme name for the document's current mode. */
export function activeTheme(): string {
	return document.documentElement.classList.contains('dark') ? 'alnair-dark' : 'alnair-light';
}

/**
 * A file extension as a Monaco language id.
 *
 * Monaco ships no ids for `.svelte`, `.toml` or `.tsx`, so the closest real
 * grammar is used rather than `plaintext`: a preview of a Svelte component
 * reads far better with HTML's rules than with none.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	ts: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	tsx: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	json: 'json',
	md: 'markdown',
	markdown: 'markdown',
	rs: 'rust',
	py: 'python',
	toml: 'ini',
	ini: 'ini',
	cfg: 'ini',
	yml: 'yaml',
	yaml: 'yaml',
	sh: 'shell',
	bash: 'shell',
	zsh: 'shell',
	css: 'css',
	scss: 'scss',
	less: 'less',
	html: 'html',
	htm: 'html',
	svelte: 'html',
	vue: 'html',
	sql: 'sql',
	diff: 'diff',
	patch: 'diff',
	go: 'go',
	java: 'java',
	rb: 'ruby',
	c: 'c',
	h: 'c',
	cpp: 'cpp',
	cc: 'cpp',
	hpp: 'cpp',
	cs: 'csharp',
	php: 'php',
	lua: 'lua',
	xml: 'xml',
	svg: 'xml'
};

export function languageFor(extension: string | undefined): string {
	return LANGUAGE_BY_EXTENSION[(extension ?? '').toLowerCase()] ?? 'plaintext';
}
