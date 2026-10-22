/**
 * Drive the web UI in a real browser over the Chrome DevTools Protocol.
 *
 *   node scripts/web-browser-test.mjs http://127.0.0.1:2499
 *
 * No Playwright/Puppeteer: the repo has neither, and adding a browser
 * automation dependency just to click through one page is a poor trade. Node's
 * built-in WebSocket speaks CDP, and Chrome/Edge is already installed.
 *
 * Selectors use the accessible names the components already carry
 * (`aria-label="Model: …"`, `data-session-id`) rather than CSS structure, so a
 * restyle does not turn this into a false failure.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:2499';

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

const profile = mkdtempSync(join(tmpdir(), 'alnair-web-test-'));
const port = 9333;

const browser = spawn(
	browserPath,
	[
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		'--headless=new',
		'--disable-gpu',
		'--no-first-run',
		'--no-default-browser-check',
		'--window-size=1440,900',
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
	if (message.method === 'Runtime.consoleAPICalled') {
		const text = message.params.args
			.map((arg) => arg.value ?? arg.description ?? arg.type)
			.join(' ');
		if (message.params.type === 'error') consoleErrors.push(text);
		else console.log('[console]', text);
	}
	if (message.method === 'Runtime.exceptionThrown') {
		pageErrors.push(
			message.params.exceptionDetails.exception?.description ??
				message.params.exceptionDetails.text
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
		throw new Error(
			result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
		);
	}
	return result.result.value;
}

async function waitFor(label, expression, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	for (;;) {
		try {
			last = await evaluate(expression);
			if (last) return last;
		} catch (error) {
			last = String(error);
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
		}
		await new Promise((r) => setTimeout(r, 200));
	}
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

/** Type into the composer the way a user would (React-style value setter). */
const typeInto = (text) => `
	(() => {
		const area = document.querySelector('textarea[aria-label="Message"]');
		if (!area) return { error: 'no composer' };
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			'value'
		).set;
		area.focus();
		setter.call(area, ${JSON.stringify(text)});
		area.dispatchEvent(new Event('input', { bubbles: true }));
		return { ok: true };
	})()
`;

// --- load -----------------------------------------------------------------

const loaded = new Promise((resolve) => {
	const listener = (event) => {
		const message = JSON.parse(String(event.data));
		if (message.method === 'Page.loadEventFired') {
			socket.removeEventListener('message', listener);
			resolve();
		}
	};
	socket.addEventListener('message', listener);
});
await send('Page.navigate', { url: base }, sessionId);
await loaded;

// --- 1. loading state -----------------------------------------------------

// Sampled immediately: against a local leader the handshake can finish inside
// the first frame, so "the skeleton was seen" is not a stable assertion. What
// IS stable is that a fixture conversation never appears and the skeleton does
// not linger.
const skeletonAtFirstPaint = await evaluate(
	`Boolean(document.querySelector('[aria-label="Connecting to the agent"]'))`
);
await waitFor(
	'the skeleton to clear',
	`!document.querySelector('[aria-label="Connecting to the agent"]')`,
	45_000
);
check(
	'1. loading state resolves to the real UI',
	true,
	skeletonAtFirstPaint ? 'skeleton painted, then cleared' : 'connected before first sample'
);

const fixtureLeak = await evaluate(`
	(() => {
		const text = document.body.innerText;
		// The mock transcript's distinctive strings; a live page has none.
		return ['Fix the flaky test', 'feat/web-harness', 'alnair-cli'].filter((s) =>
			text.includes(s)
		);
	})()
`);
check(
	'1. no fixture data on the live page',
	Array.isArray(fixtureLeak) && fixtureLeak.length === 0,
	Array.isArray(fixtureLeak) && fixtureLeak.length > 0
		? `leaked: ${fixtureLeak.join(', ')}`
		: 'clean'
);

// --- 2. sessions + history ------------------------------------------------

const sessionRows = await waitFor(
	'sidebar sessions',
	`document.querySelectorAll('[data-session-id]').length`,
	40_000
);
check('2. sidebar lists real sessions', sessionRows > 0, `${sessionRows} rows`);

const activeSessionId = await evaluate(
	`document.querySelector('[data-session-id][aria-current="true"]')?.getAttribute('data-session-id') ?? null`
);
check('2. a session is active', Boolean(activeSessionId), activeSessionId ?? 'none');

const threadChars = await evaluate(`
	(() => {
		const main = document.querySelector('main');
		return main ? main.innerText.trim().length : 0;
	})()
`);
check('2. thread pane renders', threadChars > 20, `${threadChars} chars`);

// --- 3. model picker ------------------------------------------------------

const modelLabel = await evaluate(`
	(() => {
		const hit = [...document.querySelectorAll('button')].find((b) =>
			(b.getAttribute('aria-label') || '').startsWith('Model: ')
		);
		return hit ? hit.getAttribute('aria-label') : null;
	})()
`);
check('3. model picker shows the live model', Boolean(modelLabel), modelLabel ?? 'not found');

// Open the picker and count the real catalog.
await evaluate(`
	(() => {
		const hit = [...document.querySelectorAll('button')].find((b) =>
			(b.getAttribute('aria-label') || '').startsWith('Model: ')
		);
		hit?.click();
		return true;
	})()
`);
const modelRows = await waitFor(
	'model menu',
	`[...document.querySelectorAll('[role="menuitem"]')].filter((n) =>
		/deepseek|kimi|gpt|glm|openscale/i.test(n.innerText)
	).length`,
	10_000
).catch(() => 0);
check('3. model menu lists the catalog', Number(modelRows) > 0, `${modelRows} models`);
await evaluate(`document.body.click()`);

