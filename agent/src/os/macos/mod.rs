//! macOS: a root LaunchDaemon and a menu bar LaunchAgent (`launchd`), and
//! Apple's tools and a few kernel calls behind the facts, the network, the
//! awake hold and the telemetry. What each file holds:
//!
//! - `facts`: `sw_vers` and `sysctl` for the OS, the processor, the memory;
//! - `net`: the default route's interface, its addresses, and the search
//!   domains (`route`, `ifconfig`, `scutil`);
//! - `power`: the IOKit assertion and the boot time;
//! - `launchd`: `install`, `uninstall`, `run` and the menu bar app's
//!   kickstart — the `svc` surface;
//! - `tray`: one instance, the tao event loop that drives `tray::Tray`,
//!   `open` as the opener;
//! - `telemetry`: the collector and its tiers.
//!
//! The rest is here: paths, the SRV lookup, and Claude Code's keychain
//! login and PATH; unix.rs has what Linux shares.

mod facts;
pub mod launchd;
mod net;
mod power;
mod telemetry;
#[cfg(feature = "tray")]
pub mod tray;

pub use super::unix::{
    file_owner, hide_console, lock_exclusive, mark_executable, monotonic_usec, on_interrupt,
    own_uid, pid_alive, seal, serve_local_socket, stop_process_tree, unseal, write_private,
    LocalSocket, CLAUDE_CLI_NAMES,
};
pub use facts::{cpu_name, hostname, memory_bytes, os_name, os_version};
pub use launchd as svc;
pub use net::primary_adapter;
pub use power::{converge_plan, os_uptime_secs, requests_report, Hold};
pub use telemetry::{read_updates, Collector};

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// One command's stdout, as text; empty when it fails. For the quick
/// facts (`sw_vers`, `sysctl`, `scutil`, `route`, `ifconfig`), which
/// answer at once.
fn stdout_of(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

// ── paths ─────────────────────────────────────────────────────────────────

pub const TRAY_EXE: &str = "daedalus-agent-tray";

pub fn default_data_dir() -> PathBuf {
    PathBuf::from("/Library/Application Support").join(crate::SERVICE_NAME)
}

/// The data directory is root's, so the menu bar app writes to the user's
/// own `~/Library/Logs/daedalus-agent`.
pub fn user_log_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| {
        PathBuf::from(h)
            .join("Library")
            .join("Logs")
            .join(crate::SERVICE_NAME)
    })
}

// ── network ───────────────────────────────────────────────────────────────

/// `dig +short SRV` through the system's resolver settings: dig reads the
/// resolv.conf macOS generates from its primary resolver and bypasses the
/// system cache. macOS ships dig, and its short form is one line per
/// record: `prio weight port target.`
pub fn srv_lookup(name: &str) -> Option<(String, u16)> {
    let out = Command::new("dig")
        .args(["+short", "+time=2", "+tries=1", "SRV", name])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(crate::discover::parse_short_srv)
}

// ── update ────────────────────────────────────────────────────────────────

/// Universal binaries: one pair for Apple Silicon and Intel alike.
pub const ASSETS: &[(&str, &str)] = &[
    ("daedalus-agent-universal-apple-darwin", "daedalus-agent"),
    (
        "daedalus-agent-tray-universal-apple-darwin",
        "daedalus-agent-tray",
    ),
];
/// Both assets are required here.
pub const OPTIONAL_ASSETS: &[(&str, &str)] = &[];

// ── Claude Code ───────────────────────────────────────────────────────────

/// Its own process group, so a stop reaches the sessions it spawned; and a
/// wider PATH, because the LaunchAgent's is the system's and the server
/// spawns git and shells from wherever the user installed them.
pub fn prepare_claude_server(cmd: &mut Command, home: Option<&Path>) {
    super::unix::own_process_group(cmd);
    let path = std::env::var("PATH").unwrap_or_default();
    let local = home.map(|h| h.join(".local/bin").display().to_string());
    cmd.env(
        "PATH",
        format!(
            "{}:/opt/homebrew/bin:/usr/local/bin:{path}",
            local.unwrap_or_default()
        ),
    );
}

/// macOS keeps the login in the login keychain under the service name the
/// CLI uses. Listing the item's attributes needs no access to the secret
/// and so triggers no prompt; the dates inside it would, so they stay
/// unread.
pub fn claude_keychain_login() -> bool {
    Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The server is the menu bar app's child (a launchd job of its own is a
/// later step).
pub const CLAUDE_RC: crate::config::ClaudeRc = crate::config::ClaudeRc::Child;

// ── HTTPS ─────────────────────────────────────────────────────────────────

/// Security.framework, through native-tls: the machine's trust store decides.
pub fn tls(builder: ureq::AgentBuilder) -> ureq::AgentBuilder {
    let tls = native_tls::TlsConnector::new().expect("the OS TLS stack initialises");
    builder.tls_connector(std::sync::Arc::new(tls))
}

// ── the tray program ──────────────────────────────────────────────────────

/// The menu bar app owns the session: it is the one process in the user's
/// Aqua session, where the Claude login (the keychain) is.
pub const TRAY_OWNS_SESSION: bool = true;

#[cfg(feature = "tray")]
pub use crate::tray::main as tray_main;
