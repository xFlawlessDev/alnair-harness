import { describe, expect, it } from 'vitest';
import { workspaceView } from './workspace-view.js';
import type { Session } from './types.js';

/**
 * The sidebar's workspace list.
 *
 * Two gaps in a session-derived list are what this covers: a directory the
 * reader just added has no session yet (so it would vanish), and a workspace
 * they are finished with cannot be removed without deleting transcripts (so it
 * needs hiding instead).
 */

function session(overrides: Partial<Session> & { id: string; cwd: string }): Session {
	const leaf =
		overrides.cwd
			.replace(/[\\/]+$/, '')
			.split(/[\\/]/)
			.pop() ?? overrides.cwd;
	return {
		title: overrides.id,
		source: 'local',
		numMessages: 0,
		createdAt: '2026-10-22T08:00:00Z',
		updatedAt: '2026-10-22T09:00:00Z',
		workspace: leaf,
		status: 'idle',
		...overrides
	};
}

describe('workspaceView', () => {
	it('groups sessions by workspace, alphabetically', () => {
		const view = workspaceView(
			[session({ id: 'a', cwd: '/work/zeta' }), session({ id: 'b', cwd: '/work/alpha' })],
			[],
			[]
		);
		expect(view.groups.map((group) => group.name)).toEqual(['alpha', 'zeta']);
	});

	it('shows a directory the reader added even with no session yet', () => {
		// The whole point of the added set: a freshly picked directory has no
		// session, so a session-derived list would drop it immediately.
		const view = workspaceView([], ['/work/fresh'], []);
		expect(view.groups.map((group) => group.name)).toEqual(['fresh']);
		expect(view.groups[0].sessions).toEqual([]);
		expect(view.groups[0].path).toBe('/work/fresh');
	});

	it('does not double a directory that already has a session', () => {
		// Once the session exists, the session-derived group IS the workspace;
		// painting the added entry too would show the directory twice.
		const view = workspaceView([session({ id: 'a', cwd: '/work/repo' })], ['/work/repo'], []);
		expect(view.groups).toHaveLength(1);
		expect(view.groups[0].sessions).toHaveLength(1);
	});

	it('deduplicates a directory added twice', () => {
		const view = workspaceView([], ['/work/fresh', '/work/fresh'], []);
		expect(view.groups).toHaveLength(1);
	});

	it('hides a workspace by name without touching its sessions', () => {
		const sessions = [
			session({ id: 'a', cwd: '/work/repo' }),
			session({ id: 'b', cwd: '/work/other' })
		];
		const view = workspaceView(sessions, [], ['repo']);

		expect(view.groups.map((group) => group.name)).toEqual(['other']);
		expect(view.hidden).toEqual(['repo']);
		// The sessions still exist: hiding is a view preference, not a delete.
		expect(sessions).toHaveLength(2);
	});

	it('hides an added directory that was not backed by a session', () => {
		const view = workspaceView([], ['/work/fresh'], ['fresh']);
		expect(view.groups).toEqual([]);
	});

	it('offers every hidden workspace back, sorted for a stable menu', () => {
		const view = workspaceView([], [], ['zeta', 'alpha']);
		expect(view.hidden).toEqual(['alpha', 'zeta']);
	});

	it('sorts added directories with the session-derived groups', () => {
		// A chosen directory is a workspace, not a queue entry: pinning it to
		// the top would move the list under the reader on every add.
		const view = workspaceView(
			[session({ id: 'a', cwd: '/work/beta' })],
			['/work/alpha', '/work/zeta'],
			[]
		);
		expect(view.groups.map((group) => group.name)).toEqual(['alpha', 'beta', 'zeta']);
	});

	it('reports an empty list when nothing is known', () => {
		const view = workspaceView([], [], []);
		expect(view.groups).toEqual([]);
		expect(view.pending).toEqual([]);
		expect(view.hidden).toEqual([]);
	});

	it('keeps a trailing separator out of the display name', () => {
		const view = workspaceView([], ['/work/fresh/'], []);
		expect(view.groups[0].name).toBe('fresh');
	});
});
