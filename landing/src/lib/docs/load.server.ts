import { error } from '@sveltejs/kit';
import { anchorMap, docsList, loadDoc, guideIntro } from '$lib/docs/source';
import { render_doc } from '$lib/docs/render';
import type { Locale } from '$lib/i18n';

/**
 * Server-only loader for one guide page.
 *
 * A missing slug is a 404 rather than an empty page: the sidebar links every
 * doc, so a blank page would mean a broken link rather than an empty one.
 */
export async function loadGuide(slug: string, locale: Locale) {
	const doc = loadDoc(slug);
	if (!doc) error(404, `No guide named ${slug}`);

	const prefix = locale === 'en' ? '/docs/' : '/id/docs/';
	const rendered = await render_doc(doc.markdown, { prefix, anchors: anchorMap() });

	// Rough read time from the prose, not the code: a table of flags is scanned,
	// not read. 200 words a minute is the usual floor for technical text.
	const words = doc.markdown
		.replace(/```[\s\S]*?```/g, ' ')
		.split(/\s+/)
		.filter(Boolean).length;
	const minutes = Math.max(1, Math.round(words / 200));

	return {
		doc: {
			slug: doc.slug,
			file: doc.file,
			title: doc.title,
			description: doc.description
		},
		docs: docsList(),
		...rendered,
		minutes
	};
}

export function loadIndex() {
	return { docs: docsList(), intro: guideIntro() };
}
