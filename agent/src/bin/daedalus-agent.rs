//! The service executable and its verbs. See the crate root for the layout.
//!
//!   install    register the service, the tray, the firewall rule and the data dir; start
//!   uninstall  stop and remove all of that
//!   run        the service entry point — what the Service Control Manager calls
//!   serve      the same work in the foreground, for a terminal
//!   status     print what the running agent reports
//!   update     ask the release feed now (`--apply` to install what it finds)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use daedalus_agent::{agent_main, config, update, VERSION};

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
        "claude" => claude_cmd(rest),
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
         install [--port N]   register and start the service and the tray (administrator)\n  \
         uninstall            stop and remove the service and the tray (administrator)\n  \
         run                  service entry point; used by the Service Control Manager\n  \
         serve                run in the foreground, in this terminal\n  \
         status               print the running agent's status page\n  \
         update [--apply]     check the release feed now; --apply installs a newer release\n  \
         claude restart       ask the tray to restart `claude remote-control`\n  \
         version              print the version"
    );
}

fn run_as_service() -> Result<()> {
    #[cfg(windows)]
    {
        daedalus_agent::service::run()
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
        daedalus_agent::service::install(&cfg)
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
        daedalus_agent::service::uninstall()
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
    match update::check(&cfg)? {
        None => println!("no newer release than {VERSION}"),
        Some(rel) => {
            println!("newer release: {} ({})", rel.version, rel.tag);
            if apply {
                let staged = update::download_and_verify(&rel)?;
                update::swap_in(&staged)?;
                println!("installed {}; restart the service to run it", rel.version);
            }
        }
    }
    Ok(())
}

fn claude_cmd(args: &[String]) -> Result<()> {
    let cfg = config::load_or_default()?;
    match args.first().map(String::as_str) {
        Some("restart") => {
            let url = format!("http://127.0.0.1:{}/claude/restart", cfg.port);
            let body = ureq::post(&url)
                .timeout(Duration::from_secs(3))
                .call()
                .with_context(|| format!("the agent did not answer at {url}"))?
                .into_string()?;
            print!("{body}");
            Ok(())
        }
        _ => bail!("usage: daedalus-agent claude restart"),
    }
}
