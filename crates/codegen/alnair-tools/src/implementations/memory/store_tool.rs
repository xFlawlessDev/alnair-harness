//! `memory_store` tool — the model-facing write path into durable memory.
//!
//! The read half (`memory_search` / `memory_get`) already existed; this is the
//! only way a model can record a note *during* a turn. Everything else
//! (`/flush`, the session-end hook, `/dream`) is user- or schedule-driven.
//!
//! The tool deliberately does almost nothing itself: validation lives in
//! [`super::policy`], the write and reindex live behind
//! [`MemoryWriteBackend`]. That keeps the filesystem and SQLite work in the
//! backend crate, which is the only crate that already depends on them.

use std::sync::Arc;

use super::policy;
use super::types::MemoryStoreInput;
use crate::types::memory_backend::{MemoryWriteBackend, MemoryWriteScope};
use crate::types::output::ToolOutput;
use crate::types::tool::{ToolKind, ToolNamespace};

#[derive(Debug, Default)]
pub struct MemoryStoreImpl;

impl crate::types::tool_metadata::ToolMetadata for MemoryStoreImpl {
    fn kind(&self) -> ToolKind {
        ToolKind::MemoryStore
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::Alnair
    }

    fn description_template(&self) -> &str {
        "Store a durable note in cross-session memory. It will be retrievable by `memory_search` \
         in every future session in this workspace.\n\n\
         Use this for knowledge that outlives the current turn and would otherwise have to be \
         re-derived:\n\
         - A decision and the reason behind it\n\
         - A project convention or invariant a newcomer would trip over\n\
         - A non-obvious gotcha (a platform quirk, an ordering requirement)\n\
         - Where something lives (which crate owns a behaviour, which secret store holds a key)\n\n\
         Do NOT use this for:\n\
         - Progress notes or a to-do list (use the todo tool)\n\
         - Facts you can re-derive from the code in one read\n\
         - Anything already in AGENTS.md — that file is read automatically\n\n\
         Write one fact per call, phrased so it is actionable without the conversation that \
         produced it. Name the file, symbol, or command involved. Never store credentials — \
         store where the credential lives instead."
    }
}

impl alnair_tool_runtime::Tool for MemoryStoreImpl {
    type Args = MemoryStoreInput;
    type Output = ToolOutput;

    fn id(&self) -> alnair_tool_protocol::ToolId {
        alnair_tool_protocol::ToolId::new("memory_store").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::alnair_tool_runtime::ListToolsContext,
    ) -> alnair_tool_types::ToolDescription {
        alnair_tool_types::ToolDescription::new(
            "memory_store",
            crate::types::tool_metadata::ToolMetadata::description_template(self),
        )
    }

    fn capabilities(&self) -> alnair_tool_protocol::ToolCapabilities {
        alnair_tool_protocol::ToolCapabilities {
            is_read_only: false,
            tool_scope: Some(alnair_tool_protocol::ToolScope::Write),
            ..Default::default()
        }
    }

