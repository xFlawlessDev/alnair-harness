# The web UI

`alnair web` serves a browser client for the **shared leader**, so the TUI and
the browser render the same session state: an agent turn streaming in the
terminal streams in the browser too, and a permission card parked in one can be
answered from the other.

```sh
npm --prefix web run build     # once, or after changing web/
alnair web                     # http://127.0.0.1:2420/
alnair web --bind 127.0.0.1:0 --open
```

| Flag | Default | Meaning |
|---|---|---|
| `--bind` | `127.0.0.1:2420` | Listen address. `:0` picks a free port and prints it. |
| `--pid` | none | Target a specific leader (same idea as `alnair leader info --pid`). |
| `--socket` | none | Target an explicit leader socket path. |
| `--open` | off | Open the default browser once listening. |

## Architecture

```
        ┌──────────────── Leader (auto-spawned, --no-exit-on-disconnect)
        │   session_subscribers · session_driver · interaction_requests
        └───────▲──────────────────────────▲
                │ IPC (UDS / named pipe)   │ IPC
                │                          │
             TUI (ClientId 1)        alnair web (ClientId 2..N)
                                          ▲
                                          │ HTTP: static UI
                                          │ WS:   one JSON-RPC per text frame
                                       Browser
```

Each WebSocket gets **its own `LeaderClient`**, so the leader does all the
synchronisation work:

- a live turn's deltas are broadcast to every subscriber (`session_subscribers`),
  which is why the browser sees the same stream as the TUI;
- exactly one client per session is the *driver* — reverse requests that must
  not be duplicated (`fs/read`, scheduled-task injections) go there only;
- `session/load` replay is buffered against live frames and deduped by
  `eventId`, so attaching mid-turn yields each chunk once;
- parked permission/question/plan requests are cached and replayed to a client
  that attaches later, and the first answer wins across surfaces.

The bridge in `crates/codegen/alnair-web` is therefore a byte pump. It parses
nothing except `alnair/leader_reconnected`.

### Why not `alnair agent serve`

`agent::server` creates its own `MvpAgent` (separate state) and keeps a single
`relay_dest` that each new connection overwrites, so only the newest client
receives live deltas. It is a standalone agent, not a view of the leader.

## Serving

The SvelteKit build is embedded in the binary with `rust-embed`, so Alnair
stays a single file. Debug builds read `web/build/` from disk, which means
`npm run build` is picked up without a Rust rebuild.

| Path | Behaviour |
|---|---|
| `GET /ws` | WebSocket upgrade (cookie + `Origin` required) |
| `GET /api/session` | Sets the auth cookie; returns version, leader target, `webBuilt` |
| `GET /healthz` | `ok`, no auth — for scripts |
| `GET /*` | Embedded asset; miss **with** an extension → 404; miss **without** → `index.html` |

`index.html` is `no-cache`; everything under `_app/immutable/` is
`max-age=31536000, immutable`.

### Auth

`GET /` and `/api/session` set `alnair_web=<random>` with
`HttpOnly; SameSite=Strict`. `/ws` requires **both** that cookie and an `Origin`
matching the bound address.

The `Origin` check is not redundant: a WebSocket upgrade is not subject to CORS
preflight, so without it any page open in the same browser could connect to
`127.0.0.1` and drive the agent (DNS rebinding included). `SameSite=Strict`
covers the cookie half of the same attack.

Restarting `alnair web` rotates the token, so a stale tab gets 403 until it is
reloaded. That fails closed on purpose.

## Development

**Embedded** (no Vite): `npm --prefix web run build`, then `cargo run -- web`.
Debug builds read from disk, so re-running the build is enough.

**HMR**: run `npm --prefix web run dev` (`:5173`) and proxy to the server:

```ts
// web/vite.config.ts
server: {
  proxy: {
    '/api': 'http://127.0.0.1:2420',
    '/ws': { target: 'ws://127.0.0.1:2420', ws: true }
  }
}
```

The dev origin is accepted by the `Origin` check **only** in debug builds.

### Fixtures

`?fixtures=1` swaps the socket transport for the scripted transcripts in
`web/src/lib/harness/fixtures.ts`. Those cover states the live agent rarely
produces on demand (a parked questionnaire, an exhausted retry).

## Client-side rules worth knowing

- **Extension methods go out wrapped.** `alnair/*` calls must be sent as
  `_alnair/<name>` with `{ method: "alnair/<name>", params: {…} }` as the
  request params. A plain `alnair/<name>` request is answered
  **"Method not found"** by a live leader — verified, not inferred. ACP methods
  (`initialize`, `session/load`, `session/prompt`) are sent normally.
- **Field spelling differs by surface.** The roster (`alnair/sessions/list`)
  and `alnair/session/info` come back **camelCase** (`sessionId`,
  `lastChangeUnixMs`, `usagePct`, `usageCategories`), while Alnair's extension
  *updates* on the stream are snake_case. `wire.ts` accepts both spellings
  rather than betting on one.
- **`reasoningEfforts` is a list of objects**, not strings:
  `[{ id, value, label, description, default }]`. The accepted set comes from
  `reasoningEfforts`; `reasoningEffort` is the current selection and must not be
  read as the set.
- **`activity: "dormant"`** is a session read from disk with no resident actor.
  Only `working` means a turn is running.
- **Reconnect dedup.** The leader dedups only *within* one `session/load`. Across
  loads the client must drop frames at or below its `eventId` watermark, or a
  reconnect doubles the transcript. `web/src/lib/harness/dedup.ts` implements the
  rule and `session-store.svelte.ts` applies it; unsequenced notifications always
  apply.
- **Replay resets.** `session/load` starts a replay window that clears the
  accumulator, because the replay is authoritative.
- **Attaching is subscribing.** `selectSession` must send `session/load`; a
  client that only changes its local index never receives that session's stream.
- **No client-side terminal or FS.** The browser advertises
  `terminal: false, fs: {readTextFile: false, writeTextFile: false}` so the agent
  uses its own. Claiming them routes tool calls to a client that cannot serve
  them, and the call hangs.

## Not provided, by design

| Item | Why |
|---|---|
| "The TUI is viewing session X" | Not on the wire. `alnair/sessions/changed` carries `activity`, not presence; `alnair/session/view` is a read watermark for unread badges. |
| Settings sync | `alnair/settings/update` is deliberately not broadcast (it carries auth/gate state) and is a notification, not a request/response RPC. The web dialog keeps its own registry. |
| A live terminal pane | `pty/notification` carries `terminalId`, not `sessionId`, so routing falls back to `last_active_client`; one PTY is owned by one client. Terminal tool output renders as text. |

If the TUI drives a turn and the browser sends a prompt to the same session, the
session actor serialises them FIFO (`pending_inputs`): the browser's prompt is
queued behind the running turn rather than rejected.

## Release builds

The web build must happen **before** the cargo build, or the binary embeds the
placeholder page:

```sh
npm --prefix web ci
npm --prefix web run build
```

`web/build/` is gitignored. `alnair-web/build.rs` writes a placeholder shell when
the folder is missing so `cargo check --workspace --all-targets` works on a
machine with no Node; the server reports it at startup and on `/api/session`.
