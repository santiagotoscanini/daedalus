//! daedalus-agent — the box's presence on a machine it does not run.
//!
//! A Windows service (a launchd daemon on macOS, a systemd service on
//! Linux) that holds the machine awake for as long as the box wants it to,
//! keeps one connection to the controller, the box's own agent (link/),
//! following the policy it carries, answers the tray, the session and the
//! verbs on a local socket that knows its callers (local.rs; nothing on the
//! network, loopback included), samples the machine's telemetry, and
//! updates itself to the
//! newest `agent-v*` release of the engine repository; a session that —
//! with the user's own login — runs `claude remote-control` the way the box
//! runs its own (claude/); and a tray that shows what the service reports.
//!
//! Two executables from this crate (no `.exe` on macOS and Linux):
//!
//!   daedalus-agent.exe        the service and its verbs (src/bin/daedalus-agent.rs)
//!   daedalus-agent-tray.exe   the tray icon (src/bin/daedalus-agent-tray.rs; feature `tray`)
//!
//! Where each lands on the machine, with its config, state and logs:
//! agent/README.md, "On the machine".
//!
//! Three roles, three modules: the service (`agent_main` below), the
//! `session` — Claude Code supervised and reported to the service, with no
//! UI — and the `tray`, a UI over the session. The tray runs the session on
//! Windows and macOS; on Linux the session is a user unit of its own
//! (`daedalus-agent session`) and the tray only shows it; on the controller
//! it is a thread of the service. Which parts run at all — a node or the
//! controller, whose local API socket (api/) is the app's door — is
//! role.rs's one table. Everything
//! that differs by OS is behind `os` (os/mod.rs lists the surface); nothing
//! else in the crate tests the target.

pub mod api;
pub mod claude;
pub mod config;
pub mod deadline;
pub mod discover;
pub mod dns;
pub mod door;
pub mod exec;
pub mod facts;
pub mod http;
pub mod identity;
pub mod jobs;
pub mod jsonl;
pub mod link;
pub mod local;
pub mod logging;
pub mod metrics_page;
pub mod net;
pub mod os;
pub mod pair;
pub mod paths;
pub mod power;
pub mod private;
pub mod providers;
pub mod role;
pub mod root;
pub mod rpc;
pub mod session;
pub mod shared;
pub mod state;
pub mod telemetry;
pub mod update;
pub mod util;

// The app's TypeScript wire types, generated from the types above (a test).
#[cfg(test)]
mod ts;

// The tray draws with tray-icon (and GTK on Linux): the `tray` feature.
#[cfg(feature = "tray")]
pub mod tray;

use crate::util::Shutdown;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};

pub const SERVICE_NAME: &str = "daedalus-agent";
pub const DISPLAY_NAME: &str = "Daedalus Agent";
pub use os::TRAY_EXE;
/// This build's version: the crate's, with `+<build id>` on a build that is
/// not a release (build.rs).
pub const VERSION: &str = env!("DAEDALUS_VERSION");

