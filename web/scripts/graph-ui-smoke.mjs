import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, label, timeout = 30000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const result = await read();
		if (result) return result;
		await delay(100);
	}
	throw new Error(`Timed out: ${label}`);
}

function mockLeader() {
	const makeNode = (id, title, status, deps = []) => ({
		id,
		title,
		status,
		deps: deps.map((on) => ({ on, kind: 'blocks' })),
		spec: `Implement and verify ${title}.`,
		rounds: status === 'achieved' ? 2 : 0,
		tokens_used: status === 'achieved' ? 3000 : 0
	});
	const initial = {
		graph_id: 'browser-graph',
		objective: 'Ship the graph interface',
		status: 'active',
		phase: 'executing',
		plan_version: 2,
		nodes: [
			makeNode('gn-a', 'Plan schema', 'achieved'),
			makeNode('gn-b', 'Implement API', 'running', ['gn-a']),
			makeNode('gn-c', 'Build interface', 'ready', ['gn-a']),
			makeNode('gn-final', 'Final verification', 'waiting', ['gn-b', 'gn-c'])
		],
		created_at: new Date().toISOString(),
		elapsed_ms: 64000,
		token_budget: 100000,
		tokens_spent_nodes: 3000,
		replan_runs: 1,
		pending_discoveries: [{ from_node: 'gn-b', description: 'Add coverage for stale graph ids.' }],
		history: [
			{
				timestamp: new Date().toISOString(),
				event: 'node_started',
				node_id: 'gn-b',
				detail: 'Worker dispatched.'
			}
		]
	};
	const workerTime = Date.now().toString(16).padStart(12, '0');
	const worker = {
		subagentId: `graph-gn-b-w1-${workerTime.slice(0, 8)}-${workerTime.slice(8)}-7000-8000-000000000001`,
		parentSessionId: 'session-1',
		childSessionId: 'child-b',
		subagentType: 'general-purpose',
		description: 'graph node worker (gn-b)',
		startedAtEpochMs: Date.now(),
		durationMs: 10000,
		turnCount: 2,
		toolCallCount: 3,
		tokensUsed: 2000,
		contextWindowTokens: 100000,
		contextUsagePct: 2,
		toolsUsed: ['read', 'edit'],
		errorCount: 0
	};
	globalThis.__graphMock = { graph: structuredClone(initial), commands: [] };
	globalThis.__terminalMock = { created: [], closed: [], input: [] };
	const RealWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = class extends EventTarget {
		static OPEN = 1;
		readyState = 0;
		constructor(url, protocols) {
			if (new URL(url).pathname !== '/ws') return new RealWebSocket(url, protocols);
			super();
			setTimeout(() => {
				this.readyState = 1;
				this.dispatchEvent(new Event('open'));
			}, 0);
		}
		close() {
			this.readyState = 3;
			this.dispatchEvent(new Event('close'));
		}
		send(raw) {
			const { id, method, params } = JSON.parse(raw);
			const terminal = globalThis.__terminalMock;
			const output = (terminalId, text) =>
				this.dispatchEvent(
					new MessageEvent('message', {
						data: JSON.stringify({
							jsonrpc: '2.0',
							method: '_alnair/terminal/pty/notification',
							params: { terminalId, type: 'output', data: btoa(text) }
						})
					})
				);
			if (method === 'alnair/terminal/pty/input') {
				const text = atob(params.data);
				terminal.input.push({ terminalId: params.terminalId, text });
				// ConPTY waits for a cursor report before printing the shell prompt.
				if (text.startsWith('\x1b[') && /^\d+;\d+R$/.test(text.slice(2)))
					output(params.terminalId, 'PS D:\\repo> ');
				else output(params.terminalId, text);
			}
			if (id === undefined) return;
			if (method === '_alnair/terminal/pty/create') {
				const terminalId = `pty-${terminal.created.length + 1}`;
				terminal.created.push(terminalId);
				// Output can precede the create response, including ConPTY's startup query.
				setTimeout(() => output(terminalId, '\x1b[6n'), 0);
				setTimeout(
					() =>
						this.dispatchEvent(
							new MessageEvent('message', {
								data: JSON.stringify({ jsonrpc: '2.0', id, result: { result: { terminalId } } })
							})
						),
					100
				);
				return;
			}
			if (method === '_alnair/terminal/kill') terminal.closed.push(params.terminalId);
			let result = {};
			if (method === '_alnair/sessions/list')
				result = {
					result: {
						sessions: [
							{
								sessionId: 'session-1',
								cwd: 'D:/repo',
								title: 'Graph smoke',
								activity: 'idle',
								lastChangeUnixMs: Date.now()
							}
						]
					}
				};
			if (method === 'session/load') result = { models: { availableModels: [] } };
			if (method === '_alnair/session/info') result = { result: {} };
			if (method === '_alnair/git/info') result = { result: null, error: 'not a repository' };
			if (method === '_alnair/subagent/list_running') result = { result: { subagents: [worker] } };
			if (method === '_alnair/graph/get')
				result = {
					result: {
						enabled: true,
						source: globalThis.__graphMock.graph ? 'session' : 'none',
						graph: globalThis.__graphMock.graph,
						node_goal: null
					}
				};
			if (method === '_alnair/graph/control') {
				globalThis.__graphMock.commands.push(params.action);
				if (params.action === 'pause') globalThis.__graphMock.graph.status = 'user_paused';
				if (params.action === 'clear') globalThis.__graphMock.graph = null;
				result = { result: {} };
			}
			if (method === 'session/prompt') {
				const text = params.prompt[0].text;
				globalThis.__graphMock.commands.push(text);
				if (!globalThis.__graphMock.graph) globalThis.__graphMock.graph = structuredClone(initial);
				globalThis.__graphMock.graph.status = 'active';
				result = { stopReason: 'end_turn' };
			}
			setTimeout(
				() =>
					this.dispatchEvent(
						new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result }) })
					),
				0
			);
		}
	};
}

