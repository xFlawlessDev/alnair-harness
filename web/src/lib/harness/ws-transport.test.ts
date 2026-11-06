import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketTransport } from './ws-transport.js';
import type { IncomingFrame } from './session-store.svelte.js';

/**
 * A stand-in for the browser `WebSocket`.
 *
 * The transport's job is pure message routing — ids, reverse requests, the
 * wrapped ext-notification form — so a fake socket is enough to pin all of it
 * without a running leader.
 */
class FakeSocket {
	static instances: FakeSocket[] = [];
	static readonly OPEN = 1;

	readyState = 0;
	sent: Record<string, unknown>[] = [];
	onopen?: () => void;
	onerror?: () => void;
	onmessage?: (event: { data: string }) => void;
	onclose?: () => void;

	private listeners = new Map<string, ((event: unknown) => void)[]>();

	constructor(public url: string) {
		FakeSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = FakeSocket.OPEN;
			this.emit('open', {});
		});
	}

	addEventListener(type: string, handler: (event: unknown) => void, options?: { once?: boolean }) {
		if (options?.once) {
			const wrapped = (event: unknown) => {
				this.removeEventListener(type, wrapped);
				handler(event);
			};
			this.push(type, wrapped);
			return;
		}
		this.push(type, handler);
	}

	removeEventListener(type: string, handler: (event: unknown) => void) {
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter((h) => h !== handler)
		);
	}

	send(raw: string) {
		this.sent.push(JSON.parse(raw) as Record<string, unknown>);
	}

	close() {
		this.readyState = 3;
		this.emit('close', {});
	}

	/** Deliver a frame to the transport. */
	deliver(message: Record<string, unknown>) {
		this.emit('message', { data: JSON.stringify(message) });
	}

	private push(type: string, handler: (event: unknown) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
	}

	private emit(type: string, event: unknown) {
		for (const handler of this.listeners.get(type) ?? []) handler(event);
	}
}

/** The most recent request the transport sent, by method. */
function sentOf(socket: FakeSocket, method: string) {
	return [...socket.sent].reverse().find((message) => message.method === method);
}

/** Let the fake socket's queued `open` microtask run. */
async function settle() {
	for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** Answer a request the transport sent. */
function answer(socket: FakeSocket, method: string, result: unknown) {
	const request = sentOf(socket, method);
	expect(request, `no ${method} request was sent`).toBeDefined();
	socket.deliver({ jsonrpc: '2.0', id: request!.id, result });
}

function makeTransport() {
	const frames: { sessionId: string; frame: IncomingFrame }[] = [];
	let reconnects = 0;
	const transport = new WebSocketTransport(
		() => new FakeSocket('ws://127.0.0.1:2420/ws') as unknown as WebSocket,
		'/repo'
	);
	transport.onFrame((sessionId, frame) => frames.push({ sessionId, frame }));
	transport.onReconnected(() => (reconnects += 1));
	return { transport, frames, reconnects: () => reconnects };
}

describe('ws-transport: subagent snapshots', () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	it('requests current child details without attaching or replacing the parent session', async () => {
		const { transport } = makeTransport();
		const connected = transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		const detail = transport.getSubagent('sub-2');
		await settle();
		expect(sentOf(socket, '_alnair/subagent/get')?.params).toEqual({
			subagentId: 'sub-2',
			block: false
		});
		answer(socket, '_alnair/subagent/get', {
			result: {
				snapshot: {
					subagentId: 'sub-2',
					parentSessionId: 'parent-2',
					childSessionId: 'child-2',
					subagentType: 'explore',
					description: 'Inspect',
					startedAtEpochMs: 1_000,
					durationMs: 5_000,
					status: 'completed',
					turns: 2,
					toolCalls: 7
				}
			}
		});
		await expect(detail).resolves.toMatchObject({
			id: 'sub-2',
			childSessionId: 'child-2',
			status: 'completed',
			turnCount: 2,
			toolCallCount: 7,
			tokensUsed: 0,
			contextUsagePct: 0
		});
		expect(sentOf(socket, 'session/load')).toBeUndefined();
	});

	it('allows a missing snapshot for an archived child', async () => {
		const { transport } = makeTransport();
		const connected = transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;
		const detail = transport.getSubagent('archived');
		await settle();
		answer(socket, '_alnair/subagent/get', { result: { snapshot: null } });
		await expect(detail).resolves.toBeUndefined();
	});
});

