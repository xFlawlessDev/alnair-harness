//! HTTP + WebSocket integration tests for the `alnair web` server.
//!
//! These drive the real router over a real socket: the asset rules, the auth
//! gate, and the upgrade handshake. They deliberately do not start a leader —
//! the bridge's per-connection attach is covered by `alnair-shell`'s leader
//! integration suite, and duplicating it here would only re-test the leader.

use std::net::SocketAddr;

use alnair_web::server::{LeaderTarget, WebServerConfig};
use tokio_util::sync::CancellationToken;

/// Start the server on a free port and return its address.
///
/// `spawn_web_server` returns as soon as the socket is bound, so the test can
/// hold the address while the server keeps running on its own task.
async fn start() -> (SocketAddr, CancellationToken) {
    let cancel = CancellationToken::new();
    let (addr, _handle) = alnair_web::spawn_web_server(
        WebServerConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            leader: LeaderTarget::default(),
            open: false,
        },
        cancel.clone(),
    )
    .await
    .expect("server must bind");
    (addr, cancel)
}

/// A raw HTTP/1.1 GET, returning (status, response head, body).
///
/// `reqwest` is not a dependency of this crate and a test-only HTTP client is
/// not worth adding for a handful of assertions. The read is driven by
/// `Content-Length` rather than waiting for EOF: a keep-alive server is not
/// obliged to close the socket, and blocking on it would hang the test.
async fn get(addr: SocketAddr, path: &str, extra_headers: &str) -> (u16, String, String) {
    request(addr, "GET", path, extra_headers, "").await
}

/// A raw HTTP/1.1 POST with no body.
///
/// `Content-Length: 0` is required: axum's extractors wait for a declared body,
/// so omitting it leaves the handler hanging rather than running it.
async fn post(addr: SocketAddr, path: &str, extra_headers: &str) -> (u16, String, String) {
    request(
        addr,
        "POST",
        path,
        &format!("Content-Length: 0\r\n{extra_headers}"),
        "",
    )
    .await
}

/// One raw HTTP/1.1 exchange, returning (status, response head, body).
async fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    extra_headers: &str,
    body: &str,
) -> (u16, String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    // No `Connection: close`: a WebSocket upgrade carries its own
    // `Connection: Upgrade`, and sending both makes axum's upgrade extractor
    // reject the request with 400 before the auth check can run. The reader is
    // `Content-Length`-driven, so keep-alive is fine.
    let request = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\n{extra_headers}\r\n{body}");
    stream.write_all(request.as_bytes()).await.unwrap();

    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];

    // Read until the head terminator arrives.
    let head_end = loop {
        if let Some(pos) = find_head_end(&raw) {
            break pos;
        }
        let read = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .expect("server must answer within 5s")
            .unwrap();
        if read == 0 {
            break raw.len();
        }
        raw.extend_from_slice(&chunk[..read]);
    };

    let text = String::from_utf8_lossy(&raw).to_string();
    let head = text.get(..head_end).unwrap_or(&text).to_string();
    let body_start = (head_end + 4).min(raw.len());

    let expected: usize = header(&head, "content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut body = raw[body_start..].to_vec();
    while body.len() < expected {
        let read = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .expect("body must arrive within 5s")
            .unwrap();
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }

    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    (status, head, String::from_utf8_lossy(&body).to_string())
}

/// Byte offset of the `\r\n\r\n` that ends the response head.
fn find_head_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

/// Pull one header value out of a response head.
fn header(head: &str, name: &str) -> Option<String> {
    head.lines()
        .find(|line| {
            line.split_once(':')
                .is_some_and(|(key, _)| key.eq_ignore_ascii_case(name))
        })
        .and_then(|line| {
            line.split_once(':')
                .map(|(_, value)| value.trim().to_string())
        })
}

/// Pull the auth cookie value out of `Set-Cookie`.
fn cookie_of(head: &str) -> Option<String> {
    let raw = header(head, "set-cookie")?;
    let (pair, _) = raw.split_once(';')?;
    Some(pair.to_string())
}

#[tokio::test]
async fn root_serves_the_shell_with_a_cookie() {
    let (addr, cancel) = start().await;
    let (status, head, body) = get(addr, "/", "").await;
    cancel.cancel();

    assert_eq!(status, 200);
    assert_eq!(
        header(&head, "content-type").as_deref(),
        Some("text/html; charset=utf-8")
    );
    // The shell names hashed bundles, so it must not be cached.
    assert_eq!(header(&head, "cache-control").as_deref(), Some("no-cache"));
    let cookie = cookie_of(&head).expect("the shell must hand out the auth cookie");
    assert!(cookie.starts_with("alnair_web="));
    assert!(head.to_lowercase().contains("httponly"));
    assert!(head.to_lowercase().contains("samesite=strict"));
    assert!(
        body.contains("<html") || body.contains("<!doctype"),
        "expected HTML"
    );
}

