//! Foundation modules shared by the alnair shell crate family. `alnair-shell`
//! re-exports them at their original paths; keeping them in a leaf crate lets
//! them build in parallel and avoids a rebuild on every shell edit.

pub mod cpu_profile;
pub mod env;
pub mod util;
