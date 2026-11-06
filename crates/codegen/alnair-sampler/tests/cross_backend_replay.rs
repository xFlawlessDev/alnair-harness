//! Stream a tool turn, persist it, then continue it through each wire backend.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alnair_sampler::{
    ApiBackend, AuthScheme, RequestId, RetryPolicy, SamplerActor, SamplerConfig, SamplingEvent,
};
use alnair_sampling_types::{
    ContentPart, ConversationItem, ConversationRequest, ConversationResponse, ReasoningEffort,
    ToolSpec,
};
use alnair_test_support::sse;
use axum::http::HeaderMap;
use axum::response::sse::{Event, Sse};
use axum::routing::post;
use axum::{Json, Router};
use futures_util::stream;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

const MODEL: &str = "shared-model";
const IMAGE: &str = "data:image/png;base64,iVBORw0KGgo=";
const SIGNATURE: &str = "messages-signature";
const ENCRYPTED: &str = "responses-encrypted-content";
const JWT: &str = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC10ZXN0LTQyIn0sInN1YiI6InVzZXItMSJ9.sig";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Wire {
    Chat,
    Messages,
    Responses,
    Codex,
}

impl Wire {
    const ALL: [Self; 4] = [Self::Chat, Self::Messages, Self::Responses, Self::Codex];

    fn endpoint(self) -> &'static str {
        match self {
            Self::Chat => "chat/completions",
            Self::Messages => "messages",
            Self::Responses | Self::Codex => "responses",
        }
    }

    fn config(self, base_url: String) -> SamplerConfig {
        SamplerConfig {
            model: MODEL.into(),
            base_url,
            api_key: Some(JWT.into()),
            api_backend: match self {
                Self::Chat => ApiBackend::ChatCompletions,
                Self::Messages => ApiBackend::Messages,
                Self::Responses | Self::Codex => ApiBackend::Responses,
            },
            auth_scheme: if self == Self::Messages {
                AuthScheme::XApiKey
            } else {
                AuthScheme::Bearer
            },
            openai_codex: self == Self::Codex,
            chat_compat: alnair_sampling_types::ChatCompat::Passthrough,
            max_completion_tokens: Some(1024),
            max_retries: Some(0),
            reasoning_effort: Some(ReasoningEffort::High),
            idle_timeout_secs: Some(5),
            ..Default::default()
        }
    }

    fn final_events(self) -> Vec<Event> {
        match self {
            Self::Chat => sse::chat_completion_events_exact("done", MODEL),
            Self::Messages => sse::messages_api_events("done", MODEL, "end_turn"),
            Self::Responses | Self::Codex => sse::responses_api_events_exact("done", MODEL),
        }
    }

    fn tool_events(self) -> Vec<Event> {
        let calls = [
            ("call/one:α", "{\"path\":\"one\"}"),
            ("call-two", "{\"path\":\"two\"}"),
        ];
        let values = match self {
            Self::Chat => vec![
                json!({"id":"chat-1", "object":"chat.completion.chunk", "created":0,
                    "model":MODEL, "choices":[{"index":0,"delta":{"role":"assistant",
                    "content":"reading files", "reasoning_content":"thinking text",
                    "tool_calls":calls.iter().enumerate().map(|(i, (id, args))| json!({
                        "index":i,"id":id,"type":"function",
                        "function":{"name":"read_file","arguments":args}
                    })).collect::<Vec<_>>()},"finish_reason":"tool_calls"}],
                    "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}),
            ],
            Self::Messages => {
                let mut events = vec![
                    json!({"type":"message_start","message":{"id":"msg-1","type":"message",
                        "role":"assistant","content":[],"model":MODEL,"stop_reason":null,
                        "usage":{"input_tokens":10,"output_tokens":0}}}),
                    json!({"type":"content_block_start","index":0,
                        "content_block":{"type":"thinking","thinking":"","signature":""}}),
                    json!({"type":"content_block_delta","index":0,
                        "delta":{"type":"thinking_delta","thinking":"thinking text"}}),
                    json!({"type":"content_block_delta","index":0,
                        "delta":{"type":"signature_delta","signature":SIGNATURE}}),
                    json!({"type":"content_block_stop","index":0}),
                    json!({"type":"content_block_start","index":1,
                        "content_block":{"type":"text","text":""}}),
                    json!({"type":"content_block_delta","index":1,
                        "delta":{"type":"text_delta","text":"reading files"}}),
                    json!({"type":"content_block_stop","index":1}),
                ];
                for (i, (id, args)) in calls.iter().enumerate() {
                    let index = i + 2;
                    events.extend([
                        json!({"type":"content_block_start","index":index,
                            "content_block":{"type":"tool_use","id":id,"name":"read_file","input":{}}}),
                        json!({"type":"content_block_delta","index":index,
                            "delta":{"type":"input_json_delta","partial_json":args}}),
                        json!({"type":"content_block_stop","index":index}),
                    ]);
                }
                events.extend([
                    json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},
                        "usage":{"output_tokens":5}}),
                    json!({"type":"message_stop"}),
                ]);
                events
            }
            Self::Responses | Self::Codex => {
                let mut output = vec![
                    json!({"type":"reasoning","id":"rs_native","summary":[
                        {"type":"summary_text","text":"thinking text"}],
                        "encrypted_content":ENCRYPTED}),
                    json!({"type":"message","id":"msg_native","role":"assistant",
                        "status":"completed","content":[{"type":"output_text",
                        "text":"reading files","annotations":[]}]}),
                ];
                let mut events = Vec::new();
                for (i, (id, args)) in calls.iter().enumerate() {
                    let item = json!({"type":"function_call","id":format!("fc_{i}"),
                        "call_id":id,"name":"read_file","arguments":args,"status":"completed"});
                    events.extend([
                        json!({"type":"response.output_item.added","sequence_number":i * 2,
                            "output_index":i + 2,"item":item}),
                        json!({"type":"response.function_call_arguments.delta","sequence_number":i * 2 + 1,
                            "output_index":i + 2,"item_id":format!("fc_{i}"),"delta":args}),
                    ]);
                    output.push(item);
                }
                events.push(json!({"type":"response.completed","sequence_number":10,
                    "response":{"id":"resp-1","object":"response","created_at":0,
                    "model":MODEL,"status":"completed","output":output,
                    "usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,
                        "input_tokens_details":{"cached_tokens":0},
                        "output_tokens_details":{"reasoning_tokens":1}}}}));
                events
            }
        };
        values
            .into_iter()
            .map(|value| Event::default().data(value.to_string()))
            .collect()
    }
}

