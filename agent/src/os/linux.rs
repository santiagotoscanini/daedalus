//! Linux, and any other unix that is not macOS: today's stubs, in one
//! place. The agent builds and `serve` runs — the status page, the hello,
//! the updater's check — but there is no service to install, no awake
//! hold, no telemetry collector and no tray; each says so, as an error or
//! an empty value the box already tolerates. The data directory is
//! `/var/lib/daedalus-agent`, so a read-only install has somewhere to write.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Result};

use crate::net::Adapter;
use crate::telemetry::{Collect, Sample, Slow, Static, Updates};

pub use super::unix::{
    hide_console, mark_executable, on_interrupt, pid_alive, seal, stop_process_tree, unseal,
    write_private, CLAUDE_CLI_NAMES,
};

// ── paths ─────────────────────────────────────────────────────────────────

pub const TRAY_EXE: &str = "daedalus-agent-tray";

pub fn default_data_dir() -> PathBuf {
    PathBuf::from("/var/lib").join(crate::SERVICE_NAME)
}

/// No tray, so no log of its own: the service's.
pub fn user_log_dir() -> Option<PathBuf> {
    None
}

// ── facts ─────────────────────────────────────────────────────────────────

pub fn os_name() -> String {
    String::new()
}

pub fn os_version() -> String {
    String::new()
}

pub fn cpu_name() -> String {
    String::new()
}

pub fn memory_bytes() -> Option<u64> {
    None
}

pub fn hostname() -> Option<String> {
    super::unix::short_hostname()
}

// ── network ───────────────────────────────────────────────────────────────

pub fn primary_adapter() -> Adapter {
    Adapter::default()
}

pub fn srv_lookup(name: &str) -> Option<(String, u16)> {
    let _ = name;
    None
}

// ── power ─────────────────────────────────────────────────────────────────

/// Never held: `acquire` refuses. It has a `Drop` like the other OSes', so
/// the service's explicit `drop(hold)` reads the same everywhere; there is
/// nothing to release.
pub struct Hold {
    _never: (),
}

impl Drop for Hold {
    fn drop(&mut self) {}
}

impl Hold {
    pub fn acquire(reason: &str) -> Result<Self> {
        let _ = reason;
        bail!("power requests are Windows- and macOS-only in this version")
    }
}

pub fn converge_plan() -> Result<Option<&'static str>> {
    Ok(None)
}

pub fn requests_report() -> Option<String> {
    None
}

pub fn os_uptime_secs() -> Option<u64> {
    None
}

// ── update ────────────────────────────────────────────────────────────────

/// No release carries a Linux build yet; a name no release has, so the
/// updater skips every release.
pub const ASSETS: &[(&str, &str)] = &[("daedalus-agent-unsupported", "daedalus-agent")];

// ── Claude Code ───────────────────────────────────────────────────────────

pub fn prepare_claude_server(cmd: &mut Command, home: Option<&Path>) {
    let _ = home;
    super::unix::own_process_group(cmd);
}

pub fn claude_keychain_login() -> bool {
    false
}

// ── telemetry ─────────────────────────────────────────────────────────────

/// Nothing but the errors saying so.
#[derive(Default)]
pub struct Collector;

impl Collect for Collector {
    fn read_static(&mut self) -> Static {
        Static {
            errors: vec!["telemetry is Windows- and macOS-only in this version".into()],
            ..Default::default()
        }
    }
    fn read_slow(&mut self) -> Slow {
        Slow::default()
    }
    fn sample(&mut self) -> Sample {
        Sample::default()
    }
}

pub fn read_updates() -> Updates {
    Updates {
        checked_at: Some(crate::state::now_rfc3339()),
        error: Some("OS updates are read on Windows and macOS only".into()),
        ..Default::default()
    }
}

// ── the service and the tray ──────────────────────────────────────────────

pub mod svc {
    use anyhow::{bail, Result};

    use crate::config::Config;

    /// No tray to watch.
    pub const WATCHES_TRAY: bool = false;

    pub fn run_service() -> Result<()> {
        bail!("`run` is the service entry point on Windows and macOS; use `serve` here")
    }

    pub fn install(cfg: &Config) -> Result<()> {
        let _ = cfg;
        bail!("install is for Windows and macOS in this version")
    }

    pub fn uninstall() -> Result<()> {
        bail!("uninstall is for Windows and macOS in this version")
    }

    pub fn launch_tray_or_session() -> Result<()> {
        bail!("there is no tray on this OS in this version")
    }
}

pub fn tray_main() {
    eprintln!("daedalus-agent-tray is for Windows and macOS in this version");
    std::process::exit(2);
}
