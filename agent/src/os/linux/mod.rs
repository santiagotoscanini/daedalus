//! Linux (systemd distributions, x86_64 and aarch64): a root systemd
//! service, the `session` as a systemd user unit that runs with nobody
//! logged in (linger), Claude remote control as a transient user unit of
//! its own, and on an x86_64 desktop a tray. Everything is read from
//! `/proc`, `/sys` and `/etc`; the few tools (`systemd-inhibit`,
//! `systemctl`, `smartctl`, the package managers) run only where a file
//! cannot answer. What each file holds:
//!
//! - `net`: the default route's interface, its addresses, resolv.conf's
//!   search domains, and the SRV lookup (dns.rs over UDP);
//! - `power`: the logind inhibitor and the uptime;
//! - `systemd`: `install`, `uninstall` and `run` — the `svc` surface — and
//!   the unit files they write;
//! - `jobs`: Claude's server and resumed sessions as transient user units;
//! - `telemetry`: the collector and its tiers;
//! - `tray`: GTK's loop driving `tray::Tray` over the session unit.
//!
//! The rest is here: paths, facts, the release's assets and Claude Code's
//! command; unix.rs has what macOS shares.

pub mod jobs;
mod net;
mod power;
pub mod systemd;
mod telemetry;
#[cfg(feature = "tray")]
pub mod tray;

pub use super::unix::{
    claude_holder, connect_local, create_private, ensure_private, file_owner, hide_console,
    local_socket_path, lock_exclusive, mark_executable, monotonic_usec, on_interrupt, own_uid,
    pid_alive, seal, secure_data_dir, serve_api_socket, serve_local, unseal, LocalSocket,
    CLAUDE_CLI_NAMES, CONFIG_ACCESS,
};
pub use net::{primary_adapter, srv_lookup};
pub use power::{converge_plan, os_uptime_secs, requests_report, Hold};
pub use systemd as svc;
pub use telemetry::{read_updates, Collector};

use std::path::{Path, PathBuf};

use crate::telemetry::parse::linux_sys;

/// A small text file under /proc, /sys or /etc; None when unreadable.
fn read(path: impl AsRef<Path>) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// A one-line sysfs attribute, trimmed; None when absent or empty.
fn read_line(path: impl AsRef<Path>) -> Option<String> {
    read(path)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ── paths ─────────────────────────────────────────────────────────────────

pub const TRAY_EXE: &str = "daedalus-agent-tray";

/// Root's, like the service: `/var/lib/daedalus-agent`.
pub fn default_data_dir() -> PathBuf {
    PathBuf::from("/var/lib").join(crate::SERVICE_NAME)
}

/// The session and the tray run as the user and write to
/// `$XDG_STATE_HOME/daedalus-agent` (`~/.local/state/daedalus-agent`).
/// Under `DAEDALUS_AGENT_DATA_DIR` — a development run — None, so they
/// write beside the service's logs in the moved directory.
pub fn user_log_dir() -> Option<PathBuf> {
    if std::env::var_os(crate::paths::DATA_DIR_ENV).is_some_and(|v| !v.is_empty()) {
        return None;
    }
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))?;
    Some(state.join(crate::SERVICE_NAME))
}

/// The session's own state — its jobs' gcroots, the sessions to recover —
/// lives where its logs do: the XDG state directory is what that is.
pub fn user_state_dir() -> Option<PathBuf> {
    user_log_dir()
}

// ── the status page's port ────────────────────────────────────────────────

/// Who listens on 127.0.0.1:`port` (or every interface) when the status
/// page cannot bind it: the socket's owner uid, from /proc/net/tcp.
pub fn port_holder(port: u16) -> Option<String> {
    let text = read("/proc/net/tcp")?;
    crate::telemetry::parse::linux_sys::tcp_listener_uid(&text, port)
        .map(|uid| format!("uid {uid}"))
}

// ── the local socket ──────────────────────────────────────────────────────

/// Whom the agent's local socket serves (local.rs): root, the service's own
/// uid, and the user `install` enabled the session for (`session.json`) —
/// read at each connection, since `install` records it after the service
/// is up.
pub fn local_allowed() -> crate::door::Allowed {
    let session: Vec<u32> = systemd::session_uid().into_iter().collect();
    crate::door::unix_allowed(super::unix::own_uid().unwrap_or(0), &session)
}

// ── facts ─────────────────────────────────────────────────────────────────

fn os_release() -> std::collections::HashMap<String, String> {
    read("/etc/os-release")
        .or_else(|| read("/usr/lib/os-release"))
        .map(|t| linux_sys::os_release(&t))
        .unwrap_or_default()
}

/// os-release's `NAME` ("Ubuntu", "NixOS").
pub fn os_name() -> String {
    linux_sys::os_name_version(&os_release()).0
}

/// os-release's `VERSION_ID` ("24.04"), else its `BUILD_ID`.
pub fn os_version() -> String {
    linux_sys::os_name_version(&os_release()).1
}

/// `/proc/cpuinfo`'s model name.
pub fn cpu_name() -> String {
    read("/proc/cpuinfo")
        .and_then(|t| linux_sys::cpuinfo(&t).model)
        .unwrap_or_default()
}

/// `/proc/meminfo`'s `MemTotal`.
pub fn memory_bytes() -> Option<u64> {
    read("/proc/meminfo").and_then(|t| linux_sys::meminfo(&t).get("MemTotal").copied())
}

pub fn hostname() -> Option<String> {
    super::unix::short_hostname()
}

// ── HTTPS ─────────────────────────────────────────────────────────────────

