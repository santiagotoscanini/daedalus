//! daedalus-agent — the box's presence on a machine it does not run.
//!
//! Phase one, and only phase one (PLAN.md, feature 6): a Windows service
//! that holds the machine awake for as long as it runs, answers a small
//! status page on the LAN so the box can see that it does, and updates
//! itself to the newest `agent-v*` release of the engine repository; and
//! a tray program in the desktop session that shows what the service
//! reports. No commands, no telemetry beyond the status page, no listening
//! for anything but that page. Everything the agent will later be able to
//! do arrives as a new release the existing one installs on its own —
//! which is why the update path ships first.
//!
//! Two executables from this crate:
//!
//!   daedalus-agent.exe        the service and its verbs (src/bin/daedalus-agent.rs)
//!   daedalus-agent-tray.exe   the tray icon (src/bin/daedalus-agent-tray.rs)
//!
//! Layout on the machine:
//!
//!   C:\Program Files\daedalus-agent\daedalus-agent.exe        the service (and .old / .new around an update)
//!   C:\Program Files\daedalus-agent\daedalus-agent-tray.exe   the tray, started at logon
//!   C:\ProgramData\daedalus-agent\config.toml                 what install wrote; edit and restart
//!   C:\ProgramData\daedalus-agent\state.json                  what the agent last did
//!   C:\ProgramData\daedalus-agent\logs\agent.log.*            daily-rotated log

pub mod config;
pub mod discover;
pub mod facts;
pub mod hello;
pub mod identity;
pub mod net;
pub mod power;
pub mod state;
pub mod status;
pub mod update;

#[cfg(windows)]
pub mod service;
#[cfg(windows)]
pub mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};

pub const SERVICE_NAME: &str = "daedalus-agent";
pub const DISPLAY_NAME: &str = "Daedalus Agent";
pub const TRAY_EXE: &str = "daedalus-agent-tray.exe";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The agent's work, shared by `run` (as a service) and `serve` (in a
/// terminal): hold the machine awake, answer the status page, and check
/// for updates until `stop` is raised.
pub fn agent_main(stop: Arc<AtomicBool>, foreground: bool) -> Result<()> {
    let cfg = config::load_or_default().context("reading config")?;
    let _log = config::init_logging(&cfg, foreground)?;
    tracing::info!(
        version = VERSION,
        port = cfg.port,
        "daedalus-agent starting"
    );

    let started = std::time::Instant::now();
    let state = state::State::load();
    let facts = facts::read();
    tracing::info!(os = %facts.os_name, version = %facts.os_version, cpu = %facts.cpu, "this machine");
    let shared = Arc::new(status::Shared::new(state, facts.clone(), started));

    update::retire_old_binaries();

    // The point of the whole thing. Held for the life of the process; the
    // guard releases it on a clean stop, the OS releases it on any other.
    let hold = match power::Hold::acquire(
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
        Ok(()) => tracing::info!(
            "power plan set: idle sleep and hibernate timers off, hibernation off (same on every start)"
        ),
        Err(e) => tracing::warn!(error = %e, "power plan not set"),
    }

    let server = status::serve(cfg.port, Arc::clone(&shared))?;

    // The machine's key, made on the first start. Without it there is no
    // hello, but the hold and the page above do not depend on it.
    let announcer = match identity::Identity::load_or_create() {
        Ok(id) => {
            tracing::info!(node = id.node_id(), "identity loaded");
            let shared = Arc::clone(&shared);
            let stop = Arc::clone(&stop);
            let cfg = cfg.clone();
            Some(
                std::thread::Builder::new()
                    .name("hello".into())
                    .spawn(move || hello::run_loop(cfg, id, facts, shared, stop))
                    .context("spawning the announcer")?,
            )
        }
        Err(e) => {
            tracing::error!(
                error = format!("{e:#}"),
                "no identity; the box will not hear from this machine"
            );
            None
        }
    };

    let updater = {
        let shared = Arc::clone(&shared);
        let stop = Arc::clone(&stop);
        let cfg = cfg.clone();
        std::thread::Builder::new()
            .name("updater".into())
            .spawn(move || update::run_loop(cfg, shared, stop))
            .context("spawning the updater")?
    };

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(500));
    }
    tracing::info!("stopping");
    server.unblock();
    let _ = updater.join();
    if let Some(a) = announcer {
        let _ = a.join();
    }
    drop(hold);
    Ok(())
}
