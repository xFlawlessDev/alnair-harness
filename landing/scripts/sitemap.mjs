/**
 * Write `robots.txt` and `sitemap.xml` into the build output.
 *
 *   PUBLIC_SITE_URL=https://alnair.example.com node scripts/sitemap.mjs
 *
 * Runs after `vite build`, because the page list is discovered from the
 * prerendered output rather than re-declared here: a new docs chapter appears
 * in the sitemap the moment it is prerendered, and cannot be forgotten.
 *
 * It refuses to run without a real origin. A sitemap that lists
 * `https://example.invalid` would be submitted to search engines as the truth,
 * and undoing that takes weeks of reindexing. Failing the build is cheaper.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = 'build';
const origin = (process.env.PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');

/**
 * Move the prerendered not-found page to `404.html`, where static hosts look.
 *
 * SvelteKit writes the `/404` route as `404/index.html`. Cloudflare serves a
 * `404.html` at the root for any unknown path, so the file is moved there and
 * the now-empty directory removed. A missing 404 is not an error for indexing,
 * but it is the difference between a branded, `noindex` page and the host's
 * generic one.
 */
function publishNotFound() {
	const source = path.join(root, '404', 'index.html');
	if (!fs.existsSync(source)) {
		console.warn('sitemap: no prerendered 404 page found; unknown URLs will use the host default');
		return;
	}
	fs.copyFileSync(source, path.join(root, '404.html'));
	fs.rmSync(path.join(root, '404'), { recursive: true, force: true });
}

publishNotFound();

if (!origin || origin.endsWith('.invalid') || !/^https:\/\//.test(origin)) {
	console.error(
		'sitemap: PUBLIC_SITE_URL must be the https origin of the site, e.g. https://alnair.example.com'
	);
	process.exit(1);
}

/** Every prerendered page as a URL path, with the directory-index form normalised. */
function pages(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return pages(full);
		if (entry.name !== 'index.html') return [];
		const rel = path.relative(root, dir).split(path.sep).join('/');
		return [rel === '' ? '/' : `/${rel}/`];
	});
}

/** Whether a path belongs to the Indonesian mirror (`/id/` and everything under it). */
const isIndonesian = (url) => url === '/id/' || url.startsWith('/id/');

/**
 * The English and Indonesian versions of one page, as a pair.
 *
 * Every path has exactly one counterpart: `/` ↔ `/id/`, `/docs/x/` ↔ `/id/docs/x/`.
 * Going from English to Indonesian prepends `/id`; the reverse strips it. The
 * `404` page has no mirror and is excluded before this runs.
 */
function counterpart(url) {
	if (isIndonesian(url)) return url === '/id/' ? '/' : url.slice('/id'.length);
	return url === '/' ? '/id/' : `/id${url}`;
}

const urls = pages(root).filter((url) => url !== '/404/');

const entry = (url) => {
	const english = isIndonesian(url) ? counterpart(url) : url;
	const indonesian = isIndonesian(url) ? url : counterpart(url);

	const alternates = [
		{ hreflang: 'en', href: english },
		{ hreflang: 'id', href: indonesian },
		{ hreflang: 'x-default', href: english }
	]
		.map(
			(a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${origin}${a.href}"/>`
		)
		.join('\n');

	const priority = url === '/' ? '1.0' : url === '/id/' ? '0.9' : '0.6';
	return `  <url>
    <loc>${origin}${url}</loc>
${alternates}
    <priority>${priority}</priority>
  </url>`;
};

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.map(entry).join('\n')}
</urlset>
`;

const robots = `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`;

fs.writeFileSync(path.join(root, 'sitemap.xml'), sitemap);
fs.writeFileSync(path.join(root, 'robots.txt'), robots);

console.log(`sitemap: ${urls.length} URLs for ${origin}`);
