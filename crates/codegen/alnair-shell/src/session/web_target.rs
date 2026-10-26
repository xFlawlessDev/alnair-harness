//! Live resolution of a provider connection's web endpoints.
//!
//! `web_search` and `web_fetch` no longer belong to Kimi Code. Every provider
//! connection that speaks the OpenAI-compatible extension wire serves
//!
//! - `POST {base}/search`    — search
//! - `POST {base}/web/fetch` — server-side fetch
//!
//! and the tools must reach them at the base URL of the model the session is
//! sampling with **right now**. That "right now" is the whole reason this is a
//! resolver rather than a value captured at build time: `/model` can move a
//! session from one provider to another, and a captured endpoint would keep
//! posting to the provider it started on (or, worse, to the previous provider's
//! host with the new provider's key).
//!
//! Everything is read from the session's live chat state, which is already
//! per-model by construction:
//!
//! - `SamplingConfig` supplies the routing slug and the base URL the session's
//!   inference actually goes to (so a `[model.*]` override that re-points a
//!   model at another host is honoured);
//! - `Credentials` supplies the bearer that same model's requests carry — the
//!   one credential already resolved through the inference chokepoint, not a
//!   second opinion about it;
//! - the catalog entry **matching that base URL** supplies the auth scheme. A
//!   slug alone cannot: `anthropic` and `claude-pro-max` list identical ids,
//!   and they differ in both host and header style.
//!
//! Kimi Code keeps its own wire (`/search`, `/fetch`, `text_query`,
//! `search_results`) because it is a bespoke service rather than the extension
//! wire; the difference is expressed as [`WebWire::Kimi`], not a second path.

use std::sync::Arc;

use alnair_tools::types::web_provider::{
    WebAuthScheme, WebEndpoint, WebProviderTarget, WebTargetProvider, WebWire,
};

use crate::agent::models::ModelsManager;
use crate::session::acp_session::SessionActor;

/// Platform whose web services speak the bespoke Kimi wire.
const KIMI_CODE_PLATFORM: &str = "kimi-code";

/// Resolves the web endpoints for one session's current model.
pub(crate) struct SessionWebTarget {
    models_manager: ModelsManager,
    chat_state: alnair_chat_state::ChatStateHandle,
}

impl SessionWebTarget {
    pub(crate) fn new(actor: &SessionActor) -> Arc<Self> {
        Self::from_parts(
            actor.models_manager.clone(),
            actor.chat_state_handle.clone(),
        )
    }

    /// Build from the two live handles alone, so a session can wire its web
    /// resolver before the actor it will live on exists.
    pub(crate) fn from_parts(
        models_manager: ModelsManager,
        chat_state: alnair_chat_state::ChatStateHandle,
    ) -> Arc<Self> {
        Arc::new(Self {
            models_manager,
            chat_state,
        })
    }

    /// The catalog entry serving `(slug, base_url)`, when the catalog has one.
    ///
    /// The base URL is the discriminator on purpose: duplicate slugs across
    /// platforms are by design, and the host is what tells the twins apart
    /// without depending on per-session selection state.
    ///
    /// When no entry names that exact host, the slug is used only if it is
    /// UNIQUE across the catalog. A colliding slug (`anthropic`/`claude-pro-max`
    /// both list `claude-opus-4-8`) resolves to `None` rather than a guess: the
    /// guess would pick the wrong wire and the wrong header style for a host the
    /// catalog does not describe.
    fn entry_for<'a>(
        models: &'a indexmap::IndexMap<String, crate::agent::config::ModelEntry>,
        slug: &str,
        base_url: &str,
    ) -> Option<&'a crate::agent::config::ModelEntry> {
        let base = base_url.trim_end_matches('/');
        if let Some(entry) = models.values().find(|entry| {
            entry.info.model == slug && entry.info.base_url.trim_end_matches('/') == base
        }) {
            return Some(entry);
        }
        let mut matching = models.values().filter(|entry| entry.info.model == slug);
        let first = matching.next()?;
        matching.next().is_none().then_some(first)
    }

    /// The endpoint pair for `(platform, base_url)`.
    ///
    /// A provider that serves the extension wire always gets both endpoints:
    /// whether it actually implements them is discovered at call time, and a
    /// 404 from the real host is a better answer than refusing to try.
    fn endpoints_for(
        platform: Option<alnair_models::PlatformId>,
        base_url: &str,
        model: &str,
        auth_scheme: WebAuthScheme,
    ) -> (WebEndpoint, WebEndpoint) {
        let base = base_url.trim_end_matches('/');
        let is_kimi = platform.is_some_and(|p| p.as_str() == KIMI_CODE_PLATFORM);
        let (wire, search_path, fetch_path) = if is_kimi {
            (WebWire::Kimi, "/search", "/fetch")
        } else {
            (WebWire::Provider, "/search", "/web/fetch")
        };
        let routing_model = (!model.is_empty()).then(|| model.to_string());
        let endpoint = |path: &str| WebEndpoint {
            url: format!("{base}{path}"),
            wire,
            model: routing_model.clone(),
            auth_scheme,
        };
        (endpoint(search_path), endpoint(fetch_path))
    }
}