/// rustls over the system's CA bundle (rustls-native-certs reads
/// `SSL_CERT_FILE`, or the distribution's own bundle). Mozilla's roots,
/// compiled in, are used only when the system yields no root at all — a
/// minimal image without ca-certificates — so the machine's store decides
/// wherever it has one.
pub fn tls(builder: ureq::AgentBuilder) -> ureq::AgentBuilder {
    let mut roots = rustls::RootCertStore::empty();
    let (valid, _) = roots
        .add_parsable_certificates(rustls_native_certs::load_native_certs().unwrap_or_default());
    if valid == 0 {
        roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
    }
    let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("ring supports the default TLS versions")
    .with_root_certificates(roots)
    .with_no_client_auth();
    builder.tls_config(std::sync::Arc::new(config))
}

// ── update ────────────────────────────────────────────────────────────────

/// The static musl service for this architecture, required; the tray,
/// built against glibc and GTK for x86_64 only, optional — a release
/// installs on a machine without it, and an aarch64 machine never has one.
#[cfg(target_arch = "x86_64")]
pub const ASSETS: &[(&str, &str)] =
    &[("daedalus-agent-x86_64-unknown-linux-musl", "daedalus-agent")];
#[cfg(target_arch = "x86_64")]
pub const OPTIONAL_ASSETS: &[(&str, &str)] = &[(
    "daedalus-agent-tray-x86_64-unknown-linux-gnu",
    "daedalus-agent-tray",
)];
#[cfg(target_arch = "aarch64")]
pub const ASSETS: &[(&str, &str)] = &[(
    "daedalus-agent-aarch64-unknown-linux-musl",
    "daedalus-agent",
)];
#[cfg(target_arch = "aarch64")]
pub const OPTIONAL_ASSETS: &[(&str, &str)] = &[];
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
pub const ASSETS: &[(&str, &str)] = &[("daedalus-agent-unsupported", "daedalus-agent")];
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
pub const OPTIONAL_ASSETS: &[(&str, &str)] = &[];

// ── Claude Code ───────────────────────────────────────────────────────────

/// The login is a file in the profile here, never a keychain item.
pub fn claude_keychain_login() -> bool {
    false
}

/// A process's parent, from /proc.
pub fn parent_pid(pid: u32) -> Option<u32> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    crate::jobs::parse_proc_stat(&text).map(|s| s.ppid)
}

/// /proc answers for a live session's process.
pub const PROCESS_STATS: bool = true;

/// A process from /proc: its start (clock ticks since boot, what a session
/// file's `procStart` records), CPU time, resident memory and command line.
/// None when it is gone or unreadable.
pub fn process_stats(pid: u32) -> Option<crate::jobs::ProcStats> {
    let dir = PathBuf::from(format!("/proc/{pid}"));
    let stat = crate::jobs::parse_proc_stat(&std::fs::read_to_string(dir.join("stat")).ok()?)?;
    // SAFETY: sysconf reads a constant.
    let (hz, page) = unsafe {
        (
            libc::sysconf(libc::_SC_CLK_TCK),
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    let hz = u64::try_from(hz).ok().filter(|h| *h > 0).unwrap_or(100);
    let page = u64::try_from(page).ok().filter(|p| *p > 0).unwrap_or(4096);
    let resident = std::fs::read_to_string(dir.join("statm"))
        .ok()
        .and_then(|t| t.split_whitespace().nth(1)?.parse::<u64>().ok())
        .unwrap_or(0);
    let args = std::fs::read(dir.join("cmdline"))
        .map(|b| {
            b.split(|c| *c == 0)
                .filter(|a| !a.is_empty())
                .take(64)
                .map(|a| String::from_utf8_lossy(a).into_owned())
                .collect()
        })
        .unwrap_or_default();
    Some(crate::jobs::ProcStats {
        start_ticks: stat.start_ticks,
        cpu_ms: (stat.utime + stat.stime) * 1000 / hz,
        rss_bytes: resident * page,
        args,
    })
}

// ── the tray ──────────────────────────────────────────────────────────────

/// The tray shows the session unit — which runs with or without a
/// desktop — through the service; it owns nothing.
pub const TRAY_OWNS_SESSION: bool = false;

#[cfg(feature = "tray")]
pub use crate::tray::main as tray_main;

#[cfg(test)]
mod tests {
    use super::*;

    /// install.sh downloads by name what the updater later replaces by
    /// name; the two must agree, or a machine installs and never updates.
    #[test]
    fn the_installer_fetches_the_assets_the_updater_follows() {
        let script = include_str!("../../../install.sh");
        let arch = std::env::consts::ARCH;
        assert!(script.contains("asset=\"daedalus-agent-${arch}-unknown-linux-musl\""));
        assert!(script.contains(&format!("{arch})")) || script.contains(&format!("{arch} |")));
        if matches!(arch, "x86_64" | "aarch64") {
            assert_eq!(
                ASSETS,
                &[(
                    format!("daedalus-agent-{arch}-unknown-linux-musl").as_str(),
                    "daedalus-agent"
                )]
            );
        }
        for (remote, local) in OPTIONAL_ASSETS {
            assert!(
                script.contains(remote),
                "install.sh does not fetch {remote}"
            );
            assert!(script.contains(&format!("$BIN/{local}")));
        }
        // The macOS branch is unchanged: its two universal assets.
        assert!(script.contains("daedalus-agent-universal-apple-darwin:daedalus-agent"));
        assert!(script.contains("daedalus-agent-tray-universal-apple-darwin:daedalus-agent-tray"));
    }
}
