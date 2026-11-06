# OpenCode pairing and embedded UI recheck

Checked 2026-11-06 against primary source files on `anomalyco/opencode`'s
`dev` branch. These are moving references, not a pinned release comparison.

`pair` does not run a second frontend server. It ensures the background
service exists, calls its authenticated pairing API, and prints login links.
The listener serves both API traffic and its own UI. See the
[pair handler](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/commands/handlers/pair.ts)
and [server process](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/server-process.ts).

The production build compiles `packages/app` with
`VITE_OPENCODE_SERVER_MODE=origin`. It gathers the app's distribution files,
omits source maps, compresses each entry with Brotli, and embeds an archive
into the executable. There is no production Vite process or runtime CDN
download on this path. See
[archive construction](https://github.com/anomalyco/opencode/blob/dev/packages/cli/script/app-assets.ts)
and [binary build](https://github.com/anomalyco/opencode/blob/dev/packages/cli/script/build.ts).

The [asset loader](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/app-assets.ts)
reads the archive and lazily decompresses entries. Local development can read
the app's `dist` directory instead. Missing release assets fail startup.

The [web UI handler](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/services/web-ui.ts)
serves the shell before API authentication so signed-out browsers can see the
app's login screen. `/api`, `/auth`, and `/openapi.json` go to the API;
unknown API routes remain 404. UI paths fall back to `index.html`, except
missing asset/icon paths. HTML and service worker entry points revalidate;
other assets are immutable. Non-HTML assets can use the embedded Brotli
bytes directly. The handler supports HEAD and applies CSP and nosniff headers.

The [pairing cache](https://github.com/anomalyco/opencode/blob/dev/packages/server/src/pairing.ts)
still uses 16 random bytes, a five-minute TTL, a capacity of 1000, and atomic
consumption. The [connect handler](https://github.com/anomalyco/opencode/blob/dev/packages/server/src/handlers/server.ts)
redirects HTML clients with a session cookie and returns a token to API
clients. The [authorization middleware](https://github.com/anomalyco/opencode/blob/dev/packages/server/src/middleware/authorization.ts)
exempts that connect route because the pairing code is its credential.

One correction to the earlier research: the current CLI's QR contains JSON
`{ code, urls }`, not just a URL. It filters loopback addresses out of the QR;
the ordinary printed links remain `/auth/connect/<code>` URLs. This format
serves the OpenCode companion app. A browser-oriented Alnair QR can carry
the full URL directly.

The [service client](https://github.com/anomalyco/opencode/blob/dev/packages/client/src/effect/service.ts)
discovers a private registration file, probes the endpoint, checks version
compatibility, and starts a contender when necessary. Its registration is
separate from CLI-owned service configuration. This distinguishes service
lifecycle from pairing: requesting another code does not need a new server.

Alnair keeps its existing rust-embed SPA and one leader connection per
WebSocket. It adds detached service management and pairing, with exact
Host/Origin checks and a separate local control credential. It does not copy
OpenCode's query-string credentials, app-specific QR payload, automatic tunnel,
or UI hosting policy. Its initial unpaired response is HTTP 401 with the
command to obtain a pairing link; it does not add a password sign-in screen.

Tunnel implementation, form-location middleware, and a comprehensive
repository-wide rate-limit audit remain outside this recheck's scope.
