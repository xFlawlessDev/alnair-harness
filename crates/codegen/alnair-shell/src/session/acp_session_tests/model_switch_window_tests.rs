//! `handle_set_session_model` reports the session's effective context
//! window so clients repaint their header without waiting for a turn.
use super::support::*;

#[tokio::test(flavor = "current_thread")]
async fn set_session_model_returns_the_effective_context_window() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _rx) = build_actor().await;
            let cfg = alnair_sampler::SamplerConfig {
                model: "narrow".to_string(),
                context_window: 128_000,
                ..Default::default()
            };
            let (model_id, window) = actor
                .handle_set_session_model(cfg, None, false, false, true, 85)
                .await
                .expect("model switch");
            assert_eq!(model_id.0.as_ref(), "narrow");
            assert_eq!(window.get(), 128_000);
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn auxiliary_default_preserves_chat_endpoint_credentials_and_model_switches() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _rx) = build_actor().await;
            for model in ["provider/first", "provider/second"] {
                let cfg = alnair_sampler::SamplerConfig {
                    model: model.into(),
                    base_url: "https://example.test/v1".into(),
                    api_key: Some("test-provider-key".into()),
                    api_backend: alnair_sampler::ApiBackend::Messages,
                    context_window: 128_000,
                    ..Default::default()
                };
                actor
                    .handle_set_session_model(cfg, None, false, false, true, 85)
                    .await
                    .unwrap();
                let primary = actor.reconstruct_full_config().await;
                let auxiliary = actor.auxiliary_sampler_config(None).await;
                assert_eq!(auxiliary.model, model);
                assert_eq!(auxiliary.base_url, primary.base_url);
                assert_eq!(auxiliary.api_key, primary.api_key);
                assert_eq!(auxiliary.api_backend, primary.api_backend);
                let matching_hint = actor.auxiliary_sampler_config(Some(model)).await;
                assert_eq!(matching_hint.base_url, primary.base_url);
                assert_eq!(matching_hint.api_key, primary.api_key);
                assert_eq!(matching_hint.api_backend, primary.api_backend);
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn auxiliary_override_uses_its_own_provider_credentials_and_backend() {
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let (actor, _rx) = build_actor().await;
            let mut entry =
                crate::agent::config::ModelEntry::fallback("aux-wire-model", &Default::default());
            entry.info.id = Some("custom-provider/aux-model".into());
            entry.info.base_url = "https://auxiliary.example.test/v1".into();
            entry.api_base_url = Some(entry.info.base_url.clone());
            entry.api_key = Some("auxiliary-provider-key".into());
            entry.info.api_backend = alnair_sampler::ApiBackend::Responses;
            actor
                .models_manager
                .insert_test_entry("custom-provider/aux-model", entry);
            let config = actor
                .auxiliary_sampler_config(Some("custom-provider/aux-model"))
                .await;
            assert_eq!(config.model, "aux-wire-model");
            assert_eq!(config.base_url, "https://auxiliary.example.test/v1");
            assert_eq!(config.api_key.as_deref(), Some("auxiliary-provider-key"));
            assert_eq!(config.api_backend, alnair_sampler::ApiBackend::Responses);
            assert!(config.bearer_resolver.is_none());
        })
        .await;
}
