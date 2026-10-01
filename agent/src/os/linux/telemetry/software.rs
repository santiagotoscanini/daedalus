//! The slow tier's software: the services that failed (`systemctl`), the
//! Chromium browsers, and the installed applications.
//!
//! An application on Linux is what a person launches: a desktop entry
//! (`*.desktop` that is not hidden), named as it names itself, with the
//! version and publisher of the package that owns it — one `dpkg-query`,
//! `rpm` or `pacman` call for all of them, whichever manager the machine
//! has; on NixOS the store path it resolves to says the same. The flatpaks
//! and snaps are listed by their own tools, their runtimes as runtimes.
//! Libraries and the rest of the thousands of packages are not
//! applications and are not listed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::super::read;
use super::tool;
use super::tool_any;
use crate::telemetry::parse::{linux_sys, linux_tools};
use crate::telemetry::{App, Browser, Slow};

/// `systemctl` answers at once; the deadline is for a wedged bus.
const SYSTEMCTL: Duration = Duration::from_secs(15);
/// A package manager's query over a few hundred paths.
const PACKAGES: Duration = Duration::from_secs(60);
/// A browser's `--version`.
const VERSION: Duration = Duration::from_secs(10);

/// Where the system's desktop entries live; the flatpak and snap exports
/// are listed by their own tools.
const DESKTOP_DIRS: &[&str] = &[
    "/usr/share/applications",
    "/usr/local/share/applications",
    "/run/current-system/sw/share/applications",
];

/// Launchers of other software, by their desktop name.
const LAUNCHERS: &[&str] = &[
    "Steam",
    "Lutris",
    "Heroic Games Launcher",
    "itch",
    "Bottles",
    "Minigalaxy",
];

pub(super) fn read_services(w: &mut Slow) {
    let args = [
        "list-units",
        "--failed",
        "--type=service",
        "--plain",
        "--no-legend",
        "--no-pager",
    ];
    match tool("systemctl", &args, SYSTEMCTL) {
        Ok(t) => {
            let mut down = linux_tools::systemctl_failed(&t);
            if !down.is_empty() {
                let mut show: Vec<&str> = vec!["show", "-p", "Id,ExecMainStatus", "--"];
                show.extend(down.iter().map(|s| s.name.as_str()));
                if let Ok(t) = tool("systemctl", &show, SYSTEMCTL) {
                    let codes: HashMap<String, i64> =
                        linux_tools::systemctl_exit_codes(&t).into_iter().collect();
                    for s in &mut down {
                        s.exit_code = codes.get(&s.name).copied();
                    }
                }
            }
            w.services = down;
        }
        Err(e) => w.errors.push(format!("failed services not read ({e})")),
    }
    let files = [
        "list-unit-files",
        "--type=service",
        "--no-legend",
        "--no-pager",
    ];
    if let Ok(t) = tool("systemctl", &files, SYSTEMCTL) {
        w.service_count = Some(t.lines().filter(|l| !l.trim().is_empty()).count() as u32);
    }
}

// ── browsers ────────────────────────────────────────────────────────────────

/// The Chromium browsers looked for: the command, then the kind, name and
/// channel it stands for. Firefox is not Chromium and is not here.
const BROWSER_COMMANDS: &[(&str, &str, &str, &str)] = &[
    ("google-chrome-stable", "chrome", "Google Chrome", "stable"),
    ("google-chrome", "chrome", "Google Chrome", "stable"),
    ("google-chrome-beta", "chrome", "Google Chrome", "beta"),
    ("google-chrome-unstable", "chrome", "Google Chrome", "dev"),
    ("microsoft-edge-stable", "edge", "Microsoft Edge", "stable"),
    ("microsoft-edge", "edge", "Microsoft Edge", "stable"),
    ("microsoft-edge-beta", "edge", "Microsoft Edge", "beta"),
    ("microsoft-edge-dev", "edge", "Microsoft Edge", "dev"),
    ("brave-browser-stable", "brave", "Brave", "stable"),
    ("brave-browser", "brave", "Brave", "stable"),
    ("brave", "brave", "Brave", "stable"),
    ("brave-browser-beta", "brave", "Brave", "beta"),
    ("brave-browser-nightly", "brave", "Brave", "canary"),
    ("chromium", "chromium", "Chromium", "stable"),
    ("chromium-browser", "chromium", "Chromium", "stable"),
    ("vivaldi-stable", "vivaldi", "Vivaldi", "stable"),
    ("vivaldi", "vivaldi", "Vivaldi", "stable"),
    ("opera", "opera", "Opera", "stable"),
];

/// The same browsers as flatpaks.
const BROWSER_FLATPAKS: &[(&str, &str, &str)] = &[
    ("com.google.Chrome", "chrome", "Google Chrome"),
    ("com.microsoft.Edge", "edge", "Microsoft Edge"),
    ("com.brave.Browser", "brave", "Brave"),
    ("org.chromium.Chromium", "chromium", "Chromium"),
    ("com.vivaldi.Vivaldi", "vivaldi", "Vivaldi"),
    ("com.opera.Opera", "opera", "Opera"),
];

