//! Headless VTE screen emulation, extracted from `ptyctl`.
//!
//! This crate owns the terminal *screen*: feed it bytes and it maintains an
//! `alacritty_terminal` grid that can be read back as plain text, styled runs,
//! or HTML. It never opens a PTY and never talks to a transport — callers
//! supply the bytes (from a local PTY, or from an ACP notification) and the
//! `SessionListener` sink for emulator replies.
//!
//! `ptyctl` re-exports both modules, so this is a pure extraction.

pub mod styled;
pub mod term;
