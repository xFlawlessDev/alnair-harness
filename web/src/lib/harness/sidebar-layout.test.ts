import { describe, expect, it } from 'vitest';
import type { Session } from './types.js';
import { bucketOf, flatSessions, statusGroups, workspaceLabelOf } from './sidebar-layout.js';

/**
 * The sidebar's arrangements.
 *
 * The rules that matter are the ones a reader would notice: which bucket a
 * parked request lands in, whether an unloaded session looks idle, and whether
 * the order is stable enough to click.
 */

function session(
	id: string,
	status: Session['status'],
	updatedAt = '2026-10-20T09:00:00Z'
): Session {
	return {
		id,
		title: id,
		cwd: `/repo/${id}`,
		source: 'local',
		numMessages: 1,
		createdAt: '2026-10-20T08:00:00Z',
		updatedAt,
		workspace: 'repo',
		status
	};
}

describe('bucketOf', () => {
	it('counts a parked request as active', () => {
		// A question or permission is the one state the reader must not miss;
		// filing it under "idle" would hide it.
		expect(bucketOf('attention')).toBe('active');
	});

	it('counts a running turn as active', () => {
		expect(bucketOf('running')).toBe('active');
	});

	it('counts a loaded quiet session as idle', () => {
		expect(bucketOf('idle')).toBe('idle');
	});

	it('counts an unloaded session as inactive, not idle', () => {
		// `dormant` is the roster's word for "on disk, nothing holds it". That
		// is a different fact from "open but quiet", and the sidebar says so.
		expect(bucketOf('dormant')).toBe('inactive');
	});
});

describe('statusGroups', () => {
	it('orders active before idle before inactive', () => {
		const groups = statusGroups([
			session('i', 'dormant'),
			session('a', 'running'),
			session('b', 'idle')
		]);
		expect(groups.map((group) => group.bucket)).toEqual(['active', 'idle', 'inactive']);
	});

	it('drops empty buckets instead of painting empty headers', () => {
		const groups = statusGroups([session('a', 'running')]);
		expect(groups).toHaveLength(1);
		expect(groups[0].bucket).toBe('active');
	});

	it('sorts newest first inside a bucket', () => {
		const groups = statusGroups([
			session('old', 'idle', '2026-10-20T08:00:00Z'),
			session('new', 'idle', '2026-10-20T10:00:00Z')
		]);
		expect(groups[0].sessions.map((entry) => entry.id)).toEqual(['new', 'old']);
	});

	it('returns nothing for an empty roster', () => {
		expect(statusGroups([])).toEqual([]);
	});
});

describe('flatSessions', () => {
	it('sorts newest first across every workspace', () => {
		const flat = flatSessions([
			session('a', 'idle', '2026-10-20T08:00:00Z'),
			session('b', 'running', '2026-10-20T11:00:00Z'),
			session('c', 'dormant', '2026-10-20T09:00:00Z')
		]);
		expect(flat.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
	});

	it('does not mutate the input', () => {
		const input = [
			session('a', 'idle', '2026-10-20T08:00:00Z'),
			session('b', 'idle', '2026-10-20T09:00:00Z')
		];
		const before = input.map((entry) => entry.id);
		flatSessions(input);
		expect(input.map((entry) => entry.id)).toEqual(before);
	});
});

describe('workspaceLabelOf', () => {
	it('prefers the workspace name', () => {
		expect(workspaceLabelOf(session('a', 'idle'))).toBe('repo');
	});

	it('falls back to the cwd when the agent sent no repo name', () => {
		expect(workspaceLabelOf({ ...session('a', 'idle'), workspace: '' })).toBe('/repo/a');
	});

	it('never renders an empty label', () => {
		expect(workspaceLabelOf({ ...session('a', 'idle'), workspace: '', cwd: '' })).toBe('unknown');
	});
});
