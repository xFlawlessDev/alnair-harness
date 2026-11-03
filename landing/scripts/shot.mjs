/**
 * Screenshot the landing page over the Chrome DevTools Protocol.
 *
 *   node landing/scripts/shot.mjs <url> <theme> <out.png> [width] [scrollY] [dpr]
 *
 * `scrollY` captures that viewport; the default `full` captures the whole
 * document in one tall image. No Playwright: the repo has neither it nor
 * Puppeteer, and adding a browser automation dependency just to look at one
 * page is a poor trade. Node's built-in WebSocket speaks CDP, and Chrome or
 * Edge is already installed.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [
	url = 'http://localhost:4399/',
	theme = 'dark',
	out = 'shot.png',
	width = '1440',
	scroll = 'full',
	dpr = '1'
] = process.argv.slice(2);

const CANDIDATES = [
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

const browserPath = CANDIDATES.find((candidate) => existsSync(candidate));
if (!browserPath) {
	console.error('no Chrome or Edge found');
	process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'alnair-landing-shot-'));
const port = 9344;

const browser = spawn(
	browserPath,
	[
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		'--headless=new',
		'--disable-gpu',
		'--no-first-run',
		'--no-default-browser-check',
		`--window-size=${width},1000`,
		'about:blank'
	],
	{ stdio: 'ignore' }
);

process.on('exit', () => {
	try {
		browser.kill();
	} catch {
		// Already gone.
	}
	try {
		rmSync(profile, { recursive: true, force: true });
	} catch {
		// Windows holds the profile briefly; the OS temp root reclaims it.
	}
});

async function devtoolsUrl() {
	const deadline = Date.now() + 25_000;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) return (await res.json()).webSocketDebuggerUrl;
		} catch {
			// Not listening yet.
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
const consoleErrors = [];
const pageErrors = [];

socket.addEventListener('message', (event) => {
	const message = JSON.parse(String(event.data));
	if (message.id !== undefined) {
		const waiter = pending.get(message.id);
		if (!waiter) return;
		pending.delete(message.id);
		if (message.error) waiter.reject(new Error(message.error.message));
		else waiter.resolve(message.result);
		return;
	}
	if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
		consoleErrors.push(
			message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
		);
	}
	if (message.method === 'Runtime.exceptionThrown') {
		pageErrors.push(
			message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text
		);
	}
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

async function evaluate(expression) {
	const result = await send(
		'Runtime.evaluate',
		{ expression, awaitPromise: true, returnByValue: true },
		sessionId
	);
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
	}
	return result.result.value;
}

const height = 1000;

await send(
	'Emulation.setDeviceMetricsOverride',
	{ width: Number(width), height, deviceScaleFactor: Number(dpr), mobile: false },
	sessionId
);
await send(
	'Emulation.setEmulatedMedia',
	{ features: [{ name: 'prefers-color-scheme', value: theme }] },
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

// Settle: the theme resolves on the first tick, and the reveal action fires on
// intersection — so every section has to be scrolled past once before a
// full-page capture, or half the page photographs as transparent.
await new Promise((r) => setTimeout(r, 400));
await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
await evaluate(`(async () => {
	const step = window.innerHeight * 0.8;
	for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
		window.scrollTo(0, y);
		await new Promise((r) => setTimeout(r, 60));
	}
	window.scrollTo(0, 0);
})()`);
await new Promise((r) => setTimeout(r, 700));

const metrics = await evaluate(`(() => ({
	full: document.documentElement.scrollHeight,
	width: document.documentElement.scrollWidth,
	title: document.title
}))()`);

if (scroll === 'full') {
	await send(
		'Emulation.setDeviceMetricsOverride',
		{
			width: Number(width),
			height: Math.min(metrics.full, 20000),
			deviceScaleFactor: Number(dpr),
			mobile: false
		},
		sessionId
	);
	await new Promise((r) => setTimeout(r, 400));
} else if (scroll !== '0') {
	await evaluate(`window.scrollTo(0, ${Number(scroll)})`);
	await new Promise((r) => setTimeout(r, 300));
}

const shot = await send(
	'Page.captureScreenshot',
	{ format: 'png', captureBeyondViewport: scroll === 'full' },
	sessionId
);
writeFileSync(out, Buffer.from(shot.data, 'base64'));

console.log(JSON.stringify({ out, ...metrics, consoleErrors, pageErrors }, null, 2));
socket.close();
process.exit(consoleErrors.length || pageErrors.length ? 1 : 0);
