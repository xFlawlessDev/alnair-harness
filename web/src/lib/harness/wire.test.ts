import { describe, expect, it } from 'vitest';
import {
	accessFromSession,
	applyRosterDelta,
	contextFromInfo,
	entriesFromNodes,
	lastSegment,
	modelsFromState,
	relativeTo,
	sessionFromRoster,
	sessionsFromRoster,
	unwrapExt
} from './wire.js';

describe('wire: unwrapExt', () => {
	it('unwraps the ExtMethodResult envelope', () => {
		expect(unwrapExt({ result: { ok: 1 } })).toEqual({ ok: 1 });
	});

	it('keeps a partial result that also carries an error', () => {
		expect(unwrapExt({ result: { rows: [] }, error: 'partial' })).toEqual({ rows: [] });
	});

	it('passes a RAW payload through unchanged', () => {
		// `alnair/session/updates` writes its payload straight into the
		// ExtResponse, so the result IS the payload. Reading only the envelope
		// turned every stored transcript into `undefined`.
		const raw = { updates: [{ method: 'session/update' }], totalCount: 1 };
		expect(unwrapExt(raw)).toEqual(raw);
	});

	it('distinguishes an envelope with a null result from a raw payload', () => {
		expect(unwrapExt({ result: null })).toBeUndefined();
	});

	it('returns undefined for a missing or malformed envelope', () => {
		expect(unwrapExt({ error: 'nope' })).toEqual({ error: 'nope' });
		expect(unwrapExt(null)).toBeUndefined();
		expect(unwrapExt('text')).toBeUndefined();
	});
});

describe('wire: roster rows', () => {
	it('maps a working row to a running session', () => {
		const session = sessionFromRoster({
			sessionId: 'sess-1',
			title: 'Fix the build',
			cwd: '/repo/app',
			activity: 'working',
			modelId: 'kimi-code/kimi-k2',
			lastChangeUnixMs: 1_700_000_000_000
		});
		expect(session).toBeDefined();
		expect(session!.id).toBe('sess-1');
		expect(session!.title).toBe('Fix the build');
		expect(session!.status).toBe('running');
		expect(session!.modelId).toBe('kimi-code/kimi-k2');
		// The sidebar groups by repo name; the last cwd segment is the closest
		// thing a roster row carries.
		expect(session!.workspace).toBe('app');
		expect(session!.updatedAt).toBe(new Date(1_700_000_000_000).toISOString());
	});

	it('accepts the snake_case spelling too', () => {
		// ACP structs are camelCase and Alnair's extension *updates* are
		// snake_case; a row must not vanish because a handler serialized the
		// other way.
		const session = sessionFromRoster({
			session_id: 'sess-2',
			cwd: '/repo/app',
			model_id: 'kimi-code/kimi-k2',
			last_change_unix_ms: 1_700_000_000_000
		});
		expect(session!.id).toBe('sess-2');
		expect(session!.modelId).toBe('kimi-code/kimi-k2');
	});

	it('treats a dormant row as idle', () => {
		// `dormant` is a resident-less session read from disk: it is not running.
		const session = sessionFromRoster({
			sessionId: 's',
			cwd: '/repo',
			activity: 'dormant',
			resident: false
		});
		expect(session!.status).toBe('idle');
	});

	it('falls back to the cwd segment when the row has no title', () => {
		const session = sessionFromRoster({ sessionId: 's', cwd: '/home/me/project' });
		expect(session!.title).toBe('project');
		expect(session!.status).toBe('idle');
	});

	it('rejects a row without an id rather than inventing one', () => {
		expect(sessionFromRoster({ cwd: '/repo' })).toBeUndefined();
		expect(sessionFromRoster({ sessionId: '' })).toBeUndefined();
	});

	it('filters bad rows out of a list without shifting the good ones', () => {
		const sessions = sessionsFromRoster([
			{ sessionId: 'a', cwd: '/r/one' },
			{ cwd: '/r/two' },
			{ sessionId: 'b', cwd: '/r/three' }
		]);
		expect(sessions.map((session) => session.id)).toEqual(['a', 'b']);
	});

	it('handles windows paths', () => {
		expect(lastSegment('D:\\work\\repo')).toBe('repo');
		expect(lastSegment('/home/me/repo/')).toBe('repo');
	});
});

