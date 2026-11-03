import { loadIndex } from '$lib/docs/load.server';
import type { LayoutServerLoad } from './$types';

/**
 * The sidebar is part of the layout, so its list is loaded once per language
 * rather than attached to every page's data.
 */
export const load: LayoutServerLoad = async () => {
	const { docs } = loadIndex();
	return { docs };
};
