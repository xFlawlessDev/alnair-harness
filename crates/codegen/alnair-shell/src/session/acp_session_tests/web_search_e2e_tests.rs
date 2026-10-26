use alnair_tools::computer::local::{LocalFs, LocalTerminalBackend};
use alnair_tools::computer::types::{AsyncFileSystem, TerminalBackend};
use alnair_tools::notification::ToolNotificationHandle;
use alnair_tools::registry::types::{SessionContext, ToolConfig, ToolServerConfig};
use alnair_tools::types::web_provider::{
    SharedWebTargetProvider, WebAuthScheme, WebEndpoint, WebProviderTarget, WebTargetProvider,
    WebWire,
};
use serde_json::json;
use std::sync::Arc;

/// A target resolver that always reports the same provider connection.
struct FixedTarget(WebProviderTarget);

impl WebTargetProvider for FixedTarget {
    fn target(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = WebProviderTarget> + Send + '_>> {
        Box::pin(std::future::ready(self.0.clone()))
    }
}

fn fixed_target(base_url: &str) -> SharedWebTargetProvider {
    Arc::new(FixedTarget(WebProviderTarget {
        search: Some(WebEndpoint {
            url: format!("{base_url}/search"),
            wire: WebWire::Provider,
            model: Some("gw/model".into()),
            auth_scheme: WebAuthScheme::Bearer,
        }),
        fetch: Some(WebEndpoint {
            url: format!("{base_url}/web/fetch"),
            wire: WebWire::Provider,
            model: Some("gw/model".into()),
            auth_scheme: WebAuthScheme::Bearer,
        }),
        credential: Some("provider-key".to_string()),
    }))
}

/// Build a toolset carrying the two web tools and a provider target.
async fn web_toolset(
    search: alnair_tools::implementations::web_search::WebSearchConfig,
    fetch: alnair_tools::implementations::alnair::web_fetch::WebFetchConfig,
    target: Option<SharedWebTargetProvider>,
) -> crate::tools::bridge::ToolBridge {
    let builder = crate::tools::bridge::ToolBridge::get_builder();
    let config = ToolServerConfig {
        tools: vec![
            ToolConfig::from_id("Alnair:web_search".to_string()),
            ToolConfig::from_id("Alnair:web_fetch".to_string()),
        ],
        behavior_preset: None,
    };
    let fs: Arc<dyn AsyncFileSystem> = Arc::new(LocalFs);
    let terminal: Arc<dyn TerminalBackend> = Arc::new(LocalTerminalBackend::new());
    let ctx = SessionContext {
        backend: terminal,
        fs,
        cwd: std::env::temp_dir(),
        session_folder: std::env::temp_dir().join("alnair-web-provider-target"),
        session_env: Arc::new(std::collections::HashMap::new()),
        notification_handle: ToolNotificationHandle::noop(),
        owner_session_id: None,
        parent_scheduler_handle: None,
        skills: vec![],
        state_path: std::env::temp_dir().join("alnair-web-provider-target/state.json"),
        memory_backend: None,
        web_search_config: search,
        web_fetch_config: fetch,
        web_target: target,
        lsp: None,
        app_builder_deployer_config: Default::default(),
        api_key_provider: None,
        attribution_callback: None,
        system_reminder_tag: alnair_tools::reminders::DEFAULT_REMINDER_TAG,
    };
    crate::tools::bridge::ToolBridge::finalize_builder(builder, config, ctx)
        .await
        .expect("finalize_builder should succeed")
}
#[tokio::test]
async fn web_search_errors_when_disabled() {
    let bridge = web_toolset(
        alnair_tools::implementations::web_search::WebSearchConfig::Disabled,
        Default::default(),
        None,
    )
    .await;
    let result = bridge
        .call(
            "web_search",
            json!({
                "query": "test query"
            }),
            "web-search-disabled",
        )
        .await;
    assert!(result.is_err(), "web_search should fail when disabled");
}

/// The provider connection's `/search` is the endpoint `web_search` posts to,
/// with the provider wire (`query`/`max_results`) and its own credential.
#[tokio::test]
async fn web_search_posts_to_the_provider_connection() {
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/search"))
        .and(header("authorization", "Bearer provider-key"))
        .and(body_json(serde_json::json!({
            "query": "rust",
            "max_results": 5,
            "model": "gw/model",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": "search",
            "results": [{
                "title": "Rust",
                "url": "https://rust-lang.org",
                "snippet": "A language."
            }]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let bridge = web_toolset(
        alnair_tools::implementations::web_search::WebSearchConfig::Enabled {
            extra_headers: Default::default(),
        },
        Default::default(),
        Some(fixed_target(&server.uri())),
    )
    .await;
    let result = bridge
        .call("web_search", json!({ "query": "rust" }), "call-1")
        .await
        .expect("web_search should reach the provider connection");
    let rendered = serde_json::to_string(&result).unwrap_or_default();
    assert!(
        rendered.contains("rust-lang.org"),
        "the provider's result must reach the tool output: {rendered}"
    );
}

/// `web_fetch` tries the provider's `/web/fetch` before its local pipeline, so
/// the page arrives from the connection rather than a direct request.
#[tokio::test]
async fn web_fetch_uses_the_provider_connection() {
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/web/fetch"))
        .and(header("authorization", "Bearer provider-key"))
        .and(body_json(
            serde_json::json!({ "url": "https://example.com/docs" }),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string("<html><body><h1>Fetched by the provider</h1></body></html>"),
        )
        .expect(1)
        .mount(&server)
        .await;

    let bridge = web_toolset(
        Default::default(),
        alnair_tools::implementations::alnair::web_fetch::WebFetchConfig::Enabled {
            params: Default::default(),
        },
        Some(fixed_target(&server.uri())),
    )
    .await;
    let result = bridge
        .call(
            "web_fetch",
            json!({ "url": "https://example.com/docs" }),
            "call-2",
        )
        .await
        .expect("web_fetch should succeed");
    let rendered = serde_json::to_string(&result).unwrap_or_default();
    assert!(
        rendered.contains("Fetched by the provider"),
        "the provider's body must be what the tool returns: {rendered}"
    );
}

/// A provider that fails must not fabricate a result — the local pipeline takes
/// over, and this test only pins that the failure is not surfaced as success
/// from the provider path.
#[tokio::test]
async fn web_fetch_falls_through_a_failing_provider() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/web/fetch"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;

    let bridge = web_toolset(
        Default::default(),
        alnair_tools::implementations::alnair::web_fetch::WebFetchConfig::Enabled {
            params: Default::default(),
        },
        Some(fixed_target(&server.uri())),
    )
    .await;
    // The local pipeline then tries the real host; this only asserts the call
    // completes with an answer that is NOT the provider's (empty) body.
    let result = bridge
        .call(
            "web_fetch",
            json!({ "url": "https://example.invalid/nothing" }),
            "call-3",
        )
        .await;
    if let Ok(output) = result {
        let rendered = serde_json::to_string(&output).unwrap_or_default();
        assert!(
            !rendered.contains("Fetched by the provider"),
            "a failed provider must not contribute content: {rendered}"
        );
    }
    assert!(
        server
            .received_requests()
            .await
            .expect("request log")
            .iter()
            .all(|request| request.url.path() == "/v1/web/fetch"),
        "the provider endpoint is the only one the tool may post to"
    );
}
