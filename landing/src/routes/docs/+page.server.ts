import { loadIndex } from '$lib/docs/load.server';
import type { PageServerLoad } from './$types';

/**
 * The guide index: every chapter, read from the same list the TUI builds its
 * docs picker from.
 */
export const load: PageServerLoad = async () => {
	const { docs, intro } = loadIndex();
	return { docs, intro };
};
