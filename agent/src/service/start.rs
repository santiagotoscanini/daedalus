//! What each role brings up beyond the local socket: the controller's
//! parts and its listener for the machines, a node's link and santree door.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};

use super::Workers;
use crate::config::Config;
use crate::facts::Facts;
use crate::identity::Identity;
use crate::shared::{ControllerParts, Shared};
use crate::util::Shutdown;
use crate::{link, paths, session_host};

/// `start_controller`'s outcome: the parts the shared state holds, and the
/// address the machines' listener takes once the API is up.
pub struct ControllerStart {
    pub parts: ControllerParts,
    pub listen: Option<SocketAddr>,
}

/// The controller's parts: its keys, and where `[controller] listen` names
/// an address, the registry of machines (built against `shared`'s events)
/// and the session host it follows.
pub fn start_controller(cfg: &Config, shared: &Shared, stop: &Shutdown) -> Result<ControllerStart> {
    // The keys, and a rotation under way (link/rotation.rs).
    let keys = Arc::new(
        link::rotation::Keys::load(&paths::data_dir()).context("the controller's identity")?,
    );
    tracing::info!(
        fingerprint = %keys.forward().fingerprint(),
        rotating = keys.info().is_some(),
        "controller identity loaded"
    );
    let listen = cfg.controller_listen();
    let mut parts = ControllerParts {
        keys,
        listen: listen.map(|a| a.to_string()),
        advertise: cfg
            .controller
            .advertise
            .iter()
            .map(ToString::to_string)
            .collect(),
        nodes: None,
        session_host: None,
    };
    if listen.is_none() {
        tracing::info!("no [controller] listen: no machine can connect to this controller");
        return Ok(ControllerStart { parts, listen });
    }
    let mut registry = link::controller::Registry::new(
        Arc::clone(&shared.events),
        link::controller::Limits::default(),
    );
    if let Some(host) = &cfg.controller.session_host {
        registry = registry.with_allow_list(host.allow_list.to_path_buf());
    }
    let registry = Arc::new(registry);
    // The session host this box runs, when nix names one: its status
    // followed, its key handed to santree machines (session_host.rs). Never
    // a reason not to start.
    if let Some(host) = cfg.controller.session_host.clone() {
        let status = host.status_file.display().to_string();
        let host = Arc::new(session_host::SessionHost::new(host, Arc::clone(&registry)));
        match host.start(stop) {
            Ok(()) => {
                tracing::info!(status = %status, "following the session host");
                parts.session_host = Some(host);
            }
            Err(e) => tracing::error!(error = %e, "the session host is not followed"),
        }
    }
    parts.nodes = Some(registry);
    Ok(ControllerStart { parts, listen })
}

/// The machines' links on `addr`, where the controller listens for them.
pub fn listen_for_machines(
    addr: Option<SocketAddr>,
    shared: &Shared,
) -> Result<Option<link::controller::Listener>> {
    let (Some(addr), Some(c)) = (addr, &shared.controller) else {
        return Ok(None);
    };
    let Some(registry) = &c.nodes else {
        return Ok(None);
    };
    link::controller::listen_with(addr, Arc::clone(&c.keys), Arc::clone(registry)).map(Some)
}

/// A node's door, open while held: santree's, on macOS and Linux.
#[cfg(unix)]
pub type NodeDoor = Option<crate::santree::Door>;
/// None on Windows, which has no santree door.
#[cfg(windows)]
pub type NodeDoor = Option<std::convert::Infallible>;

/// A node's way to the box: how it reaches it — through its own tunnel
/// alone when a log-in left one (enroll.rs), directly otherwise — set
/// before anything dials; then, with this machine's key, the link to the
/// controller (link/node.rs) and santree's door, which rides the same key
/// (santree.rs).
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
        crate::enroll::start(shared, &crate::enroll::Files::here());
    }
    let Some(id) = identity else {
        return Ok(None);
    };
    #[cfg(unix)]
    let door = Some(crate::santree::Door::start(Arc::clone(shared), id.clone()));
    #[cfg(windows)]
    let door = None;
    let (cfg, facts) = (cfg.clone(), facts.clone());
    workers
        .spawn("link", move |shared, stop| {
            link::node::run_loop(cfg, id, facts, shared, stop)
        })
        .context("spawning the link")?;
    Ok(door)
}
