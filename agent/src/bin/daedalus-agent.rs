//! The service executable and its verbs; `print_help` below is the list.
//! `run` is what the Service Control Manager (launchd on macOS, systemd on
//! Linux) calls; `serve` is the same work in the foreground, for a
//! terminal; `session` is the headless Claude session, what the Linux user
//! unit runs. What differs by OS — the service, install, uninstall, Ctrl-C
//! — is `os`'s.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use daedalus_agent::{agent_main, config, os, role, update, VERSION};

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
        "session" => daedalus_agent::session::run(),
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
         session              the Claude session without a tray; what the Linux user unit runs\n  \
         claude restart       ask the session to restart `claude remote-control`\n  \
         version              print the version"
    );
}

fn run_as_service() -> Result<()> {
    os::svc::run_service()
}

fn serve_foreground() -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = Arc::clone(&stop);
        os::on_interrupt(move || stop.store(true, Ordering::Relaxed));
    }
    agent_main(stop, true)
}

/// The role config.toml gives this machine; a file that does not parse is
/// no reason to refuse a (re)install, so it reads as a node's.
fn role() -> role::Role {
    config::load_or_default()
        .map(|c| c.role())
        .unwrap_or(role::Role::of(config::Mode::Node))
}

fn install(args: &[String]) -> Result<()> {
    config::refuse_env_override("install")?;
    role().allow_install("install")?;
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
    os::svc::install(&cfg)
}

fn uninstall() -> Result<()> {
    config::refuse_env_override("uninstall")?;
    role().allow_install("uninstall")?;
    os::svc::uninstall()
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
    if apply && !role().self_update {
        bail!("`update --apply` refuses in controller mode: nix moves this agent");
    }
    match update::check()? {
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
