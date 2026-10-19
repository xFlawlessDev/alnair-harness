//! Local, zero-egress observability for Alnair sessions.
//!
//! Every sink writes under the Alnair home directory and nowhere else. No module
//! here may open a network connection — that is the crate's contract.

mod appender;
pub mod debug_log;
pub mod hooks_log;
pub mod instrumentation;
pub mod memory_log;
pub mod sampling_log;
pub mod session_ctx;
pub mod unified_log;

pub use session_ctx::with_session_ctx;
