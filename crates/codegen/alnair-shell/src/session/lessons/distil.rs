//! Distil the goal strategist's `strategy.md` into a [`LessonEntry`].
//!
//! The strategist prompt (`templates/goal_strategist_prompt.md`) already
//! enforces a fixed shape, so this parses that contract rather than
//! re-deriving it:
//!
//! ```text
//! # Strategy: why the goal is stuck and how to unstick it
//!
//! ## Diagnosis
//! <1-3 sentences naming the root structural cause>
//!
//! ## Recommended restructure
//! 1. <first small, mechanical, verifiable step>
//! 2. ...
//!
//! ## Why this converges
//! <1-2 sentences>
//! ```
//!
//! Deterministic, zero tokens, works offline — which keeps the zero-egress
//! contract trivially true. An LLM distillation would be a later, config-gated
//! replacement for the `component` heuristic only.

use super::store::{LessonComponent, LessonEntry};

/// Section heading the strategist is contractually required to emit.
const DIAGNOSIS: &str = "## Diagnosis";
/// The one section without which a note cannot become a lesson.
const RESTRUCTURE: &str = "## Recommended restructure";

/// Longest objective echoed into `evidence`, in chars.
const MAX_OBJECTIVE_CHARS: usize = 200;
/// Longest `cue` kept. The injection budget is 400 chars per entry total, and
/// the cue is the part a reader skims.
const MAX_CUE_CHARS: usize = 160;

/// Build a lesson from a strategist note.
///
/// Returns `None` when the note does not carry the contract — most importantly
/// a missing `## Recommended restructure`, because a lesson without an action
/// is not worth injecting.
pub fn distil_from_strategy(
    markdown: &str,
    consecutive_failures: u32,
    objective: &str,
    captured: &str,
) -> Option<LessonEntry> {
    let sections = split_sections(markdown);

    let diagnosis = sections
        .iter()
        .find(|(name, _)| name.starts_with("Diagnosis"))
        .map(|(_, body)| body.as_str())?;
    let restructure = sections
        .iter()
        .find(|(name, _)| name.starts_with("Recommended restructure"))
        .map(|(_, body)| body.as_str())?;

    let cue = cue_from_diagnosis(diagnosis);
    let lesson = lesson_from_restructure(restructure);
    if cue.is_empty() || lesson.is_empty() {
        return None;
    }

    let evidence = format!(
        "failed {} consecutive verification rounds on: {}",
        consecutive_failures,
        truncate_chars(objective.trim(), MAX_OBJECTIVE_CHARS),
    );

    Some(LessonEntry {
        id: LessonEntry::compute_id(&cue, &lesson),
        component: component_for(&lesson),
        cue,
        lesson,
        evidence,
        captured: captured.to_string(),
        extra: Vec::new(),
    })
}

/// Split a note into `(heading-text, body)` pairs on `## ` headings.
///
/// Only level-2 headings count: the title is `#`, and the strategist's
/// contract puts every section at `##`.
fn split_sections(markdown: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, String)> = None;

    for line in markdown.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            if let Some(done) = current.take() {
                out.push(done);
            }
            current = Some((heading.trim().to_string(), String::new()));
            continue;
        }
        if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    if let Some(done) = current.take() {
        out.push(done);
    }
    out
}

/// First sentence of the diagnosis, trailing period dropped, absolute paths
/// removed.
///
/// Path stripping is not cosmetic: a note that quotes `C:\…\src\foo.rs` must
/// not leak a local path into a prompt that is read on every future turn.
fn cue_from_diagnosis(body: &str) -> String {
    let text = strip_absolute_paths(body.trim());
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return String::new();
    }
    let first = first_sentence(&text);
    let trimmed = first.trim_end_matches('.').trim();
    truncate_chars(trimmed, MAX_CUE_CHARS)
}

/// The text up to and including the first sentence terminator, if any.
fn first_sentence(text: &str) -> &str {
    let mut end = text.len();
    for (idx, ch) in text.char_indices() {
        if matches!(ch, '.' | '!' | '?') {
            // A period inside a token like `foo.rs` or `0.5` is not a
            // sentence end; require the next char to be whitespace or EOF.
            let next = text[idx + ch.len_utf8()..].chars().next();
            if next.is_none_or(char::is_whitespace) {
                end = idx + ch.len_utf8();
                break;
            }
        }
    }
    &text[..end]
}

/// Numbered items of `## Recommended restructure`, joined with `; `.
fn lesson_from_restructure(body: &str) -> String {
    let mut items: Vec<String> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        let Some(rest) = strip_list_marker(trimmed) else {
            continue;
        };
        let item = strip_absolute_paths(rest.trim());
        let item = item.trim().trim_end_matches('.').trim();
        if !item.is_empty() {
            items.push(item.to_string());
        }
    }
    if items.is_empty() {
        // Fall back to the prose body: a strategist that ignored the numbered
        // form still produced an actionable paragraph.
        let prose = body
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let prose = strip_absolute_paths(&prose);
        let prose = prose.trim().trim_end_matches('.').trim();
        return truncate_chars(prose, MAX_CUE_CHARS * 2);
    }
    truncate_chars(&items.join("; "), MAX_CUE_CHARS * 2)
}

/// `1. x` / `1) x` / `- x` / `* x` → `x`.
fn strip_list_marker(line: &str) -> Option<&str> {
    if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
        return Some(rest);
    }
    let digits_end = line.find(|c: char| !c.is_ascii_digit())?;
    if digits_end == 0 {
        return None;
    }
    let rest = &line[digits_end..];
    rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))
}

