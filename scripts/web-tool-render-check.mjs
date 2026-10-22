/**
 * Render a session's real transcript in the browser and report how each tool
 * call was drawn.
 *
 *   node scripts/web-tool-render-check.mjs http://127.0.0.1:2499 <sessionId>
 *
 * Why a separate script: the unit tests prove the REDUCER projects the right
 * part kind, but only the browser proves the component draws it. Two bugs —
 * `ask_user_question` and `spawn_subagent` rendering as "other Tool: …" — were
 * invisible to every type check and every reducer test, and obvious the moment
 * a real transcript was painted.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:2499";
const wanted = process.argv[3];

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

const profile = mkdtempSync(join(tmpdir(), "alnair-tool-render-"));
const port = 9339;

const browser = spawn(
  browserPath,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,1400",
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
      result.exceptionDetails.exception?.message ??
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

async function waitFor(label, expression, timeoutMs = 60_000) {
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
      throw new Error(
        `timed out waiting for ${label} (last: ${JSON.stringify(last)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
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
await send("Page.navigate", { url: base }, sessionId);
await loaded;

await waitFor(
  "the roster",
  `document.querySelectorAll('[data-session-id]').length > 0`,
  60_000,
);

// Switch to the requested session when one was named, else keep the first.
if (wanted) {
  await evaluate(`
		(() => {
			const row = document.querySelector('[data-session-id="${wanted}"]');
			if (row) row.click();
			return Boolean(row);
		})()
	`);
}

await new Promise((r) => setTimeout(r, 8_000));

const report = await evaluate(`
	(() => {
		const scroller = document.querySelector('[data-slot="message-scroller-content"]') ?? document.body;
		const rows = [...scroller.querySelectorAll('[data-slot="trace-line"]')];
		const textOf = (node) => (node.textContent || '').replace(/\\s+/g, ' ').trim();
		return {
			active: document
				.querySelector('[data-session-id][aria-current="true"]')
				?.getAttribute('data-session-id') ?? null,
			traceLines: rows.map((row) => ({
				status: row.getAttribute('data-status'),
				text: textOf(row).slice(0, 140)
			})),
			terminalPanels: scroller.querySelectorAll('[data-slot="terminal-panel"]').length,
			// The panel's own text, so the render can be read rather than
			// guessed at from a screenshot: it must contain the shell prompt,
			// the command, and the exit line.
			terminalSample: [...scroller.querySelectorAll('[data-slot="terminal-panel"]')]
				.slice(0, 2)
				.map((panel) => (panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300)),
			questions: [...scroller.querySelectorAll('*')].filter((node) =>
				/^(Question|Question answered|\\d+ questions)/.test(textOf(node))
			).length,
			subagentCards: [...scroller.querySelectorAll('*')].filter((node) =>
				/^Subagent /.test(textOf(node))
			).length,
			rawOther: rows.filter((row) => /^other /.test(textOf(row))).map(textOf).slice(0, 5),
			bodyChars: scroller.innerText?.length ?? 0
		};
	})()
`);

console.log(JSON.stringify({ ...report, pageErrors }, null, 2));

// Scroll a rendered terminal panel into view before the shot, so the
// screenshot shows the row this script exists to verify rather than whatever
// happens to be at the top of the transcript.
await evaluate(`
	(() => {
		const first = document.querySelector('[data-slot="terminal-panel"]');
		if (first) first.scrollIntoView({ block: 'center' });
		return Boolean(first);
	})()
`);
await new Promise((r) => setTimeout(r, 800));

const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
writeFileSync("target/web-tools.png", Buffer.from(shot.data, "base64"));
console.log("screenshot: target/web-tools.png");

socket.close();
process.exit(0);
