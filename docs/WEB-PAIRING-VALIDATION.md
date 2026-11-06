# Web pairing validation

Validated 2026-11-06 on Windows with Rust 1.97.0. No provider inference calls, public
tunnel, OS service installation, or changes to the user's running leader were
needed for these checks.

| Check | Result |
|---|---|
| `cargo check --workspace --all-targets` | PASS |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS |
| `cargo fmt --all --check` | PASS |
| `cargo test -p alnair-web --lib --test http` | PASS: 29 unit tests, 10 HTTP tests |
| `cargo test -p alnair-bin --test web_service` | PASS: detached executable lifecycle |
| `npm run check` in `web/` | PASS: no errors or warnings |
| `npm run lint` in `web/` | PASS |
| `npm test` in `web/` | PASS: 503 passed, 1 skipped |
| `node --check` for web probe scripts | PASS |
| `git diff --check` | PASS |
| `cargo deny check advisories` | FAIL: existing `pin-utils` 0.1.0, RUSTSEC-2026-0441 |

The advisory marks `pin-utils` unmaintained. It already exists in the baseline
dependency graph; this change adds no advisory ignore or unrelated dependency
migration.

The executable test runs in a `tempfile::TempDir` Alnair home and covers
idempotent start, authenticated discovery, single-use pairing, cookie reuse
after restart on the same port, revocation, stop/registration cleanup, automatic
start through `pair`, HTTPS public-origin QR output, and rejection of an
unconfigured pairing origin. Captured CLI output has a deadline, so inherited
Windows pipes cannot hang the test indefinitely.

Auth and HTTP tests exercise Host/Origin enforcement, cookie flags, unauthenticated
entry, concurrent code consumption, expiry/replay refusal, unknown API routes,
and separation of browser sessions from service administration. Windows process
creation restricts inherited handles to NUL and the log file; Unix uses
`setsid`.

A physical LAN device, a deployed TLS reverse proxy, and Linux/macOS process
lifecycle were not exercised. Proxy tests simulate the preserved Host/Origin
headers and cookie policy. Existing UI controls were not changed or subjected
to a new browser click-through.

## Anti Slop delivery scope

During mode was applied to the changed CLI messages and documentation. No
Svelte components, CSS, visual assets, or browser controls were added.

- Hard gate: PASS for changed copy; commands and durations match the tested
  behavior, with no invented adoption, performance, or compliance claims.
- Purpose gate: PASS within scope; no decorative techniques were introduced.
- Liveliness: not applicable; no visual design was generated, so design dials
  and visual composition checks do not apply to this backend change.
- Craftsmanship: PASS within scope; the lifecycle and refusal paths above
  were exercised. Layout, contrast, keyboard, and animation checks are outside
  this change's scope.