/// The agent's work, shared by `run` (as a service) and `serve` (in a
/// terminal): hold the machine awake, answer the local socket, keep the link
/// to the controller, sample telemetry and check for updates until `stop` is raised —
/// each part as far as this machine's role runs it (role.rs).
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
    // The service's own files — the key, the config, the lock and its
    // logs — to the OS alone where an older install left them open (T4), and
    // its instance lock never one another user can open (audit D6). A
    // `serve` in a terminal is its user's, and keeps its files.
    let secured = if foreground {
        Ok(())
    } else {
        let lock = paths::data_dir().join("agent.lock");
        if !lock.exists() {
            let _ = std::fs::create_dir_all(paths::data_dir());
            let _ = os::create_private(&lock);
        }
        os::secure_data_dir(&paths::data_dir())
    };
    let _log = logging::init_logging(&cfg, foreground)?;
    let role = cfg.role();
    tracing::info!(
        version = VERSION,
        socket = %paths::local_socket().display(),
        mode = ?role.mode,
        "daedalus-agent starting"
    );
    if let Err(e) = secured {
        tracing::warn!(
            error = format!("{e:#}"),
            "the data directory's private files could not be secured"
        );
    }

    // One service per data directory: its port no longer decides that (a
    // port another process holds is waited out, metrics_page.rs `Page`).
    let lock_path = paths::data_dir().join("agent.lock");
    let _ = std::fs::create_dir_all(paths::data_dir());
    let Some(_instance) = os::lock_exclusive(&lock_path) else {
        anyhow::bail!(
            "another agent already runs on {} ({} is held)",
            paths::data_dir().display(),
            lock_path.display()
        );
    };

    let started = std::time::Instant::now();
    let state = state::State::load();
    let facts = facts::read();
    tracing::info!(os = %facts.os_name, version = %facts.os_version, cpu = %facts.cpu, "this machine");
    let shared = Arc::new(shared::Shared::new(
        state,
        facts.clone(),
        started,
        cfg.initial_policy(),
        role,
    ));

    shared.set_shutdown(stop.clone());
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
        _ if role.self_update && shared.state().probation.is_none() => {
            update::retire_old_binaries()
        }
        _ => {}
    }

    // The point of the whole thing on a node. Held while the policy says
    // so — held by default, then the box's word once the controller has
    // approved this machine; the guard releases it on a clean stop, the OS
    // on any other.
    let mut hold: Option<power::Hold> = None;
    let mut hold_wanted: Option<bool> = None;

    // The local socket for the tray, the session and the verbs (local.rs),
    // and on the controller the metrics page Prometheus scrapes (metrics_page.rs).
    // Either one that cannot be bound does not stop the service: it is tried
    // again in the background while the rest runs.
    // The OS's power requests for the status document, read here every
    // minute rather than inside a request (shared.rs).
    let _ = util::spawn_worker("power-requests", &shared, &stop, |shared, stop| loop {
        shared.refresh_power_requests();
        if stop.wait(Duration::from_secs(60)) {
            return;
        }
    });
    let page = local::Door::start(Arc::clone(&shared));
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

    // The controller's own key — what every machine pins — and, where
    // `[controller] listen` names an address, the registry of machines the
    // API reads (link/). Set before the API opens, so its capabilities
    // say `nodes` from the first connection.
    let controller = if role.node_listener {
        // The keys, and a rotation under way (link/rotation.rs).
        let keys = Arc::new(
            link::rotation::Keys::load(&paths::data_dir()).context("the controller's identity")?,
        );
        shared.set_controller(shared::Controller {
            keys: Arc::clone(&keys),
            listen: cfg.controller_listen().map(|a| a.to_string()),
            advertise: cfg.controller.advertise.clone(),
        });
        tracing::info!(
            fingerprint = %keys.forward().fingerprint(),
            rotating = keys.info().is_some(),
            "controller identity loaded"
        );
        match cfg.controller_listen() {
            Some(addr) => {
                let registry = Arc::new(link::controller::Registry::new(
                    &keys.forward(),
                    shared.events_handle(),
                    link::controller::Limits::default(),
                ));
                shared.set_nodes(Arc::clone(&registry));
                Some((keys, addr, registry))
            }
            None => {
                tracing::info!("no [controller] listen: no machine can connect to this controller");
                None
            }
        }
    } else {
        None
    };

    // The controller's door for the app (api/). Opened before the sampler
    // and the session start, so a second instance that got past the local
    // socket (another data directory) stops here without having started
    // either — above all, without touching the Claude unit.
    let api = if role.api_socket {
        Some(api::serve(&cfg, Arc::clone(&shared))?)
    } else {
        None
    };

    // The machines' links, once the API is up (link/controller.rs).
    let listener = match controller {
        Some((keys, addr, registry)) => Some(link::controller::listen_with(addr, keys, registry)?),
        None => None,
    };

    // The machine's key, made on the first start, and with it the link to
    // the controller (link/node.rs). Without the key there is no link, but
    // the hold and the page above do not depend on it.
    let uplink = match role.link.then(identity::Identity::load_or_create) {
        None => None,
        Some(Ok(id)) => {
            tracing::info!(node = id.node_id(), fingerprint = %id.fingerprint(), "identity loaded");
            let (cfg, facts) = (cfg.clone(), facts.clone());
            Some(
                util::spawn_worker("link", &shared, &stop, move |shared, stop| {
                    link::node::run_loop(cfg, id, facts, shared, stop)
                })
                .context("spawning the link")?,
            )
        }
        Some(Err(e)) => {
            tracing::error!(
                error = format!("{e:#}"),
                "no identity; the box will not hear from this machine"
            );
            None
        }
    };

    let sampler = if cfg.telemetry == config::TelemetryLevel::Off {
        tracing::info!("telemetry = off: nothing is sampled");
        None
    } else {
        let level = cfg.telemetry;
        Some(
            util::spawn_worker("telemetry", &shared, &stop, move |shared, stop| {
                telemetry::run_loop(shared, stop, level)
            })
            .context("spawning the sampler")?,
        )
    };

    // The providers' reader (providers.rs), wherever there is a link to
    // push what it finds up: on every node, whatever the telemetry level.
    let provider_reader = if role.link {
        Some(
            util::spawn_worker("providers", &shared, &stop, providers::run_loop)
                .context("spawning the providers' reader")?,
        )
    } else {
        None
    };

    // The controller's session runs here, in this process (role.rs).
    let session = if role.session_in_service {
        let cfg = cfg.clone();
        Some(
            util::spawn_worker("session", &shared, &stop, move |shared, stop| {
                if let Err(e) = session::run_in_service(&cfg, shared, stop) {
                    tracing::error!(error = format!("{e:#}"), "the session did not start");
                }
            })
            .context("spawning the session")?,
        )
    } else {
        None
    };

    let updater = if role.self_update {
        let cfg = cfg.clone();
        Some(
            util::spawn_worker("updater", &shared, &stop, move |shared, stop| {
                update::run_loop(cfg, shared, stop)
            })
            .context("spawning the updater")?,
        )
    } else {
        None
    };

    // The tray watchdog, where the OS needs one (`os::svc::WATCHES_TRAY`:
    // Windows): a tray that has not reported for a while is started again
    // in the console user's session, at most once a minute. Nothing starts
    // it otherwise until the next logon — the Run key fires once. On the
    // Mac, KeepAlive and `launchd::kickstart_tray` cover it; on Linux the
    // session is a user unit systemd restarts.
    let mut tray_tried = std::time::Instant::now();
    let mut on_probation = matches!(start, update::Start::Probation(_));
    let mut probation_looked = started;
    let mut failed_probation = false;
    while !stop.is_stopped() {
        // An update on probation proves itself, or fails its run (update/).
        if on_probation && probation_looked.elapsed() >= Duration::from_secs(5) {
            probation_looked = std::time::Instant::now();
            let up_for = page.up_for();
            let proof = update::judge_proof(
                up_for,
                started.elapsed(),
                || role.session && !role.session_in_service && os::svc::interactive_user(),
                shared.tray_reporting(),
            );
            match proof {
                update::Proof::Wait => {}
                update::Proof::Proven(rule) => {
                    on_probation = false;
                    update::prove(&shared, rule);
                }
                update::Proof::Failed(why) => {
                    tracing::error!(why, "this version failed its probation run; stopping so the service manager starts it again (a counted start)");
                    failed_probation = true;
                    stop.stop();
                    break;
                }
            }
        }
        // A controller key rotation whose grace period is over retires the
        // old key (link/rotation.rs).
        if let Some(k) = shared.controller_keys() {
            k.tick();
        }
        // A session that went quiet is news to the API's subscribers.
        shared.check_claude_fresh();
        let wanted = shared.policy().awake_hold;
        if role.keep_awake && hold_wanted != Some(wanted) {
            hold_wanted = Some(wanted);
            if wanted {
                hold = match power::Hold::acquire(
                    "daedalus-agent: this machine serves the fleet and is kept awake by the box",
                ) {
                    Ok(h) => {
                        shared.set_hold(true, None);
                        Some(h)
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "could not hold the machine awake");
                        shared.set_hold(false, Some(e.to_string()));
                        None
                    }
                };
                match power::converge_plan() {
                    Ok(Some(what)) => tracing::info!("power plan set: {what}"),
                    // Nothing to converge on this OS; the assertion is the whole hold.
                    Ok(None) => {}
                    Err(e) => tracing::warn!(error = %e, "power plan not set"),
                }
            } else {
                // The box said this machine may sleep: release the request.
                // The plan's timers stay as they are — the request is what
                // held the machine, and the plan is the user's to set back.
                hold = None;
                shared.set_hold(false, None);
                tracing::info!("awake hold released: the policy for this machine is off");
            }
        }
        if os::svc::WATCHES_TRAY
            && role.tray
            && !shared.tray_reporting()
            && started.elapsed() > Duration::from_secs(45)
            && tray_tried.elapsed() > Duration::from_secs(60)
        {
            tray_tried = std::time::Instant::now();
            match os::svc::launch_tray_or_session() {
                Ok(()) => {}
                Err(e) => tracing::info!(error = format!("{e:#}"), "tray not started"),
            }
        }
        stop.wait(Duration::from_millis(500));
    }
    tracing::info!("stopping");
    drop(listener);
    drop(api);
    drop(page);
    drop(metrics);
    if let Some(s) = session {
        let _ = s.join();
    }
    if let Some(u) = updater {
        let _ = u.join();
    }
    if let Some(p) = provider_reader {
        let _ = p.join();
    }
    if let Some(s) = sampler {
        let _ = s.join();
    }
    if let Some(l) = uplink {
        let _ = l.join();
    }
    drop(hold);
    // A failed probation run leaves as a failure, once the log is flushed.
    if failed_probation {
        drop(_log);
        std::process::exit(3);
    }
    Ok(())
}
