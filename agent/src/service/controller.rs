//! The controller's parts and doors (the `controller` feature): its keys,
//! the registry of machines and the session host, built before the shared
//! state; then the app's API, the machines' listener and the metrics page.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};

use crate::controller::{link, metrics_page, rotation, session_host};
use crate::core::config::Config;
use crate::core::paths;
use crate::core::shared::{ControllerParts, Shared};
use crate::util::Shutdown;

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
    // The keys, and a rotation under way (controller/rotation.rs).
    let keys =
        Arc::new(rotation::Keys::load(&paths::data_dir()).context("the controller's identity")?);
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
    let mut registry = link::Registry::new(Arc::clone(&shared.events), link::Limits::default());
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
fn listen_for_machines(
    addr: Option<SocketAddr>,
    shared: &Shared,
) -> Result<Option<link::Listener>> {
    let (Some(addr), Some(c)) = (addr, &shared.controller) else {
        return Ok(None);
    };
    let Some(registry) = &c.nodes else {
        return Ok(None);
    };
    link::listen_with(addr, Arc::clone(&c.keys), Arc::clone(registry)).map(Some)
}

/// The controller's doors, open while held, closed in this order: the
/// machines' listener, the API, the metrics page.
pub struct ControllerDoors {
    _listener: Option<link::Listener>,
    _api: Option<crate::os::LocalSocket>,
    _metrics: Option<metrics_page::Page>,
}

impl ControllerDoors {
    /// The app's door (controller/api/) — opened before the sampler and
    /// the session start, so a second instance that got past the local
    /// socket (another data directory) stops here without having started
    /// either, above all without touching the Claude unit — then the
    /// machines' listener on `listen`, and the metrics page Prometheus
    /// scrapes, which, like the local socket, is tried again in the
    /// background when it cannot be bound.
    pub fn open(cfg: &Config, shared: &Arc<Shared>, listen: Option<SocketAddr>) -> Result<Self> {
        let role = shared.role;
        let api = if role.api_socket {
            Some(crate::controller::api::serve(cfg, Arc::clone(shared))?)
        } else {
            None
        };
        let listener = listen_for_machines(listen, shared)?;
        let metrics = match cfg.metrics_listen() {
            Some(addr) if role.metrics_page => {
                Some(metrics_page::Page::start(addr, Arc::clone(shared)))
            }
            _ => {
                tracing::info!("no [controller] metrics_listen: no metrics page");
                None
            }
        };
        Ok(Self {
            _listener: listener,
            _api: api,
            _metrics: metrics,
        })
    }
}
