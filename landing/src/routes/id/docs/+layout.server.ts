import { loadIndex } from '$lib/docs/load.server';
import type { LayoutServerLoad } from './$types';

/** Same guide, same order — only the page's language and link prefix differ. */
export const load: LayoutServerLoad = async () => {
	const { docs } = loadIndex();
	return { docs };
};
