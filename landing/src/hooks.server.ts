import type { Handle } from '@sveltejs/kit/hooks';
import { LOCALES } from '$lib/i18n';

/**
 * Each language is its own prerendered document, so `<html lang>` is decided at
 * build time instead of being patched by a script after hydration. `%lang%` is
 * the token in `app.html`; this is the only thing that fills it in.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const lang = LOCALES.find((locale) => event.url.pathname.startsWith(`/${locale}/`)) ?? 'en';

	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%lang%', lang)
	});
};
