//! What every part of the agent stands on: config.toml and the role it
//! gives this machine, where things are kept, the persisted state, the
//! machine's facts, the log, and the shared state the service's threads
//! hold (shared/) with the status document built from it.

pub mod config;
pub mod facts;
pub mod logging;
pub mod paths;
pub mod role;
pub mod shared;
pub mod state;
pub mod status;
