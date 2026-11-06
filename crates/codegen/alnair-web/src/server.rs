//! One HTTP origin for the embedded SPA, pairing, and authenticated WebSockets.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    Router,
    extract::{ConnectInfo, Path, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::auth::{Gate, PAIR_TTL, RejectReason, public_url, random_token};
use crate::service::{Registration, ServiceConfig, Store};
use crate::{assets, bridge, picker};

#[derive(Clone)]
struct AppState {
    gate: Arc<Gate>,
    leader: LeaderTarget,
    store: Store,
    cancel: CancellationToken,
    // Serialize key persistence and activation across simultaneous revoke requests.
    revoke_lock: Arc<tokio::sync::Mutex<()>>,
}

/// Which leader the web server attaches to.
#[derive(Debug, Clone, Default)]
pub struct LeaderTarget {
    /// PID from `--pid`.
    pub pid: Option<u32>,
    /// Explicit socket path from `--socket`.
    pub socket: Option<std::path::PathBuf>,
}

/// How the server should be started.
#[derive(Debug, Clone)]
pub struct WebServerConfig {
    /// Address to bind; port zero selects a free port.
    pub bind: SocketAddr,
    /// Leader target.
    pub leader: LeaderTarget,
    /// Open a one-time pairing link in the default browser.
    pub open: bool,
    /// Exact origin exposed by a reverse proxy.
    pub public_url: Option<String>,
    /// Explicit private state directory, for isolated embedders and tests.
    pub state_dir: Option<std::path::PathBuf>,
    /// Background startup must not write pairing credentials to its log.
    pub background: bool,
}

/// Bind and return immediately, holding the service lease until shutdown completes.
pub async fn spawn_web_server(
    config: WebServerConfig,
    cancel: CancellationToken,
) -> anyhow::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    let public = config.public_url.as_deref().map(public_url).transpose()?;
    let store = match &config.state_dir {
        Some(root) => Store::new(root.clone()),
        None => Store::user()?,
    };
    let store_for_lease = store.clone();
    let (mut lease, secret) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let lease = store_for_lease.acquire()?;
        let secret = lease.secret()?;
        Ok((lease, secret))
    })
    .await??;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let bound = listener.local_addr()?;
    let registration = Registration {
        pid: std::process::id(),
        bound,
        config: ServiceConfig {
            bind: config.bind,
            public_url: config.public_url.clone(),
        },
        control_token: random_token(32)?,
    };
    let gate = Arc::new(Gate::new(
        bound,
        public,
        &secret,
        registration.control_token.clone(),
    ));
    let state = AppState {
        gate: gate.clone(),
        leader: config.leader.clone(),
        store,
        cancel: cancel.clone(),
        revoke_lock: Arc::new(tokio::sync::Mutex::new(())),
    };
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/auth/connect/{code}", get(connect))
        .route("/api/session", get(session_info))
        .route("/api/pick-directory", post(pick_directory))
        .route("/api/service/status", get(service_status))
        .route("/api/service/pair", post(issue_pair))
        .route("/api/service/stop", post(stop))
        .route("/api/service/revoke", post(revoke))
        .route("/healthz", get(|| async { "ok" }))
        .fallback(get(static_handler))
        .with_state(state);

    let registration_for_write = registration.clone();
    let lease = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        lease.register(&registration_for_write)?;
        Ok(lease)
    })
    .await??;
    let url = registration.browser_url();
    eprintln!("Alnair web UI: {url}");
    if assets::is_placeholder() {
        eprintln!("Web assets missing: run `npm --prefix web run build` and rebuild Alnair.");
    }
    if !config.background {
        let link = format!(
            "{}/auth/connect/{}",
            url.trim_end_matches('/'),
            gate.issue_pair()?
        );
        eprintln!("Open this one-time link within five minutes:\n{link}");
        if config.open
            && let Err(error) = webbrowser::open(&link)
        {
            warn!(%error, "web: could not open browser");
        }
    }

    let handle = tokio::spawn(async move {
        if let Err(error) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move { cancel.cancelled().await })
        .await
        {
            warn!(%error, "web: server stopped with an error");
        }
        // Filesystem cleanup may retry on Windows, so it stays off runtime workers.
        if let Err(error) = tokio::task::spawn_blocking(move || drop(lease)).await {
            warn!(%error, "web: service lease cleanup failed");
        }
    });
    Ok((bound, handle))
}