#[tokio::test]
async fn healthz_needs_no_cookie() {
    let (addr, cancel) = start().await;
    let (status, _, body) = get(addr, "/healthz", "").await;
    cancel.cancel();

    assert_eq!(status, 200);
    assert_eq!(body, "ok");
}

#[tokio::test]
async fn extensionless_deep_link_serves_the_shell() {
    let (addr, cancel) = start().await;
    let (status, head, _) = get(addr, "/sessions/abc", "").await;
    cancel.cancel();

    assert_eq!(status, 200);
    assert_eq!(
        header(&head, "content-type").as_deref(),
        Some("text/html; charset=utf-8")
    );
}

#[tokio::test]
async fn a_missing_script_is_404_not_the_shell() {
    let (addr, cancel) = start().await;
    let (status, _, body) = get(addr, "/_app/immutable/chunks/does-not-exist.js", "").await;
    cancel.cancel();

    // Serving HTML here would turn a broken script tag into a parse error in
    // an HTML document, which is far harder to diagnose.
    assert_eq!(status, 404);
    assert!(!body.contains("<html"), "404 body must not be the shell");
}

#[tokio::test]
async fn a_hashed_asset_is_immutably_cached() {
    let (addr, cancel) = start().await;

    // Discover one real chunk from the build rather than hard-coding a hash.
    let listing = std::fs::read_dir(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../web/build/_app/immutable/chunks"),
    );
    let Ok(listing) = listing else {
        cancel.cancel();
        // No build present (placeholder only): nothing to assert.
        return;
    };
    let name = listing
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .find(|name| name.ends_with(".js"));
    let Some(name) = name else {
        cancel.cancel();
        return;
    };

    let (status, head, _) = get(addr, &format!("/_app/immutable/chunks/{name}"), "").await;
    cancel.cancel();

    assert_eq!(status, 200);
    assert_eq!(
        header(&head, "cache-control").as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(
        header(&head, "content-type").as_deref(),
        Some("text/javascript; charset=utf-8")
    );
}

#[tokio::test]
async fn api_session_reports_build_state_and_sets_the_cookie() {
    let (addr, cancel) = start().await;
    let (status, head, body) = get(addr, "/api/session", "").await;
    cancel.cancel();

    assert_eq!(status, 200);
    assert!(cookie_of(&head).is_some(), "must set the auth cookie");
    let value: serde_json::Value = serde_json::from_str(&body).expect("json body");
    assert!(value["webBuilt"].is_boolean());
    assert_eq!(value["version"], alnair_version::VERSION);
}

#[tokio::test]
async fn websocket_upgrade_without_a_cookie_is_rejected() {
    let (addr, cancel) = start().await;
    let (status, _, body) = get(
        addr,
        "/ws",
        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\
		 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://127.0.0.1\r\n",
    )
    .await;
    cancel.cancel();

    assert_eq!(status, 403);
    assert!(body.contains("cookie"), "body should explain: {body}");
}

#[tokio::test]
async fn websocket_upgrade_from_a_foreign_origin_is_rejected() {
    let (addr, cancel) = start().await;

    // Obtain a valid cookie first, so only the Origin check can fail.
    let (_, head, _) = get(addr, "/", "").await;
    let cookie = cookie_of(&head).expect("cookie");

    let (status, _, body) = get(
        addr,
        "/ws",
        &format!(
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\
			 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: {cookie}\r\n\
			 Origin: http://evil.example\r\n"
        ),
    )
    .await;
    cancel.cancel();

    assert_eq!(status, 403);
    assert!(body.contains("origin"), "body should explain: {body}");
}

/// The folder picker opens a modal window on the user's desktop, so the gate is
/// the same one `/ws` uses — and for a stronger reason: a dialog is a visible,
/// disruptive action even though it mutates nothing.
///
/// A refusal must land BEFORE any chooser is spawned, which is why these two
/// tests are safe to run on a machine with no desktop session.
#[tokio::test]
async fn pick_directory_without_a_cookie_is_rejected() {
    let (addr, cancel) = start().await;
    let (status, _, body) = post(addr, "/api/pick-directory", "Origin: http://127.0.0.1\r\n").await;
    cancel.cancel();

    assert_eq!(status, 403);
    assert!(body.contains("cookie"), "body should explain: {body}");
}

#[tokio::test]
async fn pick_directory_from_a_foreign_origin_is_rejected() {
    let (addr, cancel) = start().await;

    // A valid cookie, so only the Origin check can fail.
    let (_, head, _) = get(addr, "/", "").await;
    let cookie = cookie_of(&head).expect("cookie");

    let (status, _, body) = post(
        addr,
        "/api/pick-directory",
        &format!("Cookie: {cookie}\r\nOrigin: http://evil.example\r\n"),
    )
    .await;
    cancel.cancel();

    assert_eq!(status, 403);
    assert!(body.contains("origin"), "body should explain: {body}");
}
