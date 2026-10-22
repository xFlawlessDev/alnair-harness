/**
 * Does deleting a session that is currently LOADED (the one in front) work?
 *
 *   node scripts/web-delete-active-probe.mjs http://127.0.0.1:2499
 *
 * The sidebar's delete removes the row optimistically, so a refusal is
 * invisible until the roster refreshes. This probe loads the throwaway session
 * first (making it the active one, exactly like the user clicking its row) and
 * then checks the disk.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
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
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method) frames.push(message);
});

const request = (method, params) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 20_000);
  });
};

await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
});

const cwd = process.cwd();
const created = await request("session/new", { cwd, mcpServers: [] });
const sessionId = created.sessionId;
await request("_alnair/session/rename", { sessionId, title: "DELETE-ACTIVE-PROBE", cwd });

const dir = join(homedir(), ".alnair", "sessions", encodeURIComponent(cwd), sessionId);
console.log("created:", sessionId, "| dir exists:", existsSync(dir));

// Load it: this is what "clicking the row" does in the browser.
const loaded = await request("session/load", { sessionId, cwd, mcpServers: [] });
console.log("load ok:", Boolean(loaded));

const rosterBefore = await request("_alnair/sessions/list", {});
const row = (rosterBefore?.result?.sessions ?? []).find((r) => r.sessionId === sessionId);
console.log("roster row:", row ? { cwd: row.cwd, resident: row.resident, activity: row.activity } : null);

// A prompt would make it a live actor; that is the state a user deletes from.
const prompted = await request("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: "say hi" }],
}).catch((error) => ({ error: String(error) }));
console.log("prompt:", JSON.stringify(prompted).slice(0, 160));

await new Promise((r) => setTimeout(r, 4000));

const rosterMid = await request("_alnair/sessions/list", {});
const midRow = (rosterMid?.result?.sessions ?? []).find((r) => r.sessionId === sessionId);
console.log("mid row:", midRow ? { resident: midRow.resident, activity: midRow.activity } : null);

const deleted = await request("_alnair/session/delete", { sessionId, cwd }).catch((error) => ({
  error: String(error),
}));
console.log("delete:", JSON.stringify(deleted));
console.log("dir exists after delete:", existsSync(dir));

const rosterAfter = await request("_alnair/sessions/list", {});
const still = (rosterAfter?.result?.sessions ?? []).some((r) => r.sessionId === sessionId);
console.log("still in roster:", still);

socket.close();
process.exit(0);
