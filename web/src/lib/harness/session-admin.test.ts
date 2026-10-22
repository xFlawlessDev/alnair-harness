import { describe, expect, it, vi } from 'vitest';
import { HarnessStore } from './session-store.svelte.js';
import type { Transport } from './session-store.svelte.js';
import type { BranchEntry, GitContext, Session, WorktreeEntry } from './types.js';

/**
 * The session-administration surface: rename, delete, create, and the git
 * reads the checkout row renders.
 *
 * These run against a stub transport rather than the socket, because what is
 * under test is the STORE's contract — what it applies optimistically, what it
 * rolls back, and which calls it makes — not JSON-RPC framing (which
 * `ws-transport.test.ts` covers).
 */

const SESSION: Session = {
	id: 's-1',
	title: 'First session',
	cwd: '/repo',
	source: 'local',
	numMessages: 3,
	createdAt: '2026-10-22T08:00:00Z',
	updatedAt: '2026-10-22T09:00:00Z',
	workspace: 'repo',
	status: 'idle'
};

const OTHER: Session = {
	...SESSION,
	id: 's-2',
	title: 'Second session',
	updatedAt: '2026-10-22T07:00:00Z'
};

const GIT: GitContext = {
	root: '/repo',
	branch: 'master',
	remotes: ['origin']
};

/**
 * A transport that implements only what these tests exercise.
 *
 * `connect` is present so the store treats it as live: the fixture transport
 * (which has no `connect`) would seed scripted sessions and hide every real
 * rule behind mock data.
 */
function stubTransport(overrides: Partial<Transport> = {}) {
	const transport: Transport = {
		send: vi.fn(),
		stop: vi.fn(),
		respond: vi.fn(),
		respondQuestions: vi.fn(),
		connect: vi.fn(async () => {}),
		listSessions: vi.fn(async () => [SESSION, OTHER]),
		openSession: vi.fn(async () => ({ models: [], currentModel: undefined })),
		sessionContext: vi.fn(async () => undefined),
		listSubagents: vi.fn(async () => []),
		renameSession: vi.fn(async () => {}),
		deleteSession: vi.fn(async () => {}),
		newSession: vi.fn(async () => 's-new'),
		gitInfo: vi.fn(async () => GIT),
		gitBranches: vi.fn(async () => [] as BranchEntry[]),
		gitCheckout: vi.fn(async () => {}),
		gitWorktrees: vi.fn(async () => [] as WorktreeEntry[]),
		gitCreateWorktree: vi.fn(async () => '/repo-wt'),
		...overrides
	};
	return transport;
}

/** The store the page would use, already bootstrapped. */
async function boot(transport: Transport): Promise<HarnessStore> {
	const store = new HarnessStore(transport);
	await store.bootstrap();
	return store;
}

describe('store: rename', () => {
	it('applies the new title and sends the session cwd', async () => {
		const transport = stubTransport();
		const store = await boot(transport);

		await store.renameSession('s-1', '  Renamed  ');

		expect(store.sessions.find((session) => session.id === 's-1')?.title).toBe('Renamed');
		expect(transport.renameSession).toHaveBeenCalledWith('s-1', 'Renamed', '/repo');
	});

	it('ignores a blank title instead of sending it', async () => {
		const transport = stubTransport();
		const store = await boot(transport);

		await store.renameSession('s-1', '   ');

		expect(transport.renameSession).not.toHaveBeenCalled();
		expect(store.sessions.find((session) => session.id === 's-1')?.title).toBe('First session');
	});

	it('restores the old title when the agent rejects the rename', async () => {
		const transport = stubTransport({
			renameSession: vi.fn(async () => {
				throw new Error('title must not be blank');
			})
		});
		const store = await boot(transport);

		await store.renameSession('s-1', 'Nope');

		expect(store.sessions.find((session) => session.id === 's-1')?.title).toBe('First session');
	});
});

