import { en } from './content/en';
import { id } from './content/id';
import type { SiteCopy } from './content/types';

/** The languages this site is built in. `en` is the default and the x-default. */
export const LOCALES = ['en', 'id'] as const;

export type Locale = (typeof LOCALES)[number];

const dictionaries: Record<Locale, SiteCopy> = { en, id };

export function dictionary(locale: Locale): SiteCopy {
	return dictionaries[locale];
}

/**
 * An in-page link in the given language.
 *
 * Both languages are prerendered as real documents (`/` and `/id/`), so the
 * switch is a link, not client state: the Indonesian page is a URL that can be
 * shared, bookmarked and indexed, and it renders without JavaScript.
 */
export function href(locale: Locale, hash = ''): string {
	const base = locale === 'en' ? '/' : '/id/';
	return hash ? `${base}${hash.startsWith('#') ? hash : `#${hash}`}` : base;
}

export const other = (locale: Locale): Locale => (locale === 'en' ? 'id' : 'en');
