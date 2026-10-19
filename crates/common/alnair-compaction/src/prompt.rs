//! The shared compaction prompt seam. Per-strategy prompt *content* lives with
//! each subsystem:
//!
//! - steps prompt → [`crate::steps::format_compaction_prompt`]
//! - history prompts → [`crate::history::prompt`]
//! - alnair summary prompt → [`crate::code_compaction::build_summary_prompt`]

/// System + user prompt pair every
/// [`CompactionSampler`](crate::sampler::CompactionSampler) call takes.
#[derive(Debug, Clone)]
pub struct CompactionPrompt {
    pub system: String,
    pub user: String,
}
