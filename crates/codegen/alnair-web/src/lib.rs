//! Browser client for the Alnair leader.
//!
//! `alnair web` serves the SvelteKit build embedded in the binary and upgrades
//! `/ws` into a raw JSON-RPC pipe to a leader process. Each WebSocket gets its
//! **own** [`LeaderClient`](alnair_shell::leader::LeaderClient), so the leader's
//! existing fan-out, per-session driver election, `session/load` replay
//! buffering and interaction cache do all the synchronisation work. Nothing in
//! `alnair-shell::leader` changes.
//!
//! # Why not `agent serve`
//!
//! `agent::server` creates its own `MvpAgent` and keeps a single
//! `relay_dest` that each new connection overwrites, so it cannot share state
//! with the TUI. This crate attaches to the *leader* instead.
//!
//! # Modules
//!
//! - [`assets`] — the embedded SPA and the lookup rules that serve it.
//! - [`auth`] — the cookie + `Origin` gate on `/ws`.
//! - [`bridge`] — one leader client per WebSocket.
//! - [`server`] — router, bind, startup print.

pub mod assets;
pub mod auth;
pub mod bridge;
pub mod server;

pub use server::{WebServerConfig, run_web_server, spawn_web_server};
