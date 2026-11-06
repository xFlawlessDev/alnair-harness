//! Exercise pairing and the real HTTP router without spawning an agent leader.

use std::net::SocketAddr;

use alnair_web::{WebServerConfig, server::LeaderTarget, service::Store};
use reqwest::{Client, StatusCode, header};
use tokio_util::sync::CancellationToken;

struct Server {
    address: SocketAddr,
    cancel: CancellationToken,
    handle: Option<tokio::task::JoinHandle<()>>,
    directory: tempfile::TempDir,
    control: String,
    client: Client,
}

impl Server {
    async fn start(public_url: Option<String>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let (address, handle) = alnair_web::spawn_web_server(
            WebServerConfig {
                bind: "127.0.0.1:0".parse().unwrap(),
                leader: LeaderTarget::default(),
                open: false,
                public_url,
                state_dir: Some(directory.path().join("web")),
                background: true,
            },
            cancel.clone(),
        )
        .await
        .unwrap();
        let store = Store::new(directory.path().join("web"));
        let control = store.registration().unwrap().unwrap().control_token;
        Self {
            address,
            cancel,
            handle: Some(handle),
            directory,
            control,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }

    async fn code(&self) -> String {
        let response = self
            .client
            .post(self.url("/api/service/pair"))
            .bearer_auth(&self.control)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.json::<serde_json::Value>().await.unwrap()["code"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn cookie(&self) -> String {
        let response = self
            .client
            .get(self.url(&format!("/auth/connect/{}", self.code().await)))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    }

    async fn shutdown(mut self) {
        self.cancel.cancel();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.handle.take().unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            Store::new(self.directory.path().join("web"))
                .registration()
                .unwrap()
                .is_none()
        );
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[tokio::test]
async fn shell_and_session_info_do_not_give_unauthenticated_visitors_a_cookie() {
    let server = Server::start(None).await;
    for path in ["/", "/sessions/abc", "/api/session"] {
        let response = server.client.get(server.url(path)).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
    server.shutdown().await;
}

#[tokio::test]
async fn pairing_sets_persistent_cookie_redirects_and_cannot_be_replayed() {
    let server = Server::start(None).await;
    let path = format!("/auth/connect/{}", server.code().await);
    let response = server.client.get(server.url(&path)).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(response.headers()[header::LOCATION], "/");
    assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
    let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(cookie.contains("HttpOnly; SameSite=Lax; Max-Age=2592000"));
    assert!(cookie.starts_with(&format!("alnair_session_{}=", server.address.port())));
    let cookie = cookie.split(';').next().unwrap();
    let shell = server
        .client
        .get(server.url("/sessions/abc"))
        .header(header::COOKIE, cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(shell.status(), StatusCode::OK);
    assert_eq!(
        shell.headers()[header::CONTENT_TYPE],
        "text/html; charset=utf-8"
    );
    assert!(!shell.headers().contains_key(header::SET_COOKIE));
    let replay = server.client.get(server.url(&path)).send().await.unwrap();
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    server.shutdown().await;
}

#[tokio::test]
async fn concurrent_pair_consumers_get_exactly_one_session() {
    let server = Server::start(None).await;
    let url = server.url(&format!("/auth/connect/{}", server.code().await));
    let (first, second) = tokio::join!(
        server.client.get(&url).send(),
        server.client.get(&url).send()
    );
    let statuses = [first.unwrap().status(), second.unwrap().status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::SEE_OTHER)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::UNAUTHORIZED)
            .count(),
        1
    );
    server.shutdown().await;
}

#[tokio::test]
async fn authenticated_session_info_reports_state_without_minting_cookies() {
    let server = Server::start(None).await;
    let response = server
        .client
        .get(server.url("/api/session"))
        .header(header::COOKIE, server.cookie().await)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["version"], alnair_version::VERSION);
    assert!(body["webBuilt"].is_boolean());
    server.shutdown().await;
}

#[tokio::test]
async fn invalid_links_and_unknown_api_paths_never_fall_back_to_spa() {
    let server = Server::start(None).await;
    let bad_link = server
        .client
        .get(server.url("/auth/connect/invalid"))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_link.status(), StatusCode::UNAUTHORIZED);
    assert!(!bad_link.headers().contains_key(header::SET_COOKIE));
    for path in [
        "/api",
        "/api/unknown",
        "/auth",
        "/auth/unknown",
        "/_app/immutable/missing.js",
    ] {
        assert_eq!(
            server
                .client
                .get(server.url(path))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        server
            .client
            .get(server.url("/healthz"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "ok"
    );
    server.shutdown().await;
}

#[tokio::test]
async fn picker_and_websocket_reject_foreign_or_missing_origins_before_side_effects() {
    let server = Server::start(None).await;
    let cookie = server.cookie().await;
    for origin in [
        None,
        Some("http://evil.example"),
        Some("http://localhost:9999"),
    ] {
        let mut picker = server
            .client
            .post(server.url("/api/pick-directory"))
            .header(header::COOKIE, &cookie);
        let mut socket = server
            .client
            .get(server.url("/ws"))
            .header(header::COOKIE, &cookie)
            .header(header::UPGRADE, "websocket")
            .header(header::CONNECTION, "Upgrade")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==");
        if let Some(origin) = origin {
            picker = picker.header(header::ORIGIN, origin);
            socket = socket.header(header::ORIGIN, origin);
        }
        assert_eq!(picker.send().await.unwrap().status(), StatusCode::FORBIDDEN);
        assert_eq!(socket.send().await.unwrap().status(), StatusCode::FORBIDDEN);
    }
    let missing_cookie = server
        .client
        .post(server.url("/api/pick-directory"))
        .header(header::ORIGIN, format!("http://{}", server.address))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_cookie.status(), StatusCode::UNAUTHORIZED);
    server.shutdown().await;
}

#[tokio::test]
async fn browser_cookies_cannot_administer_service_even_when_paired() {
    let server = Server::start(None).await;
    let cookie = server.cookie().await;
    for action in ["pair", "stop", "revoke"] {
        let response = server
            .client
            .post(server.url(&format!("/api/service/{action}")))
            .header(header::COOKIE, &cookie)
            .header(header::ORIGIN, format!("http://{}", server.address))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let response = server
        .client
        .post(server.url("/api/service/pair"))
        .bearer_auth(&server.control)
        .header(header::ORIGIN, "http://evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    server.shutdown().await;
}

#[tokio::test]
async fn revoke_invalidates_cookies_and_outstanding_links() {
    let server = Server::start(None).await;
    let cookie = server.cookie().await;
    let code = server.code().await;
    let response = server
        .client
        .post(server.url("/api/service/revoke"))
        .bearer_auth(&server.control)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        server
            .client
            .get(server.url("/api/session"))
            .header(header::COOKIE, cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        server
            .client
            .get(server.url(&format!("/auth/connect/{code}")))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(!server.cookie().await.is_empty());
    server.shutdown().await;
}

#[tokio::test]
async fn https_proxy_requires_explicit_host_and_sets_secure_cookie() {
    let server = Server::start(Some("https://alnair.example.com".into())).await;
    let code = server.code().await;
    let response = server
        .client
        .get(server.url(&format!("/auth/connect/{code}")))
        .header(header::HOST, "alnair.example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert!(
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("; Secure")
    );
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let accepted = server
        .client
        .get(server.url("/api/session"))
        .header(header::HOST, "alnair.example.com")
        .header(header::ORIGIN, "https://alnair.example.com")
        .header(header::COOKIE, cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    let rebinding = server
        .client
        .get(server.url("/api/session"))
        .header(header::HOST, "attacker.example")
        .header("x-forwarded-host", "alnair.example.com")
        .header(header::COOKIE, cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(rebinding.status(), StatusCode::FORBIDDEN);
    server.shutdown().await;
}

#[tokio::test]
async fn service_stop_is_authenticated_and_removes_registration() {
    let server = Server::start(None).await;
    let store = Store::new(server.directory.path().join("web"));
    assert!(
        alnair_web::service::discover(&store)
            .await
            .unwrap()
            .is_some()
    );
    alnair_web::service::stop(&store).await.unwrap();
    assert!(
        alnair_web::service::discover(&store)
            .await
            .unwrap()
            .is_none()
    );
    server.shutdown().await;
}