describe('wire: roster deltas', () => {
	const base = sessionsFromRoster([
		{ sessionId: 'a', cwd: '/r/one', activity: 'working', lastChangeUnixMs: 1 },
		{ sessionId: 'b', cwd: '/r/two', lastChangeUnixMs: 2 }
	]);

	it('updates activity without dropping known fields', () => {
		const next = applyRosterDelta(base, {
			upserted: [{ sessionId: 'a', cwd: '/r/one', activity: 'idle', lastChangeUnixMs: 3 }]
		});
		const a = next.find((session) => session.id === 'a')!;
		expect(a.status).toBe('idle');
		// `title` is derived from cwd here, and the delta carried no title, so
		// the existing one must survive rather than being blanked.
		expect(a.title).toBe('one');
	});

	it('removes rows by id', () => {
		const next = applyRosterDelta(base, { removed: ['b'] });
		expect(next.map((session) => session.id)).toEqual(['a']);
	});

	it('appends a session the UI has not seen, preserving order', () => {
		const next = applyRosterDelta(base, {
			upserted: [{ sessionId: 'c', cwd: '/r/three' }]
		});
		expect(next.map((session) => session.id)).toEqual(['a', 'b', 'c']);
	});

	it('is a no-op for an empty delta', () => {
		expect(applyRosterDelta(base, {}).map((session) => session.id)).toEqual(['a', 'b']);
	});
});

describe('wire: context', () => {
	// Exactly the payload a live `alnair/session/info` returns.
	const info = {
		used: 2455,
		total: 1_000_000,
		systemPromptTokens: 1034,
		toolDefinitionsCount: 22,
		toolDefinitionsTokens: 6653,
		compactionCount: 0,
		turnCount: 0,
		toolCallCount: 0,
		messageCount: 3,
		messageTokens: 16444,
		freeTokens: 997545,
		usagePct: 0,
		autoCompactThresholdPercent: 85,
		usageCategories: [{ label: 'Skills', tokens: 1404, detail: '13 skills' }]
	};

	it('renames total→limit and usagePct→percent', () => {
		const usage = contextFromInfo(info)!;
		expect(usage.limit).toBe(1_000_000);
		expect(usage.percent).toBe(0);
		expect(usage.used).toBe(2455);
	});

	it('carries the itemized categories', () => {
		const usage = contextFromInfo(info)!;
		expect(usage.categories).toEqual([{ label: 'Skills', tokens: 1404, detail: '13 skills' }]);
	});

	it('accepts the snake_case spelling as well', () => {
		const usage = contextFromInfo({
			used: 10,
			total: 100,
			usage_pct: 10,
			usage_categories: [{ label: 'MCP', tokens: 5 }]
		})!;
		expect(usage.percent).toBe(10);
		expect(usage.categories).toEqual([{ label: 'MCP', tokens: 5, detail: undefined }]);
	});

	it('defaults absent breakdown fields to zero rather than guessing', () => {
		const usage = contextFromInfo({ used: 10, total: 100 })!;
		expect(usage.systemPromptTokens).toBe(0);
		expect(usage.categories).toEqual([]);
	});

	it('refuses a snapshot with no totals', () => {
		expect(contextFromInfo({ used: 10 })).toBeUndefined();
		expect(contextFromInfo({})).toBeUndefined();
	});
});

