//! The daedalus session host: santree's protocol v1 over pinned TLS, for the
//! approved nodes the controller lists. See README.md.
//!
//! A library as well as the binary so a test can run a host in process (the
//! agent interop test in `interop/`); the binary is `main.rs`.

pub mod allow;
pub mod config;
mod daemon;
mod exec;
mod framing;
mod fsops;
pub mod hook;
mod hostkey;
pub mod logger;
pub mod preauth;
pub mod serve;
mod status;
mod sys;
mod workspaces;

pub use config::Config;
pub use serve::Server;

/// This build's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
