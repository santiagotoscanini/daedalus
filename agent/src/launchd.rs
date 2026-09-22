//! The macOS side of `install`, `uninstall` and `run`: two launchd jobs.
//!
//!   /Library/LaunchDaemons/me.toscanini.daedalus-agent.plist
//!       the service, as root, at boot, kept alive — `daedalus-agent run`
//!   /Library/LaunchAgents/me.toscanini.daedalus-agent-tray.plist
//!       the menu bar app, in every user's Aqua session, kept alive
//!
//! Root for the same two reasons as LocalSystem on Windows: the power
//! assertion should outlive any login, and the updater writes over the
//! binaries. Where they live:
//!
//!   /Library/Application Support/daedalus-agent/bin/daedalus-agent        the service
//!   /Library/Application Support/daedalus-agent/bin/daedalus-agent-tray   the tray
//!   /Library/Application Support/daedalus-agent/{config.toml,state.json,identity.key,logs/}
//!
//! An update swaps the binaries in place (unix lets a running file be
//! renamed away) and exits; launchd's KeepAlive brings the service back on
//! the new one, and the tray relaunches itself as on Windows.
//!
//! `run` is `agent_main` with SIGTERM as the stop: launchd sends it on
//! `bootout` and at shutdown.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{bail, Context, Result};

use crate::config::{self, Config};
use crate::TRAY_EXE;

pub const DAEMON_LABEL: &str = "me.toscanini.daedalus-agent";
pub const TRAY_LABEL: &str = "me.toscanini.daedalus-agent-tray";

fn daemon_plist() -> PathBuf {
    PathBuf::from(format!("/Library/LaunchDaemons/{DAEMON_LABEL}.plist"))
}

fn tray_plist() -> PathBuf {
    PathBuf::from(format!("/Library/LaunchAgents/{TRAY_LABEL}.plist"))
}

static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_term(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}

/// `daedalus-agent run` under launchd: the agent until SIGTERM or SIGINT.
pub fn run() -> Result<()> {
    // SAFETY: the handler only stores to an atomic.
    unsafe {
        libc::signal(libc::SIGTERM, on_term as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_term as *const () as libc::sighandler_t);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let relay = Arc::clone(&stop);
    std::thread::spawn(move || loop {
        if STOP.load(Ordering::Relaxed) {
            relay.store(true, Ordering::Relaxed);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    });
    if is_root() {
        converge_permissions();
        // A moment later, once agent_main has opened the log, so the
        // outcome is recorded.
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(3));
            kickstart_tray();
        });
    }
    crate::agent_main(stop, false)
}

fn is_root() -> bool {
    // SAFETY: no arguments.
    unsafe { libc::geteuid() == 0 }
}

