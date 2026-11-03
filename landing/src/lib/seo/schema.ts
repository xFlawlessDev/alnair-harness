/**
 * Structured data (schema.org JSON-LD), built as plain objects.
 *
 * Kept as functions rather than inline literals so each shape is written once,
 * is typed by its inputs, and can be asserted in a test. Every URL is absolute
 * and every string is taken from the copy the page already renders — the data
 * must describe what a reader sees, or search engines discount it.
 */
import { SITE_NAME, absolute } from './site';

/** The product itself, on the home page. Lets search show the app, not just a link. */
export function softwareApplication(input: {
	name: string;
	description: string;
	url: string;
	inLanguage: string;
	image: string;
}) {
	return {
		'@type': 'SoftwareApplication',
		name: input.name,
		description: input.description,
		url: input.url,
		image: input.image,
		inLanguage: input.inLanguage,
		applicationCategory: 'DeveloperApplication',
		operatingSystem: 'macOS, Linux, Windows',
		license: 'https://www.apache.org/licenses/LICENSE-2.0',
		isAccessibleForFree: true,
		offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
		author: { '@type': 'Organization', name: SITE_NAME, url: absolute('/') }
	};
}

/** The FAQ block, so each question can appear as a rich result. */
export function faqPage(items: { q: string; a: string }[], inLanguage: string) {
	return {
		'@type': 'FAQPage',
		inLanguage,
		mainEntity: items.map((item) => ({
			'@type': 'Question',
			name: item.q,
			acceptedAnswer: { '@type': 'Answer', text: item.a }
		}))
	};
}

/** Breadcrumb trail for a docs page: Home › User guide › Chapter. */
export function breadcrumbs(trail: { name: string; path: string }[]) {
	return {
		'@type': 'BreadcrumbList',
		itemListElement: trail.map((step, index) => ({
			'@type': 'ListItem',
			position: index + 1,
			name: step.name,
			item: absolute(step.path)
		}))
	};
}

/** A docs chapter, as the technical article it is. */
export function techArticle(input: {
	headline: string;
	description: string;
	url: string;
	inLanguage: string;
	dateModified?: string;
}) {
	return {
		'@type': 'TechArticle',
		headline: input.headline,
		description: input.description,
		url: input.url,
		inLanguage: input.inLanguage,
		...(input.dateModified ? { dateModified: input.dateModified } : {}),
		author: { '@type': 'Organization', name: SITE_NAME, url: absolute('/') },
		publisher: { '@type': 'Organization', name: SITE_NAME, url: absolute('/') },
		isPartOf: { '@type': 'WebSite', name: `${SITE_NAME} user guide`, url: absolute('/docs/') }
	};
}
