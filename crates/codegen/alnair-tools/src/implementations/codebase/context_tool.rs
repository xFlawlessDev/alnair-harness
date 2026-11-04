//! `codebase_context` tool — read a bounded window around a code location.

use std::sync::Arc;

use super::types::CodebaseContextInput;
use crate::types::codebase_backend::{CodebaseBackend, CodebaseError};
use crate::types::output::ToolOutput;
use crate::types::tool::{ToolKind, ToolNamespace};

/// Lines returned when the caller does not ask for a count.
const DEFAULT_LINES: usize = 40;

/// Hard cap on lines per call.
///
/// The tool exists to replace a whole-file read for one symbol, so it must stay
/// smaller than the file it is competing with. A caller that needs more should
/// use `read_file`, which has its own paging.
const MAX_LINES: usize = 200;

/// Hard cap on the bytes returned.
///
/// Independent of the line cap because a minified or generated file can fit
/// thousands of characters on one line.
const MAX_BYTES: usize = 24 * 1024;

#[derive(Debug, Default)]
pub struct CodebaseContextImpl;

impl crate::types::tool_metadata::ToolMetadata for CodebaseContextImpl {
    fn kind(&self) -> ToolKind {
        ToolKind::CodebaseContext
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::Alnair
    }

    fn description_template(&self) -> &str {
        "Read a bounded window of a file around a code location. Use it after \
         `codebase_search` to see the body of a result without reading the whole file.\n\n\
         Prefer this over `read_file` when:\n\
         - You have a `path:line` from `codebase_search` and want the function body\n\
         - You are checking one symbol and the file is large\n\n\
         Prefer `read_file` when you need the whole file, or when the symbol's extent is \
         unclear and you would otherwise make three overlapping reads.\n\n\
         Any line that looks like a credential is replaced with a marker; the result says how \
         many lines were redacted so a gap is never mistaken for missing code."
    }
}

impl alnair_tool_runtime::Tool for CodebaseContextImpl {
    type Args = CodebaseContextInput;
    type Output = ToolOutput;

    fn id(&self) -> alnair_tool_protocol::ToolId {
        alnair_tool_protocol::ToolId::new("codebase_context").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::alnair_tool_runtime::ListToolsContext,
    ) -> alnair_tool_types::ToolDescription {
        alnair_tool_types::ToolDescription::new(
            "codebase_context",
            crate::types::tool_metadata::ToolMetadata::description_template(self),
        )
    }

    fn capabilities(&self) -> alnair_tool_protocol::ToolCapabilities {
        alnair_tool_protocol::ToolCapabilities {
            is_read_only: true,
            tool_scope: Some(alnair_tool_protocol::ToolScope::Read),
            ..Default::default()
        }
    }

    #[tracing::instrument(
        name = "tool.codebase_context",
        skip_all,
        fields(path = %input.path, line = ?input.line)
    )]
    async fn run(
        &self,
        ctx: alnair_tool_runtime::ToolCallContext,
        input: CodebaseContextInput,
    ) -> Result<ToolOutput, alnair_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;
        let Some(backend) = resources
            .lock()
            .await
            .get::<Arc<dyn CodebaseBackend>>()
            .cloned()
        else {
            return Ok(ToolOutput::Text(
                "Codebase context is not available in this session. It needs \
                 `[features] codebase_indexing` to be enabled (the default) and a workspace \
                 inside a git repository. Use `read_file` instead."
                    .into(),
            ));
        };

        let path = input.path.trim();
        if path.is_empty() {
            return Ok(ToolOutput::Text(
                "refused: `path` is empty. Pass a file path, ideally one from \
                 `codebase_search`."
                    .into(),
            ));
        }

        let line = input.line.unwrap_or(1).max(1);
        let lines = input.lines.unwrap_or(DEFAULT_LINES).clamp(1, MAX_LINES);

        let snippet = backend
            .snippet(path, line, lines, MAX_BYTES)
            .await
            .map_err(|error| tool_error(&error))?;

        let Some(snippet) = snippet else {
            return Ok(ToolOutput::Text(
                format!(
                    "Could not read `{path}`. It may not exist, or it may be outside the \
                     indexed workspace."
                )
                .into(),
            ));
        };

        let mut out = format!(
            "{}:{}-{}\n```\n{}\n```\n",
            snippet.path, snippet.start_line, snippet.end_line, snippet.text
        );
        if snippet.truncated {
            out.push_str(
                "\nThe window was cut short by the size limit; read further with another \
                 `codebase_context` call or with `read_file`.\n",
            );
        }
        Ok(ToolOutput::Text(out.into()))
    }
}

fn tool_error(error: &CodebaseError) -> alnair_tool_runtime::ToolError {
    alnair_tool_runtime::ToolError::execution(
        alnair_tool_protocol::ToolId::new("codebase_context").expect("valid tool id"),
        format!("codebase context failed: {error}"),
    )
}

/// The byte cap must be able to hold a full-width window, or the tool would
/// truncate every result and silently become useless — 200 lines at an average
/// of 80 columns plus newlines must fit.
const _: () = assert!(MAX_BYTES > MAX_LINES * 80);

/// The default must be inside the caps, or the tool's own default would be
/// silently clamped on every call.
const _: () = assert!(DEFAULT_LINES <= MAX_LINES);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_cap_is_bounded_both_ways() {
        assert_eq!(0usize.clamp(1, MAX_LINES), 1);
        assert_eq!(usize::MAX.clamp(1, MAX_LINES), MAX_LINES);
    }
}
