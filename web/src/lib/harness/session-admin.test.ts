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

		// The refusal is re-thrown, not swallowed: the caller shows it. Swallowing
		// it made "delete does nothing" invisible — the row vanished, the delete
		// never happened, and only a reload revealed the session was still there.
		await expect(store.deleteSession('s-2')).rejects.toThrow('permission denied');

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

/**
 * Workspace administration.
 *
 * "Add a workspace" is the native folder picker plus a session, because a
 * directory the backend has never opened is not a workspace it can list.
 * "Remove a workspace" is hiding — it must never touch a transcript.
 */
describe('store: workspaces', () => {
	it('adds a workspace by asking the machine, then starting a session there', async () => {
		const pickDirectory = vi.fn(async () => '/picked/repo');
		const transport = stubTransport({ pickDirectory });
		const store = await boot(transport);

		const path = await store.addWorkspace();

		expect(path).toBe('/picked/repo');
		expect(pickDirectory).toHaveBeenCalledOnce();
		// The session is what makes the directory a workspace the roster lists.
		expect(transport.newSession).toHaveBeenCalledWith('/picked/repo');
		expect(store.activeSession.cwd).toBe('/picked/repo');
	});

	it('does nothing when the dialog is cancelled', async () => {
		// `undefined` is the cancel answer; the current workspace stays put.
		const transport = stubTransport({ pickDirectory: vi.fn(async () => undefined) });
		const store = await boot(transport);
		const before = store.activeSessionId;

		const path = await store.addWorkspace();

		expect(path).toBeUndefined();
		expect(transport.newSession).not.toHaveBeenCalled();
		expect(store.activeSessionId).toBe(before);
	});

	it('surfaces a picker failure instead of silently doing nothing', async () => {
		const transport = stubTransport({
			pickDirectory: vi.fn(async () => {
				throw new Error('no native folder picker is available on this machine');
			})
		});
		const store = await boot(transport);

		await expect(store.addWorkspace()).rejects.toThrow('no native folder picker');
	});

	it('hides a workspace without dropping its sessions', async () => {
		const transport = stubTransport();
		const store = await boot(transport);
		const before = store.sessions.length;

		store.removeWorkspace('repo');

		expect(store.groups.map((group) => group.name)).not.toContain('repo');
		// Hiding is a view preference: the rows and their transcripts stay.
		expect(store.sessions).toHaveLength(before);
		expect(store.hiddenWorkspaces).toEqual(['repo']);
		expect(transport.deleteSession).not.toHaveBeenCalled();
	});

	it('brings a hidden workspace back', async () => {
		const transport = stubTransport();
		const store = await boot(transport);

		store.removeWorkspace('repo');
		store.restoreWorkspace('repo');

		expect(store.groups.map((group) => group.name)).toContain('repo');
		expect(store.hiddenWorkspaces).toEqual([]);
	});

	it('ignores a repeated hide, so the menu does not grow duplicates', async () => {
		const transport = stubTransport();
		const store = await boot(transport);

		store.removeWorkspace('repo');
		store.removeWorkspace('repo');

		expect(store.hiddenWorkspaces).toEqual(['repo']);
	});
});

/**
 * The header's subagent list must survive a session switch.
 *
 * It is derived from the transcript plus the live snapshots, both keyed by
 * session id. A stored list that `selectSession` cleared is what made a
 * running subagent appear only after switching away and back.
 */
describe('store: subagents', () => {
	const childTranscript = (sessionId: string) => [
		{
			method: '_alnair/session/update',
			params: {
				sessionId,
				update: {
					sessionUpdate: 'subagent_spawned',
					subagent_id: 'sub-a',
					parent_session_id: sessionId,
					child_session_id: 'child-a',
					subagent_type: 'explore',
					description: 'Audit the palette'
				}
			}
		}
	];

	it('lists a subagent from the transcript, with no live read at all', async () => {
		const transport = stubTransport({
			listSubagents: vi.fn(async () => []),
			sessionUpdates: vi.fn(async () => [])
		});
		const store = await boot(transport);

		// Feed the spawn frame the way a replay would.
		store['receive']('s-1', {
			method: 'alnair/session/update',
			params: childTranscript('s-1')[0].params
		});

		expect(store.subagents.map((subagent) => subagent.id)).toEqual(['sub-a']);
	});

	it('keeps a running subagent visible after switching away and back', async () => {
		// The reader's report: a running subagent showed only after switching
		// sessions. The live read is per session and merged on every attach, so
		// coming back finds it again without waiting for a frame.
		const running = [
			{
				id: 'sub-a',
				agent: 'explore',
				description: 'Audit the palette',
				childSessionId: 'child-a',
				status: 'running' as const,
				startedAt: 1_000,
				durationMs: 500,
				turnCount: 1,
				toolCallCount: 2,
				tokensUsed: 3_000,
				contextWindowTokens: 0,
				contextUsagePct: 0,
				toolsUsed: [],
				errorCount: 0
			}
		];
		const transport = stubTransport({
			// Only the first session has one running.
			listSubagents: vi.fn(async (sessionId: string) => (sessionId === 's-1' ? running : []))
		});
		const store = await boot(transport);
		expect(store.subagents.map((subagent) => subagent.id)).toEqual(['sub-a']);

		store.selectSession('s-2');
		expect(store.subagents).toEqual([]);

		store.selectSession('s-1');
		// `selectSession` attaches asynchronously; the live read repopulates it.
		await vi.waitFor(() =>
			expect(store.subagents.map((subagent) => subagent.id)).toEqual(['sub-a'])
		);
	});
});
