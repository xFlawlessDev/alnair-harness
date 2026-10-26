//! Where the web tools send their requests.
//!
//! `web_search` and `web_fetch` used to be Kimi-only: the search service
//! (`POST {coding_base}/search`) and the fetch service
//! (`POST {coding_base}/fetch`) exist solely on the Kimi Code subscription
//! channel, so both tools were gated on an OAuth session and were simply
//! absent for every other provider. That made them useless the moment the CLI
//! became provider-agnostic.
//!
//! A provider connection that speaks the OpenAI-compatible extension wire
//! serves the same two capabilities under its OWN base URL:
//!
//! - `POST {base}/search`      — search, normalized to `results[]`
//! - `POST {base}/web/fetch`   — server-side fetch, body is the page itself
//!
//! This module is the single description of "which endpoint, which wire, which
//! credential". The endpoints are resolved per request through
//! [`WebTargetProvider`], never captured at build time: a session can switch
//! providers mid-run, and a captured URL would keep posting to the provider it
//! started on.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Which wire dialect a web endpoint speaks.
///
/// The two are not interchangeable: the Kimi services take `text_query` and
/// answer `search_results`, while the provider extension takes `query` and
/// answers `results`. Sending one shape to the other host is a 400, so the
/// dialect travels WITH the URL instead of being sniffed at the call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebWire {
    /// `POST {base}/search` + `POST {base}/web/fetch`, `query`/`max_results`,
    /// `results[]`. The provider-connection extension.
    Provider,
    /// Kimi Code's `POST {base}/search` + `POST {base}/fetch`,
    /// `text_query`/`limit`, `search_results[]`, `X-Msh-Tool-Call-Id`.
    Kimi,
}

/// Header style for the web endpoints, mirroring the model wire's
/// `AuthScheme` so one provider never sends its key two different ways.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebAuthScheme {
    /// `Authorization: Bearer <key>`.
    #[default]
    Bearer,
    /// `x-api-key: <key>` (Anthropic-wire providers).
    XApiKey,
}

/// One resolved web endpoint: URL + dialect + the routing slug the provider
/// uses to pick a backend.
///
/// `model` is load-bearing for a provider that multiplexes many upstreams
/// behind one base URL (an OpenAI-compatible router): `/search` needs to know
/// which connection to resolve. A provider that serves search directly ignores
/// the field, so it is always safe to send — but it is omitted when the session
/// has no routing slug at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebEndpoint {
    /// Absolute URL, e.g. `https://gw.example/v1/search`.
    pub url: String,
    pub wire: WebWire,
    /// The routing slug the endpoint should resolve to, when it wants one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Header style for the credential.
    #[serde(default)]
    pub auth_scheme: WebAuthScheme,
}

impl WebEndpoint {
    /// The `{base}` every endpoint of one connection shares, with a trailing
    /// slash trimmed: `https://gw.example/v1` from `https://gw.example/v1/search`.
    pub fn base(&self) -> &str {
        self.url
            .strip_suffix("/web/fetch")
            .or_else(|| self.url.strip_suffix("/search"))
            .unwrap_or(&self.url)
            .trim_end_matches('/')
    }
}

/// Everything the two web tools need to reach a provider connection.
///
/// Produced per request by [`WebTargetProvider::target`]. `None` for a field
/// means "this connection does not serve that capability": `web_search` then
/// reports it plainly, and `web_fetch` falls back to its local pipeline.
#[derive(Debug, Clone, Default)]
pub struct WebProviderTarget {
    /// `POST {base}/search`, when the connection serves search.
    pub search: Option<WebEndpoint>,
    /// `POST {base}/web/fetch`, when the connection serves server-side fetch.
    pub fetch: Option<WebEndpoint>,
    /// The credential to send, resolved for the SAME model whose base URL the
    /// endpoints name. `None` sends none — never a fabricated one.
    pub credential: Option<String>,
}

impl WebProviderTarget {
    /// Nothing is served: both tools keep their pre-provider behavior.
    pub fn is_empty(&self) -> bool {
        self.search.is_none() && self.fetch.is_none()
    }
}

/// Resolves the web endpoints for the session's CURRENT model.
///
/// A session's provider can change mid-session (`/model`), and the toolset is
/// built once, so the endpoints cannot be captured at build time. The resolver
/// is asked per call instead, which is also where a rotating credential is
/// re-read.
///
/// Implemented by `alnair-shell` over the live chat state and the catalog;
/// `alnair-tools` cannot depend on those, so this trait is the seam.
pub trait WebTargetProvider: Send + Sync + 'static {
    fn target(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = WebProviderTarget> + Send + '_>>;
}

pub type SharedWebTargetProvider = Arc<dyn WebTargetProvider>;

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(url: &str) -> WebEndpoint {
        WebEndpoint {
            url: url.to_string(),
            wire: WebWire::Provider,
            model: Some("gw/model".into()),
            auth_scheme: WebAuthScheme::Bearer,
        }
    }

    #[test]
    fn base_strips_the_capability_path() {
        assert_eq!(
            endpoint("https://gw.example/v1/search").base(),
            "https://gw.example/v1"
        );
        assert_eq!(
            endpoint("https://gw.example/v1/web/fetch").base(),
            "https://gw.example/v1"
        );
    }

    #[test]
    fn base_falls_back_to_the_whole_url() {
        assert_eq!(
            endpoint("https://gw.example/search").base(),
            "https://gw.example"
        );
        assert_eq!(
            endpoint("https://gw.example/v1").base(),
            "https://gw.example/v1"
        );
    }

    #[test]
    fn empty_target_serves_nothing() {
        assert!(WebProviderTarget::default().is_empty());
    }

    #[test]
    fn a_target_with_one_capability_is_not_empty() {
        let target = WebProviderTarget {
            search: Some(endpoint("https://gw.example/v1/search")),
            ..Default::default()
        };
        assert!(!target.is_empty());
    }

    /// An endpoint round-trips through serde, so a target can be reported to a
    /// client without losing its wire or scheme.
    #[test]
    fn endpoint_serde_roundtrip() {
        let mut original = endpoint("https://gw.example/v1/search");
        original.auth_scheme = WebAuthScheme::XApiKey;
        original.wire = WebWire::Kimi;
        let json = serde_json::to_string(&original).unwrap();
        let parsed: WebEndpoint = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, original);
    }
}
