//! HTTP client for `web_search`.
//!
//! The endpoint is resolved per call through the session's
//! [`SharedWebTargetProvider`], because a session can switch providers
//! mid-session and a captured URL would keep posting to the old one. Two wires
//! exist, chosen by the resolved endpoint's [`WebWire`]:
//!
//! - **Provider** — `POST {base}/search`: `{"query", "max_results", "model"?}`
//!   in, `{"results": [...]}` out. The OpenAI-compatible extension shape; the
//!   `model` field selects the upstream when the base URL fronts several.
//! - **Kimi** — the subscription service (PRD F5), ported from kimi-cli
//!   `tools/web/search.py`: `{"text_query", "limit", "enable_page_crawling",
//!   "timeout_seconds": 30}`, `X-Msh-Tool-Call-Id`, `{"search_results": [...]}`.
//!
//! Both are rendered through the same `Title/Date/URL/Summary` formatter, so the
//! model sees one shape regardless of which provider answered.

use super::types::WebSearchConfig;
use crate::attribution::{SharedAttributionCallback, ToolConsumer};
use crate::types::web_provider::{SharedWebTargetProvider, WebAuthScheme, WebEndpoint, WebWire};
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};

/// Total request timeout. Mirrors kimi-cli search.py:74 (`total=180`):
/// the service crawls pages when `include_content` is set.
const SEARCH_TIMEOUT_SECS: u64 = 180;
/// `timeout_seconds` request field — the server-side search budget
/// (search.py:93).
const SERVER_TIMEOUT_SECS: u64 = 30;

fn tool_error(msg: impl Into<String>) -> alnair_tool_runtime::ToolError {
    alnair_tool_runtime::ToolError::execution(
        alnair_tool_protocol::ToolId::new("web_search").expect("valid"),
        msg.into(),
    )
}

/// One search hit, in the canonical shape both wires normalize to.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct SearchResult {
    #[serde(default)]
    pub site_name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub date: String,
    /// Provider extension only: relevance score, unused by the renderer.
    #[serde(default)]
    pub score: Option<f64>,
    /// Provider extension only: publication date under its own name.
    #[serde(default)]
    pub published_at: Option<String>,
}

impl SearchResult {
    /// The date to print, preferring the provider extension's `published_at`
    /// over the Kimi service's `date`.
    fn display_date(&self) -> &str {
        self.published_at
            .as_deref()
            .filter(|d| !d.is_empty())
            .unwrap_or(&self.date)
    }
}

/// Response envelope, tolerant of both wires.
#[derive(Debug, serde::Deserialize)]
struct SearchResponse {
    #[serde(default)]
    search_results: Vec<SearchResult>,
    #[serde(default)]
    results: Vec<SearchResult>,
}

impl SearchResponse {
    fn into_results(self) -> Vec<SearchResult> {
        if self.search_results.is_empty() {
            self.results
        } else {
            self.search_results
        }
    }
}

#[derive(Clone)]
pub struct WebSearchClient {
    http: reqwest::Client,
    target: SharedWebTargetProvider,
    /// Optional 401-attribution hook. Callers can wire this so a 401 from
    /// the search service emits an `auth_401_attribution` event with
    /// `consumer == "WebSearch"`.
    attribution_callback: Option<SharedAttributionCallback>,
}

impl WebSearchClient {
    /// Create a new web search client from `WebSearchConfig::Enabled`.
    ///
    /// Returns `Err` if the config is `Disabled` or has invalid header values.
    pub fn new(
        config: &WebSearchConfig,
        target: SharedWebTargetProvider,
    ) -> Result<Self, alnair_tool_runtime::ToolError> {
        if !config.is_enabled() {
            return Err(tool_error(
                "Cannot create WebSearchClient from disabled config",
            ));
        }
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        for (key, value) in config.extra_headers() {
            let header_name = HeaderName::from_bytes(key.as_bytes())
                .map_err(|e| tool_error(format!("Invalid header name '{key}': {e}")))?;
            let header_value = HeaderValue::from_str(value)
                .map_err(|e| tool_error(format!("Invalid header value for '{key}': {e}")))?;
            headers.insert(header_name, header_value);
        }
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(std::time::Duration::from_secs(SEARCH_TIMEOUT_SECS))
            .build()
            .map_err(|e| tool_error(format!("Failed to build HTTP client: {e}")))?;
        Ok(Self {
            http,
            target,
            attribution_callback: None,
        })
    }

