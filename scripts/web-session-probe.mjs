/**
 * Ask one question: what does `session/load` replay for a session?
 *
 *   node scripts/web-session-probe.mjs http://127.0.0.1:2499 <sessionId>
 *
 * Prints the load response, the replay frame counts, and writes every frame
 * (with its payload) to `target/replay-frames.json`. That dump is what lets an
 * empty transcript be told apart from a load that never happened: the browser
 * can only be debugged once we know what it was given.
 */

import { writeFileSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:2499";
const wanted = process.argv[3];

const cookie = await (async () => {
  const res = await fetch(`${base}/api/session`);
  const raw = res.headers.getSetCookie?.() ?? [];
  const token = raw
    .map((line) => line.split(";")[0])
    .find((line) => line.startsWith("alnair_web="));
  if (!token) throw new Error("no auth cookie");
  return token;
})();

const socket = new WebSocket(base.replace("http", "ws") + "/ws", {
  headers: { Cookie: cookie, Origin: base },
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("socket failed")), {
    once: true,
  });
});

let nextId = 1;
const pending = new Map();
const frames = [];

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined && message.method === undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (!message.method) return;
  const params = message.params ?? {};
  const update = params.update;
  frames.push({
    method: message.method,
    sessionId: params.sessionId,
    kind: update?.sessionUpdate,
    hasEventId: Boolean(params._meta?.eventId),
    raw: params,
  });
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30_000);
  });
}

await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
});

const roster = await request("_alnair/sessions/list", {});
const rows = roster?.result?.sessions ?? roster?.sessions ?? [];
const row = wanted ? rows.find((entry) => entry.sessionId === wanted) : rows[0];
console.log(
  "session:",
  row?.sessionId,
  "| cwd:",
  row?.cwd,
  "| title:",
  row?.title,
);

const before = frames.length;
const loadResult = await request("session/load", {
  sessionId: row.sessionId,
  cwd: row.cwd,
  mcpServers: [],
});
await new Promise((r) => setTimeout(r, 2_000));

const replay = frames.slice(before);
console.log("load keys:", Object.keys(loadResult ?? {}).join(", "));
console.log("replay frames:", replay.length);
console.log(
  "by kind:",
  JSON.stringify(
    replay.reduce((acc, frame) => {
      const key = frame.kind ?? frame.method;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  ),
);
writeFileSync("target/replay-frames.json", JSON.stringify(replay, null, 2));
console.log("wrote target/replay-frames.json");

socket.close();
process.exit(0);
