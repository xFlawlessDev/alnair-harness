/**
 * The workspaces the sidebar shows, and the ones the reader put away.
 *
 * The sidebar's groups are derived from sessions — a workspace exists because
 * some session lives in it — which is the right default but leaves two gaps:
 *
 * - a directory the reader just picked has no sessions yet, so it would vanish
 *   from the list the moment it was added;
 * - a workspace the reader is finished with cannot be removed without deleting
 *   its sessions, which is far too destructive for "hide this".
 *
 * So the store keeps two small sets beside the sessions. `added` holds
 * directories the reader chose that are not yet backed by a session;
 * `hidden` holds the workspace keys they put away. Neither touches disk: this
 * is a view preference, and a session list that disagreed with what is on disk
 * would be worse than one that forgets.
 */

import type { Session, WorkspaceGroup } from './types.js';
import { groupByWorkspace } from './workspaces.js';

/** The key a workspace is hidden by: its display name, as the sidebar names it. */
export type WorkspaceKey = string;

export interface WorkspaceView {
	/** Groups in the order they are painted. */
	groups: WorkspaceGroup[];
	/** Added directories with no session yet. */
	pending: WorkspaceGroup[];
	/** Workspaces the reader put away, so they can be brought back. */
	hidden: WorkspaceKey[];
}

/**
 * The last path segment, used for the display name.
 *
 * Kept local rather than imported from `wire.ts`: this module is pure view
 * state, and pulling the wire layer in would make a component test depend on
 * an RPC shape.
 */
function lastSegment(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/**
 * Build the sidebar's workspace list.
 *
 * `added` directories are shown only while they have no session: once one
 * exists, the session-derived group is the same workspace and painting both
 * would double it. `hidden` filters by display name, which is the only stable
 * identity a group has — two different repos with the same leaf name collapse
 * into one group by design (`groupByWorkspace` keys on it).
 */
export function workspaceView(
	sessions: Session[],
	added: string[],
	hidden: WorkspaceKey[]
): WorkspaceView {
	const hiddenSet = new Set(hidden);
	const groups = groupByWorkspace(sessions).filter((group) => !hiddenSet.has(group.name));

	const known = new Set(groups.map((group) => group.name));
	const knownPaths = new Set(groups.map((group) => group.path).filter(Boolean));

	const pending: WorkspaceGroup[] = [];
	for (const path of added) {
		const name = lastSegment(path) || path;
		if (hiddenSet.has(name) || known.has(name)) continue;
		if (knownPaths.has(path)) continue;
		// One entry per directory, even if it was added twice.
		if (pending.some((group) => group.path === path)) continue;
		pending.push({
			name,
			path,
			sessions: [],
			updatedAt: new Date(0).toISOString(),
			active: false
		});
	}

	// A chosen directory sorts with the rest rather than pinning to the top:
	// the list is a set of workspaces, not a queue of recent actions.
	const ordered = [...groups, ...pending].sort((a, b) => a.name.localeCompare(b.name));

	return {
		groups: ordered,
		pending,
		// Sorted so the "hidden" menu does not reorder itself between renders.
		hidden: [...hiddenSet].sort((a, b) => a.localeCompare(b))
	};
}