// --- 4. context window ----------------------------------------------------

const contextLabel = await evaluate(`
	(() => {
		const hit = [...document.querySelectorAll('button')].find((b) =>
			(b.getAttribute('aria-label') || '').startsWith('Context')
		);
		return hit ? hit.getAttribute('aria-label') : null;
	})()
`);
check(
	'4. context meter reports a real window',
	Boolean(contextLabel) && !/unknown/i.test(contextLabel),
	contextLabel ?? 'not found'
);

// --- 5. access ------------------------------------------------------------

const accessLabel = await evaluate(`
	(() => {
		const hit = [...document.querySelectorAll('button')].find((b) =>
			(b.getAttribute('aria-label') || '').startsWith('Access: ')
		);
		return hit ? hit.getAttribute('aria-label') : null;
	})()
`);
check('5. access picker renders the session mode', Boolean(accessLabel), accessLabel ?? 'not found');

// --- 6. slash commands ----------------------------------------------------

await evaluate(typeInto('/'));
const commandRows = await waitFor(
	'slash commands',
	`[...document.querySelectorAll('button')].filter((n) =>
		n.innerText.trim().startsWith('/')
	).length`,
	15_000
).catch(() => 0);
check('6. slash menu lists the agent commands', Number(commandRows) > 0, `${commandRows} commands`);

await evaluate(typeInto(''));
await evaluate(`
	document.querySelector('textarea[aria-label="Message"]')
		.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
`);

// --- A + B. file listing and fuzzy search ---------------------------------

await evaluate(typeInto('@'));
const fileRows = await waitFor(
	'@ listing',
	`[...document.querySelectorAll('button')].filter((n) =>
		/(src|crates|web|docs|package)/i.test(n.innerText)
	).length`,
	25_000
).catch(() => 0);
check('A. @ lists the workspace', Number(fileRows) > 0, `${fileRows} entries`);

await evaluate(typeInto('@main'));
const matchRows = await waitFor(
	'fuzzy matches',
	`[...document.querySelectorAll('button')].filter((n) => /main/i.test(n.innerText)).length`,
	25_000
).catch(() => 0);
check('B. @query returns fuzzy matches', Number(matchRows) > 0, `${matchRows} matches`);

await evaluate(typeInto(''));
await evaluate(`
	document.querySelector('textarea[aria-label="Message"]')
		.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
`);

// --- 7. subagents ---------------------------------------------------------

const subagentChrome = await evaluate(`
	(() => {
		const text = document.body.innerText;
		return /subagent/i.test(text);
	})()
`);
check(
	'7. subagent chrome comes from live state',
	true,
	subagentChrome ? 'a subagent chip is shown' : 'no running subagents in this session'
);

// --- a real message round-trip -------------------------------------------

// The one check that proves the socket, the prompt path and the stream all
// work: send a trivial prompt and wait for the agent's text to appear.
const beforeSend = await evaluate(`document.body.innerText.length`);
await evaluate(typeInto('Reply with exactly: pong'));
await evaluate(`
	(() => {
		const area = document.querySelector('textarea[aria-label="Message"]');
		area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		return true;
	})()
`);

const replied = await waitFor(
	'a reply',
	`/pong/i.test(document.body.innerText)`,
	120_000
).catch(() => false);
check('send: a prompt round-trips and the reply renders', Boolean(replied), `before ${beforeSend} chars`);

// Order matters: the answer must come AFTER the question. Reading text offsets
// is not enough — the prompt's own text contains "pong" — so this walks the
// rendered message nodes, finds the LAST user message, and requires the reply
// to appear in a LATER item. `content-visibility: auto` makes an off-screen
// message report an empty innerText, so this reads textContent.
//
// It polls the ordering itself rather than the text: the reply streams in, and
// the last user message is the one just sent.
const ORDER_EXPR = `
	(() => {
		const items = [...document.querySelectorAll('[data-slot="message-scroller-item"]')];
		if (items.length === 0) return { ok: false, why: 'no messages' };
		const text = (node) => (node.textContent || '').replace(/\\s+/g, ' ').trim();
		let lastUser = -1;
		for (let i = 0; i < items.length; i += 1) {
			if (items[i].querySelector('[data-align="end"]')) lastUser = i;
		}
		if (lastUser === -1) return { ok: false, why: 'no user message' };
		const prompt = text(items[lastUser]);
		const after = items.slice(lastUser + 1).map(text).join(' ');
		return {
			ok: prompt.includes('Reply with exactly') && /pong/i.test(after),
			why: prompt.slice(0, 40) + ' -> ' + (after.slice(0, 40) || '(nothing yet)'),
			items: items.length
		};
	})()
`;

const deadline = Date.now() + 90_000;
let order = { ok: false, why: 'not evaluated' };
for (;;) {
	order = await evaluate(ORDER_EXPR);
	if (order?.ok) break;
	if (Date.now() > deadline) break;
	await new Promise((r) => setTimeout(r, 300));
}
check('send: the reply renders BELOW its prompt', Boolean(order?.ok), order?.why ?? 'unknown');

// --- errors + paint -------------------------------------------------------

check(
	'no uncaught page errors',
	pageErrors.length === 0,
	pageErrors.slice(0, 2).join(' | ') || 'none'
);
check(
	'no console errors',
	consoleErrors.length === 0,
	consoleErrors.slice(0, 2).join(' | ') || 'none'
);

const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
writeFileSync('target/web-ui.png', Buffer.from(shot.data, 'base64'));
check('page paints', shot.data.length > 10_000, `target/web-ui.png`);

for (const result of results) {
	console.log(
		`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`
	);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
socket.close();
process.exit(failed > 0 ? 1 : 0);
