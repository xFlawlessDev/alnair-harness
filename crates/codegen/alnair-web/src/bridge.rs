//! One leader client per WebSocket connection.
//!
//! The bridge is deliberately a byte pump. It does not parse ACP, does not
//! route, and does not replay: the leader already broadcasts session updates to
//! every subscriber, elects one driver per session, buffers live frames during
//! a `session/load`, and caches parked interactions for replay-on-attach. All
//! this layer does is move JSON-RPC strings between a socket and that client.
//!
//! The single exception is `alnair/leader_reconnected`: the browser needs to
//! know the leader was replaced so it can re-handshake, and only this layer
//! sees the reconnect.

use alnair_shell::leader::{
    ClientCapabilities, ClientMode, LeaderReconnector, ReconnectPolicy, connect_or_spawn,
};
use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

/// The client type reported to the leader; appears in `clientIdentifier` and in
/// leader logs, so it names the surface rather than the process.
pub const CLIENT_TYPE: &str = "alnair-web";

/// Notification telling the browser to re-handshake after a leader relaunch.
const RECONNECTED_NOTIFICATION: &str =
    r#"{"jsonrpc":"2.0","method":"alnair/leader_reconnected","params":{}}"#;

/// Capabilities for a browser client.
///
/// `terminal`/`fs_*` are `false` on purpose: the agent then uses its own
/// filesystem and PTY instead of asking a browser that cannot serve them.
/// `yolo_mode`/`auto_mode` are left off — the browser must not silently widen
/// permissions the user set in the TUI.
pub fn capabilities() -> ClientCapabilities {
    ClientCapabilities {
        yolo_mode: false,
        auto_mode: false,
        default_model: None,
        client_version: Some(alnair_version::VERSION.to_string()),
        code_nav_enabled: false,
        terminal: false,
        fs_read: false,
        fs_write: false,
    }
}

/// Serve one WebSocket for its lifetime.
///
/// Returns when the socket closes or the leader connection cannot be
/// re-established. The leader client is created here, so the connection count
/// and the socket count are one and the same.
pub async fn serve_socket(socket: WebSocket) {
    let cancel = CancellationToken::new();

    let conn = match connect_or_spawn(CLIENT_TYPE, ClientMode::Stdio, capabilities()).await {
        Ok(conn) => conn,
        Err(e) => {
            warn!(error = %e, "web: failed to attach to the leader");
            // Drop the socket; the browser sees a clean close and retries.
            return;
        }
    };

    let registration = conn.registration();
    info!(
        client_id = registration.client_id,
        leader_version = ?registration.leader_binary_version,
        "web: attached to leader"
    );

    let reconnector = LeaderReconnector::new(
        CLIENT_TYPE,
        ClientMode::Stdio,
        capabilities(),
        LeaderReconnector::status_channel().0,
    );

    let (to_leader, from_leader) = conn.into_channels();
    let (to_ws, mut from_ws) = mpsc::unbounded_channel::<String>();
    let (mut ws_write, mut ws_read) = socket.split();

    // Browser → leader.
    let to_leader = std::sync::Arc::new(tokio::sync::Mutex::new(to_leader));
    let to_leader_for_ws = to_leader.clone();
    let cancel_for_ws = cancel.clone();
    let reader = tokio::spawn(async move {
        while let Some(frame) = ws_read.next().await {
            match frame {
                Ok(Message::Text(text)) => {
                    let payload = text.as_str().trim_end_matches(['\r', '\n']).to_string();
                    // A browser keepalive is not JSON; the leader would log it as
                    // a malformed message.
                    if payload.is_empty() || payload == "ping" {
                        continue;
                    }
                    if to_leader_for_ws.lock().await.send(payload).is_err() {
                        break;
                    }
                }
                Ok(Message::Binary(bin)) => {
                    let Ok(text) = std::str::from_utf8(&bin) else {
                        continue;
                    };
                    let payload = text.trim_end_matches(['\r', '\n']).to_string();
                    if payload.is_empty() || payload == "ping" {
                        continue;
                    }
                    if to_leader_for_ws.lock().await.send(payload).is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
            }
        }
        cancel_for_ws.cancel();
    });

    // Leader → browser, including the reconnect notification.
    let cancel_for_leader = cancel.clone();
    let leader = tokio::spawn(async move {
        let mut from_leader = from_leader;
        loop {
            tokio::select! {
                biased;
                _ = cancel_for_leader.cancelled() => break,
                Some(payload) = from_leader.recv() => {
                    if to_ws.send(payload).is_err() {
                        break;
                    }
                }
                else => {
                    // The leader channel closed: it exited or relaunched.
                    warn!("web: leader connection closed, reconnecting");
                    match reconnector
                        .reconnect(ReconnectPolicy::unbounded(), &cancel_for_leader)
                        .await
                    {
                        Ok((new_tx, new_rx, _disconnect)) => {
                            info!("web: reattached to leader");
                            *to_leader.lock().await = new_tx;
                            from_leader = new_rx;
                            // The browser owns its own re-handshake: it re-sends
                            // `initialize` and `session/load`. The bridge does not
                            // replay, unlike the stdio bridge for IDE clients.
                            if to_ws.send(RECONNECTED_NOTIFICATION.to_string()).is_err() {
                                break;
                            }
                            reconnector.notify_connected();
                        }
                        Err(e) => {
                            warn!(error = %e, "web: could not reattach to the leader");
                            break;
                        }
                    }
                }
            }
        }
    });

    let writer = tokio::spawn(async move {
        while let Some(payload) = from_ws.recv().await {
            if ws_write.send(Message::Text(payload.into())).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = reader => {}
        _ = leader => {}
        _ = writer => {}
    }

    cancel.cancel();
    debug!("web: socket closed");
}

/// Reason a bridge task ended, for tests.
#[derive(Debug, PartialEq, Eq)]
pub enum BridgeEnd {
    /// The browser closed the socket.
    SocketClosed,
    /// The leader went away and could not be re-reached.
    LeaderLost,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_never_widen_permissions() {
        // A browser must not inherit the TUI's yolo/auto mode: the leader
        // injects these into `session/new`, so `true` here would silently
        // auto-approve every tool call for sessions the browser creates.
        let caps = capabilities();
        assert!(!caps.yolo_mode);
        assert!(!caps.auto_mode);
        assert!(caps.default_model.is_none());
    }

    #[test]
    fn capabilities_decline_client_side_terminal_and_fs() {
        // Declining makes the agent use its own FS/PTY. Claiming them would
        // route `fs/read_text_file` and terminal creation to a browser that has
        // no implementation, and the tool call would hang.
        let caps = capabilities();
        assert!(!caps.terminal);
        assert!(!caps.fs_read);
        assert!(!caps.fs_write);
    }

    #[test]
    fn reconnect_notification_is_a_notification_not_a_request() {
        let value: serde_json::Value = serde_json::from_str(RECONNECTED_NOTIFICATION).unwrap();
        assert_eq!(value["method"], "alnair/leader_reconnected");
        assert!(value.get("id").is_none(), "must not expect a response");
    }
}