fn launchctl(args: &[&str]) -> Result<()> {
    let out = Command::new("launchctl").args(args).output()?;
    if !out.status.success() {
        bail!(
            "launchctl {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

fn plist(label: &str, program: &Path, args: &[&str], log: &Path, agent: bool) -> String {
    let mut argv = format!("      <string>{}</string>\n", program.display());
    for a in args {
        argv.push_str(&format!("      <string>{a}</string>\n"));
    }
    // A LaunchAgent is loaded into every Aqua session and, being Interactive,
    // may draw; the daemon is Background.
    let session = if agent {
        "    <key>LimitLoadToSessionType</key>\n    <string>Aqua</string>\n    <key>ProcessType</key>\n    <string>Interactive</string>\n"
    } else {
        "    <key>ProcessType</key>\n    <string>Background</string>\n"
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
{argv}    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
{session}    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
  </dict>
</plist>
"#,
        log = log.display(),
    )
}

/// The uid of whoever owns the console — the logged-in user — for loading
/// the tray into their session right now rather than at their next login.
fn console_uid() -> Option<u32> {
    let out = Command::new("stat")
        .args(["-f", "%u", "/dev/console"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// `daedalus-agent install`: the two plists, the config, a start of both.
/// Idempotent: a second run rewrites the plists (the binaries were already
/// replaced by the installer script), leaves config.toml alone, and
/// restarts the daemon onto the new binary.
pub fn install(cfg: &Config) -> Result<()> {
    if !is_root() {
        bail!("install needs root: sudo daedalus-agent install");
    }
    let exe = std::env::current_exe().context("locating this binary")?;
    let tray = exe.with_file_name(TRAY_EXE);
    let logs = config::log_dir();
    std::fs::create_dir_all(&logs).context("creating the log directory")?;
    let path = config::write_if_absent(cfg)?;
    converge_permissions();
    println!("config at {}", path.display());

    // The daemon. bootout first so a re-install lands on the new binary.
    let _ = launchctl(&["bootout", &format!("system/{DAEMON_LABEL}")]);
    std::fs::write(
        daemon_plist(),
        plist(
            DAEMON_LABEL,
            &exe,
            &["run"],
            &logs.join("launchd.log"),
            false,
        ),
    )
    .context("writing the daemon's plist")?;
    launchctl(&["bootstrap", "system", &daemon_plist().to_string_lossy()])?;
    println!("service {DAEMON_LABEL} registered and started");

    // The application firewall, when it is on, would otherwise ask (and a
    // daemon cannot answer). Best effort: absent on some systems.
    let fw = "/usr/libexec/ApplicationFirewall/socketfilterfw";
    if Path::new(fw).exists() {
        let exe_s = exe.to_string_lossy().to_string();
        let _ = Command::new(fw).args(["--add", &exe_s]).output();
        let _ = Command::new(fw).args(["--unblockapp", &exe_s]).output();
    }

    // The tray, for every user at login, and for the console user now.
    if tray.exists() {
        std::fs::write(
            tray_plist(),
            plist(
                TRAY_LABEL,
                &tray,
                &[],
                Path::new("/tmp/daedalus-agent-tray.log"),
                true,
            ),
        )
        .context("writing the tray's plist")?;
        if let Some(uid) = console_uid().filter(|u| *u != 0) {
            let domain = format!("gui/{uid}");
            let _ = launchctl(&["bootout", &format!("{domain}/{TRAY_LABEL}")]);
            match launchctl(&["bootstrap", &domain, &tray_plist().to_string_lossy()]) {
                Ok(()) => {
                    println!("menu bar app registered for every login and started for uid {uid}")
                }
                Err(e) => println!("menu bar app registered for every login; not started now: {e}"),
            }
        } else {
            println!("menu bar app registered for every login");
        }
    } else {
        println!("no {TRAY_EXE} beside the service; the menu bar app is not registered");
    }
    // Once more after the plists are written, so they are readable too.
    converge_permissions();
    Ok(())
}

/// `daedalus-agent uninstall`: stop and remove both jobs. The binaries,
/// config and identity stay for the installer script to remove or keep.
pub fn uninstall() -> Result<()> {
    if !is_root() {
        bail!("uninstall needs root: sudo daedalus-agent uninstall");
    }
    if let Some(uid) = console_uid().filter(|u| *u != 0) {
        let _ = launchctl(&["bootout", &format!("gui/{uid}/{TRAY_LABEL}")]);
    }
    let _ = launchctl(&["bootout", &format!("system/{DAEMON_LABEL}")]);
    for p in [daemon_plist(), tray_plist()] {
        if p.exists() {
            std::fs::remove_file(&p).with_context(|| format!("removing {}", p.display()))?;
        }
    }
    println!("service and menu bar app removed");
    Ok(())
}

/// What the user's processes must be able to read. Root made the tree
/// under whatever umask `sudo sh` had — 077 on some Macs — and the tray
/// runs as the user: it has to traverse the data directory and bin and
/// read config.toml, and launchd has to read the plists. Run at install
/// AND at every service start, because a self-update swaps binaries
/// without re-running install. The identity key stays root's alone
/// (0600, identity.rs).
pub fn converge_permissions() {
    let exe = std::env::current_exe().unwrap_or_default();
    let bin = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let dirs = [config::data_dir(), bin.clone(), config::log_dir()];
    let files = [
        config::config_path(),
        config::state_path(),
        daemon_plist(),
        tray_plist(),
    ];
    let bins = [exe.clone(), bin.join(TRAY_EXE)];
    for (p, mode) in dirs
        .iter()
        .map(|p| (p, 0o755))
        .chain(files.iter().map(|p| (p, 0o644)))
        .chain(bins.iter().map(|p| (p, 0o755)))
    {
        if p.exists() {
            let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
        }
    }
}

/// Start the menu bar app in the console user's session if it is not
/// running. launchd gives up on a job whose spawn failed (a root-only tree
/// did that to every 0.5.0 install) and a self-update replaces binaries
/// without touching jobs, so the daemon asks for it at every start, after
/// the permissions are right. A tray that is already up is left alone;
/// one whose binary changed relaunches itself.
pub fn kickstart_tray() {
    let Some(uid) = console_uid().filter(|u| *u != 0) else {
        return;
    };
    if !tray_plist().exists() {
        return;
    }
    let target = format!("gui/{uid}/{TRAY_LABEL}");
    // Not loaded in that session yet (a login that predates the install):
    // bootstrap it, which also starts it. Loaded: kickstart starts it if
    // it is not running.
    if launchctl(&["print", &target]).is_err() {
        match launchctl(&[
            "bootstrap",
            &format!("gui/{uid}"),
            &tray_plist().to_string_lossy(),
        ]) {
            Ok(()) => tracing::info!(uid, "menu bar app loaded into the console session"),
            Err(e) => tracing::warn!(uid, error = %e, "menu bar app not loaded"),
        }
        return;
    }
    match launchctl(&["kickstart", &target]) {
        Ok(()) => tracing::info!(uid, "menu bar app kickstarted"),
        Err(e) => tracing::warn!(uid, error = %e, "menu bar app not kickstarted"),
    }
}