fn request() -> ConversationRequest {
    ConversationRequest {
        model: Some(MODEL.into()),
        items: vec![
            ConversationItem::system("follow instructions"),
            ConversationItem::user("inspect files"),
        ],
        tools: vec![ToolSpec {
            name: "read_file".into(),
            description: Some("Read a file".into()),
            parameters: json!({"type":"object","properties":{"path":{"type":"string"}},
                "required":["path"],"additionalProperties":false}),
        }],
        ..Default::default()
    }
}

async fn collect(config: SamplerConfig, req: ConversationRequest) -> ConversationResponse {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = SamplerActor::spawn(config, RetryPolicy::default(), tx);
    let (response, _) = tokio::time::timeout(
        Duration::from_secs(10),
        handle.submit_and_collect(RequestId::from("replay"), req),
    )
    .await
    .expect("sampling timed out")
    .expect("sampling failed");
    let mut tool_deltas = 0;
    while let Ok(event) = rx.try_recv() {
        if matches!(event, SamplingEvent::ToolCallDelta { .. }) {
            tool_deltas += 1;
        }
    }
    if !response.assistant().unwrap().tool_calls.is_empty() {
        assert!(
            tool_deltas >= 2,
            "tool calls must also be streamed to the UI"
        );
    }
    response
}

