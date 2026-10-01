//! A node's way to the box, beyond the local socket: its link and
//! santree's door.

use std::sync::Arc;

use anyhow::{Context, Result};

use super::Workers;
use crate::core::config::Config;
use crate::core::facts::Facts;
use crate::core::shared::Shared;
use crate::identity::Identity;

/// A node's door, open while held: santree's, on macOS and Linux.
#[cfg(unix)]
pub type NodeDoor = Option<crate::node::santree::Door>;
/// None on Windows, which has no santree door.
#[cfg(windows)]
pub type NodeDoor = Option<std::convert::Infallible>;

/// A node's way to the box: how it reaches it — through its own tunnel
/// alone when a log-in left one (node/enroll.rs), directly otherwise — set
/// before anything dials; then, with this machine's key, the link to the
/// controller (node/link.rs) and santree's door, which rides the same key
/// (node/santree.rs).
pub fn start_node(
    cfg: &Config,
    shared: &Arc<Shared>,
    identity: Option<Identity>,
    facts: &Facts,
    workers: &mut Workers,
) -> Result<NodeDoor> {
    #[cfg(windows)]
    let _ = shared;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if shared.role.link {
        crate::node::enroll::start(shared, &crate::node::enroll::Files::here());
    }
    let Some(id) = identity else {
        return Ok(None);
    };
    #[cfg(unix)]
    let door = Some(crate::node::santree::Door::start(
        Arc::clone(shared),
        id.clone(),
    ));
    #[cfg(windows)]
    let door = None;
    let (cfg, facts) = (cfg.clone(), facts.clone());
    workers
        .spawn("link", move |shared, stop| {
            crate::node::link::run_loop(cfg, id, facts, shared, stop)
        })
        .context("spawning the link")?;
    Ok(door)
}
