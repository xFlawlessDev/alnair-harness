import { Marked, type Tokens } from 'marked';
import { highlight } from './highlight.server';
import { anchor_key, slugify } from './slug';

/**
 * Markdown → HTML for the docs pages.
 *
 * The same render runs at build time for both languages, and it is a pure
 * function of (markdown, prefix): nothing in it reads the DOM, so a prerendered
 * page and a client-side navigation produce identical markup.
 *
 * Highlighting happens in a PRE-PASS rather than inside marked's renderer.
 * marked runs synchronously while Shiki is async, and making the whole parser
 * async would force every renderer method to return a promise for no benefit —
 * the parse itself has nothing to wait on. So the fenced blocks are highlighted
 * first, in order, and the sync renderer splices them back in by index.
 *
 * Three things are specific to these docs rather than to markdown in general:
 *
 * - **Links to sibling docs become site links.** The guide is written for the
 *   TUI, where `[Hooks](10-hooks.md)` is a file in the same folder. Published,
 *   that link must become `/docs/hooks/`, and a `#anchor` must survive the hop.
 * - **Headings get ids.** Without them neither the table of contents nor the
 *   cross-document `#harness-compatibility` links can land anywhere.
 * - **Code is highlighted at build time**, so the page ships no Shiki runtime.
 */

export interface Heading {
	id: string;
	text: string;
	level: number;
}

export interface RenderedDoc {
	html: string;
	headings: Heading[];
}

/** ```` ```lang … ``` ```` — the only fence form the guide uses. */
const FENCE = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm;

function strip_tags(html: string): string {
	return html.replace(/<[^>]+>/g, '');
}

/**
 * The guide's own file links, rewritten for the site.
 *
 * `10-hooks.md` → `{prefix}hooks/`, and `05-configuration.md#harness-compatibility`
 * → `{prefix}configuration/#harness-compatibility`. Anything that is not a
 * sibling doc (http, mailto, an in-page `#`) is returned untouched.
 */
export function resolve_doc_link(href: string, prefix: string): string {
	const sibling = /^(?:\.\/)?(\d{2}-[a-z0-9-]+)\.md(#[^\s]*)?$/i.exec(href);
	if (sibling) {
		const slug = sibling[1].replace(/^\d+-/, '');
		return `${prefix}${slug}/${sibling[2] ?? ''}`;
	}
	if (/^README\.md(#[^\s]*)?$/i.test(href)) {
		return `${prefix}${href.replace(/^README\.md/, '')}`;
	}
	return href;
}

/**
 * A link the site cannot serve, turned into its text.
 *
 * The guide is an in-repo document, so a handful of its links point at sources
 * that are not part of it — `../../plan/agent-dashboard.md` is the design plan
 * the user guide quotes from, and it is neither published nor embedded in the
 * binary. Leaving a relative `.md` link in published HTML would 404 for every
 * reader, and prerendering it would fail the build, so the anchor is flattened
 * and the sentence stays readable. The rule is by shape, not by a list: every
 * relative markdown path is unpublished by definition.
 */
function unservable(href: string): boolean {
	return !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && /\.md(#|$)/i.test(href);
}

function escape_html(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

interface PreparedFence {
	html: string;
}

/**
 * Highlight every fenced block, in document order.
 *
 * An unlabelled fence in this guide is a TUI transcript — box drawing and
 * status glyphs, not code. Highlighting it would tokenise box characters as
 * operators, so it is emitted as plain text in its own frame.
 */
async function prepare_fences(markdown: string): Promise<PreparedFence[]> {
	const fences: PreparedFence[] = [];

	for (const match of markdown.matchAll(FENCE)) {
		const language = (match[1] ?? '').trim().split(/\s+/)[0] ?? '';
		const text = match[2] ?? '';

		if (!language) {
			fences.push({
				html: `<div class="doc-frame"><pre class="doc-transcript">${escape_html(text)}</pre></div>`
			});
			continue;
		}

		const highlighted = await highlight(text, language);
		const body = highlighted?.html ?? `<pre><code>${escape_html(text)}</code></pre>`;
		fences.push({ html: `<div class="doc-code" data-lang="${language}">${body}\n</div>` });
	}

	return fences;
}

/**
 * Repair a cross-document fragment against the ids the target page really has.
 *
 * A path-absolute site link with a `#fragment` is checked against the anchor
 * index: an exact match is left alone, a loose match is rewritten to the id
 * that exists, and a miss drops the fragment so the reader still lands on the
 * page instead of nowhere.
 */
function repair_anchor(target: string, prefix: string, anchors?: Map<string, string>): string {
	if (!anchors || !target.startsWith(prefix)) return target;
	const hash = target.indexOf('#');
	if (hash < 0) return target;

	const fragment = target.slice(hash + 1);
	const repaired = anchors.get(anchor_key(fragment));
	return repaired ? `${target.slice(0, hash)}#${repaired}` : target.slice(0, hash);
}

export interface RenderOptions {
	/** Site path the doc lives under, e.g. `/docs/` or `/id/docs/`. */
	prefix: string;
	/**
	 * anchor key → exact id, for every guide. Used to repair a cross-document
	 * fragment that was written by hand against a heading spelled differently.
	 */
	anchors?: Map<string, string>;
}

export async function render_doc(markdown: string, options: RenderOptions): Promise<RenderedDoc> {
	const headings: Heading[] = [];
	const seen = new Map<string, number>();

	// The page header already prints the title and the registry's description, so
	// the document's own leading `# Title` is a duplicate — it rendered as a
	// second h1 directly under the real one.
	markdown = markdown.replace(/^\s*#\s+[^\n]*\n/, '');

	const fences = await prepare_fences(markdown);
	let fenceIndex = 0;

	const marked = new Marked({
		async: false,
		gfm: true,
		renderer: {
			// Every section in this guide is separated by a `---`, and headings
			// carry their own top rule. Rendering the rule as well drew two lines
			// a few pixels apart.
			hr() {
				return '';
			},

			heading({ tokens, depth }: Tokens.Heading) {
				const text = strip_tags(this.parser.parseInline(tokens));
				let id = slugify(text);
				const duplicate = seen.get(id) ?? 0;
				seen.set(id, duplicate + 1);
				if (duplicate > 0) id = `${id}-${duplicate}`;

				headings.push({ id, text, level: depth });
				return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
			},

			link({ href, title, tokens }: Tokens.Link) {
				const text = this.parser.parseInline(tokens);
				const target = repair_anchor(
					resolve_doc_link(href, options.prefix),
					options.prefix,
					options.anchors
				);
				if (unservable(target)) return text;

				const external = /^https?:\/\//i.test(target);
				const attrs = [
					`href="${target}"`,
					title ? `title="${title}"` : '',
					external ? 'rel="noreferrer"' : ''
				]
					.filter(Boolean)
					.join(' ');
				return `<a ${attrs}>${text}</a>`;
			},

			code(_token: Tokens.Code) {
				const fence = fences[fenceIndex++];
				return fence ? `${fence.html}\n` : '';
			}
		}
	});

	const html = marked.parse(markdown, { async: false }) as string;
	return { html, headings };
}
