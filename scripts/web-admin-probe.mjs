/**
 * Probe the session-admin wire: create a throwaway session, rename it, delete
 * it, and report what the agent actually did (including whether the on-disk
 * directory survived).
 *
 *   node scripts/web-admin-probe.mjs http://127.0.0.1:2499
 *
 * Uses a live `alnair web`, so it writes to the real `~/.alnair`. The session
 * it creates is the only one it touches.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const base = process.argv[2] ?? "http://127.0.0.1:2499";

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
const notifications = [];

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined && message.method === undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method) notifications.push(message);
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 20_000);
  });
}

await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
});

const cwd = process.cwd();
const created = await request("session/new", { cwd, mcpServers: [] });
const sessionId = created?.sessionId;
console.log("created:", sessionId);

const encoded = encodeURIComponent(cwd);
const dir = join(homedir(), ".alnair", "sessions", encoded, sessionId);
console.log("dir exists after create:", existsSync(dir), dir);

const renamed = await request("_alnair/session/rename", {
  sessionId,
  title: "probe rename",
  cwd,
});
console.log("rename result:", JSON.stringify(renamed));

const rosterAfterRename = await request("_alnair/sessions/list", {});
const row = (rosterAfterRename?.result?.sessions ?? []).find(
  (r) => r.sessionId === sessionId,
);
console.log("roster title after rename:", row?.title, "| cwd:", row?.cwd);

const deleted = await request("_alnair/session/delete", { sessionId, cwd });
console.log("delete result:", JSON.stringify(deleted));
console.log("dir exists after delete:", existsSync(dir));

const rosterAfterDelete = await request("_alnair/sessions/list", {});
const still = (rosterAfterDelete?.result?.sessions ?? []).some(
  (r) => r.sessionId === sessionId,
);
console.log("still in roster:", still);

console.log("notification methods:", [
  ...new Set(notifications.map((n) => n.method)),
]);
const changed = notifications.filter((n) =>
  String(n.method).includes("sessions/changed"),
);
console.log("roster-delta count:", changed.length);
if (changed.length > 0)
  console.log("last delta:", JSON.stringify(changed.at(-1)));

socket.close();
process.exit(0);
