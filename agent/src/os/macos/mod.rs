//! macOS: a root LaunchDaemon and a menu bar LaunchAgent (`launchd`), and
//! Apple's tools and a few kernel calls behind the facts, the network, the
//! awake hold and the telemetry. What each file holds:
//!
//! - `facts`: `sw_vers` and `sysctl` for the OS, the processor, the memory;
//! - `net`: the default route's interface, its addresses, and the search
//!   domains (`route`, `ifconfig`, `scutil`);
//! - `power`: the IOKit assertion and the boot time;
//! - `bundle`: Daedalus Agent.app — where it runs from, and how a copy of
//!   it is staged, sealed and checked before it replaces the one there;
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

pub mod bundle;
mod facts;
pub mod jobs;
pub mod launchd;
pub mod lemonade;
mod net;
mod power;
mod telemetry;
#[cfg(feature = "tray")]
pub mod tray;

pub use super::unix::{
    claude_holder, connect_local, contain, create_private, ensure_private, file_owner,
    hide_console, isolate, kill_tree, local_socket_path, lock_exclusive, mark_executable,
    monotonic_usec, on_interrupt, own_uid, pid_alive, seal, serve_local, try_lock_exclusive,
    unseal, LocalSocket, Tree, CLAUDE_CLI_NAMES, CONFIG_ACCESS,
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
    if std::env::var_os(crate::core::paths::DATA_DIR_ENV).is_some_and(|v| !v.is_empty()) {
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

/// Whom the agent's local socket serves (ipc/local/): root, the service's own
/// uid, and the user at the console — the owner of `/dev/console`, whose
/// menu bar app runs Claude — read at each connection, since it changes
/// with the person logged in.
pub fn local_allowed() -> crate::ipc::door::Allowed {
    use std::os::unix::fs::MetadataExt;
    let console: Vec<u32> = std::fs::metadata("/dev/console")
        .map(|m| m.uid())
        .into_iter()
        .filter(|u| *u != 0)
        .collect();
    crate::ipc::door::unix_allowed(super::unix::own_uid().unwrap_or(0), &console)
}

/// The operator: whom santree's socket (santree.rs) and a log-in
/// (enroll.rs) serve — root, the service's own uid, and the user who
/// installed the agent (`launchd::installer_uid`, recorded by `install`
/// from `sudo`) — never whoever holds the console:
/// a santree connection is a shell on the box, and a log-in hands the Mac
/// to a box, so another account that fast-user-switches in gets
/// `forbidden`.
pub fn operator_allowed() -> crate::ipc::door::Allowed {
    let installer: Vec<u32> = operator_uid().into_iter().collect();
    crate::ipc::door::unix_allowed(super::unix::own_uid().unwrap_or(0), &installer)
}

/// The installing user, when `install` recorded one.
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

/// One asset: Daedalus Agent.app, universal (Apple Silicon and Intel), zipped
/// — (release target, asset name, what it is here). The updater replaces
/// the bundle whole in its fixed place (update/bundle.rs, bundle.rs).
pub const ASSETS: &[(&str, &str, &str)] = &[(
    "universal-apple-darwin",
    "daedalus-agent-universal-apple-darwin.app.zip",
    "Daedalus Agent.app.zip",
)];
/// Nothing optional: the bundle carries the service and the menu bar app.
pub const OPTIONAL_ASSETS: &[(&str, &str, &str)] = &[];

// ── Claude Code ───────────────────────────────────────────────────────────

/// macOS keeps the login in the login keychain under the service name the
/// CLI uses. Listing the item's attributes needs no access to the secret
/// and so triggers no prompt; the dates inside it would, so they stay
/// unread.
pub fn claude_keychain_login() -> bool {
    let mut c = Command::new("/usr/bin/security");
    c.args(["find-generic-password", "-s", "Claude Code-credentials"]);
    crate::exec::both(c, std::time::Duration::from_secs(5)).is_some_and(|r| r.ok)
}

/// One `proc_pidinfo` flavor of a process, whole; None when it is gone or
/// not this user's to read.
pub(super) fn pidinfo<T>(pid: u32, flavor: libc::c_int) -> Option<T> {
    let size = libc::c_int::try_from(std::mem::size_of::<T>()).ok()?;
    let mut info = std::mem::MaybeUninit::<T>::zeroed();
    // SAFETY: a buffer of exactly `size` bytes for the flavor's struct;
    // read only when the kernel filled all of it.
    unsafe {
        let n = libc::proc_pidinfo(
            libc::c_int::try_from(pid).ok()?,
            flavor,
            0,
            info.as_mut_ptr().cast(),
            size,
        );
        (n == size).then(|| info.assume_init())
    }
}

/// Every process's parent, from libproc (no `ps`): pid → ppid.
pub fn process_table() -> std::collections::HashMap<u32, u32> {
    // SAFETY: a null buffer asks for the count; the second call fills at
    // most the buffer's size and says how many it wrote.
    let pids = unsafe {
        let n = libc::proc_listallpids(std::ptr::null_mut(), 0);
        let mut pids = vec![0 as libc::c_int; usize::try_from(n).unwrap_or(0) + 64];
        let bytes = libc::c_int::try_from(std::mem::size_of_val(pids.as_slice())).unwrap_or(0);
        let got = libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes);
        pids.truncate(usize::try_from(got).unwrap_or(0));
        pids
    };
    pids.into_iter()
        .filter_map(|p| u32::try_from(p).ok().filter(|p| *p > 0))
        .filter_map(|p| {
            pidinfo::<libc::proc_bsdinfo>(p, libc::PROC_PIDTBSDINFO).map(|i| (p, i.pbi_ppid))
        })
        .collect()
}

/// The ratio that turns a task's mach time into nanoseconds (1/1 on Intel).
fn timebase() -> (u64, u64) {
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> libc::c_int;
    }
    let mut t = Timebase { numer: 1, denom: 1 };
    // SAFETY: one out-struct of the declared layout.
    let rc = unsafe { mach_timebase_info(&mut t) };
    if rc != 0 || t.denom == 0 {
        return (1, 1);
    }
    (u64::from(t.numer), u64::from(t.denom))
}

/// A process's command line (`KERN_PROCARGS2`), at most 64 arguments; empty
/// when it cannot be read.
fn args_of(pid: u32) -> Vec<String> {
    let Ok(pid) = libc::c_int::try_from(pid) else {
        return Vec::new();
    };
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    // SAFETY: a null buffer asks the size; the second call fills at most
    // `size` bytes of a buffer that long and says how many it wrote.
    unsafe {
        if libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return Vec::new();
        }
        let mut buf = vec![0u8; size];
        if libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return Vec::new();
        }
        buf.truncate(size);
        crate::jobs::parse_procargs2(&buf, 64)
    }
}

/// A process from libproc: CPU time, resident memory and command line. Its
/// start is not compared: the CLI records `ps -o lstart` here, not a count
/// (jobs/proc.rs `ProcStats`).
pub fn process_stats(pid: u32) -> Option<crate::jobs::ProcStats> {
    let t = pidinfo::<libc::proc_taskinfo>(pid, libc::PROC_PIDTASKINFO)?;
    let (numer, denom) = timebase();
    let mach = t.pti_total_user.saturating_add(t.pti_total_system);
    let nanos = u128::from(mach) * u128::from(numer) / u128::from(denom);
    Some(crate::jobs::ProcStats {
        start_ticks: None,
        cpu_ms: u64::try_from(nanos / 1_000_000).unwrap_or(u64::MAX),
        rss_bytes: t.pti_resident_size,
        args: args_of(pid),
    })
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
