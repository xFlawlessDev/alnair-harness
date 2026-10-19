//! Endpoint defaults live in the [`alnair_env`] leaf crate so sibling crates can
//! share them without depending on this one; only the shared test helper is
//! re-exported here.
pub use alnair_env::EnvVarGuard;
