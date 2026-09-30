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
        "pair" => pair(rest),
        // The last step of a log-in (enroll.rs): the menu bar runs it as
        // root, behind the administrator prompt.
        "enroll-finish" => enroll_finish(rest),
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
         install [--pin FINGERPRINT] [--controller HOST:PORT]\n                       register and start the service and the tray (administrator);\n                       with --pin it is paired at once, without it it runs unpaired\n                       (macOS: no options; the Mac logs in from its menu bar)\n  \
         pair --pin FINGERPRINT [--controller HOST:PORT]\n                       trust the controller with that key (administrator), written\n                       to config.toml; the running service connects to it at once;\n                       --controller where it is (else DNS). pair --check: exit 0 if paired\n                       (not on macOS: \"Log in…\" in the menu bar)\n  \
         enroll-finish CODE   (macOS, Linux) a log-in's last step, as root; the menu bar runs it\n  \
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
    if cfg!(target_os = "macos") {
        return install_mac(args);
    }
    // Without --pin the machine installs unpaired: it runs and dials nobody
    // until `pair` names the controller (pair.rs).
    let (pairing, controller) = daedalus_agent::pair::parse_args(args)?;
    // Paired with another box: the last one's santree grant goes before the
    // service starts again.
    if pairing.as_ref().is_some_and(|p| {
        daedalus_agent::pair::moves_pin(&daedalus_agent::paths::config_path(), &p.pin)
    }) {
        daedalus_agent::paths::forget_santree();
    }
    let cfg = config::Config {
        controller_pin: pairing.map(|p| p.pin),
        controller_address: controller,
        ..config::Config::default()
    };
    os::svc::install(&cfg)?;
    if !daedalus_agent::pair::paired_at(&daedalus_agent::link::KeyFiles::here())? {
        println!("\n{}", daedalus_agent::pair::unpaired_hint());
    }
    Ok(())
}

/// macOS: install with no options — the Mac logs in from its menu bar
/// (enroll.rs) — and clear a pin a logged-out Mac kept (an older agent's
/// `pair`): without a tunnel config it is logged out, and says so.
fn install_mac(args: &[String]) -> Result<()> {
    if !args.is_empty() {
        bail!(
            "a Mac logs in from its menu bar (\"Log in…\"); `install` takes no --pin or \
             --controller here"
        );
    }
    let path = daedalus_agent::paths::config_path();
    if !daedalus_agent::paths::tunnel_path().exists() {
        config::clear_link_keys_at(&path)?;
        daedalus_agent::paths::forget_santree();
    }
    os::svc::install(&config::Config::default())?;
    if !daedalus_agent::pair::paired_at(&daedalus_agent::link::KeyFiles::here())? {
        println!("\n{}", daedalus_agent::pair::unpaired_hint());
    }
    Ok(())
}

/// `pair --pin KEY [--controller HOST:PORT]`: name the controller this
/// machine trusts (pair.rs), as an administrator, and have the running
/// service follow it. `pair --check` exits 0 when paired, 1 when not, for
/// the install scripts.
fn pair(args: &[String]) -> Result<()> {
    config::refuse_env_override("pair")?;
    role().allow_install("pair")?;
    if cfg!(target_os = "macos") {
        bail!("a Mac logs in from its menu bar instead (\"Log in…\")");
    }
    let path = daedalus_agent::paths::config_path();
    if args.len() == 1 && args[0] == "--check" {
        if daedalus_agent::pair::paired_at(&daedalus_agent::link::KeyFiles::here())? {
            println!("paired");
            return Ok(());
        }
        println!("not paired");
        std::process::exit(1);
    }
    let (pairing, _) = daedalus_agent::pair::parse_args(args)?;
    let Some(p) = pairing else {
        bail!(
            "--pin is required: the controller key from Settings › Machines, as in\n  {}",
            daedalus_agent::pair::command_line("<key>", None)
        );
    };
    let moved = daedalus_agent::pair::moves_pin(&path, &p.pin);
    p.write_at(&path).with_context(|| {
        format!(
            "config.toml is the service's: run `pair` as {}",
            if cfg!(windows) {
                "an administrator"
            } else {
                "root (sudo)"
            }
        )
    })?;
    if moved {
        daedalus_agent::paths::forget_santree();
    }
    println!("paired: this machine trusts the controller key {}", p.pin);
    match daedalus_agent::local::call("link.reload", serde_json::Value::Null) {
        Ok(_) => println!("the service connects now; `daedalus-agent status` shows the link"),
        Err(e) => println!("the service did not answer ({e}); it reads config.toml when it starts"),
    }
    Ok(())
}

/// `enroll-finish CODE`: a log-in's last step — the code the browser brought
/// back, handed to the service, which redeems it at the app with the PKCE
/// verifier it kept (`enroll.finish`: root alone). The menu bar runs it
/// behind the administrator prompt.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn enroll_finish(args: &[String]) -> Result<()> {
    let [code] = args else {
        bail!("usage: daedalus-agent enroll-finish CODE (the menu bar runs it)");
    };
    let said = daedalus_agent::local::call_within(
        "enroll.finish",
        serde_json::json!({ "code": code }),
        daedalus_agent::local::ENROLL_DEADLINE,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("{}", said.as_str().unwrap_or_default());
    Ok(())
}

#[cfg(windows)]
fn enroll_finish(_args: &[String]) -> Result<()> {
    bail!("no log-in on Windows: pair the machine (`daedalus-agent pair`)")
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
    if body["controller"]["state"] == "unpaired" {
        eprintln!("\n{}", daedalus_agent::pair::unpaired_hint());
    }
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
        // Never applied, `--apply` or not: this version cannot install it.
        Some(update::Offer::Reinstall { version, tag }) => {
            println!("newer release: {version} ({tag})");
            println!("{}", update::reinstall_line(&version.to_string()));
            if apply {
                bail!(
                    "{version} is a macOS app bundle, which this agent cannot apply: re-install it"
                );
            }
        }
        Some(update::Offer::Install(rel)) => {
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
