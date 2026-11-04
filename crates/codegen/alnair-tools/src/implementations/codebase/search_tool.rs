//! `codebase_search` tool — structural symbol lookup over the code graph.

use std::sync::Arc;

use super::types::CodebaseSearchInput;
use crate::types::codebase_backend::{
    CodebaseBackend, CodebaseError, CodebaseMatchKind, CodebaseSearchOutcome,
};
use crate::types::output::ToolOutput;
use crate::types::tool::{ToolKind, ToolNamespace};

/// Results returned when the caller does not specify a count.
const DEFAULT_LIMIT: usize = 20;

/// Hard cap, whatever the caller asks for.
///
/// The whole point of a structural index is a small, ranked answer. A caller
/// that wants more than this should narrow the query, not page through 31,000
/// references — that is what `grep` is for.
const MAX_LIMIT: usize = 100;

#[derive(Debug, Default)]
pub struct CodebaseSearchImpl;

impl crate::types::tool_metadata::ToolMetadata for CodebaseSearchImpl {
    fn kind(&self) -> ToolKind {
        ToolKind::CodebaseSearch
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::Alnair
    }

    fn description_template(&self) -> &str {
        "Find symbols by name across the repository using the parsed code graph, and report \
         where each one is declared. Works on Rust, TypeScript, JavaScript, Go and Python.\n\n\
         Use this instead of `grep` when you are looking for a *symbol*:\n\
         - Where is `render_tab_strip` defined, and what else is near it?\n\
         - Which helpers exist for tab rendering? (`tab` as a fragment)\n\
         - Is this a declaration or just a call site?\n\n\
         Unlike `grep` this matches names, not text, so it does not drown in comments, string \
         literals, and unrelated files. Unlike a language server it needs no configuration.\n\n\
         It is name-based — exact, prefix, then substring — not semantic. If you need the *body* \
         of a result, follow up with `codebase_context`, or `read_file` for the whole file. If \
         the answer is empty, the symbol may live in a language the index cannot parse; the \
         result names the languages it covers so you can tell that apart from a genuine absence."
    }
}

impl alnair_tool_runtime::Tool for CodebaseSearchImpl {
    type Args = CodebaseSearchInput;
    type Output = ToolOutput;

    fn id(&self) -> alnair_tool_protocol::ToolId {
        alnair_tool_protocol::ToolId::new("codebase_search").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &::alnair_tool_runtime::ListToolsContext,
    ) -> alnair_tool_types::ToolDescription {
        alnair_tool_types::ToolDescription::new(
            "codebase_search",
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
        name = "tool.codebase_search",
        skip_all,
        fields(query = %input.query, limit = ?input.limit)
    )]
    async fn run(
        &self,
        ctx: alnair_tool_runtime::ToolCallContext,
        input: CodebaseSearchInput,
    ) -> Result<ToolOutput, alnair_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;
        // Clone the Arc out before any `.await` so the resource guard is not
        // held across the index query.
        let Some(backend) = resources
            .lock()
            .await
            .get::<Arc<dyn CodebaseBackend>>()
            .cloned()
        else {
            return Ok(ToolOutput::Text(
                "Structural code search is not available in this session. It needs \
                 `[features] codebase_indexing` to be enabled (the default) and a workspace \
                 inside a git repository. Use `grep` instead."
                    .into(),
            ));
        };

        let query = input.query.trim();
        if query.is_empty() {
            return Ok(ToolOutput::Text(
                "refused: `query` is empty. Pass a symbol name or a fragment of one.".into(),
            ));
        }

        let limit = input.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let path_prefix = input
            .path_prefix
            .as_deref()
            .map(str::trim)
            .filter(|prefix| !prefix.is_empty());

        let outcome = backend
            .search(query, limit, input.include_references, path_prefix)
            .await
            .map_err(|error| tool_error(&error))?;

        Ok(ToolOutput::Text(render(&outcome, query).into()))
    }
}

fn tool_error(error: &CodebaseError) -> alnair_tool_runtime::ToolError {
    alnair_tool_runtime::ToolError::execution(
        alnair_tool_protocol::ToolId::new("codebase_search").expect("valid tool id"),
        format!("codebase search failed: {error}"),
    )
}

