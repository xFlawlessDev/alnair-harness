//! Session summary (title) generation lifecycle.
//!
//! Encapsulates the full lifecycle: check if a summary already exists,
//! generate one via the LLM, persist it, sync to remote, update the
//! session registry, and notify the client. The persistence actor just
//! calls [`SummaryGenerator::update_with_sampler`] — all state transitions are internal.

use crate::extensions::notification::{SessionNotification, SessionUpdate as XaiSessionUpdate};
use crate::sampling::Client as OaiCompatClient;
use crate::session::helpers::session_summary::generate_session_summary;
use crate::session::info::Info;
use crate::session::persistence::PersistenceMsg;
use agent_client_protocol as acp;
use alnair_acp_lib::AcpAgentGatewaySender as GatewaySender;
use tokio::sync::mpsc;

/// Internal state for the summary generation lifecycle.
enum State {
    /// No summary generated yet. Will attempt on the next [`SummaryGenerator::update_with_sampler`] call.
    Idle,
    /// Summary generation has been attempted (spawned or already on disk). No further work needed.
    Done,
}

/// Dependencies for session title generation and fan-out.
pub(crate) struct SummaryConfig {
    pub(crate) sampling_client: OaiCompatClient,
    pub(crate) model: String,
    /// Channel back to the persistence actor for sequential storage writes.
    pub(crate) persistence_tx: mpsc::UnboundedSender<PersistenceMsg>,
}

/// Manages session title generation with explicit lifecycle state.
///
/// Created once per persistence actor. The only public method is [`Self::update_with_sampler`],
/// which is called from the `ContentChunk` handler. Internally it transitions
/// through `Idle -> Done`, spawning the LLM call as a background task and
/// routing the result back through the persistence channel for storage.
pub(crate) struct SummaryGenerator {
    state: State,
    config: SummaryConfig,
}

impl SummaryGenerator {
    pub(crate) fn new(config: SummaryConfig) -> Self {
        Self {
            state: State::Idle,
            config,
        }
    }

    /// Generate a session summary from the first content chunk.
    ///
    /// - **Idle**: checks disk for an existing summary, spawns a background
    ///   task for LLM title generation so the persistence actor is not blocked.
    ///   Empty content is skipped (stays Idle) so the next chunk can retry.
    /// - **Done**: no-op.
    pub(crate) fn update_with_sampler(
        &mut self,
        content: String,
        sampler: Option<Box<crate::sampling::SamplerConfig>>,
    ) {
        match self.state {
            State::Done => {}
            State::Idle => {
                // No text to generate a title from (e.g. image-only message).
                // Stay Idle so the next ContentChunk with actual text retries.
                if content.trim().is_empty() {
                    return;
                }

                // Transition to Done so subsequent ContentChunk messages
                // don't spawn duplicate title generation tasks.
                self.state = State::Done;

                let (sampling_client, model) = match sampler {
                    Some(config) => {
                        let model = config.model.clone();
                        match OaiCompatClient::new(*config) {
                            Ok(client) => (client, model),
                            Err(error) => {
                                tracing::warn!(%error, "failed to build session title client");
                                let title = crate::session::helpers::session_summary::title_fallback_from_user_text(&content);
                                let _ = self
                                    .config
                                    .persistence_tx
                                    .send(PersistenceMsg::GeneratedTitle(title));
                                return;
                            }
                        }
                    }
                    None => (
                        self.config.sampling_client.clone(),
                        self.config.model.clone(),
                    ),
                };
                let persistence_tx = self.config.persistence_tx.clone();

                // Spawn title generation as a background task so the
                // persistence actor can continue processing messages
                // (updates, flushes) without waiting for the LLM call.
                tokio::spawn(async move {
                    let mut title =
                        generate_session_summary(content.clone(), sampling_client, &model).await;
                    if title.trim().is_empty() {
                        title =
                            crate::session::helpers::session_summary::title_fallback_from_user_text(
                                &content,
                            );
                    }

                    // Route the result through the persistence channel. The
                    // actor persists it (only if the session has no title yet)
                    // and notifies the client there, so a title rejected for
                    // racing a manual `/rename` never reaches the client.
                    let _ = persistence_tx.send(PersistenceMsg::GeneratedTitle(title));
                });
            }
        }
    }

    /// Mark as Done (e.g. when disk already has a summary during load).
    pub(crate) fn mark_done(&mut self) {
        self.state = State::Done;
    }
}

/// Notify the client that a session summary is available.
pub(crate) fn notify_client(gateway: &Option<GatewaySender>, info: &Info, title: &str) {
    let Some(gateway) = gateway else {
        return;
    };

    let notification = SessionNotification {
        session_id: info.id.clone(),
        update: XaiSessionUpdate::SessionSummaryGenerated {
            session_summary: title.to_owned(),
        },
        meta: None,
    };
    if let Ok(params) = serde_json::value::to_raw_value(&notification) {
        gateway.forward_fire_and_forget(acp::ExtNotification::new(
            "alnair/session_notification",
            params.into(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn auxiliary_title_uses_the_sampler_supplied_with_the_first_prompt() {
        let server = wiremock::MockServer::start().await;
        let response = serde_json::json!({
            "id": "title-response", "object": "chat.completion.chunk", "created": 0,
            "model": "current-chat",
            "choices": [{"index": 0, "finish_reason": "tool_calls", "delta": {
                "role": "assistant", "content": null,
                "tool_calls": [{"index": 0, "id": "title-call", "type": "function", "function": {
                    "name": "session_title", "arguments": "{\"session_title\":\"A generated session title\"}"
                }}]
            }}]
        });
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::body_partial_json(
                serde_json::json!({"model": "current-chat"}),
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(format!("data: {response}\n\ndata: [DONE]\n\n")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let mut config = crate::sampling::SamplerConfig {
            base_url: server.uri(),
            api_key: Some("test-key".into()),
            model: "creation-time-model".into(),
            api_backend: crate::sampling::ApiBackend::ChatCompletions,
            max_retries: Some(0),
            ..Default::default()
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut generator = SummaryGenerator::new(SummaryConfig {
            sampling_client: OaiCompatClient::new(config.clone()).unwrap(),
            model: config.model.clone(),
            persistence_tx: tx,
        });
        config.model = "current-chat".into();
        generator.update_with_sampler("Fix the authentication bug".into(), Some(Box::new(config)));
        let message = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let PersistenceMsg::GeneratedTitle(title) = message else {
            panic!("expected generated title")
        };
        assert_eq!(title, "A generated session title");
        generator.update_with_sampler("Later message".into(), None);
        assert!(rx.try_recv().is_err());
    }
}
