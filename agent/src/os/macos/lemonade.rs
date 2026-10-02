//! Lemonade on macOS: the `.pkg`, whose root LaunchDaemon
//! `ai.lemonadeserver.server` runs `lemond` for the machine, beside a
//! per-user tray. The install is the pkg receipt and the daemon's plist;
//! startup is launchd's enable/disable; power is bootstrap/bootout on the
//! vendor label. Built and compile-checked; no Mac offers Lemonade yet.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::exec::{stdout_any, stdout_or, Text};
use crate::node::providers::host::{launchctl_disabled, pkgutil_info};
use crate::node::providers::{
    Console, Found, ProviderInstall, ProviderInstallMethod, ProviderInstallScope, ProviderStartup,
};

/// The installers this OS takes.
pub const INSTALLERS: &[&str] = &["pkg"];

const LABEL: &str = "ai.lemonadeserver.server";
const PLIST: &str = "/Library/LaunchDaemons/ai.lemonadeserver.server.plist";
const QUICK: Duration = Duration::from_secs(10);
const INSTALL: Duration = Duration::from_secs(15 * 60);

fn target() -> String {
    format!("system/{LABEL}")
}

fn run(program: &str, args: &[&str], deadline: Duration) -> Result<(i32, String), String> {
    let mut c = Command::new(program);
    c.args(args);
    stdout_any(c, deadline, Text::Lossy).map_err(|e| format!("{program} {}: {e}", args.join(" ")))
}

/// The receipt, the daemon's plist, its process and its enablement.
pub fn find() -> Found {
    let mut found = Found {
        console: Some(Console::default()),
        ..Default::default()
    };
    let plist = Path::new(PLIST).is_file();
    let receipt = run("/usr/sbin/pkgutil", &["--pkgs"], QUICK)
        .ok()
        .and_then(|(_, t)| {
            t.lines()
                .map(str::trim)
                .find(|l| l.to_ascii_lowercase().contains("lemonade"))
                .map(str::to_string)
        });
    if !plist && receipt.is_none() {
        return found;
    }
    let (installer_version, location) = receipt
        .as_deref()
        .and_then(|id| {
            let mut c = Command::new("/usr/sbin/pkgutil");
            c.args(["--pkg-info", id]);
            stdout_or(c, QUICK, Text::Lossy).ok()
        })
        .map(|t| pkgutil_info(&t))
        .unwrap_or_default();
    found.install = Some(ProviderInstall {
        method: ProviderInstallMethod::Pkg,
        scope: ProviderInstallScope::Machine,
        location,
        installer_version,
        user: None,
    });
    if let Ok((0, t)) = run("/bin/launchctl", &["print", &target()], QUICK) {
        if let Some(crate::jobs::JobState::Running { pid, .. }) =
            crate::jobs::parse_launchctl_print(&t)
        {
            found.pid = pid;
        }
    }
    found.startup = match run("/bin/launchctl", &["print-disabled", "system"], QUICK) {
        Ok((_, t)) => Some(if launchctl_disabled(&t, LABEL) == Some(true) {
            ProviderStartup::Disabled
        } else {
            ProviderStartup::Enabled
        }),
        Err(e) => {
            found.errors.push(e);
            None
        }
    };
    found
}

/// Where the installer's output is kept.
pub fn log_path(_found: &Found) -> PathBuf {
    crate::core::paths::log_dir().join("lemonade-install.log")
}

/// `installer -pkg <file> -target /`: its postflight reinstalls the plist
/// and kickstarts the daemon. An older package installs over a newer one,
/// so a roll-back is the same call.
pub fn install(file: &Path, _found: &Found, log: &Path, _downgrade: bool) -> Result<(), String> {
    let mut c = Command::new("/usr/sbin/installer");
    c.arg("-verboseR")
        .arg("-pkg")
        .arg(file)
        .args(["-target", "/"]);
    let ran = crate::exec::both(c, INSTALL);
    if let Some(r) = &ran {
        let _ =
            crate::util::write_atomic(log, r.output.as_bytes(), crate::util::Access::Mode(0o640));
    }
    match ran {
        Some(r) if r.ok => Ok(()),
        Some(_) => Err("installer failed (see its log)".into()),
        None => Err("installer: not run, or no answer in time".into()),
    }
}

pub fn uninstall(_file: &Path, _found: &Found, _log: &Path) -> Result<(), String> {
    Ok(())
}

fn launchctl(args: &[&str]) -> Result<(), String> {
    match run("/bin/launchctl", args, Duration::from_secs(30))? {
        (0, _) => Ok(()),
        (code, _) => Err(format!("launchctl {} exited {code}", args.join(" "))),
    }
}

/// Loaded and kicked. A daemon disabled at boot (always-on off) is enabled
/// for the bootstrap and disabled again, which keeps it off at the next
/// boot without unloading it now.
pub fn start(found: &Found) -> Result<(), String> {
    let disabled = found.startup == Some(ProviderStartup::Disabled);
    if disabled {
        launchctl(&["enable", &target()])?;
    }
    if run("/bin/launchctl", &["print", &target()], QUICK).map(|(c, _)| c) != Ok(0) {
        launchctl(&["bootstrap", "system", PLIST])?;
    }
    let kicked = launchctl(&["kickstart", &target()]);
    if disabled {
        launchctl(&["disable", &target()])?;
    }
    kicked
}

pub fn stop(_found: &Found, _port: u16) -> Result<(), String> {
    launchctl(&["bootout", &target()])
}

pub fn set_startup(_found: &Found, on: bool) -> Result<(), String> {
    launchctl(&[if on { "enable" } else { "disable" }, &target()])
}
