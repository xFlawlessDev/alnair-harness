import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Find the code blocks that still scroll sideways.
 *
 *   node scripts/measure.mjs http://localhost:4399/docs/configuration/ 1600
 *
 * A single `codeOverflow` number says "something is clipped" without saying
 * which block or by how much, which is not enough to decide whether to widen
 * the column or reflow the markup. This reports the worst offenders with the
 * first line of each, so the fix goes to the block that needs it.
 */

const [url = 'http://localhost:4399/docs/configuration/', width = '1600'] = process.argv.slice(2);

const CANDIDATES = [
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const browserPath = CANDIDATES.find((candidate) => existsSync(candidate));
if (!browserPath) throw new Error('no Chrome or Edge found');

const profile = mkdtempSync(join(tmpdir(), 'alnair-measure-'));
const port = 9347;
const browser = spawn(
	browserPath,
	[
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		'--headless=new',
		'--disable-gpu',
		'--no-first-run',
		`--window-size=${width},1000`,
		'about:blank'
	],
	{ stdio: 'ignore' }
);

process.on('exit', () => {
	try {
		browser.kill();
	} catch {
		// already gone
	}
	try {
		rmSync(profile, { recursive: true, force: true });
	} catch {
		// windows holds it briefly
	}
});

async function devtoolsUrl() {
	const deadline = Date.now() + 25_000;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) return (await res.json()).webSocketDebuggerUrl;
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) throw new Error('browser never opened its debugging port');
		await new Promise((r) => setTimeout(r, 150));
	}
}

const socket = new WebSocket(await devtoolsUrl());
await new Promise((resolve, reject) => {
	socket.addEventListener('open', () => resolve(), { once: true });
	socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
	const message = JSON.parse(String(event.data));
	if (message.id === undefined) return;
	const waiter = pending.get(message.id);
	if (!waiter) return;
	pending.delete(message.id);
	if (message.error) waiter.reject(new Error(message.error.message));
	else waiter.resolve(message.result);
});

function send(method, params = {}, sessionId) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		socket.send(JSON.stringify({ id, method, params, sessionId }));
	});
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send(
	'Emulation.setDeviceMetricsOverride',
	{ width: Number(width), height: 1000, deviceScaleFactor: 1, mobile: false },
	sessionId
);

const loaded = new Promise((resolve) => {
	const handler = (event) => {
		const message = JSON.parse(String(event.data));
		if (message.method === 'Page.loadEventFired') {
			socket.removeEventListener('message', handler);
			resolve();
		}
	};
	socket.addEventListener('message', handler);
});
await send('Page.navigate', { url }, sessionId);
await loaded;
await new Promise((r) => setTimeout(r, 600));

const expression = `(() => {
	const rows = [];
	document.querySelectorAll('.doc-code pre, .doc-transcript, table').forEach((node) => {
		const overflow = node.scrollWidth - node.clientWidth;
		if (overflow <= 2) return;
		rows.push({
			kind: node.tagName === 'TABLE' ? 'table' : node.className || 'pre',
			lang: node.closest('[data-lang]')?.dataset.lang ?? '',
			overflow,
			first: (node.textContent ?? '').trim().split('\\n')[0].slice(0, 46)
		});
	});
	rows.sort((a, b) => b.overflow - a.overflow);
	return { count: rows.length, worst: rows.slice(0, 12) };
})()`;

const result = await send(
	'Runtime.evaluate',
	{ expression, returnByValue: true, awaitPromise: true },
	sessionId
);

console.log(JSON.stringify(result.result.value, null, 2));
socket.close();
process.exit(0);
