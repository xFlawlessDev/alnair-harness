/**
 * Why does "Delete session" not delete anything?
 *
 *   node scripts/web-delete-probe.mjs http://127.0.0.1:2499
 *
 * Drives the real page over CDP, records every WebSocket frame the page SENDS,
 * and clicks the sidebar's delete item twice. The answer is in those frames:
 * if `_alnair/session/delete` never appears, the click never reached the store.
 *
 * It creates a throwaway session first, so the only row it can destroy is one
 * it just made.
 */

import { spawn } from "node:child_process";
import { pairedCookie } from "./web-auth.mjs";
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

// A throwaway session, created through the same socket the UI uses.
const cookie = await pairedCookie(base);

async function withSocket(run) {
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
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined || message.method !== undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
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
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  });
  try {
    return await run(request);
  } finally {
    socket.close();
  }
}

const victim = await withSocket(async (request) => {
  const created = await request("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  });
  const sessionId = created.sessionId;
  await request("_alnair/session/rename", {
    sessionId,
    title: "DELETE-PROBE",
    cwd: process.cwd(),
  });
  console.log("throwaway session:", sessionId);
  return sessionId;
});

const profile = mkdtempSync(join(tmpdir(), "alnair-delete-probe-"));
const port = 9334;
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
    /* already gone */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Windows holds it briefly */
  }
});

async function devtoolsUrl() {
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* not listening yet */
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
const sentFrames = [];
const pageErrors = [];

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === "Network.webSocketFrameSent") {
    sentFrames.push(message.params.response.payloadData);
  }
  if (message.method === "Runtime.exceptionThrown") {
    pageErrors.push(
      message.params.exceptionDetails.exception?.description ??
        message.params.exceptionDetails.text,
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

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: cdp } = await send("Target.attachToTarget", {
  targetId,
  flatten: true,
});
await send("Runtime.enable", {}, cdp);
await send("Network.enable", {}, cdp);
await send("Page.enable", {}, cdp);
const cookieSeparator = cookie.indexOf("=");
await send("Network.setCookie", {
  name: cookie.slice(0, cookieSeparator),
  value: cookie.slice(cookieSeparator + 1),
  url: base,
  httpOnly: true,
  secure: new URL(base).protocol === "https:",
  sameSite: "Lax",
}, cdp);
await send("Page.navigate", { url: `${base}/` }, cdp);

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
    if (await evaluate(expression)) return true;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

await waitFor(
  `!!document.querySelector('[data-session-id]')`,
  "the sidebar roster",
);

// The throwaway row may be below the fold; bring it into view first.
console.log(
  "victim row present:",
  await evaluate(`!!document.querySelector('[data-session-id="${victim}"]')`),
);

const rowTitle = await evaluate(`(() => {
  const row = document.querySelector('[data-session-id="${victim}"]');
  return row ? row.innerText.split('\\n')[0] : null;
})()`);
console.log("victim row title:", rowTitle);

/** Open the row's action menu and list its items. */
const openMenu = `(async () => {
  const row = document.querySelector('[data-session-id="${victim}"]');
  if (!row) return 'no row';
  const button = row.parentElement.querySelector('button[aria-label^="Session actions"]');
  if (!button) return 'no action button';
  button.click();
  await new Promise((r) => setTimeout(r, 350));
  return [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
    .map((item) => item.innerText.trim())
    .join(' | ');
})()`;

console.log("menu items:", await evaluate(openMenu));

const clickDelete = `(async () => {
  const item = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
    .find((candidate) => /Delete/i.test(candidate.innerText));
  if (!item) return 'no delete item';
  item.click();
  await new Promise((r) => setTimeout(r, 400));
  return 'clicked';
})()`;

console.log("first click:", await evaluate(clickDelete));
console.log("menu after first click:", await evaluate(openMenu));
console.log("second click:", await evaluate(clickDelete));

await new Promise((r) => setTimeout(r, 1200));

// The page reports a refused action in a banner above the thread; without it
// the failure is invisible (the row is dropped optimistically either way).
console.log(
  "banner:",
  await evaluate(`(() => {
    const text = document.body.innerText;
    const match = text.match(/Delete failed[^\\n]*/);
    return match ? match[0] : null;
  })()`),
);

const deleteFrames = sentFrames.filter((frame) =>
  frame.includes("session/delete"),
);
console.log("frames sent:", sentFrames.length);
console.log(
  "delete frames:",
  deleteFrames.length,
  deleteFrames.map((frame) => frame.slice(0, 220)),
);
console.log(
  "row still present:",
  await evaluate(`!!document.querySelector('[data-session-id="${victim}"]')`),
);

// The user's complaint is "delete does not work" — which is what a row that
// comes BACK looks like. Reload and look again: a silent no-op (the agent
// reporting success without finding the transcript) only shows up here.
await send("Page.navigate", { url: `${base}/` }, cdp);
await waitFor(
  `!!document.querySelector('[data-session-id]')`,
  "the roster after reload",
);
await new Promise((r) => setTimeout(r, 1500));
console.log(
  "row present after reload:",
  await evaluate(`!!document.querySelector('[data-session-id="${victim}"]')`),
);
console.log("page errors:", pageErrors);

socket.close();
process.exit(0);
