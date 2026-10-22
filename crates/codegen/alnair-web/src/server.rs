//! Router, bind and startup reporting.
//!
//! One origin serves both the SPA and the WebSocket, which is what makes the
//! `SameSite=Strict` cookie work without a CORS story.

use std::net::SocketAddr;

use axum::{
    Router,
    extract::{ConnectInfo, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use tracing::{info, warn};

use crate::assets;
use crate::auth::{Gate, RejectReason};
use crate::bridge;
use crate::picker;

/// Everything the handlers share.
#[derive(Clone)]
struct AppState {
    gate: Gate,
    /// The leader this server proxies to, for the startup line and
    /// `/api/session`. `None` means "whatever `connect_or_spawn` finds".
    leader: LeaderTarget,
}

/// Which leader the web server attaches to.
#[derive(Debug, Clone, Default)]
pub struct LeaderTarget {
    /// PID from `--pid`, resolved to a socket before serving.
    pub pid: Option<u32>,
    /// Explicit socket path from `--socket`.
    pub socket: Option<std::path::PathBuf>,
}

/// How the server should be started.
#[derive(Debug, Clone)]
pub struct WebServerConfig {
    /// Address to bind. Port `0` picks a free one, reported after binding.
    pub bind: SocketAddr,
    /// The leader to attach to.
    pub leader: LeaderTarget,
    /// Open the default browser once listening.
    pub open: bool,
}

/// Bind and serve, returning the address and a handle to the running server.
///
/// Returns as soon as the socket is bound, so a caller using port `0` can print
/// the real URL without waiting for shutdown. Awaiting a serve-forever future
/// here would deadlock any caller that needs the address.
pub async fn spawn_web_server(
    config: WebServerConfig,
    cancel: tokio_util::sync::CancellationToken,
) -> anyhow::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let bound = listener.local_addr()?;

    let gate = Gate::new(bound);
    let state = AppState {
        gate: gate.clone(),
        leader: config.leader.clone(),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/session", get(session_info))
        .route("/api/pick-directory", post(pick_directory))
        .route("/healthz", get(healthz))
        .fallback(get(static_handler))
        .with_state(state);

    print_startup(bound, &config, &gate);
    if config.open {
        open_browser(bound);
    }

    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move { cancel.cancelled().await })
        .await
        {
            warn!(error = %e, "web: server stopped with an error");
        }
    });

    Ok((bound, handle))
}

/// Bind, serve, and block until the server shuts down.
///
/// The CLI entry point. Tests use [`spawn_web_server`] so they can hold the
/// address while the server is running.
pub async fn run_web_server(
    config: WebServerConfig,
    cancel: tokio_util::sync::CancellationToken,
) -> anyhow::Result<SocketAddr> {
    let (bound, handle) = spawn_web_server(config, cancel).await?;
    let _ = handle.await;
    Ok(bound)
}

/// Startup line: URL, leader target, and a loud note when the assets are a
/// placeholder. Mirrors `print_serve_startup_info` in `alnair-bin`.
fn print_startup(bound: SocketAddr, config: &WebServerConfig, _gate: &Gate) {
    let url = format!("http://{bound}/");
    eprintln!();
    eprintln!("   Alnair web UI");
    eprintln!();
    eprintln!("   URL:      {url}");
    match (&config.leader.pid, &config.leader.socket) {
        (Some(pid), _) => eprintln!("   Leader:   pid {pid}"),
        (None, Some(socket)) => eprintln!("   Leader:   {}", socket.display()),
        (None, None) => eprintln!("   Leader:   default (spawned on demand)"),
    }
    if assets::is_placeholder() {
        eprintln!();
        eprintln!("   WARNING: web/build was not built — serving a placeholder page.");
        eprintln!("            Run `npm --prefix web run build` and rebuild alnair.");
    }
    eprintln!();
    eprintln!("   The UI is protected by a same-origin cookie; open the URL above.");
    eprintln!();
}

