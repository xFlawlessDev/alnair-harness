/**
 * Site-wide SEO constants: the one place the public origin is used.
 *
 * `SITE_URL` must be the absolute origin the site is served from. Canonical
 * links, hreflang alternates, the sitemap and Open Graph images all derive from
 * it, and a relative URL in any of them is ignored or misread by crawlers — the
 * most common reason a site is indexed under the wrong address.
 *
 * The value comes from `src/env.ts`, validated and inlined at build time.
 */
import { PUBLIC_SITE_URL } from '$app/env/public';

export const SITE_NAME = 'Alnair';

/** Trailing slashes stripped so `${SITE_URL}${path}` never doubles one. */
export const SITE_URL: string = PUBLIC_SITE_URL.replace(/\/+$/, '');

/** True until a real origin is supplied; gates the sitemap and robots output. */
export const IS_PLACEHOLDER: boolean = SITE_URL.endsWith('.invalid');

export const LOCALES = ['en', 'id'] as const;
export type SiteLocale = (typeof LOCALES)[number];

/** The path each locale's home page lives at. `en` is the root and the `x-default`. */
export const HOME_PATH: Record<SiteLocale, string> = { en: '/', id: '/id/' };

/** Absolute URL for a site-relative path. Always absolute: never trust a relative canonical. */
export function absolute(path: string): string {
	return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The image shared when a page is linked on social media. */
export const OG_IMAGE: string = absolute('/media/alnair-demo-poster.jpg');