/// Each kind's process name (`/proc/<pid>/comm`, 15 bytes at most).
fn comm_of(kind: &str) -> &'static [&'static str] {
    match kind {
        "chrome" => &["chrome"],
        "edge" => &["msedge"],
        "brave" => &["brave"],
        "chromium" => &["chromium", "chromium-browse"],
        "vivaldi" => &["vivaldi-bin"],
        "opera" => &["opera"],
        _ => &[],
    }
}

/// Every running process: its name and, where readable (root reads all),
/// its executable.
fn processes() -> Vec<(String, Option<PathBuf>)> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .bytes()
                .all(|b| b.is_ascii_digit())
        })
        .filter_map(|e| {
            let comm = read(e.path().join("comm"))?.trim().to_string();
            Some((comm, std::fs::read_link(e.path().join("exe")).ok()))
        })
        .collect()
}

/// The installed Chromium browsers: the commands found on PATH (one per
/// install, however many names point at it), and the flatpaks.
pub(super) fn read_browsers(flatpaks: &[App]) -> (Vec<Browser>, Vec<String>) {
    let procs = processes();
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for (command, kind, name, channel) in BROWSER_COMMANDS {
        let Some(path) = crate::exec::locate(command) else {
            continue;
        };
        let real = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.contains(&real) {
            continue;
        }
        seen.push(real.clone());
        let version = match tool(&path.to_string_lossy(), &["--version"], VERSION) {
            Ok(t) => t.lines().next().and_then(linux_tools::browser_version),
            Err(e) => {
                errors.push(format!("{name}: version not read ({e})"));
                None
            }
        };
        // Its processes run from the install's directory (a wrapper script
        // on PATH points there); by name where the executable is unreadable.
        let install_dir = real.parent().map(Path::to_path_buf);
        let running = procs.iter().any(|(comm, exe)| match (exe, &install_dir) {
            (Some(exe), Some(dir)) => exe.starts_with(dir),
            _ => comm_of(kind).contains(&comm.as_str()),
        });
        out.push(Browser {
            name: name.to_string(),
            kind: kind.to_string(),
            version,
            channel: Some(channel.to_string()),
            path: Some(real.display().to_string()),
            running,
            default_browser: false,
        });
    }
    for (id, kind, name) in BROWSER_FLATPAKS {
        let Some(app) = flatpaks.iter().find(|a| {
            a.path
                .as_deref()
                .is_some_and(|p| p.ends_with(&format!(":{id}")))
        }) else {
            continue;
        };
        out.push(Browser {
            name: name.to_string(),
            kind: kind.to_string(),
            version: app.version.clone(),
            channel: Some("stable".into()),
            path: app.path.clone(),
            running: procs
                .iter()
                .any(|(comm, _)| comm_of(kind).contains(&comm.as_str())),
            default_browser: false,
        });
    }
    if !out.is_empty() {
        errors.push("default browser: a per-user desktop setting, not read on Linux".into());
    }
    (out, errors)
}

// ── installed applications ──────────────────────────────────────────────────

/// "YYYY-MM-DD" of an epoch second.
fn date_of(epoch: u64) -> Option<String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let ts = crate::core::state::rfc3339_ago(now.checked_sub(epoch)?);
    Some(ts[..10].to_string())
}

/// The desktop entries a person launches: (entry path, entry).
fn desktop_entries() -> Vec<(PathBuf, linux_sys::DesktopEntry)> {
    let mut out = Vec::new();
    for dir in DESKTOP_DIRS {
        let Ok(rd) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "desktop"))
            .collect();
        paths.sort();
        for p in paths {
            if let Some(e) = read(&p).and_then(|t| linux_sys::desktop_entry(&t)) {
                if e.application && !e.hidden {
                    out.push((p, e));
                }
            }
        }
    }
    out
}

fn kind_of(e: &linux_sys::DesktopEntry) -> &'static str {
    if LAUNCHERS.contains(&e.name.as_str()) {
        "launcher"
    } else if e.categories.iter().any(|c| c == "Game") {
        "game"
    } else {
        "app"
    }
}

