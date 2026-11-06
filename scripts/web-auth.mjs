import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Each probe gets a fresh link; remote servers can supply one through the environment. */
export async function pairingLink(base) {
  const origin = new URL(base).origin;
  let link = process.env.ALNAIR_WEB_PAIR_URL;
  if (!link) {
    const local = fileURLToPath(
      new URL(`../target/debug/alnair${process.platform === "win32" ? ".exe" : ""}`, import.meta.url),
    );
    const executable = process.env.ALNAIR_WEB_BINARY ?? (existsSync(local) ? local : "alnair");
    const { stdout } = await promisify(execFile)(executable, ["web", "pair", "--url", origin]);
    link = stdout.split(/\r?\n/).find((line) => /^https?:\/\/.*\/auth\/connect\//.test(line));
  }
  if (!link || new URL(link).origin !== origin) {
    throw new Error("Pairing link must match the probe origin; set ALNAIR_WEB_PAIR_URL to a fresh link from that server.");
  }
  return link;
}

export async function pairedCookie(base) {
  const response = await fetch(await pairingLink(base), {
    redirect: "manual",
    headers: { Accept: "text/html" },
  });
  const cookie = response.headers.getSetCookie()
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith("alnair_session_"));
  if (response.status !== 303 || !cookie) {
    throw new Error("Pairing failed; the link may have expired or already been used.");
  }
  return cookie;
}
