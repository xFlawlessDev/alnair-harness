/**
 * End-to-end probe against a live `alnair web`.
 *
 * Speaks the same JSON-RPC the browser transport speaks and reports what
 * actually came back — the point is to see real payload shapes, not to assert
 * what we hope they are.
 *
 *   node scripts/web-probe.mjs http://127.0.0.1:2441
 *
 * Implemented on `node:http` + `node:net` rather than the built-in `WebSocket`,
 * because that one cannot set an `Origin` header and the server's gate
 * (correctly) requires one.
 */

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:2441');
const timeoutMs = 20_000;

/** Fetch the auth cookie the WS gate wants. */
const page = await new Promise((resolve, reject) => {
	http
		.get({ host: base.hostname, port: base.port, path: '/', headers: { accept: 'text/html' } }, (res) => {
			res.resume();
			resolve(res);
		})
		.on('error', reject);
});

const rawCookie = page.headers['set-cookie']?.[0];
if (!rawCookie) {
	console.error('no auth cookie from', base.origin);
	process.exit(1);
}
const cookie = rawCookie.split(';')[0];

/** Open the upgrade. */
const socket = net.connect(Number(base.port), base.hostname);
const key = randomBytes(16).toString('base64');

await new Promise((resolve, reject) => {
	socket.once('error', reject);
	socket.once('connect', () => {
		socket.write(
			[
				`GET /ws HTTP/1.1`,
				`Host: ${base.host}`,
				`Upgrade: websocket`,
				`Connection: Upgrade`,
				`Sec-WebSocket-Version: 13`,
				`Sec-WebSocket-Key: ${key}`,
				`Origin: ${base.origin}`,
				`Cookie: ${cookie}`,
				'',
				''
			].join('\r\n')
		);
	});
	socket.once('data', (chunk) => {
		const head = chunk.toString('latin1');
		if (!head.startsWith('HTTP/1.1 101')) {
			reject(new Error(`upgrade refused:\n${head.split('\r\n').slice(0, 6).join('\n')}`));
			return;
		}
		resolve();
	});
});

/** Frame a client text message (masked, per RFC 6455). */
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

/** Incremental server-frame parser (server frames are unmasked). */
let buffer = Buffer.alloc(0);
const frames = [];
const listeners = [];

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

		if (opcode === 0x1) {
			const message = JSON.parse(payload.toString('utf8'));
			frames.push(message);
			for (const listener of listeners.splice(0)) listener(message);
		}
	}
});

let nextId = 1;
const pending = new Map();

function request(method, params) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			if (pending.delete(id)) reject(new Error(`${method} timed out`));
		}, timeoutMs);
		pending.set(id, { resolve, reject, timer });
		send({ jsonrpc: '2.0', id, method, params });
	});
}

socket.on('data', () => {
	for (const [id, waiter] of pending) {
		const response = frames.find((frame) => Number(frame.id) === id && !frame.method);
		if (!response) continue;
		pending.delete(id);
		clearTimeout(waiter.timer);
		if (response.error) waiter.reject(new Error(response.error.message));
		else waiter.resolve(response.result);
	}
});

const report = {};

async function probe(name, method, params) {
	try {
		const result = await request(method, params);
		report[name] = result;
		return result;
	} catch (e) {
		report[name] = { error: String(e.message) };
		return undefined;
	}
}

await probe('initialize', 'initialize', {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false
	}
});

const rosterPlain = await probe('rosterPlain', 'alnair/sessions/list', {});
const roster = await probe('roster', '_alnair/sessions/list', {
	method: 'alnair/sessions/list',
	params: {}
});
const rows = roster?.result?.sessions ?? roster?.sessions ?? [];
report.rosterCount = rows.length;
report.firstRow = rows[0];

if (rows[0]?.sessionId) {
	const sessionId = rows[0].sessionId;
	const cwd = rows[0].cwd ?? '';
	const load = await probe('load', 'session/load', { sessionId, cwd, mcpServers: [] });
	report.loadKeys = load ? Object.keys(load) : [];
	report.loadModels = load?.models ?? null;

	await probe('info', '_alnair/session/info', {
		method: 'alnair/session/info',
		params: { sessionId }
	});

	await new Promise((resolve) => setTimeout(resolve, 1500));
	report.frameCount = frames.filter((frame) => frame.method).length;
	report.frameMethods = [...new Set(frames.filter((f) => f.method).map((f) => f.method))];
}

console.log(JSON.stringify(report, null, 2));
socket.end();
