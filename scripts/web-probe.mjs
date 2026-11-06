/**
 * End-to-end probe against a live `alnair web`: prints the raw payload shapes.
 *
 *   node scripts/web-probe.mjs http://127.0.0.1:2441
 *
 * For assertions use `web-verify.mjs`, and for the UI in a real browser use
 * `web-browser-test.mjs`. This one is for looking at what the wire actually
 * says when something is unexpected.
 *
 * Extension methods go out `_`-prefixed with FLAT params. The ACP decoder
 * strips the `_` and hands the whole `params` object to the handler, so nesting
 * `{ method, params }` one level down leaves it with no fields — which is how
 * a release shipped with an empty UI. `plainExt` below shows that failure on
 * purpose.
 *
 * Implemented on `node:http` + `node:net` rather than the built-in `WebSocket`,
 * because that one cannot set an `Origin` header and the server's gate
 * (correctly) requires one.
 */

import { createHash, randomBytes } from "node:crypto";
import { pairedCookie } from "./web-auth.mjs";
import net from "node:net";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:2441");
const timeoutMs = 20_000;

const cookie = await pairedCookie(base);

/** Open the upgrade. */
const socket = net.connect(Number(base.port), base.hostname);
const key = randomBytes(16).toString("base64");

await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.once("connect", () => {
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
        "",
        "",
      ].join("\r\n"),
    );
  });
  socket.once("data", (chunk) => {
    const head = chunk.toString("latin1");
    if (!head.startsWith("HTTP/1.1 101")) {
      reject(
        new Error(
          `upgrade refused:\n${head.split("\r\n").slice(0, 6).join("\n")}`,
        ),
      );
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
      : Buffer.from([
          0x81,
          0x80 | 126,
          payload.length >> 8,
          payload.length & 0xff,
        ]);
  socket.write(Buffer.concat([header, mask, masked]));
}

/** Incremental server-frame parser (server frames are unmasked). */
let buffer = Buffer.alloc(0);
const frames = [];
const listeners = [];

socket.on("data", (chunk) => {
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
      const message = JSON.parse(payload.toString("utf8"));
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
    send({ jsonrpc: "2.0", id, method, params });
  });
}

socket.on("data", () => {
  for (const [id, waiter] of pending) {
    const response = frames.find(
      (frame) => Number(frame.id) === id && !frame.method,
    );
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

await probe("initialize", "initialize", {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
});

// The two envelopes, side by side: the flat form the client must use, and the
// nested form that silently loses every field.
const rosterFlat = await probe("rosterFlat", "_alnair/sessions/list", {});
const rosterNested = await probe("rosterNested", "_alnair/sessions/list", {
  method: "alnair/sessions/list",
  params: {},
});
const rows = rosterFlat?.result?.sessions ?? rosterFlat?.sessions ?? [];
report.rosterCount = rows.length;
report.firstRow = rows[0];

// `fs/list` REQUIRES `path`, so it tells the two forms apart: the nested one is
// rejected with "invalid params: missing field `path`". The roster ignores
// unknown fields and answers either way, which is how the bug hid.
report.fsListFlat = await probe("fsListFlat", "_alnair/fs/list", {
  path: rows[0]?.cwd ?? "",
});
report.fsListNested = await probe("fsListNested", "_alnair/fs/list", {
  method: "alnair/fs/list",
  params: { path: rows[0]?.cwd ?? "" },
});

if (rows[0]?.sessionId) {
  const sessionId = rows[0].sessionId;
  const cwd = rows[0].cwd ?? "";
  const load = await probe("load", "session/load", {
    sessionId,
    cwd,
    mcpServers: [],
  });
  report.loadKeys = load ? Object.keys(load) : [];
  report.loadModels = load?.models ?? null;

  // Flat params, the correct form. Nested here would fall back to the FIRST
  // resident session, which is why a probe that only looks at row 0 cannot
  // see the mistake.
  await probe("info", "_alnair/session/info", { sessionId });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  report.frameCount = frames.filter((frame) => frame.method).length;
  report.frameMethods = [
    ...new Set(frames.filter((f) => f.method).map((f) => f.method)),
  ];
}

console.log(JSON.stringify(report, null, 2));
socket.end();
