//! The service: `run` under the service manager, `serve` in a terminal.
//! `agent_main` brings up what this machine's role runs (role.rs) — the
//! controller's parts (`start_controller`) or a node's link and santree
//! door (`start_node`), the local socket, the workers — then keeps the
//! awake hold (`HoldKeeper`), an update's probation (`Probation`) and, on
//! Windows, the tray (`TrayWatchdog`) until `stop` is raised, and takes it
//! all down in order.

mod hold;
mod probation;
mod start;
mod watchdog;
mod workers;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::util::Shutdown;
use crate::{config, facts, local, logging, metrics_page, os, paths, state, update};

pub use hold::HoldKeeper;
pub use probation::Probation;
pub use start::{start_controller, start_node, ControllerStart, NodeDoor};
pub use watchdog::TrayWatchdog;
pub use workers::Workers;

/// How often the service's own loop looks at the hold, the probation and
/// the tray.
const TICK: Duration = Duration::from_millis(500);

/// The instance lock: one service per data directory, held for as long as
/// it runs.
pub fn instance_lock_path() -> PathBuf {
    paths::data_dir().join("agent.lock")
}

/// Take the instance lock: Ok(None) while an agent holds it, an error when
/// it cannot be opened. `private`: the lock is made so no other user can
/// open it when it is first made (audit D6) — the service's, and a verb's
/// that stands in for it (`update --apply`); a `serve` in a terminal is
/// its user's, and keeps its files.
pub fn take_instance_lock(private: bool) -> std::io::Result<Option<std::fs::File>> {
    let path = instance_lock_path();
    let _ = std::fs::create_dir_all(paths::data_dir());
    if private && !path.exists() {
        let _ = os::create_private(&path);
    }
    os::try_lock_exclusive(&path)
}

