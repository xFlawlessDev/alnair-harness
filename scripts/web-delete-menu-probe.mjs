/**
 * Does the session action menu stay open after "Delete session…"?
 *
 *   node scripts/web-delete-menu-probe.mjs http://127.0.0.1:2499
 *
 * The delete item is a two-click confirmation. If the dropdown closes on the
 * FIRST click, the second one cannot land — which is exactly what "delete
 * tidak bekerja" looks like: the row stays, and a reload brings it back.
 */

import { spawn } from "node:child_process";
import { pairingLink } from "./web-auth.mjs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:2499";
const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const browserPath = CANDIDATES.find((candidate) => existsSync(candidate));
if (!browserPath) {
  console.error("no Chrome or Edge found");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "alnair-menu-probe-"));
const port = 9335;
const browser = spawn(
  browserPath,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);
process.on("exit", () => {
  try {
    browser.kill();
  } catch {
    /* gone */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* held briefly */
  }
});

async function devtoolsUrl() {
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error("browser never opened its debugging port");
    await new Promise((r) => setTimeout(r, 150));
  }
}

const socket = new WebSocket(await devtoolsUrl());
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener(
    "error",
    () => reject(new Error("CDP socket failed")),
    { once: true },
  );
});
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
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

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: cdp } = await send("Target.attachToTarget", {
  targetId,
  flatten: true,
});
await send("Runtime.enable", {}, cdp);
await send("Page.enable", {}, cdp);
await send("Page.navigate", { url: await pairingLink(base) }, cdp);

const evaluate = async (expression) => {
  const result = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    cdp,
  );
  return result.result?.value;
};
async function waitFor(expression, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await evaluate(expression)) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
await waitFor(`!!document.querySelector('[data-session-id]')`, "the roster");

const state = `(() => {
  const items = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')];
  const row = document.querySelector('[data-session-id]');
  const button = row?.parentElement.querySelector('button[aria-label^="Session actions"]');
  return JSON.stringify({
    menuOpen: items.length > 0,
    items: items.map((item) => item.innerText.trim()),
    armed: items.some((item) => /Click again/i.test(item.innerText)),
    actionButton: Boolean(button),
  });
})()`;

console.log("before open:", await evaluate(state));
console.log(
  "opened:",
  await evaluate(`(async () => {
    const row = document.querySelector('[data-session-id]');
    row.parentElement.querySelector('button[aria-label^="Session actions"]').click();
    await new Promise((r) => setTimeout(r, 300));
    return 'ok';
  })()`),
);
console.log("menu open:", await evaluate(state));

console.log(
  "first delete click:",
  await evaluate(`(async () => {
    const item = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
      .find((candidate) => /Delete/i.test(candidate.innerText));
    if (!item) return 'no item';
    item.click();
    await new Promise((r) => setTimeout(r, 500));
    return 'clicked';
  })()`),
);
console.log("after first click:", await evaluate(state));

socket.close();
process.exit(0);
