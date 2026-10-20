//! ptyctl — Headless PTY controller built on alacritty_terminal.
//!
//! Provides programmatic control of terminal sessions: spawn processes
//! in a PTY, send keystrokes, read screen content as text/styled/HTML,
//! and expose it all via HTTP REST API.

pub mod keys;
pub mod pty;
pub mod server;
pub mod session;
pub mod wait;

// The screen emulator lives in `alnair-terminal-screen` so the pager can render
// PTY output without depending on the PTY controller. Re-exported here so every
// existing `ptyctl::term` / `ptyctl::styled` path keeps working unchanged.
pub use alnair_terminal_screen::{styled, term};
