import fs from 'node:fs';
import path from 'node:path';

/**
 * Every generated page, and the anchors it is linked to with.
 *
 *   node scripts/check-links.mjs
 *
 * SvelteKit's prerenderer already fails on a dangling fragment between two of
 * its own pages, but it does not know about two cases that matter here: the
 * Indonesian mirror (a different build pass, and its own copy of every link)
 * and any anchor written by hand in the guide. This walks the output and
 * reports a link whose target page or fragment is missing, so the site never
 * ships a link to nowhere.
 */

const root = 'build';

/** A page's URL path, always with POSIX separators (the build runs on Windows too). */
function posix(file) {
	return path
		.relative(root, file)
		.split(path.sep)
		.join('/')
		.replace(/index\.html$/, '');
}

function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return walk(full);
		return entry.name === 'index.html' ? [full] : [];
	});
}

const pages = walk(root);
const ids = new Map();

for (const file of pages) {
	const url = '/' + posix(file);
	const html = fs.readFileSync(file, 'utf8');
	ids.set(url, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
}

const problems = [];

for (const file of pages) {
	const url = '/' + posix(file);
	const html = fs.readFileSync(file, 'utf8');

	for (const match of html.matchAll(/<a\s[^>]*href="([^"]+)"/g)) {
		const href = match[1];
		if (!href.startsWith('/') || href.startsWith('//')) continue;

		const [pathname, fragment] = href.split('#');
		const target = pathname.endsWith('/') ? pathname : `${pathname}/`;
		if (!ids.has(target)) {
			problems.push(`${url} → ${href}: no such page`);
			continue;
		}
		if (fragment && !ids.get(target).has(fragment)) {
			problems.push(`${url} → ${href}: page exists, #${fragment} does not`);
		}
	}
}

console.log(`${pages.length} pages, ${problems.length} broken links`);
for (const problem of problems) console.log(' ', problem);
process.exit(problems.length > 0 ? 1 : 0);
