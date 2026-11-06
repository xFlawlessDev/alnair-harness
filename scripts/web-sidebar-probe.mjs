/**
 * Dump the sidebar's DOM so a selector can be checked against what is really
 * rendered, rather than against what the component was expected to render.
 *
 *   node scripts/web-sidebar-probe.mjs http://127.0.0.1:2499
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

const profile = mkdtempSync(join(tmpdir(), "alnair-sidebar-probe-"));
const port = 9337;

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
    // Already gone.
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Windows holds the profile briefly.
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
const { sessionId } = await send("Target.attachToTarget", {
  targetId,
  flatten: true,
});
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);

async function evaluate(expression) {
  const result = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

const loaded = new Promise((resolve) => {
  const listener = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Page.loadEventFired") {
      socket.removeEventListener("message", listener);
      resolve();
    }
  };
  socket.addEventListener("message", listener);
});
await send("Page.navigate", { url: await pairingLink(base) }, sessionId);
await loaded;

// Wait for the sidebar to paint.
for (let i = 0; i < 200; i += 1) {
  const count = await evaluate(
    `document.querySelectorAll('[data-session-id]').length`,
  );
  if (count > 0) break;
  await new Promise((r) => setTimeout(r, 200));
}

const report = await evaluate(`
	(() => {
		const aside = document.querySelector('aside');
		if (!aside) return { error: 'no aside' };
		const buttons = [...aside.querySelectorAll('button')];
		return {
			asideText: aside.innerText.slice(0, 300),
			buttonCount: buttons.length,
			labels: buttons.map((b) => b.getAttribute('aria-label')).filter(Boolean).slice(0, 30),
			rowHtml: (() => {
				const row = document.querySelector('[data-session-id]');
				return row ? row.parentElement?.outerHTML.slice(0, 1200) : null;
			})()
		};
	})()
`);

console.log(JSON.stringify(report, null, 2));
socket.close();
process.exit(0);
