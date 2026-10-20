import { describe, expect, it } from 'vitest';
import { countSessions, groupByWorkspace } from './workspaces.js';
import type { Session } from './types.js';

const session = (
	id: string,
	workspace: string,
	updatedAt: string,
	status: Session['status'] = 'idle'
): Session => ({
	id,
	title: id,
	cwd: `/dev/${workspace}`,
	workspace,
	source: 'local',
	numMessages: 1,
	createdAt: '2026-10-01T00:00:00Z',
	updatedAt,
	status
});

describe('groupByWorkspace', () => {
	it('nests conversations under their workspace', () => {
		const groups = groupByWorkspace([
			session('a', 'alnair-cli', '2026-10-20T10:00:00Z'),
			session('b', 'alnair-cli', '2026-10-20T11:00:00Z'),
			session('c', 'alnair-site', '2026-10-20T09:00:00Z')
		]);
		expect(groups.map((group) => group.name)).toEqual(['alnair-cli', 'alnair-site']);
		expect(groups[0].sessions.map((entry) => entry.id)).toEqual(['b', 'a']);
	});

	it('keeps the order stable regardless of which session is active', () => {
		// Clicking a conversation must not move its group to the top: a list
		// that reorders under the pointer loses the row the reader aimed at.
		const rows = [
			session('a', 'alnair-cli', '2026-10-20T10:00:00Z'),
			session('c', 'zzz-site', '2026-10-20T09:00:00Z')
		];
		expect(groupByWorkspace(rows).map((group) => group.name)).toEqual(['alnair-cli', 'zzz-site']);

		const withOtherActive = rows.map((row) =>
			row.id === 'c' ? { ...row, status: 'running' as const } : row
		);
		expect(groupByWorkspace(withOtherActive).map((group) => group.name)).toEqual([
			'alnair-cli',
			'zzz-site'
		]);
	});

	it('marks a workspace active when any of its sessions is busy', () => {
		const groups = groupByWorkspace([
			session('a', 'alnair-cli', '2026-10-20T10:00:00Z', 'running'),
			session('b', 'alnair-site', '2026-10-20T10:00:00Z')
		]);
		expect(groups.find((group) => group.name === 'alnair-cli')?.active).toBe(true);
		expect(groups.find((group) => group.name === 'alnair-site')?.active).toBe(false);
	});

	it('falls back to the cwd when the agent sent no workspace name', () => {
		const orphan = { ...session('a', '', '2026-10-20T10:00:00Z'), cwd: '/dev/some/repo' };
		const groups = groupByWorkspace([orphan]);
		expect(groups[0].name).toBe('repo');
	});

	it('counts every conversation across groups', () => {
		const groups = groupByWorkspace([
			session('a', 'one', '2026-10-20T10:00:00Z'),
			session('b', 'one', '2026-10-20T10:00:00Z'),
			session('c', 'two', '2026-10-20T10:00:00Z')
		]);
		expect(countSessions(groups)).toBe(3);
	});
});
