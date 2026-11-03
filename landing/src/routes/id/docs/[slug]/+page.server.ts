import { docsList } from '$lib/docs/source';
import { loadGuide } from '$lib/docs/load.server';
import type { EntryGenerator, PageServerLoad } from './$types';

export const entries: EntryGenerator = () => docsList().map((doc) => ({ slug: doc.slug }));

export const load: PageServerLoad = async ({ params }) => loadGuide(params.slug, 'id');
