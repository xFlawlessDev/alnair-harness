/**
 * Live verification of the seven reported issues, using the FIXED wire shapes.
 *
 *   node scripts/web-verify.mjs http://127.0.0.1:2499
 *
 * Each check prints PASS/FAIL plus the evidence it used, so a regression names
 * itself instead of showing up as "the UI looks empty".
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:2499');
const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

const page = await new Promise((resolve, reject) => {
	http
		.get(
			{ host: base.hostname, port: base.port, path: '/', headers: { accept: 'text/html' } },
			(res) => {
				res.resume();
				resolve(res);
			}
		)
		.on('error', reject);
});
const cookie = page.headers['set-cookie'][0].split(';')[0];

const socket = net.connect(Number(base.port), base.hostname);
await new Promise((resolve, reject) => {
	socket.once('error', reject);
	socket.once('connect', () =>
		socket.write(
			[
				'GET /ws HTTP/1.1',
				`Host: ${base.host}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Version: 13',
				`Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
				`Origin: ${base.origin}`,
				`Cookie: ${cookie}`,
				'',
				''
			].join('\r\n')
		)
	);
	socket.once('data', (chunk) => {
		if (!chunk.toString('latin1').startsWith('HTTP/1.1 101')) reject(new Error('refused'));
		else resolve();
	});
});

function send(message) {
	const payload = Buffer.from(JSON.stringify(message));
	const mask = randomBytes(4);
	const masked = Buffer.from(payload);
	for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
	const header =
		payload.length < 126
			? Buffer.from([0x81, 0x80 | payload.length])
			: Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
	socket.write(Buffer.concat([header, mask, masked]));
}

const frames = [];
let buffer = Buffer.alloc(0);
socket.on('data', (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		if (buffer.length < 2) return;
		const opcode = buffer[0] & 0x0f;
		let length = buffer[1] & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (buffer.length < 4) return;
			length = buffer.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (buffer.length < 10) return;
			length = Number(buffer.readBigUInt64BE(2));
			offset = 10;
		}
		if (buffer.length < offset + length) return;
		const payload = buffer.subarray(offset, offset + length);
		buffer = buffer.subarray(offset + length);
		if (opcode === 0x1) frames.push(JSON.parse(payload.toString('utf8')));
	}
});

let nextId = 1;
function request(method, params, timeoutMs = 20_000) {
	const id = nextId++;
	return new Promise((resolve) => {
		const started = Date.now();
		const poll = setInterval(() => {
			const hit = frames.find((f) => Number(f.id) === id && f.method === undefined);
			if (hit) {
				clearInterval(poll);
				resolve(hit.error ? { error: hit.error.message, data: hit.error.data } : hit.result);
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(poll);
				resolve({ timeout: true });
			}
		}, 20);
		send({ jsonrpc: '2.0', id, method, params });
	});
}

/** The fixed transport's ext call: `_` prefix, FLAT params. */
const ext = (method, params) => request(`_${method}`, params);

/**
 * Unwrap either ext response shape.
 *
 * `ExtMethodResult { result, error }` for the handlers built with
 * `to_ext_response`; the bare payload for the ones written with
 * `to_raw_response` (`session/updates`, `commands/list`). Reading only the
 * envelope is exactly the bug this run is meant to catch.
 */
const payload = (raw) =>
	raw && typeof raw === 'object' && 'result' in raw ? (raw.result ?? undefined) : raw;

await request('initialize', {
	protocolVersion: 1,
	clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
});

// --- 1. roster ------------------------------------------------------------

const roster = await ext('alnair/sessions/list', {});
const rows = payload(roster)?.sessions ?? [];
check('1. roster loads', rows.length > 0, `${rows.length} sessions`);

const target = rows[0];
check(
	'1. roster carries the session cwd',
	typeof target?.cwd === 'string' && target.cwd.length > 0,
	target?.cwd
);

// --- 2. conversation history ---------------------------------------------

// Find a session with a stored transcript, so the replay has something to send.
let withHistory = null;
for (const row of rows.slice(0, 45)) {
	const stored = await ext('alnair/session/updates', { sessionId: row.sessionId, cwd: row.cwd });
	const total = payload(stored)?.totalCount ?? 0;
	if (total > 0) {
		withHistory = { row, total };
		break;
	}
}

