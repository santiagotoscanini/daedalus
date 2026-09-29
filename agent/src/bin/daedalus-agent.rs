//! The service executable and its verbs; `print_help` below is the list.
//! `run` is what the Service Control Manager (launchd on macOS, systemd on
//! Linux) calls; `serve` is the same work in the foreground, for a
//! terminal; `session` is the headless Claude session, what the Linux user
//! unit runs. What differs by OS — the service, install, uninstall, Ctrl-C
//! — is `os`'s.

use daedalus_agent::util::Shutdown;

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
        // One connection of the box's root helper (root/): systemd starts
        // it per connection to its socket, never a person.
        "root-helper" => root_helper(rest),
        "claude" => claude_cmd(rest),
        // A resumed Claude session's terminal on Windows (os/windows/holder.rs):
        // started by the tray as a detached job, never by hand.
        "claude-holder" => match os::claude_holder(rest) {
            Ok(code) => std::process::exit(code),
            Err(e) => Err(e),
        },
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
         install --pin FINGERPRINT [--controller HOST:PORT]\n                       register and start the service and the tray (administrator);\n                       --pin is the controller key to trust (required), --controller\n                       where it is (else DNS); both written to config.toml\n  \
         uninstall            stop and remove the service and the tray (administrator)\n  \
         run                  service entry point; used by the Service Control Manager\n  \
         serve                run in the foreground, in this terminal\n  \
         status               print the running agent's status page\n  \
         update [--apply]     check the release feed now; --apply installs a newer release\n  \
         session              the Claude session without a tray; what the Linux user unit runs\n  \
         claude restart       ask the session to restart `claude remote-control`\n  \
         claude-holder …      (Windows) a resumed session's terminal; the tray starts it\n  \
         root-helper --table FILE\n                       (the box) one connection to the root helper; systemd starts it\n  \
         version              print the version"
    );
}

#[cfg(target_os = "linux")]
fn root_helper(args: &[String]) -> Result<()> {
    daedalus_agent::root::helper::main(args)
}

#[cfg(not(target_os = "linux"))]
fn root_helper(_args: &[String]) -> Result<()> {
    bail!("`root-helper` runs on the box, under systemd")
}

fn run_as_service() -> Result<()> {
    os::svc::run_service()
}

fn serve_foreground() -> Result<()> {
    let stop = Shutdown::new();
    {
        let stop = stop.clone();
        os::on_interrupt(move || stop.stop());
    }
    agent_main(stop, true)
}

/// The role config.toml gives this machine; a file that does not parse is
/// no reason to refuse a (re)install, so it reads as a node's.
fn role() -> role::Role {
    config::load_for_user()
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
            "--controller" => {
                let a = it.next().context("--controller needs host:port")?;
                if !config::valid_host_port(a) {
                    bail!(
                        "--controller must be host:port (the controller's link address), not {a:?}"
                    );
                }
                cfg.controller_address = Some(a.clone());
            }
            "--pin" => {
                let p = it
                    .next()
                    .context("--pin needs the controller key's fingerprint")?;
                let d = daedalus_agent::identity::parse_fingerprint(p)?;
                cfg.controller_pin = Some(daedalus_agent::identity::format_fingerprint(&d));
            }
            other => bail!("unknown option {other}"),
        }
    }
    // The controller this machine trusts is named at install, never
    // learned from whoever answers first (link/node.rs).
    if cfg.controller_pin.is_none() {
        bail!(
            "--pin is required: the controller key's fingerprint this machine trusts \
             (Settings › Machines shows the install line with it)"
        );
    }
    os::svc::install(&cfg)
}

fn uninstall() -> Result<()> {
    config::refuse_env_override("uninstall")?;
    role().allow_install("uninstall")?;
    os::svc::uninstall()
}

fn status_cmd() -> Result<()> {
    config::load_for_user()?;
    let body = daedalus_agent::local::call("status", serde_json::Value::Null)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

fn update_cmd(args: &[String]) -> Result<()> {
    let apply = args.iter().any(|a| a == "--apply");
    if apply && !role().self_update {
        bail!("`update --apply` refuses in controller mode: nix moves this agent");
    }
    // The running service keeps the state `--apply` writes (the probation
    // the new binary counts its starts against) and would save over it.
    if apply && daedalus_agent::local::call("status", serde_json::Value::Null).is_ok() {
        bail!(
            "the service is running: stop it first, or let it install the release itself (`updates = \"self\"`)"
        );
    }
    let mut state = daedalus_agent::state::State::load();
    let refused = state.rolled_back.as_ref().map(|r| r.version.clone());
    match update::check(refused.as_deref())? {
        None => println!("no newer release than {VERSION}"),
        Some(rel) => {
            println!("newer release: {} ({})", rel.version, rel.tag);
            if apply {
                let staged = update::download_and_verify(&rel)?;
                // As the service does it (update::install): the probation on
                // disk before anything is replaced, the version checked after.
                update::begin_probation(
                    &mut state,
                    &rel.version.to_string(),
                    &daedalus_agent::state::now_rfc3339(),
                );
                state
                    .try_save()
                    .context("the probation could not be recorded; nothing was replaced")?;
                update::swap_in(&staged)?;
                let said = update::installed_version()?;
                if said != rel.version {
                    update::roll_back()?;
                    bail!(
                        "the installed binary says {said}, not {}; put the previous one back",
                        rel.version
                    );
                }
                println!(
                    "installed {}; start the service to run it (on probation: the previous binaries stay until it proves itself)",
                    rel.version
                );
            }
        }
    }
    Ok(())
}

fn claude_cmd(args: &[String]) -> Result<()> {
    config::load_for_user()?;
    match args.first().map(String::as_str) {
        Some("restart") => {
            let said = daedalus_agent::local::call("claude.restart", serde_json::Value::Null)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            println!("{}", said.as_str().unwrap_or_default());
            Ok(())
        }
        _ => bail!("usage: daedalus-agent claude restart"),
    }
}