impl WebTargetProvider for SessionWebTarget {
    fn target(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = WebProviderTarget> + Send + '_>> {
        Box::pin(async move {
            let Some(sampling) = self.chat_state.get_sampling_config().await else {
                return WebProviderTarget::default();
            };
            let models = self.models_manager.models();
            let entry = Self::entry_for(&models, &sampling.model, &sampling.base_url);
            let platform = entry.and_then(|entry| {
                entry
                    .info()
                    .id
                    .as_deref()
                    .and_then(alnair_models::parse_managed_model_key)
                    .map(|(platform, _)| platform)
            });
            let auth_scheme = match entry.map(|entry| entry.info().auth_scheme) {
                Some(alnair_sampler::AuthScheme::XApiKey) => WebAuthScheme::XApiKey,
                _ => WebAuthScheme::Bearer,
            };
            let (search, fetch) =
                Self::endpoints_for(platform, &sampling.base_url, &sampling.model, auth_scheme);
            // The credential is the one this model's own inference carries,
            // already resolved through the chokepoint — read from the same live
            // slot so a `/model` switch cannot leave the previous provider's
            // key behind.
            let credential = self
                .chat_state
                .get_credentials()
                .await
                .api_key
                .filter(|key| !key.trim().is_empty());
            WebProviderTarget {
                search: Some(search),
                fetch: Some(fetch),
                credential,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kimi_code_keeps_its_own_paths_and_wire() {
        let platform = alnair_models::PlatformId::parse(KIMI_CODE_PLATFORM);
        let (search, fetch) = SessionWebTarget::endpoints_for(
            platform,
            "https://api.kimi.com/coding/v1",
            "kimi-k3",
            WebAuthScheme::Bearer,
        );
        assert_eq!(search.url, "https://api.kimi.com/coding/v1/search");
        assert_eq!(fetch.url, "https://api.kimi.com/coding/v1/fetch");
        assert_eq!(search.wire, WebWire::Kimi);
        assert_eq!(fetch.wire, WebWire::Kimi);
        assert_eq!(search.model.as_deref(), Some("kimi-k3"));
    }

    #[test]
    fn any_other_provider_gets_the_extension_wire() {
        let platform = alnair_models::PlatformId::parse("openai");
        let (search, fetch) = SessionWebTarget::endpoints_for(
            platform,
            "https://gw.example/v1/",
            "gw/model",
            WebAuthScheme::XApiKey,
        );
        assert_eq!(search.url, "https://gw.example/v1/search");
        assert_eq!(fetch.url, "https://gw.example/v1/web/fetch");
        assert_eq!(search.wire, WebWire::Provider);
        assert_eq!(fetch.wire, WebWire::Provider);
        assert_eq!(search.auth_scheme, WebAuthScheme::XApiKey);
        assert_eq!(fetch.auth_scheme, WebAuthScheme::XApiKey);
        assert_eq!(fetch.model.as_deref(), Some("gw/model"));
    }

    #[test]
    fn a_platform_less_model_still_resolves_the_extension_wire() {
        let (search, fetch) = SessionWebTarget::endpoints_for(
            None,
            "http://127.0.0.1:7878/v1",
            "deepseek-v4-1-flash",
            WebAuthScheme::Bearer,
        );
        assert_eq!(search.url, "http://127.0.0.1:7878/v1/search");
        assert_eq!(fetch.url, "http://127.0.0.1:7878/v1/web/fetch");
        assert_eq!(search.wire, WebWire::Provider);
    }

    #[test]
    fn an_empty_slug_omits_the_routing_model() {
        let (search, _) = SessionWebTarget::endpoints_for(
            None,
            "https://gw.example/v1",
            "",
            WebAuthScheme::Bearer,
        );
        assert!(search.model.is_none());
    }
}