/// The system package that owns each path, from whichever manager is here:
/// (source, package) by path.
fn owners(
    paths: &[String],
    errors: &mut Vec<String>,
) -> HashMap<String, (&'static str, linux_tools::Package)> {
    let mut out = HashMap::new();
    if paths.is_empty() {
        return out;
    }
    let args = |first: &[&'static str]| -> Vec<String> {
        first
            .iter()
            .map(|s| s.to_string())
            .chain(paths.iter().cloned())
            .collect()
    };
    if crate::exec::locate("dpkg-query").is_some() {
        let a = args(&["-S"]);
        let a: Vec<&str> = a.iter().map(String::as_str).collect();
        let owned = match tool_any("dpkg-query", &a, PACKAGES) {
            Ok((_, t)) => linux_tools::dpkg_owners(&t),
            Err(e) => {
                errors.push(format!("installed applications: {e}"));
                return out;
            }
        };
        let mut pkgs: Vec<&str> = owned.iter().map(|(_, p)| p.as_str()).collect();
        pkgs.sort_unstable();
        pkgs.dedup();
        let format = "${Package}\t${Version}\t${Maintainer}\t${Installed-Size}\n";
        let mut w = vec!["-W", "-f", format, "--"];
        w.extend(pkgs);
        let details: HashMap<String, linux_tools::Package> =
            match tool_any("dpkg-query", &w, PACKAGES) {
                Ok((_, t)) => linux_tools::dpkg_packages(&t)
                    .into_iter()
                    .map(|p| (p.name.clone(), p))
                    .collect(),
                Err(e) => {
                    errors.push(format!("installed applications: {e}"));
                    HashMap::new()
                }
            };
        for (path, pkg) in owned {
            let mut p = details.get(&pkg).cloned().unwrap_or(linux_tools::Package {
                name: pkg.clone(),
                ..Default::default()
            });
            p.installed_epoch = std::fs::metadata(format!("/var/lib/dpkg/info/{pkg}.list"))
                .or_else(|_| {
                    std::fs::metadata(format!("/var/lib/dpkg/info/{pkg}:{}.list", dpkg_arch()))
                })
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            out.insert(path, ("dpkg", p));
        }
    } else if crate::exec::locate("rpm").is_some() {
        let a = args(&[
            "-qf",
            "--qf",
            "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\t%{SIZE}\t%{INSTALLTIME}\n",
        ]);
        let a: Vec<&str> = a.iter().map(String::as_str).collect();
        match tool_any("rpm", &a, PACKAGES) {
            Ok((_, t)) => {
                for (path, pkg) in paths.iter().zip(linux_tools::rpm_owners(&t)) {
                    if let Some(p) = pkg {
                        out.insert(path.clone(), ("rpm", p));
                    }
                }
            }
            Err(e) => errors.push(format!("installed applications: {e}")),
        }
    } else if crate::exec::locate("pacman").is_some() {
        let a = args(&["-Qo"]);
        let a: Vec<&str> = a.iter().map(String::as_str).collect();
        match tool_any("pacman", &a, PACKAGES) {
            Ok((_, t)) => {
                for (path, p) in linux_tools::pacman_owners(&t) {
                    out.insert(path, ("pacman", p));
                }
            }
            Err(e) => errors.push(format!("installed applications: {e}")),
        }
    }
    out
}

/// dpkg's native architecture, for the `.list` of a multi-arch package.
fn dpkg_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// The flatpaks: applications and runtimes.
pub(super) fn read_flatpaks(errors: &mut Vec<String>) -> Vec<App> {
    if crate::exec::locate("flatpak").is_none() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let cols = "--columns=application,name,version,origin,installation";
    for (flag, kind) in [("--app", "app"), ("--runtime", "runtime")] {
        match tool("flatpak", &["list", flag, cols], PACKAGES) {
            Ok(t) => out.extend(linux_tools::flatpak_list(&t, kind)),
            Err(e) => errors.push(format!("flatpaks not listed ({e})")),
        }
    }
    out
}

/// Everything a person launches, plus the flatpaks and snaps.
pub(super) fn read_apps(flatpaks: Vec<App>) -> (Vec<App>, Vec<String>) {
    let mut errors = Vec::new();
    let entries = desktop_entries();
    let paths: Vec<String> = entries
        .iter()
        .filter(|(p, _)| !p.starts_with("/run/current-system"))
        .map(|(p, _)| p.display().to_string())
        .collect();
    let owned = owners(&paths, &mut errors);
    let mut apps: Vec<App> = entries
        .into_iter()
        .map(|(path, e)| {
            let key = path.display().to_string();
            let kind = kind_of(&e).to_string();
            if let Some((source, p)) = owned.get(&key) {
                return App {
                    name: e.name,
                    version: p.version.clone(),
                    publisher: p.publisher.clone(),
                    installed_at: p.installed_epoch.and_then(date_of),
                    size_bytes: p.size_bytes,
                    kind,
                    source: Some(source.to_string()),
                    path: Some(key),
                };
            }
            // NixOS: the entry is a link into the store path of its package.
            let store = std::fs::canonicalize(&path)
                .ok()
                .and_then(|r| linux_sys::nix_store_name_version(&r.to_string_lossy()));
            App {
                name: e.name,
                version: store.as_ref().and_then(|(_, v)| v.clone()),
                kind,
                source: Some(if store.is_some() { "nix" } else { "desktop" }.into()),
                path: Some(key),
                ..Default::default()
            }
        })
        .collect();
    apps.extend(flatpaks);
    if crate::exec::locate("snap").is_some() {
        match tool("snap", &["list"], PACKAGES) {
            Ok(t) => apps.extend(linux_tools::snap_list(&t)),
            Err(e) => errors.push(format!("snaps not listed ({e})")),
        }
    }
    (apps, errors)
}