describe('ws-transport: handshake', () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	it('sends initialize with browser-appropriate capabilities', async () => {
		const { transport } = makeTransport();
		const connected = transport.connect();
		await settle();

		const socket = FakeSocket.instances[0];
		const init = sentOf(socket, 'initialize');
		expect(init).toBeDefined();
		const params = init!.params as Record<string, unknown>;
		expect(params.protocolVersion).toBe(1);
		// Claiming fs/terminal would route tool calls to a browser that cannot
		// serve them; the agent must use its own.
		const caps = params.clientCapabilities as Record<string, unknown>;
		expect(caps.terminal).toBe(false);
		expect((caps.fs as Record<string, unknown>).readTextFile).toBe(false);

		answer(socket, 'initialize', { protocolVersion: 1 });
		await connected;
	});

	it('maps roster rows to the view model', async () => {
		const { transport } = makeTransport();
		const connected = transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		const listing = transport.listSessions();
		await settle();
		// Ext methods go out WRAPPED: a live leader answers a plain
		// `alnair/sessions/list` with "Method not found".
		expect(sentOf(socket, '_alnair/sessions/list')).toBeDefined();
		answer(socket, '_alnair/sessions/list', {
			result: {
				sessions: [
					{
						sessionId: 's1',
						cwd: '/repo',
						title: 'Fix the bug',
						activity: 'working',
						lastChangeUnixMs: 1_700_000_000_000
					}
				]
			}
		});
		const sessions = await listing;
		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe('s1');
		expect(sessions[0].status).toBe('running');
	});

	it('sends ext methods with FLAT params, not nested one level down', async () => {
		// The ACP decoder strips the `_` prefix and hands the whole `params`
		// object to the handler. Nesting `{ method, params }` leaves the handler
		// with no fields of its own — a live leader answers
		// "invalid params: missing field `path`" for `fs/list` sent that way.
		const { transport } = makeTransport();
		const connected = transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		void transport.listSessions();
		await settle();
		const request = sentOf(socket, '_alnair/sessions/list')!;
		expect(request.params).toEqual({});
	});

	it('sends a session id flat for session/info', async () => {
		const { transport } = makeTransport();
		const connected = transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		void transport.sessionContext('s1');
		await settle();
		const request = sentOf(socket, '_alnair/session/info')!;
		expect(request.params).toEqual({ sessionId: 's1' });
	});

	it('loads a session with its own cwd, never an empty one', async () => {
		// The agent rejects a relative or empty cwd outright ("Path is not
		// absolute"), so the roster's cwd has to travel with the load.
		const { transport } = makeTransport();
		const connected = transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		void transport.openSession('s1', '/repo/app');
		await settle();
		const request = sentOf(socket, 'session/load')!;
		expect(request.params).toMatchObject({ sessionId: 's1', cwd: '/repo/app' });
	});

	it('closes the replay window when session/load answers', async () => {
		// The store opens the gate before the request; only the transport sees
		// the response, so only it can close the gate. Without this the gate
		// stays in `replay` for the session's whole life: every later frame
		// applies unconditionally and the watermark never arms, so a reconnect
		// replays the transcript on top of one that already holds it.
		const { transport, frames } = makeTransport();
		const connected = transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		const opened = transport.openSession('s1', '/repo/app');
		await settle();
		answer(socket, 'session/load', { models: { availableModels: [] } });
		await opened;

		const marker = frames.find((entry) => entry.frame.method === 'session/load:result');
		expect(marker, 'the load response must close the replay gate').toBeDefined();
		expect(marker!.sessionId).toBe('s1');
	});

	it('switches the model with the underscore method name', async () => {
		// `session/setModel` is answered "Method not found"; ACP spells it
		// `session/set_model`, and the effort rides in `_meta`.
		const { transport } = makeTransport();
		const connected = transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		transport.openSession('s1', '/repo/app');
		await settle();
		transport.setModel('kimi-code/kimi-k2', 'high');
		await settle();
		const request = sentOf(socket, 'session/set_model')!;
		expect(request.params).toMatchObject({
			sessionId: 's1',
			modelId: 'kimi-code/kimi-k2',
			_meta: { reasoningEffort: 'high' }
		});
	});
});

