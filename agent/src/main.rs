//! daedalus-agent — the box's presence on a machine it does not run.
//!
//! Phase one, and only phase one (PLAN.md, feature 6): a Windows service
//! that holds the machine awake for as long as it runs, answers a small
//! status page on the LAN so the box can see that it does, and updates
//! itself to the newest `agent-v*` release of the engine repository. No
//! commands, no telemetry beyond the status page, no listening for anything
//! but that page. Everything the agent will later be able to do arrives as
//! a new release the existing one installs on its own — which is why the
//! update path ships first.
//!
//! One binary, five verbs:
//!
//!   install    register the service, the firewall rule and the data dir, start it
//!   uninstall  stop and remove all of that
//!   run        the service entry point — what the Service Control Manager calls
//!   serve      the same work in the foreground, for a terminal
//!   status     print what the running agent reports
//!   update     ask the release feed now (`--apply` to install what it finds)
//!
//! Layout on the machine:
//!
//!   C:\Program Files\daedalus-agent\daedalus-agent.exe   the binary (and .old / .new around an update)
//!   C:\ProgramData\daedalus-agent\config.toml            what install wrote; edit and restart
//!   C:\ProgramData\daedalus-agent\state.json             what the agent last did
//!   C:\ProgramData\daedalus-agent\logs\agent.log.*       daily-rotated log

mod config;
mod power;
mod state;
mod status;
mod update;

#[cfg(windows)]
mod service;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};

pub const SERVICE_NAME: &str = "daedalus-agent";
pub const DISPLAY_NAME: &str = "Daedalus Agent";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let verb = args.first().map(String::as_str).unwrap_or("help");
    let rest = &args[args.len().min(1)..];

    let outcome = match verb {
        "install" => install(rest),
        "uninstall" => uninstall(),
        "run" => run_as_service(),
        "serve" => serve_foreground(),
        "status" => status_cmd(),
        "update" => update_cmd(rest),
        "version" | "--version" | "-V" => {
            println!("daedalus-agent {VERSION}");
            Ok(())
        }
        _ => {
            print_help();
            Ok(())
        }
    };

    if let Err(e) = outcome {
        eprintln!("daedalus-agent: {e:#}");
        std::process::exit(2);
    }
}

fn print_help() {
    println!(
        "daedalus-agent {VERSION}\n\n\
         usage: daedalus-agent <verb>\n\n  \
         install [--port N]   register and start the service (administrator)\n  \
         uninstall            stop and remove the service (administrator)\n  \
         run                  service entry point; used by the Service Control Manager\n  \
         serve                run in the foreground, in this terminal\n  \
         status               print the running agent's status page\n  \
         update [--apply]     check the release feed now; --apply installs a newer release\n  \
         version              print the version"
    );
}

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
    let shared = Arc::new(status::Shared::new(state, started));

    update::retire_old_binary();

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
        Ok(changed) => tracing::info!(
            changed,
            "power plan converged (no idle sleep, no hibernate)"
        ),
        Err(e) => tracing::warn!(error = %e, "power plan not converged"),
    }

    let server = status::serve(cfg.port, Arc::clone(&shared))?;

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
    drop(hold);
    Ok(())
}

fn run_as_service() -> Result<()> {
    #[cfg(windows)]
    {
        service::run()
    }
    #[cfg(not(windows))]
    {
        bail!("`run` is the Windows service entry point; use `serve` here")
    }
}

fn serve_foreground() -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = Arc::clone(&stop);
        ctrlc_handler(move || stop.store(true, Ordering::Relaxed));
    }
    agent_main(stop, true)
}

/// A Ctrl-C hook without a crate: on Windows through the console control
/// handler, elsewhere by ignoring it (the foreground mode is a convenience
/// there, not a deployment).
fn ctrlc_handler<F: Fn() + Send + Sync + 'static>(f: F) {
    #[cfg(windows)]
    {
        use std::sync::OnceLock;
        use windows::core::BOOL;
        use windows::Win32::System::Console::SetConsoleCtrlHandler;
        static HANDLER: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
        let _ = HANDLER.set(Box::new(f));
        unsafe extern "system" fn on_ctrl(_: u32) -> BOOL {
            if let Some(h) = HANDLER.get() {
                h();
            }
            BOOL(1)
        }
        // SAFETY: the callback only touches a OnceLock that outlives it.
        unsafe {
            let _ = SetConsoleCtrlHandler(Some(on_ctrl), true);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = f;
    }
}

fn install(args: &[String]) -> Result<()> {
    let mut cfg = config::Config::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--port" => {
                cfg.port = it
                    .next()
                    .context("--port needs a number")?
                    .parse()
                    .context("--port must be a TCP port")?
            }
            other => bail!("unknown option {other}"),
        }
    }
    #[cfg(windows)]
    {
        service::install(&cfg)
    }
    #[cfg(not(windows))]
    {
        let _ = cfg;
        bail!("install is Windows-only in this version")
    }
}

fn uninstall() -> Result<()> {
    #[cfg(windows)]
    {
        service::uninstall()
    }
    #[cfg(not(windows))]
    {
        bail!("uninstall is Windows-only in this version")
    }
}

fn status_cmd() -> Result<()> {
    let cfg = config::load_or_default()?;
    let url = format!("http://127.0.0.1:{}/status", cfg.port);
    let body: serde_json::Value = ureq::get(&url)
        .timeout(Duration::from_secs(3))
        .call()
        .with_context(|| format!("the agent did not answer at {url} — is the service running?"))?
        .into_json()?;
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

fn update_cmd(args: &[String]) -> Result<()> {
    let apply = args.iter().any(|a| a == "--apply");
    let cfg = config::load_or_default()?;
    let found = update::check(&cfg)?;
    match found {
        None => println!("no newer release than {VERSION}"),
        Some(rel) => {
            println!("newer release: {} ({})", rel.version, rel.tag);
            if apply {
                let path = update::download_and_verify(&rel)?;
                update::swap_in(&path)?;
                println!("installed {}; restart the service to run it", rel.version);
            }
        }
    }
    Ok(())
}
