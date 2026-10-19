//! Shared utilities used by both `alnair-shell` and its downstream clients
//! (e.g. `alnair-pager-render`). This crate sits upstream of `alnair-shell`
//! so it must never depend on it.

pub mod clipboard;
pub mod placeholder_images;
pub mod session;
pub mod stderr;
pub mod ui_config;
