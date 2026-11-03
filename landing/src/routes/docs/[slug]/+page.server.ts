import { docsList } from '$lib/docs/source';
import { loadGuide } from '$lib/docs/load.server';
import type { EntryGenerator, PageServerLoad } from './$types';

/**
 * `entries` is what makes every guide a real prerendered page: the adapter
 * would otherwise know only the index route, and `/docs/hooks/` would 404 on a
 * static host even though the markdown is right there.
 */
export const entries: EntryGenerator = () => docsList().map((doc) => ({ slug: doc.slug }));

export const load: PageServerLoad = async ({ params }) => loadGuide(params.slug, 'en');