fn assert_replay(source: Wire, target: Wire, headers: &HeaderMap, body: &Value) {
    let serialized = body.to_string();
    assert!(serialized.contains("follow instructions"));
    assert!(serialized.contains("reading files"));
    assert!(serialized.contains("file one"));
    assert!(serialized.contains("file two"));
    assert_eq!(body["stream"], true);
    assert_eq!(body["model"], MODEL);
    assert_eq!(headers.contains_key("originator"), target == Wire::Codex);
    assert_eq!(
        headers.contains_key("chatgpt-account-id"),
        target == Wire::Codex
    );
    assert_eq!(headers.contains_key("x-api-key"), target == Wire::Messages);
    assert_eq!(
        headers.contains_key("authorization"),
        target != Wire::Messages
    );

    match target {
        Wire::Chat => {
            assert!(!serialized.contains(ENCRYPTED) && !serialized.contains(SIGNATURE));
            let messages = body["messages"].as_array().unwrap();
            let assistant = messages
                .iter()
                .find(|m| m.get("tool_calls").is_some())
                .unwrap();
            let calls = assistant["tool_calls"].as_array().unwrap();
            let results: Vec<_> = messages.iter().filter(|m| m["role"] == "tool").collect();
            assert_eq!(calls.len(), 2);
            assert_eq!(results.len(), 2);
            for (call, result) in calls.iter().zip(results) {
                assert_eq!(call["id"], result["tool_call_id"]);
                assert!(
                    result["content"].is_string(),
                    "tool images need a user message"
                );
            }
            assert!(serialized.contains(IMAGE));
        }
        Wire::Messages => {
            assert!(!serialized.contains(ENCRYPTED));
            let blocks: Vec<_> = body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|m| m["content"].as_array().unwrap())
                .collect();
            let calls: Vec<_> = blocks.iter().filter(|b| b["type"] == "tool_use").collect();
            let results: Vec<_> = blocks
                .iter()
                .filter(|b| b["type"] == "tool_result")
                .collect();
            assert_eq!(calls.len(), 2);
            assert_eq!(results.len(), 2);
            for (call, result) in calls.iter().zip(results) {
                assert_eq!(call["id"], result["tool_use_id"]);
            }
            assert_eq!(serialized.contains(SIGNATURE), source == Wire::Messages);
            assert!(serialized.contains("iVBORw0KGgo="));
        }
        Wire::Responses | Wire::Codex => {
            assert!(!serialized.contains(SIGNATURE));
            assert_eq!(body["store"], false);
            assert_eq!(body["reasoning"]["effort"], "high");
            assert!(
                body["include"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("reasoning.encrypted_content"))
            );
            assert!(body.get("previous_response_id").is_none_or(Value::is_null));
            let input = body["input"].as_array().unwrap();
            let calls: Vec<_> = input
                .iter()
                .filter(|i| i["type"] == "function_call")
                .collect();
            let results: Vec<_> = input
                .iter()
                .filter(|i| i["type"] == "function_call_output")
                .collect();
            assert_eq!(calls.len(), 2);
            assert_eq!(results.len(), 2);
            for (call, result) in calls.iter().zip(results) {
                assert_eq!(call["call_id"], result["call_id"]);
                assert!(
                    call["call_id"]
                        .as_str()
                        .unwrap()
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                );
            }
            assert_eq!(
                serialized.contains(ENCRYPTED),
                matches!(source, Wire::Responses | Wire::Codex)
            );
            assert!(serialized.contains(IMAGE));
            if target == Wire::Codex {
                assert_eq!(body["instructions"], "follow instructions");
                assert!(input.iter().all(|i| i["role"] != "system"));
            } else {
                assert!(input.iter().any(|i| i["role"] == "system"));
            }
        }
    }
}

#[tokio::test]
async fn tool_turns_replay_between_all_backends_after_session_serialization() {
    for source in Wire::ALL {
        for target in Wire::ALL {
            let captured = Arc::new(Mutex::new(None));
            let target_capture = captured.clone();
            let app = Router::new()
                .route(
                    &format!("/source/v1/{}", source.endpoint()),
                    post(move || async move {
                        Sse::new(stream::iter(
                            source.tool_events().into_iter().map(Ok::<_, Infallible>),
                        ))
                    }),
                )
                .route(
                    &format!("/target/v1/{}", target.endpoint()),
                    post(move |headers: HeaderMap, Json(body): Json<Value>| {
                        let captured = target_capture.clone();
                        async move {
                            *captured.lock().unwrap() = Some((headers, body));
                            Sse::new(stream::iter(
                                target.final_events().into_iter().map(Ok::<_, Infallible>),
                            ))
                        }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (shutdown_tx, shutdown_rx) = oneshot::channel();
            let server = tokio::spawn(async move {
                axum::serve(listener, app)
                    .with_graceful_shutdown(async {
                        shutdown_rx.await.ok();
                    })
                    .await
                    .unwrap();
            });

            let mut req = request();
            let response = collect(
                source.config(format!("http://{addr}/source/v1")),
                req.clone(),
            )
            .await;
            let calls = response.assistant().unwrap().tool_calls.clone();
            assert_eq!(calls.len(), 2, "source {source:?}");
            assert_eq!(calls[0].arguments.as_ref(), "{\"path\":\"one\"}");
            assert_eq!(
                response.assistant().unwrap().model_id.as_deref(),
                Some(MODEL)
            );
            assert!(response.usage.as_ref().unwrap().prompt_tokens > 0);

            let persisted = serde_json::to_vec(&response.items).unwrap();
            req.items
                .extend(serde_json::from_slice::<Vec<ConversationItem>>(&persisted).unwrap());
            req.items.push(ConversationItem::tool_result_with_images(
                calls[0].id.to_string(),
                "file one",
                vec![ContentPart::Image { url: IMAGE.into() }],
            ));
            req.items.push(ConversationItem::tool_result(
                calls[1].id.to_string(),
                "file two",
            ));
            let completed = collect(target.config(format!("http://{addr}/target/v1")), req).await;
            assert_eq!(
                completed.assistant_text(),
                "done",
                "{source:?} -> {target:?}"
            );

            let (headers, body) = captured.lock().unwrap().take().unwrap();
            assert_replay(source, target, &headers, &body);
            shutdown_tx.send(()).unwrap();
            server.await.unwrap();
        }
    }
}