    pub fn with_attribution_callback(
        mut self,
        callback: Option<SharedAttributionCallback>,
    ) -> Self {
        self.attribution_callback = callback;
        self
    }

    /// The search endpoint + credential for the session's current model.
    ///
    /// `None` when the current provider serves no search — the tool then
    /// reports that plainly instead of posting to a URL that would 404.
    async fn resolve(&self) -> Option<(WebEndpoint, String)> {
        let target = self.target.target().await;
        let endpoint = target.search?;
        let credential = target.credential?;
        Some((endpoint, credential))
    }

    fn record_401_attribution(&self, sent_bearer: &str) {
        crate::attribution::emit_401(
            self.attribution_callback.as_ref(),
            ToolConsumer::WebSearch,
            Some(sent_bearer),
        );
    }

    /// Apply the endpoint's credential header.
    ///
    /// The scheme travels with the endpoint: an Anthropic-wire provider reads
    /// `x-api-key`, everything else reads `Authorization: Bearer`. Sending the
    /// wrong one is a 401 on a request that is otherwise well-formed.
    fn apply_auth(
        &self,
        request: reqwest::RequestBuilder,
        endpoint: &WebEndpoint,
        bearer: &str,
    ) -> reqwest::RequestBuilder {
        match endpoint.auth_scheme {
            WebAuthScheme::Bearer => request.header("Authorization", format!("Bearer {bearer}")),
            WebAuthScheme::XApiKey => request.header("x-api-key", bearer),
        }
    }

