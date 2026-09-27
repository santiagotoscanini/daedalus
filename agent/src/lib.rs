//! daedalus-agent — the box's presence on a machine it does not run.
//!
//! A Windows service (a launchd daemon on macOS, a systemd service on
//! Linux) that holds the machine awake for as long as the box wants it to,
//! answers a small status page on the LAN, announces itself to the box
//! with a signed hello once a minute and follows the policy the answer
//! carries, samples the machine's telemetry, and updates itself to the
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
//! (`daedalus-agent session`) and the tray only shows it. Which parts run
//! at all — a node or the controller — is role.rs's one table. Everything
//! that differs by OS is behind `os` (os/mod.rs lists the surface); nothing
//! else in the crate tests the target.

pub mod claude;
pub mod config;
pub mod discover;
pub mod dns;
pub mod exec;
pub mod facts;
pub mod hello;
pub mod http;
pub mod identity;
pub mod net;
pub mod os;
pub mod power;
pub mod providers;
pub mod role;
pub mod session;
pub mod state;
pub mod status;
pub mod telemetry;
pub mod update;
pub mod util;

// The tray draws with tray-icon (and GTK on Linux): the `tray` feature.
#[cfg(feature = "tray")]
pub mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};

pub const SERVICE_NAME: &str = "daedalus-agent";
pub const DISPLAY_NAME: &str = "Daedalus Agent";
pub use os::TRAY_EXE;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The agent's work, shared by `run` (as a service) and `serve` (in a
/// terminal): hold the machine awake, answer the status page, announce
/// itself, sample telemetry and check for updates until `stop` is raised —
/// each part as far as this machine's role runs it (role.rs).
pub fn agent_main(stop: Arc<AtomicBool>, foreground: bool) -> Result<()> {
    let cfg = config::load_or_default().context("reading config")?;
    let _log = config::init_logging(&cfg, foreground)?;
    let role = cfg.role();
    tracing::info!(
        version = VERSION,
        port = cfg.port,
        mode = ?role.mode,
        "daedalus-agent starting"
    );

    let started = std::time::Instant::now();
    let state = state::State::load();
    let facts = facts::read();
    tracing::info!(os = %facts.os_name, version = %facts.os_version, cpu = %facts.cpu, "this machine");
    let shared = Arc::new(status::Shared::new(
        state,
        facts.clone(),
        started,
        hello::Policy::default(),
    ));

    if role.self_update {
        update::retire_old_binaries();
    }

    // The point of the whole thing on a node. Held while the policy says
    // so — held by default, then the box's word once it has approved this
    // machine; the guard releases it on a clean stop, the OS on any other.
    let mut hold: Option<power::Hold> = None;
    let mut hold_wanted: Option<bool> = None;

    let server = status::serve(cfg.port, Arc::clone(&shared))?;

    // The machine's key, made on the first start. Without it there is no
    // hello, but the hold and the page above do not depend on it.
    let announcer = match role.hello.then(identity::Identity::load_or_create) {
        None => None,
        Some(Ok(id)) => {
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
        Some(Err(e)) => {
            tracing::error!(
                error = format!("{e:#}"),
                "no identity; the box will not hear from this machine"
            );
            None
        }
    };

    let sampler = {
        let shared = Arc::clone(&shared);
        let stop = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("telemetry".into())
            .spawn(move || telemetry::run_loop(shared, stop))
            .context("spawning the sampler")?
    };

    let updater = if role.self_update {
        let shared = Arc::clone(&shared);
        let stop = Arc::clone(&stop);
        let cfg = cfg.clone();
        Some(
            std::thread::Builder::new()
                .name("updater".into())
                .spawn(move || update::run_loop(cfg, shared, stop))
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
    while !stop.load(Ordering::Relaxed) {
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
        std::thread::sleep(Duration::from_millis(500));
    }
    tracing::info!("stopping");
    server.unblock();
    if let Some(u) = updater {
        let _ = u.join();
    }
    let _ = sampler.join();
    if let Some(a) = announcer {
        let _ = a.join();
    }
    drop(hold);
    Ok(())
}
