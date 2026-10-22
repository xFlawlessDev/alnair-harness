/**
 * Does a parked `ask_user_question` reach the browser?
 *
 *   node scripts/web-ask-probe.mjs http://127.0.0.1:2499
 *
 * Injects the EXACT wire form the agent sends — a gateway-WRAPPED reverse
 * request — and checks that the question panel appears above the composer. The
 * wrapped shape is the whole bug: reading `params.sessionId` off the wrapper
 * finds nothing, the frame is dropped, and the agent waits forever.
 *
 * The request is synthetic on purpose. Driving a real model into asking a
 * question needs a live turn and a cooperative prompt; the transport's handling
 * of the frame is what is under test, and that is deterministic.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const profile = mkdtempSync(join(tmpdir(), "alnair-ask-probe-"));
const port = 9338;
const browser = spawn(
  browserPath,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,1000",
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

// Record every WebSocket the page opens, BEFORE the app runs. The transport
// does not expose its socket (it should not), so the probe supplies its own
// hook rather than the product carrying a test-only global.
await send(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
      window.__alnairSockets = [];
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          window.__alnairSockets.push(this);
        }
      };
    `,
  },
  cdp,
);

await send("Page.navigate", { url: `${base}/` }, cdp);

const evaluate = async (expression) => {
  const result = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    cdp,
  );
  return result.result?.value;
};

async function waitFor(expression, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await evaluate(expression)) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

await waitFor(`!!document.querySelector('[data-session-id]')`, "the roster");

// Feed the wrapped frame through the page's OWN WebSocket, so the transport's
// normalizer runs exactly as it would for a live agent.
console.log(
  "injected:",
  await evaluate(`(async () => {
    const sockets = window.__alnairSockets ?? [];
    const socket = sockets.find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) return 'no open socket (' + sockets.length + ' seen)';
    const sessionId = document.querySelector('[data-session-id]').getAttribute('data-session-id');
    socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 9001,
        method: '_alnair/ask_user_question',
        params: {
          method: 'alnair/ask_user_question',
          params: {
            sessionId,
            toolCallId: 'tc-probe-ask',
            mode: 'default',
            questions: [{
              question: 'This is a test of the ask tool - which option would you like to pick?',
              multiSelect: false,
              options: [
                { label: 'Option A', description: 'the first one' },
                { label: 'Option B', description: 'the second one' }
              ]
            }]
          }
        }
      }),
    }));
    await new Promise((r) => setTimeout(r, 800));
    return 'dispatched';
  })()`),
);

await new Promise((r) => setTimeout(r, 800));

console.log(
  "question panel:",
  await evaluate(`(() => {
    const panel = document.body.innerText.includes('The agent is asking a question');
    const choices = [...document.querySelectorAll('button')]
      .filter((button) => /Option A|Option B/.test(button.innerText))
      .map((button) => button.innerText.split('\\n')[0]);
    return JSON.stringify({
      panel,
      choices,
      accept: Boolean([...document.querySelectorAll('button')].find((b) => /Accept/.test(b.innerText))),
      answerHint: document.body.innerText.includes('Answer above the composer')
    });
  })()`),
);

const shot = await send("Page.captureScreenshot", { format: "png" }, cdp);
writeFileSync("target/web-ask.png", Buffer.from(shot.data, "base64"));
console.log("screenshot: target/web-ask.png");
console.log("page errors:", pageErrors);

socket.close();
process.exit(0);