    #[tracing::instrument(
        name = "tool.memory_store",
        skip_all,
        fields(chars = input.content.chars().count(), scope = ?input.scope)
    )]
    async fn run(
        &self,
        ctx: alnair_tool_runtime::ToolCallContext,
        input: MemoryStoreInput,
    ) -> Result<ToolOutput, alnair_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;
        // Clone the Arc out of the resource lock before any `.await`, so the
        // guard is not held across the write.
        let Some(memory) = resources
            .lock()
            .await
            .get::<Arc<dyn MemoryWriteBackend>>()
            .cloned()
        else {
            return Ok(ToolOutput::Text(
                "Memory is not enabled. Enable it with `[memory] enabled = true` in config.toml \
                 or ALNAIR_MEMORY=1, then start a new session."
                    .into(),
            ));
        };

        let scope = match input.scope.as_deref() {
            None => MemoryWriteScope::Workspace,
            Some(raw) => match MemoryWriteScope::parse(raw) {
                Some(scope) => scope,
                None => {
                    return Ok(ToolOutput::Text(
                        format!(
                            "refused: unknown scope {raw:?}. Use \"workspace\" (this project) or \
                             \"global\" (all projects)."
                        )
                        .into(),
                    ));
                }
            },
        };

        if let Err(rejection) = policy::validate(&input.content) {
            tracing::info!(
                target: crate::types::memory_backend::MEMORY_LOG_TARGET,
                rule = ?rejection,
                "MEMORY_STORE: refused by policy"
            );
            return Ok(ToolOutput::Text(rejection.message().into()));
        }

        // A consolidation pass rewrites the memory files; appending into one it
        // is about to replace loses the note silently, so refuse instead.
        if memory.is_consolidating() {
            return Ok(ToolOutput::Text(
                "Memory consolidation is running right now. Retry in a moment.".into(),
            ));
        }

        tracing::info!(
            target: crate::types::memory_backend::MEMORY_LOG_TARGET,
            scope = scope.as_str(),
            "MEMORY_STORE: invoked"
        );
        let tool_id = alnair_tool_protocol::ToolId::new("memory_store").expect("valid tool id");
        let outcome = memory.append(scope, &input.content).await.map_err(|e| {
            alnair_tool_runtime::ToolError::execution(
                tool_id.clone(),
                format!("memory store failed: {e}"),
            )
        })?;

        tracing::info!(
            target: crate::types::memory_backend::MEMORY_LOG_TARGET,
            bytes = outcome.bytes_written,
            indexed = outcome.indexed,
            "MEMORY_STORE: complete"
        );

        // Never echo the content back: the model already has it, and repeating it
        // costs tokens for no information.
        let mut output = format!(
            "Stored {} bytes in {}.",
            outcome.bytes_written, outcome.path
        );
        if !outcome.indexed {
            output.push_str(
                " The note is saved but not indexed yet; it becomes searchable on the next \
                 `memory_search`.",
            );
        }
        Ok(ToolOutput::Text(output.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::memory_backend::AppendOutcome;
    use std::sync::Mutex;

    /// Records calls so the tool's argument handling can be asserted without a
    /// real memory store.
    #[derive(Default)]
    struct FakeWriteBackend {
        calls: Mutex<Vec<(MemoryWriteScope, String)>>,
        consolidating: bool,
    }

    #[async_trait::async_trait]
    impl MemoryWriteBackend for FakeWriteBackend {
        async fn append(
            &self,
            scope: MemoryWriteScope,
            content: &str,
        ) -> Result<AppendOutcome, Box<dyn std::error::Error + Send + Sync>> {
            self.calls
                .lock()
                .unwrap()
                .push((scope, content.to_string()));
            Ok(AppendOutcome {
                path: "/tmp/MEMORY.md".into(),
                bytes_written: content.len(),
                indexed: true,
            })
        }

        fn is_consolidating(&self) -> bool {
            self.consolidating
        }
    }

    fn tool_id() -> alnair_tool_protocol::ToolId {
        alnair_tool_protocol::ToolId::new("memory_store").expect("valid")
    }

    #[test]
    fn tool_id_matches_the_registered_constant() {
        assert_eq!(
            alnair_tool_runtime::Tool::id(&MemoryStoreImpl).to_string(),
            super::super::MEMORY_STORE_TOOL_NAME
        );
    }

    #[test]
    fn the_tool_is_a_write_not_a_read() {
        // The capability bit drives permission prompts and multi-agent routing;
        // a durable write must never claim to be read-only.
        let caps = alnair_tool_runtime::Tool::capabilities(&MemoryStoreImpl);
        assert!(!caps.is_read_only, "memory_store must not be read-only");
        assert_eq!(
            caps.tool_scope,
            Some(alnair_tool_protocol::ToolScope::Write)
        );
    }

    #[test]
    fn kind_is_its_own_variant() {
        // TemplateRenderer's by_kind map holds one tool name per kind, so
        // sharing MemorySearch would silently redirect `${{ tools.by_kind.* }}`.
        assert_eq!(
            crate::types::tool_metadata::ToolMetadata::kind(&MemoryStoreImpl),
            ToolKind::MemoryStore
        );
    }

    #[test]
    fn namespace_is_alnair() {
        assert_eq!(
            crate::types::tool_metadata::ToolMetadata::tool_namespace(&MemoryStoreImpl),
            ToolNamespace::Alnair
        );
    }

    /// The fake backend is exercised directly (not through `run`, which needs a
    /// `ToolCallContext`); this pins the trait shape the tool depends on.
    #[tokio::test]
    async fn append_receives_the_scope_and_content() {
        let backend = FakeWriteBackend::default();
        backend
            .append(MemoryWriteScope::Global, "note")
            .await
            .unwrap();
        let calls = backend.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, MemoryWriteScope::Global);
        assert_eq!(calls[0].1, "note");
    }

    #[test]
    fn default_is_not_consolidating() {
        assert!(!FakeWriteBackend::default().is_consolidating());
    }

    #[test]
    fn id_helper_is_valid() {
        assert_eq!(tool_id().to_string(), "memory_store");
    }
}
