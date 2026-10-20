import type { Session, WorkspaceGroup } from './types.js';

/**
 * Regroup the flat session list into workspaces.
 *
 * `alnair/session/list` returns one flat row per conversation, each naming its
 * repo. The sidebar wants the opposite shape — workspace first, conversations
 * nested under it — so the grouping happens here, once, and the components
 * never re-derive it.
 *
 * The order is stable: groups alphabetically, sessions newest-first inside a
 * group. Nothing is pinned by the active session, because a list that reorders
 * when you click it moves the row out from under the pointer.
 */
export function groupByWorkspace(sessions: Session[]): WorkspaceGroup[] {
	const groups = new Map<string, WorkspaceGroup>();

	for (const session of sessions) {
		// The agent derives `repoName` from the cwd, so it is always present;
		// fall back to the cwd's last segment for a row that predates it.
		const name = session.workspace || lastSegment(session.cwd) || 'unknown';

		let group = groups.get(name);
		if (!group) {
			group = {
				name,
				path: session.gitRootDir ?? session.cwd,
				sessions: [],
				updatedAt: session.updatedAt,
				active: false
			};
			groups.set(name, group);
		}

		group.sessions.push(session);
		if (session.updatedAt > group.updatedAt) group.updatedAt = session.updatedAt;
		if (session.status !== 'idle') group.active = true;
		if (!group.path && (session.gitRootDir ?? session.cwd)) {
			group.path = session.gitRootDir ?? session.cwd;
		}
	}

	const ordered = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));

	for (const group of ordered) {
		group.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	return ordered;
}

const lastSegment = (path: string): string => {
	const trimmed = path.replace(/[\\/]+$/, '');
	const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	return index === -1 ? trimmed : trimmed.slice(index + 1);
};

/** Total conversations across every workspace. */
export const countSessions = (groups: WorkspaceGroup[]): number =>
	groups.reduce((total, group) => total + group.sessions.length, 0);
