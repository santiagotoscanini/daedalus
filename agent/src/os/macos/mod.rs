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
//! - `jobs`: Claude's server and resumed sessions as launchd jobs of the
//!   user's gui domain;
//! - `telemetry`: the collector and its tiers.
//!
//! The rest is here: paths, the SRV lookup, and Claude Code's keychain
//! login; unix.rs has what Linux shares.

mod facts;
pub mod jobs;
pub mod launchd;
mod net;
mod power;
mod telemetry;
#[cfg(feature = "tray")]
pub mod tray;

pub use super::unix::{
    claude_holder, connect_local, create_private, ensure_private, file_owner, hide_console,
    isolate, kill_tree, local_socket_path, lock_exclusive, mark_executable, monotonic_usec,
    on_interrupt, own_uid, pid_alive, seal, secure_data_dir, serve_api_socket, serve_local, unseal,
    LocalSocket, CLAUDE_CLI_NAMES, CONFIG_ACCESS,
};
pub use facts::{cpu_name, hostname, memory_bytes, os_name, os_version};
pub use launchd as svc;
pub use net::primary_adapter;
pub use power::{converge_plan, os_uptime_secs, requests_report, Hold};
pub use telemetry::{read_updates, Collector};

use std::path::PathBuf;
use std::process::Command;

/// One command's stdout, as text; empty when it fails. For the quick
/// facts (`sw_vers`, `sysctl`, `scutil`, `route`, `ifconfig`), which
/// answer at once.
fn stdout_of(cmd: &str, args: &[&str]) -> String {
    let mut c = Command::new(cmd);
    c.args(args);
    crate::exec::stdout_or(
        c,
        std::time::Duration::from_secs(5),
        crate::exec::Text::Lossy,
    )
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

/// The menu bar app's own state — its jobs' plists, the sessions to
/// recover — in `~/Library/Application Support/daedalus-agent`. Under
/// `DAEDALUS_AGENT_DATA_DIR` (a development run) None: the moved directory.
pub fn user_state_dir() -> Option<PathBuf> {
    if std::env::var_os(crate::paths::DATA_DIR_ENV).is_some_and(|v| !v.is_empty()) {
        return None;
    }
    std::env::var_os("HOME").map(|h| {
        PathBuf::from(h)
            .join("Library")
            .join("Application Support")
            .join(crate::SERVICE_NAME)
    })
}

// ── the status page's port ────────────────────────────────────────────────

/// Who holds the status page's port when it cannot be bound: not read
/// here (Linux reads /proc/net/tcp).
pub fn port_holder(port: u16) -> Option<String> {
    let _ = port;
    None
}

// ── the local socket ──────────────────────────────────────────────────────

/// Whom the agent's local socket serves (local.rs): root, the service's own
/// uid, and the user at the console — the owner of `/dev/console`, whose
/// menu bar app runs Claude — read at each connection, since it changes
/// with the person logged in.
pub fn local_allowed() -> crate::door::Allowed {
    use std::os::unix::fs::MetadataExt;
    let console: Vec<u32> = std::fs::metadata("/dev/console")
        .map(|m| m.uid())
        .into_iter()
        .filter(|u| *u != 0)
        .collect();
    crate::door::unix_allowed(super::unix::own_uid().unwrap_or(0), &console)
}

/// The operator: whom santree's socket (santree.rs) and a log-in
/// (enroll.rs) serve — root, the service's own uid, and the user who
/// installed the agent (`launchd::installer_uid`, recorded by `install`
/// from `sudo`) — never whoever holds the console:
/// a santree connection is a shell on the box, and a log-in hands the Mac
/// to a box, so another account that fast-user-switches in gets
/// `forbidden`.
pub fn operator_allowed() -> crate::door::Allowed {
    let installer: Vec<u32> = operator_uid().into_iter().collect();
    crate::door::unix_allowed(super::unix::own_uid().unwrap_or(0), &installer)
}

/// The installing user, when one is recorded: an agent that updated
/// itself from before 0.22 has none until `install` runs again.
pub fn operator_uid() -> Option<u32> {
    launchd::installer_uid()
}

// ── network ───────────────────────────────────────────────────────────────

/// The SRV records from the resolv.conf macOS generates from its primary
/// resolver (dns.rs), as Linux asks: no `dig` forked.
pub fn srv_lookup(name: &str) -> Vec<crate::dns::Srv> {
    crate::dns::query_system(name)
}

// ── update ────────────────────────────────────────────────────────────────

/// Universal binaries: one pair for Apple Silicon and Intel alike. Each is
/// (release target, asset name, file name here).
pub const ASSETS: &[(&str, &str, &str)] = &[
    (
        "universal-apple-darwin",
        "daedalus-agent-universal-apple-darwin",
        "daedalus-agent",
    ),
    (
        "universal-apple-darwin",
        "daedalus-agent-tray-universal-apple-darwin",
        "daedalus-agent-tray",
    ),
];
/// Both assets are required here.
pub const OPTIONAL_ASSETS: &[(&str, &str, &str)] = &[];

// ── Claude Code ───────────────────────────────────────────────────────────

/// macOS keeps the login in the login keychain under the service name the
/// CLI uses. Listing the item's attributes needs no access to the secret
/// and so triggers no prompt; the dates inside it would, so they stay
/// unread.
pub fn claude_keychain_login() -> bool {
    let mut c = Command::new("security");
    c.args(["find-generic-password", "-s", "Claude Code-credentials"]);
    crate::exec::both(c, std::time::Duration::from_secs(5)).is_some_and(|r| r.ok)
}

/// A process's parent: `ps -o ppid=`.
pub fn parent_pid(pid: u32) -> Option<u32> {
    let mut cmd = Command::new("/bin/ps");
    cmd.args(["-o", "ppid=", "-p", &pid.to_string()]);
    crate::exec::stdout_or(
        cmd,
        std::time::Duration::from_secs(5),
        crate::exec::Text::Lossy,
    )
    .ok()?
    .trim()
    .parse()
    .ok()
}

/// A live session's CPU and memory are not read here yet (it would take
/// `proc_pidinfo`); the roster says so in its `errors`.
pub const PROCESS_STATS: bool = false;

pub fn process_stats(pid: u32) -> Option<crate::jobs::ProcStats> {
    let _ = pid;
    None
}

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