describe('ws-transport: frames', () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	async function connectedTransport() {
		const harness = makeTransport();
		const connected = harness.transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;
		return { ...harness, socket };
	}

	it('routes a session/update notification by sessionId', async () => {
		const { socket, frames } = await connectedTransport();
		socket.deliver({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId: 's1',
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
				_meta: { eventId: 's1-4' }
			}
		});
		expect(frames).toHaveLength(1);
		expect(frames[0].sessionId).toBe('s1');
		expect(frames[0].frame.method).toBe('session/update');
		// `_meta` must survive: the store's dedup reads `eventId` from it.
		expect((frames[0].frame.params._meta as Record<string, unknown>).eventId).toBe('s1-4');
	});

	it('dispatches an ext notification with its real method and flat params', async () => {
		// The extension rail is NOT nested: `_alnair/session/update` carries
		// `{ sessionId, update, _meta }` at the top of `params`, exactly like
		// `session/update`. A live replay confirmed this.
		const { socket, frames } = await connectedTransport();
		socket.deliver({
			jsonrpc: '2.0',
			method: '_alnair/session/update',
			params: {
				sessionId: 's1',
				update: { sessionUpdate: 'graph_updated', total_nodes: 3 },
				_meta: { eventId: 's1-9' }
			}
		});
		expect(frames).toHaveLength(1);
		// The `_` is the gateway's extension marker, not part of the name, so the
		// transport strips it once. Every consumer then matches on `alnair/…`,
		// which is also what makes the wrapped reverse-request form readable.
		expect(frames[0].frame.method).toBe('alnair/session/update');
		expect((frames[0].frame.params.update as Record<string, unknown>).sessionUpdate).toBe(
			'graph_updated'
		);
	});

	it('unwraps a gateway-wrapped reverse request', async () => {
		// This is the shape `ask_user_question` actually arrives in:
		//   { method: "_alnair/ask_user_question",
		//     params: { method: "alnair/ask_user_question", params: { … } } }
		// Reading `params.sessionId` off the wrapper finds nothing, so the frame
		// used to be dropped and the questionnaire never rendered.
		const { socket, frames } = await connectedTransport();
		socket.deliver({
			jsonrpc: '2.0',
			id: 77,
			method: '_alnair/ask_user_question',
			params: {
				method: 'alnair/ask_user_question',
				params: {
					sessionId: 's1',
					toolCallId: 'tc-ask',
					mode: 'default',
					questions: [{ question: 'Which option?', options: [] }]
				}
			}
		});

		expect(frames).toHaveLength(1);
		expect(frames[0].frame.method).toBe('alnair/ask_user_question');
		expect(frames[0].frame.params.sessionId).toBe('s1');
		expect(frames[0].frame.params.toolCallId).toBe('tc-ask');
		// The inner payload, not the wrapper: `questions` must be reachable at
		// the top of `params`.
		expect(Array.isArray(frames[0].frame.params.questions)).toBe(true);
	});

	it('routes alnair/session_notification to the extension decoder', async () => {
		// A model switch made in the TUI rides this rail, not `session/update`.
		const { socket, frames } = await connectedTransport();
		socket.deliver({
			jsonrpc: '2.0',
			method: 'alnair/session_notification',
			params: {
				sessionId: 's1',
				update: { sessionUpdate: 'model_changed', model_id: 'a/b' }
			}
		});
		expect(frames).toHaveLength(1);
		expect(frames[0].frame.method).toBe('alnair/session_notification');
	});

	it('drops a session notification with no update', async () => {
		const { socket, frames } = await connectedTransport();
		socket.deliver({
			jsonrpc: '2.0',
			method: 'session/update',
			params: { sessionId: 's1' }
		});
		expect(frames).toHaveLength(0);
	});

	it('ignores notifications with no session id', async () => {
		const { socket, frames } = await connectedTransport();
		socket.deliver({ jsonrpc: '2.0', method: 'session/update', params: { update: {} } });
		expect(frames).toHaveLength(0);
	});
});

describe('ws-transport: reverse requests', () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	async function connectedTransport() {
		const harness = makeTransport();
		const connected = harness.transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;
		return { ...harness, socket };
	}

	it('surfaces a permission request and answers on the same id', async () => {
		const { socket, frames, transport } = await connectedTransport();
		socket.deliver({
			jsonrpc: '2.0',
			id: 77,
			method: 'session/request_permission',
			params: {
				sessionId: 's1',
				toolCall: { toolCallId: 'call-1' },
				options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
			}
		});
		expect(frames).toHaveLength(1);
		expect(frames[0].frame.method).toBe('session/request_permission');

		transport.respond('call-1', 'allow');
		const response = socket.sent.find((message) => message.id === 77 && !message.method);
		expect(response).toBeDefined();
		expect(response!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
	});

	it('answers a plan approval on its own id', async () => {
		const { socket, transport } = await connectedTransport();
		socket.deliver({
			jsonrpc: '2.0',
			id: 88,
			method: 'alnair/exit_plan_mode',
			params: { sessionId: 's1', toolCallId: 'plan-1', planContent: '# plan' }
		});
		transport.respondPlan('plan-1', 'approved');
		const response = socket.sent.find((message) => message.id === 88 && !message.method);
		expect(response!.result).toEqual({ outcome: 'approved' });
	});

	it('does not answer an unknown tool call id', async () => {
		const { socket, transport } = await connectedTransport();
		const before = socket.sent.length;
		transport.respond('nope', 'allow');
		expect(socket.sent.length).toBe(before);
	});
});

