import fs from 'node:fs';
import path from 'node:path';
import { anchor_key, slugify } from './slug';

/**
 * The docs source.
 *
 * There is exactly one copy of the user guide, and it lives in the app:
 * `crates/codegen/alnair-tui/docs/user-guide/`. The TUI embeds those files with
 * `include_str!` and extracts them to `~/.alnair/docs/user-guide`, and this
 * module reads the same bytes at build time, so the site can never publish a
 * guide that differs from the one the binary ships.
 *
 * Titles and descriptions come from the SAME registry the TUI uses
 * (`crates/codegen/alnair-tui/src/docs.rs`, `USER_GUIDE`), parsed rather than
 * retyped — a retyped table is a second source of truth, and the two drift.
 */

declare const __DOCS_ROOT__: string;

/**
 * The repository root, injected by Vite (`define` in `vite.config.ts`).
 *
 * A `path.relative` walk up from `import.meta` cannot work here: the build
 * bundle runs from `.svelte-kit/output`, so `../..` lands inside `.svelte-kit`
 * rather than in the checkout.
 */
const REPO_ROOT = __DOCS_ROOT__;
const DOCS_DIR = path.join(REPO_ROOT, 'crates/codegen/alnair-tui/docs/user-guide');
const REGISTRY = path.join(REPO_ROOT, 'crates/codegen/alnair-tui/src/docs.rs');

export interface DocMeta {
	/** File name, e.g. `07-mcp-servers.md`. Used as the URL slug source. */
	file: string;
	/** URL segment: `mcp-servers`. */
	slug: string;
	title: string;
	description: string;
}

export interface Doc extends DocMeta {
	markdown: string;
}

const entry_pattern =
	/guide!\(\s*"([^"]+)",\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\)/g;

function unescape_rust(value: string): string {
	return value.replace(/\\(["\\])/g, '$1');
}

function slug_of(file: string): string {
	return file.replace(/^\d+-/, '').replace(/\.md$/, '');
}

let cache: DocMeta[] | undefined;

/**
 * The ordered guide list: registry order first (the TUI's own order, which is
 * the order a beginner should read in), then any doc on disk the registry does
 * not name — a new page must not be invisible because someone forgot the
 * registry line. The registry ordering is also checked against the disk: a
 * `guide!` entry whose file is gone fails the build rather than 404ing later.
 */
export function docsList(): DocMeta[] {
	if (cache) return cache;

	const registry = fs.readFileSync(REGISTRY, 'utf8');
	const fromRegistry: DocMeta[] = [];
	for (const match of registry.matchAll(entry_pattern)) {
		const file = match[1];
		if (!fs.existsSync(path.join(DOCS_DIR, file))) {
			throw new Error(`docs.rs names ${file}, which does not exist in ${DOCS_DIR}`);
		}
		fromRegistry.push({
			file,
			slug: slug_of(file),
			title: unescape_rust(match[2]),
			description: unescape_rust(match[3])
		});
	}

	if (fromRegistry.length === 0) {
		throw new Error(`could not parse any guide! entries from ${REGISTRY}`);
	}

	const named = new Set(fromRegistry.map((doc) => doc.file));
	const onDisk = fs
		.readdirSync(DOCS_DIR)
		.filter((name) => /^\d{2}-.+\.md$/.test(name) && !named.has(name))
		.sort();

	for (const file of onDisk) {
		const { title, description } = describe_unregistered(path.join(DOCS_DIR, file));
		fromRegistry.push({ file, slug: slug_of(file), title, description });
	}

	cache = fromRegistry;
	return cache;
}

/**
 * A doc the registry does not name still needs a title: its first `#` heading
 * and its first paragraph are exactly what `guide!` would have recorded.
 */
function describe_unregistered(file: string): { title: string; description: string } {
	const markdown = fs.readFileSync(file, 'utf8');
	const lines = markdown.split('\n');
	const heading = lines.find((line) => line.startsWith('# ')) ?? '';
	const index = lines.indexOf(heading);
	const paragraph = lines
		.slice(index + 1)
		.find((line) => line.trim().length > 0 && !line.startsWith('>'));
	return {
		title: heading.replace(/^#\s*/, '') || path.basename(file, '.md'),
		description: (paragraph ?? '').replace(/\*\*/g, '').trim()
	};
}

export function loadDoc(slug: string): Doc | undefined {
	const meta = docsList().find((doc) => doc.slug === slug);
	if (!meta) return undefined;

	return { ...meta, markdown: fs.readFileSync(path.join(DOCS_DIR, meta.file), 'utf8') };
}

/** The prose sections of the guide index (`README.md`), minus its link tables. */
export function guideIntro(): string {
	const file = path.join(DOCS_DIR, 'README.md');
	if (!fs.existsSync(file)) return '';
	const markdown = fs.readFileSync(file, 'utf8');
	return markdown
		.split('\n')
		.filter((line) => !line.startsWith('|'))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Every heading id the guide defines, as one `anchor key → exact id` map.
 *
 * One map for the whole guide is enough because the ids are globally distinct
 * in practice (`escape`, `harness-compatibility`, …), and it keeps the renderer
 * from taking a per-document lookup table it would then have to thread through.
 * The first spelling of a key wins, so a repaired link points at the first page
 * that defines it.
 */
let anchorCache: Map<string, string> | undefined;

export function anchorMap(): Map<string, string> {
	if (anchorCache) return anchorCache;

	const map = new Map<string, string>();
	for (const doc of docsList()) {
		const markdown = fs.readFileSync(path.join(DOCS_DIR, doc.file), 'utf8');
		// Fenced code first: a `# comment` inside a snippet is not a heading.
		const headings = markdown
			.replace(/```[\s\S]*?```/g, '')
			.split('\n')
			.filter((line) => /^#{1,6}\s/.test(line))
			.map((line) => line.replace(/^#{1,6}\s+/, '').trim());

		const seen = new Map<string, number>();
		for (const heading of headings) {
			const base = slugify(heading);
			const duplicate = seen.get(base) ?? 0;
			seen.set(base, duplicate + 1);
			const id = duplicate > 0 ? `${base}-${duplicate}` : base;

			const key = anchor_key(id);
			if (!map.has(key)) map.set(key, id);
		}
	}

	anchorCache = map;
	return map;
}