class DevTools {
	next = 0;
	pending = new Map();
	exceptions = [];
	constructor(socket) {
		this.socket = socket;
		socket.addEventListener('message', ({ data }) => {
			const message = JSON.parse(String(data));
			if (message.method === 'Runtime.exceptionThrown')
				this.exceptions.push(message.params.exceptionDetails.text);
			const waiter = this.pending.get(message.id);
			if (!waiter) return;
			this.pending.delete(message.id);
			clearTimeout(waiter.timer);
			if (message.error) waiter.reject(new Error(message.error.message));
			else waiter.resolve(message.result);
		});
	}
	send(method, params = {}, sessionId) {
		const id = ++this.next;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, 15000);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}
}

async function main() {
	const profile = await mkdtemp(join(tmpdir(), 'alnair-graph-ui-'));
	let vite, browser, cdp, diagnose;
	let viteLog = '';
	try {
		let url = '';
		vite = spawn(
			process.execPath,
			[join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '0'],
			{ cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
		);
		vite.stdout.on('data', (data) => {
			viteLog += String(data);
			const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
			if (match) url = match[0];
		});
		vite.stderr.on('data', (data) => {
			viteLog += String(data);
		});
		await until(() => url, 'Vite server');
		let executable;
		for (const candidate of [
			process.env.ALNAIR_TEST_BROWSER,
			'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
			'C:/Program Files/Google/Chrome/Application/chrome.exe',
			'/usr/bin/chromium',
			'/usr/bin/google-chrome',
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
		].filter(Boolean)) {
			try {
				await access(candidate);
				executable = candidate;
				break;
			} catch {
				/* Try the next installed browser. */
			}
		}
		assert.ok(executable, 'Set ALNAIR_TEST_BROWSER to an installed Chromium browser.');
		let endpoint = '';
		browser = spawn(
			executable,
			[
				'--headless=new',
				'--no-first-run',
				'--disable-background-networking',
				'--disable-component-update',
				'--disable-sync',
				'--disable-default-apps',
				'--disable-extensions',
				'--remote-debugging-port=0',
				`--user-data-dir=${profile}`,
				'about:blank'
			],
			{ windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
		);
		browser.stderr.on('data', (data) => {
			const match = String(data).match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+/);
			if (match) endpoint = match[0];
		});
		await until(() => endpoint, 'Chromium DevTools');
		const socket = new WebSocket(endpoint);
		await new Promise((resolve, reject) => {
			socket.addEventListener('open', resolve, { once: true });
			socket.addEventListener('error', reject, { once: true });
		});
		cdp = new DevTools(socket);
		const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
		const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
		const send = (method, params = {}) => cdp.send(method, params, sessionId);
		const evaluate = async (expression) => {
			const result = await send('Runtime.evaluate', {
				expression,
				returnByValue: true,
				awaitPromise: true
			});
			if (result.exceptionDetails)
				throw new Error(
					result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
				);
			return result.result.value;
		};
		diagnose = async () => {
			console.error(await evaluate('document.body.innerText'));
			console.error(cdp.exceptions);
			const { data } = await send('Page.captureScreenshot', { format: 'png' });
			await mkdir(join(root, '.svelte-kit/graph-smoke'), { recursive: true });
			await writeFile(
				join(root, '.svelte-kit/graph-smoke/failure.png'),
				Buffer.from(data, 'base64')
			);
		};
		await send('Page.enable');
		await send('Runtime.enable');
		// Every application request stays local; model/runtime responses are fixtures.
		await send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] });
		socket.addEventListener('message', ({ data }) => {
			const message = JSON.parse(String(data));
			if (message.method !== 'Fetch.requestPaused') return;
			const { requestId, request } = message.params;
			void send(request.url.startsWith(`${url}/`) ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
				requestId,
				...(request.url.startsWith(`${url}/`) ? {} : { errorReason: 'BlockedByClient' })
			});
		});
		await send('Emulation.setDeviceMetricsOverride', {
			width: 1440,
			height: 1000,
			deviceScaleFactor: 1,
			mobile: false
		});
		await send('Page.addScriptToEvaluateOnNewDocument', {
			source: `(${mockLeader.toString()})();`
		});
		await send('Page.navigate', { url });
		const wait = (expression, label) => until(() => evaluate(expression), label);
		const click = (label) =>
			evaluate(
				`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getClientRects().length); if (!button) throw new Error('Missing button: ' + ${JSON.stringify(label)}); button.click(); })()`
			);
		if (process.argv.includes('--terminal')) {
			await wait(
				`document.querySelector('[aria-label="Toggle the editor and terminal panel"]')`,
				'terminal toggle'
			);
			const toggle = () =>
				evaluate(
					`document.querySelector('[aria-label="Toggle the editor and terminal panel"]').click()`
				);
			await toggle();
			await wait(`globalThis.__terminalMock.created.length > 0`, 'PTY create');
			await delay(250);
			assert.equal(
				await evaluate('globalThis.__terminalMock.created.length'),
				1,
				'Opening the terminal must spawn exactly one PTY.'
			);
			await wait(
				`document.querySelector('.xterm-rows')?.textContent.includes('PS D:\\\\repo>')`,
				'shell prompt after cursor report'
			);
			assert.equal(
				await evaluate('globalThis.__terminalMock.input.length'),
				1,
				'The startup cursor query must receive a reply.'
			);
			await send('Input.insertText', { text: 'echo hello' });
			await wait(
				`document.querySelector('.xterm-rows')?.textContent.includes('echo hello')`,
				'shell input and output'
			);
			await click('Editor');
			await click('Terminal');
			assert.equal(
				await evaluate('globalThis.__terminalMock.created.length'),
				1,
				'Switching tabs must keep the same shell.'
			);
			await toggle();
			await wait(`globalThis.__terminalMock.closed.length === 1`, 'close owned PTY');
			await toggle();
			await wait(`globalThis.__terminalMock.created.length === 2`, 'second PTY create');
			await toggle();
			await wait(
				`globalThis.__terminalMock.closed.length === 2`,
				'close PTY created after unmount'
			);
			assert.deepEqual(await evaluate('globalThis.__terminalMock.closed'), ['pty-1', 'pty-2']);
			assert.deepEqual(cdp.exceptions, [], 'No uncaught browser exceptions.');
			console.log(
				'Terminal browser smoke passed: single spawn, early cursor query, prompt, input/output, tab switch, pending-create cleanup.'
			);
			return;
		}
		await wait(`document.querySelector('[aria-label="Open graph progress"]')`, 'graph entry point');
		assert.equal(
			await evaluate(
				`document.querySelector('[aria-label="Model: No models available"]')?.disabled`
			),
			true,
			'An empty model catalog must keep the graph accessible.'
		);
		await evaluate(`document.querySelector('[aria-label="Open graph progress"]').click()`);
		await wait(`document.querySelector('[aria-label="Implement API: running"]')`, 'graph nodes');
		await evaluate(`document.querySelector('[aria-label="Implement API: running"]').click()`);
		await wait(
			`document.querySelector('[aria-label="Node details"]')?.textContent.includes('3 tool calls')`,
			'per-node live activity'
		);
		const artifacts = join(root, '.svelte-kit/graph-smoke');
		await mkdir(artifacts, { recursive: true });
		const screenshot = async (name) => {
			const { data } = await send('Page.captureScreenshot', { format: 'png' });
			await writeFile(join(artifacts, name), Buffer.from(data, 'base64'));
		};
		await screenshot('desktop.png');
		await evaluate(
			`(() => { const graph = globalThis.__graphMock.graph; graph.nodes[1].status = 'failed'; graph.nodes[1].failure = 'Verification found a failing API test.'; graph.nodes.push({ id: 'gn-docs', title: 'Document API', spec: 'Describe the endpoint', status: 'ready', rounds: 0, tokens_used: 0, deps: [{ on: 'gn-b', kind: 'discovered_from' }] }); graph.plan_version += 1; })()`
		);
		await wait(
			`document.querySelector('[aria-label="Node details"]')?.textContent.includes('Verification found a failing API test.')`,
			'live node failure'
		);
		await wait(
			`document.querySelector('[aria-label="Document API: ready"]')`,
			'replanned topology'
		);
		await evaluate(
			`(() => { const node = globalThis.__graphMock.graph.nodes[1]; node.status = 'running'; delete node.failure; })()`
		);
		await click('Nodes');
		await wait(`document.querySelector('[aria-label="Filter graph nodes"]')`, 'node list');
		await click('History');
		await wait(
			`document.body.textContent.includes('Add coverage for stale graph ids.')`,
			'replan discoveries'
		);
		await click('Dependencies');
		await click('Pause after current work');
		await wait(
			`globalThis.__graphMock.commands.includes('pause') && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Resume graph')`,
			'pause'
		);
		await evaluate(
			`(() => { const input = document.querySelector('#graph-extra-budget'); input.value = '50000'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`
		);
		await click('Resume graph');
		await wait(
			`globalThis.__graphMock.commands.includes('/graph resume --budget 50000')`,
			'resume with budget'
		);
		await evaluate(`globalThis.__graphMock.graph.status = 'complete'`);
		await wait(
			`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New graph')`,
			'completed graph controls'
		);
		await click('New graph');
		await wait(`document.querySelector('#graph-objective')`, 'new objective after completion');
		await click('Back to graph');
		await click('Clear graph');
		await evaluate(`globalThis.__graphMock.graph.graph_id = 'replacement-graph'`);
		await wait(
			`![...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Confirm clear')`,
			'disarm clear when graph identity changes'
		);
		await click('Clear graph');
		await click('Confirm clear');
		await wait(`document.querySelector('#graph-objective')`, 'clear');
		await evaluate(
			`(() => { const input = document.querySelector('#graph-objective'); input.value = 'Implement browser coverage'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`
		);
		await click('Start graph');
		await wait(
			`globalThis.__graphMock.commands.some(c => c.startsWith('/graph Implement browser coverage'))`,
			'start'
		);
		await wait(`document.querySelector('[aria-label="Implement API: running"]')`, 'new graph');
		await send('Emulation.setDeviceMetricsOverride', {
			width: 390,
			height: 844,
			deviceScaleFactor: 1,
			mobile: false
		});
		await delay(200);
		const overflow = await evaluate(`document.documentElement.scrollWidth > window.innerWidth`);
		assert.equal(overflow, false, 'The mobile viewport must not overflow horizontally.');
		await screenshot('mobile-top.png');
		await evaluate(`document.querySelector('[aria-label="Implement API: running"]').click()`);
		await wait(
			`document.querySelector('[aria-label="Node details"]')?.textContent.includes('3 tool calls')`,
			'mobile node details'
		);
		assert.ok(
			await evaluate(
				`document.querySelector('[aria-label="Node details"]').getBoundingClientRect().height > 150`
			),
			'Node details need usable space on mobile.'
		);
		await evaluate(
			`document.querySelector('[aria-label="Node details"]').scrollIntoView({ block: 'start' })`
		);
		await screenshot('mobile.png');
		assert.deepEqual(cdp.exceptions, [], 'No uncaught browser exceptions.');
		console.log(
			'Graph browser smoke passed: node activity, dependency/list/history views, pause, budget resume, clear, start, mobile layout.'
		);
		console.log(`Screenshots: ${artifacts}`);
	} catch (cause) {
		console.error(viteLog.slice(-8000));
		if (diagnose) await diagnose();
		throw cause;
	} finally {
		if (cdp) {
			try {
				await cdp.send('Browser.close');
			} catch {
				/* Browser may close before acknowledging. */
			}
		}
		browser?.kill();
		vite?.kill();
		await rm(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
	}
}

await main();