/// Serve until cancelled, propagating task failures to the CLI.
pub async fn run_web_server(
    config: WebServerConfig,
    cancel: CancellationToken,
) -> anyhow::Result<SocketAddr> {
    let (bound, handle) = spawn_web_server(config, cancel).await?;
    handle.await?;
    Ok(bound)
}

async fn connect(
    State(state): State<AppState>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(reason) = state.gate.check_host(&headers) {
        return reject(reason);
    }
    // Embedded pages must not silently consume a link and pair another browsing context.
    if headers
        .get("sec-fetch-dest")
        .is_some_and(|value| value != "document")
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(token) = state.gate.consume_pair(&code) else {
        return private(
            (
                StatusCode::UNAUTHORIZED,
                "Pairing link expired or already used. Run `alnair web pair` on the server.",
            )
                .into_response(),
        );
    };
    let mut response = Redirect::to("/").into_response();
    match HeaderValue::from_str(&state.gate.set_cookie(&token)) {
        Ok(cookie) => {
            response.headers_mut().insert(header::SET_COOKIE, cookie);
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    private(response)
}

async fn issue_pair(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !state.gate.check_control(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match state.gate.issue_pair() {
        Ok(code) => private(
            axum::Json(serde_json::json!({ "code": code, "expires_in": PAIR_TTL.as_secs() }))
                .into_response(),
        ),
        Err(error) => {
            warn!(%error, "web: could not issue pairing code");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn service_status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !state.gate.check_control(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    private(
        axum::Json(
            serde_json::json!({ "pid": std::process::id(), "version": alnair_version::VERSION }),
        )
        .into_response(),
    )
}

async fn stop(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !state.gate.check_control(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    state.cancel.cancel();
    private(axum::Json(serde_json::json!({ "stopping": true })).into_response())
}

async fn revoke(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !state.gate.check_control(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let _guard = state.revoke_lock.lock().await;
    let store = state.store.clone();
    let gate = state.gate.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let secret = store.rotate_secret()?;
        gate.revoke(&secret)
    })
    .await;
    match result {
        Ok(Ok(())) => private(axum::Json(serde_json::json!({ "revoked": true })).into_response()),
        error => {
            warn!(?error, "web: could not revoke sessions");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn pick_directory(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(reason) = state.gate.check(&headers, true) {
        return reject(reason);
    }
    match picker::pick_directory().await {
        Ok(Some(path)) => private(axum::Json(serde_json::json!({ "path": path })).into_response()),
        Ok(None) => private(axum::Json(serde_json::json!({ "cancelled": true })).into_response()),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({ "error": error.message() })),
        )
            .into_response(),
    }
}

async fn session_info(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(reason) = state.gate.check(&headers, false) {
        return reject(reason);
    }
    private(
        axum::Json(serde_json::json!({
            "version": alnair_version::VERSION,
            "leaderPid": state.leader.pid,
            "leaderSocket": state.leader.socket.as_ref().map(|p| p.display().to_string()),
            "webBuilt": !assets::is_placeholder(),
        }))
        .into_response(),
    )
}

async fn static_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    if matches!(uri.path(), "/api" | "/auth")
        || uri.path().starts_with("/api/")
        || uri.path().starts_with("/auth/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Err(reason) = state.gate.check_host(&headers) {
        return reject(reason);
    }
    let Some(asset) = assets::resolve(uri.path()) else {
        let (status, _, body) = assets::not_found();
        return (status, body).into_response();
    };
    if asset.is_shell
        && let Err(reason) = state.gate.check(&headers, false)
    {
        return reject(reason);
    }
    let mut response = asset.body.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(asset.content_type),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if asset.is_shell {
            "no-store"
        } else {
            "public, max-age=31536000, immutable"
        }),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let session = match state.gate.check(&headers, true) {
        Ok(session) => session,
        Err(reason) => {
            warn!(%peer, reason = reason.as_str(), "web: rejected WebSocket upgrade");
            return reject(reason);
        }
    };
    info!(%peer, "web: WebSocket attached");
    ws.on_upgrade(move |socket| bridge::serve_socket(socket, state.cancel, session))
}

fn private(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
        .headers_mut()
        .insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

fn reject(reason: RejectReason) -> Response {
    let status = match reason {
        RejectReason::MissingCookie | RejectReason::BadCookie => StatusCode::UNAUTHORIZED,
        _ => StatusCode::FORBIDDEN,
    };
    private(
        (
            status,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            reason.as_str(),
        )
            .into_response(),
    )
}
