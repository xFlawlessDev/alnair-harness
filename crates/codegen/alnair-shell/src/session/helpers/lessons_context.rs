//! Format workspace lessons as `<harness-lessons>` content.
//!
//! Mirrors [`super::memory_context`] in shape, and deliberately not in tag.
//! The block is injected as a `system-reminder` **user** message (appended, not
//! prepended), so the conversation prefix is untouched and the KV cache is
//! unaffected. Memory takes the prepend path and accepts one prefix rewrite;
//! lessons have no reason to.
//!
//! Two properties make default-on safe:
//!
//! - **No entries, no block.** An empty store changes nothing, so a fresh
//!   workspace is byte-identical to not having the feature.
//! - **The lesson text is model-authored.** It is capped, framed as advisory,
//!   and never phrased as an instruction from the user.

use alnair_chat_state::{LESSONS_CONTEXT_CLOSE_TAG, LESSONS_CONTEXT_OPEN_TAG};
use alnair_sampling_types::ConversationItem;

use crate::session::lessons::LessonEntry;

/// Returns `true` if a lessons block already sits in the conversation.
///
/// This is the cross-segment idempotency check: a resumed process must not
/// inject a second block, and a second turn in the same segment must not
/// either. The per-process latch only avoids re-reading the file.
pub fn conversation_has_lessons_context(items: &[ConversationItem]) -> bool {
    items.iter().any(|item| match item {
        ConversationItem::System(sys) => sys.content.contains(LESSONS_CONTEXT_OPEN_TAG),
        ConversationItem::User(user) => user
            .content
            .iter()
            .any(|block| block_text(block).is_some_and(|t| t.contains(LESSONS_CONTEXT_OPEN_TAG))),
        _ => false,
    })
}

/// Best-effort text of a content block, for the tag scan only.
fn block_text(block: &alnair_sampling_types::ContentPart) -> Option<&str> {
    match block {
        alnair_sampling_types::ContentPart::Text { text } => Some(text),
        _ => None,
    }
}

/// Render the first-turn block. `None` when there is nothing to say.
pub fn format_lessons_reminder(
    entries: &[LessonEntry],
    inject_max: usize,
    inject_max_chars: usize,
) -> Option<String> {
    if entries.is_empty() || inject_max == 0 {
        return None;
    }
    let mut out = format!("{LESSONS_CONTEXT_OPEN_TAG}\n");
    out.push_str("## Lessons from earlier sessions in this workspace\n\n");
    out.push_str(
        "These are notes about how the harness worked here, not facts about the code. \
         Apply one only when the situation matches.\n",
    );
    for entry in entries.iter().take(inject_max) {
        out.push_str("\n### ");
        out.push_str(entry.cue.trim());
        out.push('\n');
        let body = format!(
            "{} (component: {})",
            entry.lesson.trim(),
            entry.component.as_str()
        );
        out.push_str(&truncate_chars(&body, inject_max_chars));
        out.push('\n');
    }
    out.push_str(LESSONS_CONTEXT_CLOSE_TAG);
    Some(out)
}

/// Truncate on a char boundary, appending an ellipsis when cut.
fn truncate_chars(text: &str, max: usize) -> String {
    if max == 0 || text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::lessons::LessonComponent;

    fn entry(cue: &str, lesson: &str) -> LessonEntry {
        LessonEntry {
            cue: cue.to_string(),
            lesson: lesson.to_string(),
            evidence: "failed 3 consecutive verification rounds on: x".into(),
            component: LessonComponent::Workflow,
            captured: "2026-10-22T09:14:03Z".into(),
            id: LessonEntry::compute_id(cue, lesson),
            extra: Vec::new(),
        }
    }

    #[test]
    fn empty_store_produces_no_block() {
        assert_eq!(format_lessons_reminder(&[], 3, 400), None);
    }

    #[test]
    fn zero_inject_max_produces_no_block() {
        assert_eq!(format_lessons_reminder(&[entry("a", "b")], 0, 400), None);
    }

    #[test]
    fn block_is_tagged_and_framed_as_advisory() {
        let text = format_lessons_reminder(&[entry("cue one", "do the thing")], 3, 400).unwrap();
        assert!(text.starts_with(LESSONS_CONTEXT_OPEN_TAG));
        assert!(text.ends_with(LESSONS_CONTEXT_CLOSE_TAG));
        assert!(text.contains("not facts about the code"));
        assert!(text.contains("component: workflow"));
        // Never reuses memory's tag.
        assert!(!text.contains("<memory-context>"));
    }

    #[test]
    fn at_most_inject_max_entries_newest_first() {
        let entries = vec![entry("c1", "l1"), entry("c2", "l2"), entry("c3", "l3")];
        let text = format_lessons_reminder(&entries, 2, 400).unwrap();
        assert!(text.contains("c1"));
        assert!(text.contains("c2"));
        assert!(!text.contains("c3"));
    }

    #[test]
    fn per_entry_budget_is_enforced() {
        let long = "x".repeat(1000);
        let text = format_lessons_reminder(&[entry("cue", &long)], 3, 100).unwrap();
        assert!(
            text.chars().count() < 400,
            "block: {}",
            text.chars().count()
        );
        assert!(text.contains('…'));
    }

    #[test]
    fn detects_an_existing_block_in_a_user_message() {
        let injected = format_lessons_reminder(&[entry("c", "l")], 3, 400).unwrap();
        let conversation = vec![
            ConversationItem::system("You are a helpful assistant."),
            ConversationItem::user(format!("<system-reminder>\n{injected}\n</system-reminder>")),
        ];
        assert!(conversation_has_lessons_context(&conversation));
    }

    #[test]
    fn no_block_means_no_detection() {
        let conversation = vec![
            ConversationItem::system("You are a helpful assistant."),
            ConversationItem::user("just a normal prompt"),
        ];
        assert!(!conversation_has_lessons_context(&conversation));
        assert!(!conversation_has_lessons_context(&[]));
    }

    #[test]
    fn memory_block_is_not_mistaken_for_lessons() {
        let conversation = vec![ConversationItem::system(
            "<memory-context>\nstuff\n</memory-context>",
        )];
        assert!(!conversation_has_lessons_context(&conversation));
    }
}
