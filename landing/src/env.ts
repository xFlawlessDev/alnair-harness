import { defineEnvVars } from '@sveltejs/kit/env';
import * as v from 'valibot';

/**
 * The environment this site is built with.
 *
 * `PUBLIC_SITE_URL` is the origin every canonical, hreflang, sitemap and
 * Open Graph URL is built from. It is `static` so SvelteKit inlines it at build
 * time, which keeps the prerendered HTML fixed: no runtime lookup, and nothing
 * for a crawler to see differ between two requests.
 *
 * The schema requires an https origin when the site is actually built and
 * deployed (`building` is true during prerender), and accepts a placeholder
 * during `svelte-kit sync` and `npm run check`, so a fresh clone still type-checks.
 */
export const variables = defineEnvVars({
	PUBLIC_SITE_URL: {
		public: true,
		static: true,
		description: 'Absolute https origin the site is served from, without a trailing slash.',
		schema: v.optional(
			v.pipe(
				v.string(),
				v.regex(
					/^https:\/\/[^/\s]+$/,
					'PUBLIC_SITE_URL must be an https origin, e.g. https://alnair.example.com'
				)
			),
			'https://example.invalid'
		)
	}
});