describe('ws-transport: leader relaunch', () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	it('re-handshakes and notifies the store on leader_reconnected', async () => {
		const harness = makeTransport();
		const connected = harness.transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		socket.deliver({ jsonrpc: '2.0', method: 'alnair/leader_reconnected', params: {} });
		await settle();

		// A second initialize went out on the same socket.
		const inits = socket.sent.filter((message) => message.method === 'initialize');
		expect(inits).toHaveLength(2);

		answer(socket, 'initialize', {});
		await settle();
		expect(harness.reconnects()).toBe(1);
	});
});

describe('ws-transport: roster hot-reload', () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	/** A connected transport with a roster sink attached. */
	async function withRoster() {
		const harness = makeTransport();
		const deltas: { upserted?: unknown[]; removed?: string[] }[] = [];
		harness.transport.onRosterChanged((delta) => deltas.push(delta));
		const connected = harness.transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;
		return { socket, deltas, harness };
	}

	it('accepts the `_`-prefixed form the leader actually sends', async () => {
		// The production wire form. The bare name is what a request looks like;
		// notifications from the agent are `_`-prefixed by the gateway, and
		// matching only the bare name dropped every delta — which is why a new
		// session only appeared after a page reload.
		const { socket, deltas } = await withRoster();
		socket.deliver({
			jsonrpc: '2.0',
			method: '_alnair/sessions/changed',
			params: {
				upserted: [{ sessionId: 's-new', cwd: '/repo', activity: 'idle' }],
				removed: []
			}
		});
		expect(deltas).toHaveLength(1);
		expect(deltas[0].upserted).toHaveLength(1);
	});

	it('still accepts the bare name', async () => {
		const { socket, deltas } = await withRoster();
		socket.deliver({
			jsonrpc: '2.0',
			method: 'alnair/sessions/changed',
			params: { upserted: [{ sessionId: 's-x', cwd: '/repo' }], removed: [] }
		});
		expect(deltas).toHaveLength(1);
	});

	it('passes removed ids through, filtered to strings', async () => {
		const { socket, deltas } = await withRoster();
		socket.deliver({
			jsonrpc: '2.0',
			method: '_alnair/sessions/changed',
			params: { upserted: [], removed: ['s-1', 42, null] }
		});
		expect(deltas[0].removed).toEqual(['s-1']);
	});
});

describe('ws-transport: pty routing', () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});

	it('routes PTY notifications by terminalId, not sessionId', async () => {
		// A PTY notification carries `terminalId` and no session id, so the
		// generic session path would drop every one of them.
		const harness = makeTransport();
		const events: { id: string; event: Record<string, unknown> }[] = [];
		harness.transport.onPtyEvent((id, event) => events.push({ id, event }));

		const connected = harness.transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		socket.deliver({
			jsonrpc: '2.0',
			method: '_alnair/terminal/pty/notification',
			params: { terminalId: 'pty-1', type: 'output', data: 'aGk=' }
		});
		expect(events).toHaveLength(1);
		expect(events[0].id).toBe('pty-1');
		expect(events[0].event.type).toBe('output');
		// It must NOT have been treated as a session frame.
		expect(harness.frames).toHaveLength(0);
	});

	it('sends create flat and returns the terminal id', async () => {
		const harness = makeTransport();
		const connected = harness.transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		const created = harness.transport.ptyCreate({
			sessionId: 's1',
			cwd: '/repo',
			rows: 24,
			cols: 80
		});
		await settle();
		answer(socket, '_alnair/terminal/pty/create', { result: { terminalId: 'pty-9' } });
		await expect(created).resolves.toBe('pty-9');

		const request = sentOf(socket, '_alnair/terminal/pty/create');
		expect(request!.params).toMatchObject({ sessionId: 's1', cwd: '/repo', rows: 24, cols: 80 });
	});

	it('forwards keystrokes as a notification, not a request', async () => {
		const harness = makeTransport();
		const connected = harness.transport.connect();
		await settle();
		const socket = FakeSocket.instances[0];
		answer(socket, 'initialize', {});
		await connected;

		const before = socket.sent.length;
		harness.transport.ptyInput('pty-1', 'aGk=');
		expect(socket.sent.length).toBe(before + 1);
		const sent = socket.sent.at(-1)!;
		// Notifications go out bare: the gateway strips the `_` on requests, and
		// the leader's `method_of` normalizes both forms for notifications. The
		// important part is that it has NO id, so nothing waits on a response.
		expect(sent.method).toBe('alnair/terminal/pty/input');
		expect(sent.id).toBeUndefined();
		expect(sent.params).toEqual({ terminalId: 'pty-1', data: 'aGk=' });
	});
});