if (withHistory) {
	const before = frames.length;
	const load = await request('session/load', {
		sessionId: withHistory.row.sessionId,
		cwd: withHistory.row.cwd,
		mcpServers: []
	});
	check('2. session/load accepts the real cwd', !load?.error, load?.error ?? 'ok');

	await new Promise((r) => setTimeout(r, 2500));
	const replay = frames.slice(before).filter((f) => f.method);
	const updates = replay.filter(
		(f) =>
			(f.method === 'session/update' || f.method === '_alnair/session/update') &&
			Boolean(f.params?.sessionId) &&
			Boolean(f.params?.update)
	);
	check(
		'2. replay delivers transcript frames the transport dispatches',
		updates.length > 0,
		`${updates.length} of ${replay.length} replay frames; totalCount ${withHistory.total}`
	);
} else {
	check(
		'2. conversation history',
		false,
		'no session on this leader has a stored updates.jsonl, so the replay had nothing to send'
	);
}

// --- 3. model selector ----------------------------------------------------

const loadForModels = await request('session/load', {
	sessionId: target.sessionId,
	cwd: target.cwd,
	mcpServers: []
});
const models = loadForModels?.models ?? {};
const available = models.availableModels ?? [];
check(
	'3. model catalog arrives',
	available.length > 0,
	`${available.length} models, current ${models.currentModelId}`
);

const efforts = available[0]?._meta?.reasoningEfforts ?? [];
check(
	'3. effort list arrives',
	Array.isArray(efforts) && efforts.length > 0,
	`${efforts.length} efforts (${efforts.map((e) => e.value ?? e.id).join(', ')})`
);

const switchTo = available[1]?.modelId ?? available[0]?.modelId;
const switched = await request('session/set_model', {
	sessionId: target.sessionId,
	modelId: switchTo,
	_meta: { reasoningEffort: efforts[1]?.value ?? efforts[0]?.value }
});
check(
	'3. session/set_model accepted',
	!switched?.error,
	switched?.error ?? `switched to ${switchTo}`
);

// --- 4. context window ----------------------------------------------------

const info = await ext('alnair/session/info', { sessionId: target.sessionId });
const infoSessionId = payload(info)?.sessionId ?? info?.sessionId;
const context = payload(info)?.context ?? info?.context;
check(
	'4. session/info answers for THIS session',
	infoSessionId === target.sessionId,
	`asked ${target.sessionId}, got ${infoSessionId}`
);
check(
	'4. context totals present',
	typeof context?.total === 'number' && context.total > 0,
	`${context?.used} / ${context?.total} (${context?.usagePct}%)`
);

// --- 5. access / permission ----------------------------------------------

check(
	'5. roster carries the session yolo flag',
	typeof target.yolo === 'boolean',
	`yolo=${target.yolo} (activity ${target.activity})`
);

// --- 6. slash commands ----------------------------------------------------

const beforeCommands = frames.length;
await request('session/load', { sessionId: target.sessionId, cwd: target.cwd, mcpServers: [] });
await new Promise((r) => setTimeout(r, 2500));
const commandFrame = frames
	.slice(beforeCommands)
	.find(
		(f) =>
			f.params?.update?.sessionUpdate === 'available_commands_update' &&
			Boolean(f.params?.sessionId)
	);
const commandCount = commandFrame?.params?.update?.availableCommands?.length ?? 0;
check(
	'6. available_commands_update reaches a dispatcher',
	Boolean(commandFrame) && commandCount > 0,
	`${commandCount} commands, method ${commandFrame?.method ?? 'none'}`
);

// --- 7. subagents ---------------------------------------------------------

const subagents = await ext('alnair/subagent/list_running', { sessionId: target.sessionId });
check(
	'7. subagent listing answers',
	!subagents?.error,
	subagents?.error ??
		`${payload(subagents)?.subagents?.length ?? 0} running (a live spawn is needed to see rows)`
);

// --- composer file listing (A + B) ---------------------------------------

const listed = await ext('alnair/fs/list', { path: target.cwd, sessionId: target.sessionId });
const nodes = payload(listed)?.nodes ?? [];
check('A. alnair/fs/list lists a directory', nodes.length > 0, `${nodes.length} entries`);

const searched = await ext('alnair/fs/search', {
	sessionId: target.sessionId,
	path: target.cwd,
	query: 'main'
});
const hits = payload(searched)?.results ?? [];
check(
	'B. alnair/fs/search ranks paths',
	!searched?.error && hits.length > 0,
	searched?.error ?? `${hits.length} hits (e.g. ${hits.slice(0, 3).map((h) => h.path).join(', ')})`
);

// --- report ---------------------------------------------------------------

for (const result of results) {
	const mark = result.ok ? 'PASS' : 'FAIL';
	console.log(`${mark}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
socket.end();
process.exit(failed > 0 ? 1 : 0);