describe('wire: models', () => {
	it('reads the catalog key, provider, efforts and context window', () => {
		const { models, current } = modelsFromState({
			currentModelId: 'kimi-code/kimi-k2',
			availableModels: [
				{
					modelId: 'kimi-code/kimi-k2',
					name: 'Kimi K2',
					description: 'Kimi Code',
					_meta: {
						reasoningEfforts: [{ id: 'low' }, { id: 'high' }],
						totalContextTokens: 262_144
					}
				}
			]
		});
		expect(current).toBe('kimi-code/kimi-k2');
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: 'kimi-code/kimi-k2',
			label: 'Kimi K2',
			provider: 'Kimi Code',
			efforts: ['low', 'high'],
			contextWindow: 262_144
		});
	});

	it('reads effort objects by their value when present', () => {
		const { models } = modelsFromState({
			availableModels: [
				{
					modelId: 'p/m',
					name: 'M',
					_meta: {
						reasoningEfforts: [
							{ id: 'low', value: 'low', label: 'Low' },
							{ id: 'xhigh', value: 'max', label: 'Max' }
						]
					}
				}
			]
		});
		expect(models[0].efforts).toEqual(['low', 'max']);
	});

	it('falls back to the key platform when nothing names a provider', () => {
		const { models } = modelsFromState({
			availableModels: [{ modelId: 'claude-pro-max/claude-sonnet-4-5', name: 'Sonnet' }]
		});
		expect(models[0].provider).toBe('claude-pro-max');
	});

	it('does not mistake the selected effort for the accepted set', () => {
		const { models } = modelsFromState({
			availableModels: [{ modelId: 'p/m', name: 'M', _meta: { reasoningEffort: 'high' } }]
		});
		expect(models[0].efforts).toEqual([]);
	});

	it('tolerates a malformed state', () => {
		expect(modelsFromState(undefined)).toEqual({ models: [] });
		expect(modelsFromState({ availableModels: 'nope' })).toEqual({ models: [] });
	});
});

describe('wire: access mode', () => {
	it('prefers yolo over auto, and falls back to ask', () => {
		expect(accessFromSession(true, true)).toBe('always-approve');
		expect(accessFromSession(false, true)).toBe('auto');
		expect(accessFromSession(false, false)).toBe('ask');
		expect(accessFromSession(undefined, undefined)).toBe('ask');
	});
});

describe('wire: roster yolo', () => {
	it('carries the session own yolo flag', () => {
		const session = sessionFromRoster({ sessionId: 's1', cwd: '/r', yolo: true });
		expect(session!.yolo).toBe(true);
	});

	it('reads a row without yolo as unknown, not false', () => {
		const session = sessionFromRoster({ sessionId: 's1', cwd: '/r' });
		expect(session!.yolo).toBeUndefined();
	});

	it('keeps yolo through a thin roster delta', () => {
		const first = sessionsFromRoster([{ sessionId: 's1', cwd: '/r', yolo: true }]);
		const next = applyRosterDelta(first, { upserted: [{ sessionId: 's1', activity: 'working' }] });
		expect(next[0].yolo).toBe(true);
	});
});

describe('wire: fs listing', () => {
	it('maps nodes to menu rows', () => {
		const entries = entriesFromNodes([
			{ name: 'src', path: 'src', type: 'directory' },
			{ name: 'a.ts', path: 'a.ts', type: 'file', size: 12 }
		]);
		expect(entries).toEqual([
			{ name: 'src', path: 'src', type: 'directory' },
			{ name: 'a.ts', path: 'a.ts', type: 'file', size: 12 }
		]);
	});

	it('falls back to the last segment when the node has no name', () => {
		const entries = entriesFromNodes([{ path: '/repo/src/main.rs', type: 'file' }]);
		expect(entries[0].name).toBe('main.rs');
	});

	it('drops a node with no path', () => {
		expect(entriesFromNodes([{ name: 'x', type: 'file' }])).toEqual([]);
	});

	it('treats an unknown type as a file', () => {
		expect(entriesFromNodes([{ path: 'a', type: 'symlink' }])[0].type).toBe('file');
	});
});

describe('wire: relativeTo', () => {
	it('re-roots an absolute path at the workspace', () => {
		expect(relativeTo('/repo/app', '/repo/app/src/main.rs')).toBe('src/main.rs');
	});

	it('normalizes windows separators', () => {
		expect(relativeTo('C:\\repo', 'C:\\repo\\src\\main.rs')).toBe('src/main.rs');
	});

	it('ignores a trailing separator on the root', () => {
		expect(relativeTo('/repo/app/', '/repo/app/a.ts')).toBe('a.ts');
	});

	it('leaves a path outside the root unchanged', () => {
		expect(relativeTo('/repo/app', '/other/a.ts')).toBe('/other/a.ts');
	});
});