/// Render an outcome as markdown.
///
/// Two rules shape the output. Paths are printed as the backend reports them
/// (relative to the workspace root), because that is what the model can join
/// with the root it already knows. And the header always states what was
/// searched: an empty answer with no coverage line is indistinguishable from a
/// symbol that does not exist.
fn render(outcome: &CodebaseSearchOutcome, query: &str) -> String {
    let status = &outcome.status;
    let mut out = String::new();

    if outcome.hits.is_empty() {
        out.push_str(&format!(
            "No symbol matching `{query}` is declared in the indexed languages ({}).\n",
            describe_languages(&status.languages)
        ));
        out.push_str(&format!(
            "The index covers {} file(s). A symbol in a language outside that list is \
             invisible here — `grep` searches text and will still find it.\n",
            status.files
        ));
        return out;
    }

    out.push_str(&format!(
        "{} hit(s) for `{query}` across {} indexed file(s).\n",
        outcome.hits.len(),
        status.files
    ));
    if outcome.truncated {
        out.push_str(&format!(
            "\n**Partial answer:** showing the best {} of {} occurrences. Narrow the query or \
             pass `path_prefix` for the rest.\n",
            outcome.hits.len(),
            outcome.total_hits
        ));
    }

    // Group by symbol so the reader sees "this is declared here, used here"
    // instead of a flat list where the same name repeats.
    let mut current: Option<&str> = None;
    for hit in &outcome.hits {
        if current != Some(hit.symbol.as_str()) {
            current = Some(hit.symbol.as_str());
            match outcome.symbols.iter().find(|s| s.name == hit.symbol) {
                Some(symbol) => out.push_str(&format!(
                    "\n### `{}` — {} declaration(s), {} use(s) [{}]\n",
                    symbol.name,
                    symbol.definitions,
                    symbol.references,
                    match_kind_label(symbol.kind),
                )),
                None => out.push_str(&format!("\n### `{}`\n", hit.symbol)),
            }
        }
        out.push_str(&format!(
            "- {}:{} ({})\n",
            hit.path,
            hit.line,
            hit.kind.as_str()
        ));
    }

    out
}

fn match_kind_label(kind: CodebaseMatchKind) -> &'static str {
    match kind {
        CodebaseMatchKind::Exact => "exact name",
        CodebaseMatchKind::Prefix => "prefix",
        CodebaseMatchKind::Substring => "substring",
    }
}

fn describe_languages(languages: &[String]) -> String {
    if languages.is_empty() {
        return "no languages reported".to_string();
    }
    languages.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::codebase_backend::{
        CodebaseHit, CodebaseHitKind, CodebaseMatchKind, CodebaseStatus, CodebaseSymbol,
    };

    fn status(files: usize) -> CodebaseStatus {
        CodebaseStatus {
            indexed: true,
            files,
            definitions: 10,
            references: 100,
            languages: vec!["rust".into(), "typescript".into()],
        }
    }

    fn outcome(hits: Vec<CodebaseHit>, symbols: Vec<CodebaseSymbol>) -> CodebaseSearchOutcome {
        CodebaseSearchOutcome {
            total_hits: hits.len(),
            truncated: false,
            hits,
            symbols,
            status: status(42),
        }
    }

    fn hit(path: &str, line: usize, symbol: &str, kind: CodebaseHitKind) -> CodebaseHit {
        CodebaseHit {
            path: path.into(),
            line,
            symbol: symbol.into(),
            kind,
        }
    }

    #[test]
    fn an_empty_result_states_what_was_searched() {
        let rendered = render(&outcome(vec![], vec![]), "nope");
        assert!(rendered.contains("No symbol matching `nope`"));
        assert!(
            rendered.contains("rust, typescript"),
            "must name the covered languages: {rendered}"
        );
        assert!(rendered.contains("grep"), "must offer the fallback");
    }

    #[test]
    fn a_truncated_answer_says_so_with_both_numbers() {
        let symbol = CodebaseSymbol {
            name: "thing".into(),
            kind: CodebaseMatchKind::Exact,
            definitions: 1,
            references: 900,
        };
        let mut result = outcome(
            vec![hit("src/lib.rs", 3, "thing", CodebaseHitKind::Definition)],
            vec![symbol],
        );
        result.truncated = true;
        result.total_hits = 900;

        let rendered = render(&result, "thing");
        assert!(rendered.contains("Partial answer"), "{rendered}");
        assert!(rendered.contains("1 of 900"), "{rendered}");
    }

    #[test]
    fn results_are_grouped_by_symbol_with_counts() {
        let symbols = vec![CodebaseSymbol {
            name: "render".into(),
            kind: CodebaseMatchKind::Prefix,
            definitions: 2,
            references: 5,
        }];
        let hits = vec![
            hit("src/a.rs", 10, "render", CodebaseHitKind::Definition),
            hit("src/b.rs", 20, "render", CodebaseHitKind::Reference),
        ];
        let rendered = render(&outcome(hits, symbols), "render");
        assert_eq!(
            rendered.matches("### `render`").count(),
            1,
            "one heading per symbol: {rendered}"
        );
        assert!(
            rendered.contains("2 declaration(s), 5 use(s)"),
            "{rendered}"
        );
        assert!(rendered.contains("[prefix]"), "{rendered}");
        assert!(rendered.contains("src/a.rs:10 (definition)"));
        assert!(rendered.contains("src/b.rs:20 (reference)"));
    }

    #[test]
    fn a_symbol_without_a_summary_still_gets_a_heading() {
        let rendered = render(
            &outcome(
                vec![hit("src/a.rs", 1, "orphan", CodebaseHitKind::Definition)],
                vec![],
            ),
            "orphan",
        );
        assert!(rendered.contains("### `orphan`"), "{rendered}");
    }

    #[test]
    fn the_limit_is_clamped() {
        assert_eq!(0usize.clamp(1, MAX_LIMIT), 1);
        assert_eq!(usize::MAX.clamp(1, MAX_LIMIT), MAX_LIMIT);
    }

    #[test]
    fn match_kinds_are_labelled_for_humans() {
        assert_eq!(match_kind_label(CodebaseMatchKind::Exact), "exact name");
        assert_eq!(match_kind_label(CodebaseMatchKind::Substring), "substring");
    }
}
