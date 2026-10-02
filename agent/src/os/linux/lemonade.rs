//! Lemonade on Linux: the `.deb` or `.rpm`, whose `lemond.service` runs the
//! server as the user `lemonade` — the machine's daemon, needing no one
//! logged on. The install is the package that owns the unit file; startup
//! is the unit's enablement; the installer is apt or dnf on the downloaded
//! file. Built and compile-checked; no Linux machine offers Lemonade yet.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::exec::{stdout_any, stdout_or, Text};
use crate::node::providers::host::{dpkg_owner, show_value};
use crate::node::providers::{
    Console, Found, ProviderInstall, ProviderInstallMethod, ProviderInstallScope, ProviderStartup,
};

/// The installers this OS takes.
pub const INSTALLERS: &[&str] = &["deb", "rpm"];

const UNIT: &str = "lemond.service";
const QUICK: Duration = Duration::from_secs(10);
const INSTALL: Duration = Duration::from_secs(15 * 60);

fn tool(name: &str) -> Option<Command> {
    crate::exec::locate(name).map(Command::new)
}

/// The unit, the package that owns it, and whether it runs and is enabled.
pub fn find() -> Found {
    let mut found = Found {
        console: Some(Console::default()),
        ..Default::default()
    };
    let Some(mut cmd) = tool("systemctl") else {
        found.errors.push("no systemctl".into());
        return found;
    };
    cmd.args([
        "show",
        UNIT,
        "-p",
        "LoadState,FragmentPath,UnitFileState,MainPID",
    ]);
    let show = match stdout_or(cmd, QUICK, Text::Lossy) {
        Ok(s) => s,
        Err(e) => {
            found.errors.push(format!("systemctl show {UNIT}: {e}"));
            return found;
        }
    };
    if show_value(&show, "LoadState") != "loaded" {
        return found;
    }
    let unit = show_value(&show, "FragmentPath").to_string();
    found.pid = show_value(&show, "MainPID")
        .parse::<u32>()
        .ok()
        .filter(|p| *p > 0);
    found.startup = match show_value(&show, "UnitFileState") {
        "enabled" | "enabled-runtime" | "static" | "alias" => Some(ProviderStartup::Enabled),
        "" => None,
        _ => Some(ProviderStartup::Disabled),
    };
    let mut install = ProviderInstall {
        scope: ProviderInstallScope::Machine,
        location: (!unit.is_empty()).then(|| unit.clone()),
        ..Default::default()
    };
    if let Some(pkg) = tool("dpkg-query").and_then(|mut c| {
        c.args(["-S", &unit]);
        stdout_or(c, QUICK, Text::Lossy)
            .ok()
            .and_then(|t| dpkg_owner(&t))
    }) {
        install.method = ProviderInstallMethod::Deb;
        install.installer_version = tool("dpkg-query").and_then(|mut c| {
            c.args(["-W", "-f=${Version}", &pkg]);
            stdout_or(c, QUICK, Text::Lossy)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        });
    } else if let Some(v) = tool("rpm").and_then(|mut c| {
        c.args(["-qf", "--qf", "%{VERSION}-%{RELEASE}", &unit]);
        stdout_or(c, QUICK, Text::Lossy)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }) {
        install.method = ProviderInstallMethod::Rpm;
        install.installer_version = Some(v);
    } else {
        found
            .errors
            .push(format!("no package owns {unit}: installed by hand"));
        return found;
    }
    found.install = Some(install);
    found
}

/// Where the package tool's output is kept.
pub fn log_path(_found: &Found) -> PathBuf {
    crate::core::paths::log_dir().join("lemonade-install.log")
}

/// Run a command to its end within `deadline`, its output into `log`.
fn logged(mut cmd: Command, log: &Path, deadline: Duration) -> Result<(), String> {
    let what = format!("{:?}", cmd.get_program());
    cmd.env("DEBIAN_FRONTEND", "noninteractive");
    let ran = crate::exec::both(cmd, deadline);
    if let Some(r) = &ran {
        let _ =
            crate::util::write_atomic(log, r.output.as_bytes(), crate::util::Access::Mode(0o640));
    }
    match ran {
        Some(r) if r.ok => Ok(()),
        Some(_) => Err(format!("{what} failed (see its log)")),
        None => Err(format!("{what}: not run, or no answer in time")),
    }
}

/// The downloaded package installed, over whatever is there — a
/// `downgrade` too, for a roll-back. The `.deb` restarts the unit on an
/// upgrade; an `.rpm` starts nothing, which the install's verification
/// does.
pub fn install(file: &Path, _found: &Found, log: &Path, downgrade: bool) -> Result<(), String> {
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
    let cmd = match ext {
        "deb" => {
            let mut c = tool("apt-get").ok_or("no apt-get to install a .deb with")?;
            c.args(["install", "-y"]);
            if downgrade {
                c.arg("--allow-downgrades");
            }
            c.arg(file);
            c
        }
        "rpm" if downgrade => {
            let mut c = tool("rpm").ok_or("no rpm to install an .rpm with")?;
            c.args(["-U", "--oldpackage", "--replacepkgs"]).arg(file);
            c
        }
        "rpm" => {
            let mut c = tool("dnf").ok_or("no dnf to install an .rpm with")?;
            c.args(["install", "-y"]).arg(file);
            c
        }
        e => return Err(format!("a .{e} is not an installer for Linux")),
    };
    logged(cmd, log, INSTALL)
}

/// Nothing to undo first: the package tools take an older package over a
/// newer one (`install` with `downgrade`).
pub fn uninstall(_file: &Path, _found: &Found, _log: &Path) -> Result<(), String> {
    Ok(())
}

fn systemctl(verb: &str) -> Result<(), String> {
    let mut c = tool("systemctl").ok_or("no systemctl")?;
    c.args([verb, UNIT]);
    match stdout_any(c, Duration::from_secs(60), Text::Lossy) {
        Ok((0, _)) => Ok(()),
        Ok((code, _)) => Err(format!("systemctl {verb} {UNIT} exited {code}")),
        Err(e) => Err(format!("systemctl {verb} {UNIT}: {e}")),
    }
}

pub fn start(_found: &Found) -> Result<(), String> {
    systemctl("start")
}

pub fn stop(_found: &Found, _port: u16) -> Result<(), String> {
    systemctl("stop")
}

pub fn set_startup(_found: &Found, on: bool) -> Result<(), String> {
    systemctl(if on { "enable" } else { "disable" })
}
