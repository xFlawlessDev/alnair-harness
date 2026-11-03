import { loadIndex } from '$lib/docs/load.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const { docs, intro } = loadIndex();
	return { docs, intro };
};