/// Best-effort browser launch; a failure is not worth aborting the server.
fn open_browser(bound: SocketAddr) {
    let url = format!("http://{bound}/");
    if let Err(e) = webbrowser::open(&url) {
        warn!(error = %e, "web: could not open the browser; open the URL manually");
    }
}

/// Ask the user for a workspace directory with the OS's own dialog.
///
/// The browser cannot answer this: a directory handle exposes only a leaf
/// name, never an absolute path, and a session needs one. So the dialog runs
/// here, on the machine serving the page.
///
/// Gated exactly like `/ws`. The cookie alone would be enough for a browser
/// (it is `SameSite=Strict`), but the `Origin` check is what stops a
/// DNS-rebinding page from popping a modal dialog on the user's desktop — and
/// a dialog is a visible, disruptive action even though it changes nothing.
async fn pick_directory(State(state): State<AppState>, headers: HeaderMap) -> Response {
    // `check` reads both headers; a missing cookie or a foreign Origin is a
    // 403 with the same wording the socket upgrade uses.
    if let Err(reason) = state.gate.check(&headers) {
        return reject(reason);
    }

    match picker::pick_directory().await {
        Ok(Some(path)) => {
            info!("web: workspace directory picked");
            axum::Json(serde_json::json!({ "path": path })).into_response()
        }
        // A cancelled dialog is not an error: the caller simply keeps its
        // current workspace and shows nothing.
        Ok(None) => axum::Json(serde_json::json!({ "cancelled": true })).into_response(),
        Err(error) => {
            warn!(reason = error.message(), "web: folder picker unavailable");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(serde_json::json!({ "error": error.message() })),
            )
                .into_response()
        }
    }
}

async fn healthz() -> &'static str {
    "ok"
}

/// Sets the auth cookie and reports what this server attached to.
async fn session_info(State(state): State<AppState>) -> Response {
    let body = serde_json::json!({
        "version": alnair_version::VERSION,
        "leaderPid": state.leader.pid,
        "leaderSocket": state.leader.socket.as_ref().map(|p| p.display().to_string()),
        "webBuilt": !assets::is_placeholder(),
    });
    let mut response = axum::Json(body).into_response();
    if let Ok(cookie) = HeaderValue::from_str(&state.gate.set_cookie()) {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    response
}

/// Embedded asset lookup with the SPA fallback rules from [`crate::assets`].
async fn static_handler(State(state): State<AppState>, uri: axum::http::Uri) -> Response {
    let path = uri.path();
    let mut response = match assets::resolve(path) {
        Some(asset) => {
            let cache = if asset.is_shell {
                // The shell names hashed bundles; caching it would pin a stale
                // build after an upgrade.
                "no-cache"
            } else {
                "public, max-age=31536000, immutable"
            };
            let mut response = asset.body.into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(asset.content_type),
            );
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
            response
        }
        None => {
            let (status, headers, body) = assets::not_found();
            let mut response = (status, body).into_response();
            for (name, value) in headers {
                response
                    .headers_mut()
                    .insert(name, HeaderValue::from_static(value));
            }
            response
        }
    };
    // The shell is the entry point, so it hands out the cookie too: a user who
    // navigates straight to a deep link still gets one before the WS opens.
    if let Ok(cookie) = HeaderValue::from_str(&state.gate.set_cookie()) {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    response
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(reason) = state.gate.check(&headers) {
        // Log the offending Origin but never the cookie value.
        warn!(
            %peer,
            reason = reason.as_str(),
            origin = ?headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()),
            "web: rejected WebSocket upgrade"
        );
        return reject(reason);
    }

    info!(%peer, "web: WebSocket attached");
    ws.on_upgrade(bridge::serve_socket)
}

/// The 403 body for a refused upgrade.
fn reject(reason: RejectReason) -> Response {
    (
        StatusCode::FORBIDDEN,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        reason.as_str(),
    )
        .into_response()
}