    /// Search through the provider connection's endpoint.
    ///
    /// Returns the rendered result text plus the unique result URLs as
    /// citations.
    ///
    /// `tool_call_id` rides along as `X-Msh-Tool-Call-Id` on the Kimi wire
    /// (search.py:85) so the service can correlate the request with the agent
    /// turn; the provider wire has no such field.
    pub async fn search(
        &self,
        query: &str,
        limit: u8,
        include_content: bool,
        tool_call_id: &str,
    ) -> Result<(String, Vec<String>), alnair_tool_runtime::ToolError> {
        let Some((endpoint, bearer)) = self.resolve().await else {
            return Err(tool_error(
                "web_search is unavailable: the current provider connection serves no \
                 search endpoint. Switch to a provider that does, or use web_fetch on a \
                 known URL.",
            ));
        };
        let body = match endpoint.wire {
            WebWire::Provider => {
                let mut body = serde_json::json!({
                    "query": query,
                    "max_results": limit,
                });
                if let Some(model) = endpoint.model.as_deref() {
                    body["model"] = serde_json::Value::String(model.to_string());
                }
                body
            }
            WebWire::Kimi => serde_json::json!({
                "text_query": query,
                "limit": limit,
                "enable_page_crawling": include_content,
                "timeout_seconds": SERVER_TIMEOUT_SECS,
            }),
        };
        let mut request = self.apply_auth(self.http.post(&endpoint.url), &endpoint, &bearer);
        if endpoint.wire == WebWire::Kimi {
            request = request.header("X-Msh-Tool-Call-Id", tool_call_id);
        }
        let response = request.json(&body).send().await.map_err(|e| {
            tool_error(format!(
                "Search request to {} failed: {e}. The search service may be unavailable.",
                endpoint.url
            ))
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            self.record_401_attribution(&bearer);
            return Err(alnair_tool_runtime::ToolError::unauthorized(
                "Search service returned 401 Unauthorized".to_string(),
            ));
        }
        if !status.is_success() {
            return Err(tool_error(format!(
                "Failed to search. Status: {status} from {}. This may indicate that the \
                 search service is currently unavailable.",
                endpoint.url
            )));
        }
        let results = response
            .json::<SearchResponse>()
            .await
            .map_err(|e| tool_error(format!("Failed to parse search results: {e}")))?
            .into_results();
        Ok(render_results(&results))
    }
}

/// Render hits in kimi-cli's result schema (search.py:141-149):
/// `Title/Date/URL/Summary` per hit, page content when crawled, hits
/// separated by `---`. Citations are the unique result URLs in order.
fn render_results(results: &[SearchResult]) -> (String, Vec<String>) {
    let mut content = String::new();
    let mut citations: Vec<String> = Vec::new();
    for (i, result) in results.iter().enumerate() {
        if i > 0 {
            content.push_str("---\n\n");
        }
        content.push_str(&format!(
            "Title: {}\nDate: {}\nURL: {}\nSummary: {}\n\n",
            result.title,
            result.display_date(),
            result.url,
            result.snippet
        ));
        if !result.content.is_empty() {
            content.push_str(&format!("{}\n\n", result.content));
        }
        if !citations.contains(&result.url) {
            citations.push(result.url.clone());
        }
    }
    (content, citations)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::web_provider::{
        SharedWebTargetProvider, WebProviderTarget, WebTargetProvider,
    };
    use indexmap::IndexMap;
    use std::sync::Arc;

    struct StaticTarget(WebProviderTarget);

    impl WebTargetProvider for StaticTarget {
        fn target(
            &self,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = WebProviderTarget> + Send + '_>>
        {
            Box::pin(std::future::ready(self.0.clone()))
        }
    }

    fn endpoint(url: &str, wire: WebWire) -> WebEndpoint {
        WebEndpoint {
            url: url.to_string(),
            wire,
            model: Some("gw/model".into()),
            auth_scheme: WebAuthScheme::Bearer,
        }
    }

    fn resolver_for(target: WebProviderTarget) -> SharedWebTargetProvider {
        Arc::new(StaticTarget(target))
    }

    fn enabled_config(url: &str, wire: WebWire) -> (WebSearchConfig, SharedWebTargetProvider) {
        (
            WebSearchConfig::Enabled {
                extra_headers: IndexMap::new(),
            },
            resolver_for(WebProviderTarget {
                search: Some(endpoint(url, wire)),
                fetch: None,
                credential: Some("test-key".to_string()),
            }),
        )
    }

    #[test]
    fn new_rejects_disabled_config() {
        assert!(
            WebSearchClient::new(
                &WebSearchConfig::Disabled,
                resolver_for(WebProviderTarget::default())
            )
            .is_err()
        );
    }

    #[test]
    fn new_rejects_invalid_extra_header() {
        let mut headers = IndexMap::new();
        headers.insert("bad header name".to_string(), "v".to_string());
        let config = WebSearchConfig::Enabled {
            extra_headers: headers,
        };
        assert!(WebSearchClient::new(&config, resolver_for(WebProviderTarget::default())).is_err());
    }

    #[test]
    fn render_results_follows_kimi_cli_schema() {
        let results = vec![
            SearchResult {
                site_name: "Rust Blog".into(),
                title: "Announcing Rust".into(),
                url: "https://blog.rust-lang.org/a".into(),
                snippet: "The release".into(),
                content: String::new(),
                date: "2026-01-01".into(),
                ..Default::default()
            },
            SearchResult {
                site_name: "Docs".into(),
                title: "The Book".into(),
                url: "https://doc.rust-lang.org/book".into(),
                snippet: "Learn Rust".into(),
                content: "Full crawled page text".into(),
                date: String::new(),
                ..Default::default()
            },
        ];
        let (content, citations) = render_results(&results);
        assert_eq!(
            content,
            "Title: Announcing Rust\nDate: 2026-01-01\nURL: https://blog.rust-lang.org/a\n\
             Summary: The release\n\n---\n\nTitle: The Book\nDate: \n\
             URL: https://doc.rust-lang.org/book\nSummary: Learn Rust\n\n\
             Full crawled page text\n\n"
        );
        assert_eq!(
            citations,
            [
                "https://blog.rust-lang.org/a",
                "https://doc.rust-lang.org/book"
            ]
        );
    }

    /// The provider extension reports the date as `published_at`; the renderer
    /// must prefer it over the (empty) Kimi `date` field rather than printing
    /// a blank.
    #[test]
    fn provider_published_at_reaches_the_rendered_date() {
        let hit = SearchResult {
            title: "T".into(),
            url: "https://a.example".into(),
            snippet: "S".into(),
            published_at: Some("2026-02-02".into()),
            ..Default::default()
        };
        let (content, _) = render_results(&[hit]);
        assert!(content.contains("Date: 2026-02-02"), "{content}");
    }

    #[test]
    fn render_results_deduplicates_citations() {
        let hit = SearchResult {
            title: "T".into(),
            url: "https://same.example".into(),
            snippet: "S".into(),
            ..Default::default()
        };
        let (_, citations) = render_results(&[hit.clone(), hit]);
        assert_eq!(citations, ["https://same.example"]);
    }

    /// The provider wire sends `query`/`max_results` plus the routing slug, and
    /// parses `results[]`.
    #[tokio::test]
    async fn provider_search_sends_the_extension_wire() {
        use wiremock::matchers::{body_json, header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/search"))
            .and(header("authorization", "Bearer test-key"))
            .and(body_json(serde_json::json!({
                "query": "rust ownership",
                "max_results": 5,
                "model": "gw/model",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": "search",
                "results": [{
                    "title": "Ownership",
                    "url": "https://doc.rust-lang.org/ownership",
                    "snippet": "What is ownership?",
                    "published_at": "2026-05-01"
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (config, target) =
            enabled_config(&format!("{}/search", server.uri()), WebWire::Provider);
        let client = WebSearchClient::new(&config, target).unwrap();
        let (content, citations) = client
            .search("rust ownership", 5, false, "call-42")
            .await
            .unwrap();
        assert!(content.contains("Title: Ownership"), "{content}");
        assert!(content.contains("Date: 2026-05-01"), "{content}");
        assert_eq!(citations, ["https://doc.rust-lang.org/ownership"]);
    }

    /// An Anthropic-wire provider reads the key from `x-api-key`.
    #[tokio::test]
    async fn provider_search_honours_the_x_api_key_scheme() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/search"))
            .and(header("x-api-key", "test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": []
            })))
            .expect(1)
            .mount(&server)
            .await;

        let config = WebSearchConfig::Enabled {
            extra_headers: IndexMap::new(),
        };
        let target = resolver_for(WebProviderTarget {
            search: Some(WebEndpoint {
                auth_scheme: WebAuthScheme::XApiKey,
                ..endpoint(&format!("{}/search", server.uri()), WebWire::Provider)
            }),
            fetch: None,
            credential: Some("test-key".to_string()),
        });
        let client = WebSearchClient::new(&config, target).unwrap();
        client.search("q", 5, false, "c").await.unwrap();
    }

    #[tokio::test]
    async fn search_sends_kimi_wire_contract_and_parses_results() {
        use wiremock::matchers::{body_json, header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/search"))
            .and(header("authorization", "Bearer test-key"))
            .and(header("x-msh-tool-call-id", "call-42"))
            .and(body_json(serde_json::json!({
                "text_query": "rust ownership",
                "limit": 5,
                "enable_page_crawling": false,
                "timeout_seconds": 30,
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "search_results": [{
                    "site_name": "Docs",
                    "title": "Ownership",
                    "url": "https://doc.rust-lang.org/ownership",
                    "snippet": "What is ownership?",
                    "content": "",
                    "date": "2026-05-01",
                    "icon": "",
                    "mime": ""
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (config, target) = enabled_config(&format!("{}/search", server.uri()), WebWire::Kimi);
        let client = WebSearchClient::new(&config, target).unwrap();
        let (content, citations) = client
            .search("rust ownership", 5, false, "call-42")
            .await
            .unwrap();
        assert!(content.contains("Title: Ownership"));
        assert!(content.contains("URL: https://doc.rust-lang.org/ownership"));
        assert_eq!(citations, ["https://doc.rust-lang.org/ownership"]);
    }

    #[tokio::test]
    async fn search_maps_401_to_unauthorized() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let (config, target) =
            enabled_config(&format!("{}/search", server.uri()), WebWire::Provider);
        let client = WebSearchClient::new(&config, target).unwrap();
        let err = client.search("q", 5, false, "c").await.unwrap_err();
        assert!(err.to_string().contains("401"), "{err}");
    }

    #[tokio::test]
    async fn search_surfaces_server_errors_with_the_endpoint() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let (config, target) =
            enabled_config(&format!("{}/search", server.uri()), WebWire::Provider);
        let client = WebSearchClient::new(&config, target).unwrap();
        let err = client.search("q", 5, false, "c").await.unwrap_err();
        let message = err.to_string();
        assert!(message.contains("503"), "{message}");
        assert!(
            message.contains("/search"),
            "the error must name the endpoint that failed: {message}"
        );
    }

    /// A provider that serves no search must produce a clear error, never a
    /// request to a URL that cannot exist.
    #[tokio::test]
    async fn a_provider_without_search_reports_it_plainly() {
        let config = WebSearchConfig::Enabled {
            extra_headers: IndexMap::new(),
        };
        let target = resolver_for(WebProviderTarget::default());
        let client = WebSearchClient::new(&config, target).unwrap();
        let err = client.search("q", 5, false, "c").await.unwrap_err();
        assert!(
            err.to_string().contains("serves no search endpoint"),
            "{err}"
        );
    }
}
