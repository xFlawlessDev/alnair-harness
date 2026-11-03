/**
 * Slug rules, shared by the renderer (which writes ids) and the link resolver
 * (which has to match them).
 *
 * Two spellings have to meet in the middle. The renderer sees the heading's
 * plain text — "`Ctrl+Enter` doesn't interject in WezTerm" — while the guide
 * links to `#problem-ctrlenter-doesnt-interject-in-wezterm`, an anchor the
 * author wrote by hand and one the docs' own viewer never checked. So ids are
 * generated from a normalised form and lookups compare a further-loosened key.
 *
 * The "Problem: " prefix is dropped because the guide's links omit it: every
 * `### Problem: …` heading is linked as `<name-of-the-problem>`.
 */

const STOP_PREFIX = /^(problem|issue|note|warning):\s*/i;

/**
 * Undo the entities the inline parser emits.
 *
 * `marked` escapes `'` to `&#39;` while parsing inline text, so slugifying the
 * rendered fragment directly turns "doesn't" into `doesn39t`. The guide's own
 * anchors are written in plain text, so the entity has to come back off before
 * anything else runs.
 */
function unescape_entities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

function normalise(text: string): string {
	return unescape_entities(text).replace(STOP_PREFIX, '');
}

/** The id a heading gets: lowercase, punctuation dropped, spaces to dashes. */
export function slugify(text: string): string {
	return normalise(text)
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[`*_~]/g, '')
		.replace(/[^\p{L}\p{N}\s-]/gu, '')
		.trim()
		.replace(/\s+/g, '-');
}

/** The comparison key: everything but letters and digits is gone. */
export function anchor_key(text: string): string {
	return normalise(text)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '');
}
