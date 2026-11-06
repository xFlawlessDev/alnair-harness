/**
 * The sidebar's workspace actions, end to end.
 *
 *   node scripts/web-workspace-probe.mjs http://127.0.0.1:2499
 *
 * Checks the three things the sidebar now promises: the header `+` reaches the
 * native picker endpoint, "Remove workspace" hides a group without touching its
 * sessions, and the session delete goes through a dialog instead of an armed
 * menu item (which could never be completed — the dropdown closes on the first
 * click).
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

const profile = mkdtempSync(join(tmpdir(), "alnair-ws-probe-"));
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
const requests = [];
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
  if (message.method === "Network.requestWillBeSent") {
    const url = message.params.request.url;
    if (url.includes("/api/pick-directory")) {
      requests.push(`${message.params.request.method} ${url}`);
    }
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
await send("Page.navigate", { url: await pairingLink(base) }, cdp);

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

const groupNames = `[...document.querySelectorAll('[aria-label^="Workspace actions"]')]
  .map((button) => button.getAttribute('aria-label'))`;

console.log(
  "workspaces before:",
  await evaluate(`JSON.stringify(${groupNames})`),
);

// 1. The header `+` must reach the picker endpoint.
console.log(
  "clicked add:",
  await evaluate(`(async () => {
    const button = document.querySelector('[aria-label="Add workspace directory"]');
    if (!button) return 'no button';
    button.click();
    await new Promise((r) => setTimeout(r, 2500));
    return 'clicked';
  })()`),
);
console.log("picker requests:", requests);
console.log(
  "add button state:",
  await evaluate(`(() => {
    const button = document.querySelector('[aria-label="Add workspace directory"]');
    return button ? button.disabled : 'missing';
  })()`),
);

// 2. "Remove workspace" hides the group without touching sessions.
const firstGroup = await evaluate(`${groupNames}[0]`);
const groupName = firstGroup?.replace("Workspace actions: ", "");
console.log("removing group:", groupName);

console.log(
  "removed:",
  await evaluate(`(async () => {
    const button = [...document.querySelectorAll('[aria-label^="Workspace actions"]')]
      .find((candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(firstGroup)});
    if (!button) return 'no button';
    button.click();
    await new Promise((r) => setTimeout(r, 300));
    const item = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
      .find((candidate) => /Remove workspace/i.test(candidate.innerText));
    if (!item) return 'no item';
    item.click();
    await new Promise((r) => setTimeout(r, 500));
    return 'clicked';
  })()`),
);
console.log(
  "workspaces after:",
  await evaluate(`JSON.stringify(${groupNames})`),
);
console.log(
  "hidden chip:",
  await evaluate(`(() => {
    const chip = document.querySelector('[aria-label^="Hidden workspaces"]');
    return chip ? chip.getAttribute('aria-label') : null;
  })()`),
);

// 3. Restore it.
console.log(
  "restored:",
  await evaluate(`(async () => {
    const chip = document.querySelector('[aria-label^="Hidden workspaces"]');
    if (!chip) return 'no chip';
    chip.click();
    await new Promise((r) => setTimeout(r, 300));
    const item = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
      .find((candidate) => /restore/i.test(candidate.innerText));
    if (!item) return 'no restore item';
    item.click();
    await new Promise((r) => setTimeout(r, 400));
    return 'clicked';
  })()`),
);
console.log(
  "workspaces restored:",
  await evaluate(`JSON.stringify(${groupNames})`),
);

// 4. Delete goes through a dialog, not an armed menu item.
console.log(
  "opened delete dialog:",
  await evaluate(`(async () => {
    const row = document.querySelector('[data-session-id]');
    if (!row) return 'no row';
    row.parentElement.querySelector('button[aria-label^="Session actions"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const item = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
      .find((candidate) => /Delete session/i.test(candidate.innerText));
    if (!item) return 'no item';
    item.click();
    await new Promise((r) => setTimeout(r, 500));
    return document.body.innerText.includes('Delete this session?') ? 'dialog open' : 'no dialog';
  })()`),
);
console.log(
  "dialog buttons:",
  await evaluate(`[...document.querySelectorAll('[data-slot="dialog-content"] button')]
    .map((button) => button.innerText.trim()).join(' | ')`),
);

// Close it without deleting: the probe must not destroy a real transcript.
await evaluate(`(async () => {
  const cancel = [...document.querySelectorAll('[data-slot="dialog-content"] button')]
    .find((button) => /^Cancel$/.test(button.innerText.trim()));
  if (cancel) cancel.click();
  await new Promise((r) => setTimeout(r, 300));
  return true;
})()`);

const shot = await send("Page.captureScreenshot", { format: "png" }, cdp);
const { writeFileSync } = await import("node:fs");
writeFileSync("target/web-workspace.png", Buffer.from(shot.data, "base64"));
console.log("screenshot: target/web-workspace.png");
console.log("page errors:", pageErrors);

socket.close();
process.exit(0);