/// The agent's work, shared by `run` (as a service) and `serve` (in a
/// terminal): hold the machine awake, answer the local socket, keep the
/// link to the controller, sample telemetry and check for updates until
/// `stop` is raised — each part as far as this machine's role runs it
/// (role.rs).
pub fn agent_main(stop: Shutdown, foreground: bool) -> Result<()> {
    // Before anything that could fail: an update on probation counts this
    // start, and one that started too often is rolled back here (update/)
    // — the service's starts only: a `serve` in a terminal is not one.
    let start = if foreground {
        update::Start::Normal
    } else {
        update::on_start()
    };
    let cfg = config::load_or_default().context("reading config")?;
    let log = logging::init_logging(&cfg, foreground)?;
    let role = cfg.role();
    tracing::info!(
        version = crate::VERSION,
        socket = %paths::local_socket().display(),
        mode = ?role.mode,
        "daedalus-agent starting"
    );

    // One service per data directory (a port another process holds is
    // waited out, metrics_page.rs `Page`).
    let lock_path = instance_lock_path();
    let _instance = match take_instance_lock(!foreground) {
        Ok(Some(lock)) => lock,
        Ok(None) => anyhow::bail!(
            "another agent already runs on {} ({} is held)",
            paths::data_dir().display(),
            lock_path.display()
        ),
        Err(e) => return Err(e).with_context(|| format!("opening {}", lock_path.display())),
    };

    let state = state::State::load();
    let facts = facts::read();
    tracing::info!(os = %facts.os_name, version = %facts.os_version, cpu = %facts.cpu, "this machine");
    let on_probation = state.probation.is_some();
    let base = crate::shared::Shared::new(
        role,
        facts.clone(),
        state,
        cfg.initial_policy(),
        stop.clone(),
    );
    // The controller's own key — what every machine pins — and, where
    // `[controller] listen` names an address, the registry of machines and
    // the session host: built before the shared state is, so every reader
    // sees them from the first request.
    let (base, listen) = if role.node_listener {
        let c = start_controller(&cfg, &base, &stop)?;
        (base.with_controller(c.parts), c.listen)
    } else {
        (base, None)
    };
    // The machine's key, made on the first start: without it there is no
    // link, but the hold and the local socket do not depend on it.
    let identity = role.link.then(load_identity).flatten();
    let shared = Arc::new(match &identity {
        Some(id) => base.with_node(crate::shared::NodeKey {
            id: id.node_id(),
            fingerprint: id.fingerprint(),
        }),
        None => base,
    });

    match &start {
        update::Start::Probation(n) => tracing::info!(
            starts = n,
            max = update::MAX_STARTS,
            "this version is on probation; the previous binaries stay until it has run {} s",
            update::PROBATION.as_secs()
        ),
        // Only when the binaries could not be put back (update/).
        update::Start::RollBack(r) => tracing::error!(
            version = r.version,
            "this version did not last, and could not be rolled back"
        ),
        // No update waits for its proof (a `serve` does not count one).
        _ if role.self_update && !on_probation => update::retire_old_binaries(),
        _ => {}
    }

    let mut workers = Workers::new(&shared, &stop);
    // The OS's power requests for the status document, read here every
    // minute rather than inside a request (shared/machine.rs).
    let _ = workers.spawn("power-requests", |shared, stop| loop {
        shared.power.refresh_requests();
        if stop.wait(Duration::from_secs(60)) {
            return;
        }
    });
    // The local socket for the tray, the session and the verbs (local.rs),
    // and on the controller the metrics page Prometheus scrapes
    // (metrics_page.rs). Either one that cannot be bound does not stop the
    // service: it is tried again in the background while the rest runs.
    let local_door = local::Door::start(Arc::clone(&shared));
    let metrics = role
        .status_on_lan
        .then(|| metrics_page::Page::start(cfg.port, Arc::clone(&shared)));
    // After an update, the tray or the session started again on the new
    // binary so it matches the service (os `restart_desktop_side`).
    if matches!(start, update::Start::Probation(1)) && role.session && !role.session_in_service {
        let _ = std::thread::Builder::new()
            .name("desktop-restart".into())
            .spawn(|| {
                std::thread::sleep(Duration::from_secs(3));
                os::svc::restart_desktop_side();
            });
    }

    // The controller's door for the app (api/), opened before the sampler
    // and the session start, so a second instance that got past the local
    // socket (another data directory) stops here without having started
    // either — above all, without touching the Claude unit; then the
    // machines' listener (link/controller/).
    let api = if role.api_socket {
        Some(crate::api::serve(&cfg, Arc::clone(&shared))?)
    } else {
        None
    };
    let listener = start::listen_for_machines(listen, &shared)?;

    // A node's way to the box: the link and santree's door.
    let node = start_node(&cfg, &shared, identity, &facts, &mut workers)?;
    let doors = Doors {
        _listener: listener,
        _node: node,
        _api: api,
        local: local_door,
        _metrics: metrics,
    };

    if cfg.telemetry == config::TelemetryLevel::Off {
        tracing::info!("telemetry = off: nothing is sampled");
    } else {
        let level = cfg.telemetry;
        workers
            .spawn("telemetry", move |shared, stop| {
                crate::telemetry::run_loop(shared, stop, level)
            })
            .context("spawning the sampler")?;
    }
    // The providers' reader (providers/), wherever there is a link to push
    // what it finds up: on every node, whatever the telemetry level.
    if role.link {
        workers
            .spawn("providers", crate::providers::run_loop)
            .context("spawning the providers' reader")?;
    }
    // The controller's session runs here, in this process (role.rs).
    if role.session_in_service {
        let cfg = cfg.clone();
        workers
            .spawn("session", move |shared, stop| {
                if let Err(e) = crate::session::run_in_service(&cfg, shared, stop) {
                    tracing::error!(error = format!("{e:#}"), "the session did not start");
                }
            })
            .context("spawning the session")?;
    }
    if role.self_update {
        let cfg = cfg.clone();
        workers
            .spawn("updater", move |shared, stop| {
                update::run_loop(cfg, shared, stop)
            })
            .context("spawning the updater")?;
    }

    let mut probation = Probation::new(&start, shared.started);
    let mut hold = HoldKeeper::default();
    let mut tray = TrayWatchdog::new(shared.started);
    let mut failed_probation = false;
    while !stop.is_stopped() {
        if probation.tick(doors.local.up_for(), &shared) {
            failed_probation = true;
            stop.stop();
            break;
        }
        // A controller key rotation whose grace period is over retires the
        // old key (link/rotation.rs).
        if let Some(c) = &shared.controller {
            c.keys.tick();
        }
        if role.keep_awake {
            hold.follow(shared.settings.policy().awake_hold, &shared);
        }
        tray.tick(&shared);
        stop.wait(TICK);
    }
    tracing::info!("stopping");
    drop(doors);
    drop(workers);
    drop(hold);
    // A failed probation run leaves as a failure, once the log is flushed.
    if failed_probation {
        drop(log);
        std::process::exit(3);
    }
    Ok(())
}

/// What the service answers on, closed in this order when dropped: the
/// machines' listener, santree's door, the API, the local socket, the
/// metrics page.
struct Doors {
    _listener: Option<crate::link::controller::Listener>,
    _node: NodeDoor,
    _api: Option<crate::os::LocalSocket>,
    local: local::Door,
    _metrics: Option<metrics_page::Page>,
}

/// This machine's key, made on the first start; None, logged, when it
/// cannot be had: the box will not hear from this machine.
fn load_identity() -> Option<crate::identity::Identity> {
    match crate::identity::Identity::load_or_create() {
        Ok(id) => {
            tracing::info!(node = id.node_id(), fingerprint = %id.fingerprint(), "identity loaded");
            Some(id)
        }
        Err(e) => {
            tracing::error!(
                error = format!("{e:#}"),
                "no identity; the box will not hear from this machine"
            );
            None
        }
    }
}