describe('store: delete', () => {
	it('drops the row and calls the agent with the session cwd', async () => {
		const transport = stubTransport();
		const store = await boot(transport);

		await store.deleteSession('s-2');

		expect(store.sessions.map((session) => session.id)).toEqual(['s-1']);
		expect(transport.deleteSession).toHaveBeenCalledWith('s-2', '/repo');
	});

	it('moves the view to a survivor when the active session is deleted', async () => {
		const transport = stubTransport();
		const store = await boot(transport);
		expect(store.activeSessionId).toBe('s-1');

		await store.deleteSession('s-1');

		expect(store.activeSessionId).toBe('s-2');
		expect(transport.openSession).toHaveBeenCalledWith('s-2', '/repo');
	});

	it('restores the row when the agent refuses the delete', async () => {
		const transport = stubTransport({
			deleteSession: vi.fn(async () => {
				throw new Error('permission denied');
			})
		});
		const store = await boot(transport);

		await store.deleteSession('s-2');

		expect(store.sessions.map((session) => session.id)).toContain('s-2');
	});

	it('leaves an empty store when the last session is deleted', async () => {
		const transport = stubTransport({ listSessions: vi.fn(async () => [SESSION]) });
		const store = await boot(transport);

		await store.deleteSession('s-1');

		expect(store.sessions).toEqual([]);
		expect(store.activeSessionId).toBe('');
	});
});

describe('store: create', () => {
	it('inserts the new session and attaches to it', async () => {
		const transport = stubTransport();
		const store = await boot(transport);

		await store.createSession('/other-repo');

		const created = store.sessions.find((session) => session.id === 's-new');
		expect(created?.cwd).toBe('/other-repo');
		expect(created?.workspace).toBe('other-repo');
		expect(store.activeSessionId).toBe('s-new');
		expect(transport.openSession).toHaveBeenCalledWith('s-new', '/other-repo');
	});

	it('does not duplicate a session the roster already delivered', async () => {
		const transport = stubTransport();
		const store = await boot(transport);
		store.sessions = [...store.sessions, { ...SESSION, id: 's-new', title: 'Already here' }];

		await store.createSession('/repo');

		const matches = store.sessions.filter((session) => session.id === 's-new');
		expect(matches).toHaveLength(1);
		expect(matches[0].title).toBe('Already here');
	});
});

describe('store: git', () => {
	it('reads the repo, branches and worktrees on attach', async () => {
		const branches: BranchEntry[] = [
			{ name: 'master', current: true, remote: false },
			{ name: 'origin/main', current: false, remote: true }
		];
		const worktrees: WorktreeEntry[] = [{ path: '/repo', branch: 'master', current: true }];
		const transport = stubTransport({
			gitBranches: vi.fn(async () => branches),
			gitWorktrees: vi.fn(async () => worktrees)
		});
		const store = await boot(transport);

		expect(store.git).toEqual(GIT);
		expect(store.branches).toEqual(branches);
		expect(store.worktrees).toEqual(worktrees);
	});

	it('clears the git state when the session is not in a repo', async () => {
		const transport = stubTransport({
			gitInfo: vi.fn(async () => {
				throw new Error('not a git repository');
			})
		});
		const store = await boot(transport);

		expect(store.git).toBeUndefined();
		expect(store.branches).toEqual([]);
		expect(store.worktrees).toEqual([]);
	});

	it('strips the remote prefix and creates a local branch when tracking one', async () => {
		const transport = stubTransport({
			gitBranches: vi.fn(async () => [
				{ name: 'master', current: true, remote: false },
				{ name: 'origin/feature', current: false, remote: true }
			])
		});
		const store = await boot(transport);

		await store.checkoutBranch('origin/feature');

		expect(transport.gitCheckout).toHaveBeenCalledWith('s-1', 'feature', true);
		expect(store.activeSession.branch).toBe('feature');
	});

	it('checks out a local branch without creating anything', async () => {
		const transport = stubTransport({
			gitBranches: vi.fn(async () => [
				{ name: 'master', current: true, remote: false },
				{ name: 'dev', current: false, remote: false }
			])
		});
		const store = await boot(transport);

		await store.checkoutBranch('dev');

		expect(transport.gitCheckout).toHaveBeenCalledWith('s-1', 'dev', false);
	});

	it('creates a worktree from the session cwd and starts a session there', async () => {
		const transport = stubTransport();
		const store = await boot(transport);

		await store.createWorktree('fix-flaky');

		expect(transport.gitCreateWorktree).toHaveBeenCalledWith({
			sessionId: 's-1',
			sourcePath: '/repo',
			gitRef: undefined,
			label: 'fix-flaky'
		});
		expect(transport.newSession).toHaveBeenCalledWith('/repo-wt');
		expect(store.activeSessionId).toBe('s-new');
	});

	it('drops the previous repo when switching sessions', async () => {
		const transport = stubTransport();
		const store = await boot(transport);
		expect(store.git).toBeDefined();

		store.selectSession('s-2');

		// Cleared synchronously so the checkout row cannot briefly name the
		// previous session's branch while the new one loads.
		expect(store.git).toBeUndefined();
		expect(store.branches).toEqual([]);
	});
});
