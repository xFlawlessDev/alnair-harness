//! Workspace lesson library.
//!
//! Captures what the harness itself got wrong in a workspace and what fixed it,
//! so a later session in the same repository starts with that knowledge. See
//! `docs/HANDOVER-lesson-library.md` for the design.
//!
//! Two invariants worth restating at the module level:
//!
//! - **Never stored inside the repository.** A lesson file is read into context
//!   automatically, so a repo-controlled one would let a hostile checkout steer
//!   every future session in it. The store lives under `~/.alnair/lessons/`.
//! - **Never exposed as a tool.** Capture is harness-owned. A write tool would
//!   hand the model a permanent, auto-injected channel into every future
//!   session — a prompt-injection surface with no need behind it.

pub mod distil;
pub mod store;

pub use distil::distil_from_strategy;
pub use store::{AppendOutcome, LessonComponent, LessonEntry};
