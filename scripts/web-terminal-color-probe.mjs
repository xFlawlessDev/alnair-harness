/**
 * Does the terminal panel render a real command's colour?
 *
 *   node scripts/web-terminal-color-probe.mjs http://127.0.0.1:2499 <sessionId>
 *
 * Opens the page, finds an execute row, expands it, and reports whether the
 * output carries styled spans. A capture with ANSI escapes must produce more
 * than one colour; plain output must still render as text.
 */

import { spawn } from "node:child_process";
import { pairingLink } from "./web-auth.mjs";
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

const profile = mkdtempSync(join(tmpdir(), "alnair-color-probe-"));
const port = 9336;
const browser = spawn(
  browserPath,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,1200",
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
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? "evaluate failed",
    );
  }
  return result.result?.value;
};

async function waitFor(expression, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await evaluate(expression)) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

await waitFor(`!!document.querySelector('[data-session-id]')`, "the roster");

if (wanted) {
  await evaluate(`(async () => {
    const row = document.querySelector('[data-session-id="${wanted}"]');
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 400));
    return true;
  })()`);
}

// Give the replay time to fold; a long transcript arrives in bursts.
await new Promise((r) => setTimeout(r, 4000));

// Open every collapsed trace row so the panels exist.
await evaluate(`(async () => {
  const triggers = [...document.querySelectorAll('[data-slot="collapsible-trigger"]')];
  for (const trigger of triggers) trigger.click();
  await new Promise((r) => setTimeout(r, 600));
  return triggers.length;
})()`);

const report = await evaluate(`(() => {
  const panels = [...document.querySelectorAll('[data-slot="terminal-panel"]')];
  return JSON.stringify({
    panels: panels.length,
    details: panels.slice(0, 6).map((panel) => {
      const body = panel.querySelector('[data-slot="terminal-body"]');
      const styled = [...(body?.querySelectorAll('[style*="--shiki"]') ?? [])];
      const colors = [...new Set(styled.map((node) => getComputedStyle(node).color))];
      return {
        text: (body?.innerText ?? '').slice(0, 120),
        styledSpans: styled.length,
        colors: colors.slice(0, 5),
        lines: body?.querySelectorAll('[data-slot="code-block-line"]').length ?? 0,
      };
    }),
  });
})()`);

console.log(report);

const shot = await send("Page.captureScreenshot", { format: "png" }, cdp);
writeFileSync(
  "target/web-terminal-color.png",
  Buffer.from(shot.data, "base64"),
);
console.log("screenshot: target/web-terminal-color.png");
console.log("page errors:", pageErrors);

socket.close();
process.exit(0);