/// Which harness lever the lesson points at.
///
/// The one honest weak point of v1: a keyword guess over the lesson text. It
/// exists so a reader can group lessons by what fixed them, and nothing acts
/// on it, so a wrong guess costs a sort order.
fn component_for(lesson: &str) -> LessonComponent {
    let lower = lesson.to_ascii_lowercase();
    for (needle, component) in [
        ("skill", LessonComponent::Skill),
        ("subagent", LessonComponent::Subagent),
        ("hook", LessonComponent::Hook),
        ("script", LessonComponent::Script),
    ] {
        if lower.contains(needle) {
            return component;
        }
    }
    LessonComponent::Workflow
}

/// Remove absolute paths (`/a/b/c`, `C:\a\b`, `~/a/b`) from text.
///
/// Keeps the sentence readable by replacing each run with `<path>`.
fn strip_absolute_paths(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let at_boundary = i == 0 || chars[i - 1].is_whitespace() || "([`\"'".contains(chars[i - 1]);
        let starts_path = at_boundary
            && (chars[i] == '/'
                || (chars[i].is_ascii_alphabetic()
                    && chars.get(i + 1) == Some(&':')
                    && matches!(chars.get(i + 2), Some('\\') | Some('/')))
                || (chars[i] == '~' && chars.get(i + 1) == Some(&'/')));
        if !starts_path {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() && !")]`\",;".contains(chars[i]) {
            i += 1;
        }
        // Only replace something that actually looks like a path: a bare `/`
        // (as in "and/or") is not.
        let candidate: String = chars[start..i].iter().collect();
        if candidate.matches(['/', '\\']).count() >= 2 || candidate.contains(":\\") {
            out.push_str("<path>");
        } else {
            out.push_str(&candidate);
        }
    }
    out
}

/// Truncate on a char boundary, appending an ellipsis when cut.
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "# Strategy: why the goal is stuck and how to unstick it

## Diagnosis

The verifier keeps re-reporting the same gap because the module under test
mixes parsing and I/O, so every partial fix moves the failure elsewhere.

## Recommended restructure

1. Split the module into a pure parser and a thin I/O shell.
2. Point the verifier at the parser alone.
3. Re-run only the failing case.

## Why this converges

Each step is independently verifiable, so the gap cannot reappear silently.
";

    #[test]
    fn distils_all_four_fields_from_the_contract_shape() {
        let entry = distil_from_strategy(NOTE, 3, "ship the parser", "2026-10-22T09:14:03Z")
            .expect("a contract-shaped note must distil");
        assert!(
            entry.cue.starts_with("The verifier keeps re-reporting"),
            "cue: {}",
            entry.cue
        );
        assert!(
            !entry.cue.ends_with('.'),
            "trailing period must be dropped: {}",
            entry.cue
        );
        assert!(entry.lesson.contains("Split the module into a pure parser"));
        assert!(entry.lesson.contains("; "), "numbered items are joined");
        assert_eq!(
            entry.evidence,
            "failed 3 consecutive verification rounds on: ship the parser"
        );
        assert_eq!(entry.component, LessonComponent::Workflow);
        assert_eq!(entry.captured, "2026-10-22T09:14:03Z");
        assert_eq!(entry.id, LessonEntry::compute_id(&entry.cue, &entry.lesson));
    }

    #[test]
    fn missing_restructure_yields_none() {
        let note = "## Diagnosis\n\nSomething is wrong.\n";
        assert!(distil_from_strategy(note, 3, "x", "t").is_none());
    }

    #[test]
    fn missing_diagnosis_yields_none() {
        let note = "## Recommended restructure\n\n1. Do the thing.\n";
        assert!(distil_from_strategy(note, 3, "x", "t").is_none());
    }

    #[test]
    fn absolute_paths_are_stripped_from_the_cue() {
        let note = "## Diagnosis\n\nThe failure is in C:\\work\\repo\\src\\foo.rs every time.\n\n\
                    ## Recommended restructure\n\n1. Split /home/dev/repo/src/bar.rs in two.\n";
        let entry = distil_from_strategy(note, 3, "x", "t").unwrap();
        assert!(
            !entry.cue.contains("C:\\"),
            "cue leaked a path: {}",
            entry.cue
        );
        assert!(!entry.cue.contains("foo.rs"), "cue: {}", entry.cue);
        assert!(entry.cue.contains("<path>"), "cue: {}", entry.cue);
        assert!(
            !entry.lesson.contains("/home/dev"),
            "lesson: {}",
            entry.lesson
        );
    }

    #[test]
    fn a_bare_slash_is_not_a_path() {
        assert_eq!(strip_absolute_paths("cats and/or dogs"), "cats and/or dogs");
    }

    #[test]
    fn component_heuristic_reads_the_lesson_text() {
        let note = "## Diagnosis\n\nStuck.\n\n## Recommended restructure\n\n\
                    1. Add a skill that explains the workflow.\n";
        let entry = distil_from_strategy(note, 2, "x", "t").unwrap();
        assert_eq!(entry.component, LessonComponent::Skill);
    }

    #[test]
    fn objective_is_truncated_in_evidence() {
        let long = "x".repeat(500);
        let entry = distil_from_strategy(NOTE, 5, &long, "t").unwrap();
        assert!(entry.evidence.chars().count() < 300);
        assert!(entry.evidence.ends_with('…'));
    }

    #[test]
    fn a_period_inside_a_filename_does_not_end_the_sentence() {
        assert_eq!(
            first_sentence("Look at foo.rs first. Then the rest."),
            "Look at foo.rs first."
        );
    }

    #[test]
    fn prose_restructure_falls_back_to_the_body() {
        let note = "## Diagnosis\n\nStuck.\n\n## Recommended restructure\n\n\
                    Split the module and re-verify.\n";
        let entry = distil_from_strategy(note, 3, "x", "t").unwrap();
        assert_eq!(entry.lesson, "Split the module and re-verify");
    }
}
