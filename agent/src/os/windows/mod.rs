//! Windows: a LocalSystem service (`service`), a tray in the desktop session
//! (`tray`), and the Win32 and registry readers behind the facts, the
//! network, the awake hold and the telemetry. What each file holds:
//!
//! - `facts`: the OS's name and version, the processor and memory;
//! - `net`: the primary adapter (`GetAdaptersAddresses`); `dns`: the SRV
//!   lookup through the OS resolver (`DnsQuery_W`);
//! - `power`: the power request and the power plan (`powercfg`);
//! - `dpapi`: the identity key sealed under the machine's DPAPI scope;
//! - `service`: `install`, `uninstall`, `run` and the tray started as the
//!   console user — the `svc` surface;
//! - `tray`: one instance, the Win32 message loop, Explorer as the opener;
//! - `jobs`: Claude's server and resumed sessions as processes detached from
//!   the tray, and `holder`: the pseudo-console a resumed session runs in;
//! - `pipe`: the agent's local door, a named pipe that knows its callers;
//! - `telemetry`: the collector and its tiers.
//!
//! The small things are here: paths, processes, the Claude command's names.

mod acl;
mod dns;
mod dpapi;
mod facts;
mod holder;
pub mod jobs;
pub mod lemonade;
mod net;
mod pipe;
mod power;
pub mod service;
mod telemetry;
#[cfg(feature = "tray")]
pub mod tray;

pub use acl::{create_private, ensure_private, file_owner, protect_data_dir};
pub use dns::srv_lookup;
pub use dpapi::{seal, unseal};
pub use facts::{cpu_name, memory_bytes, os_name, os_version};
pub use holder::run as claude_holder;
pub use net::primary_adapter;
pub use pipe::{connect_local, local_allowed, local_socket_path, serve_local, LocalSocket};
pub use power::{converge_plan, os_uptime_secs, requests_report, Hold};
pub use service as svc;
pub use telemetry::{read_updates, Collector};

use std::path::{Path, PathBuf};
use std::process::Command;

// ── paths ─────────────────────────────────────────────────────────────────

pub const TRAY_EXE: &str = "daedalus-agent-tray.exe";

/// `C:\ProgramData\daedalus-agent`; beside the binary, in `data\`, on a
/// machine without `ProgramData` in its environment.
pub fn default_data_dir() -> PathBuf {
    if let Ok(pd) = std::env::var("ProgramData") {
        return PathBuf::from(pd).join(crate::SERVICE_NAME);
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("data")))
        .unwrap_or_else(|| PathBuf::from("data"))
}

/// The tray and the session write their own logs where the user's own
/// files are, `%LOCALAPPDATA%\daedalus-agent\logs`: the service's `logs\`
/// is SYSTEM's and Administrators' alone (audit D2), so no user can plant
/// what the service opens by name. Under `DAEDALUS_AGENT_DATA_DIR` None: the
/// moved directory.
pub fn user_log_dir() -> Option<PathBuf> {
    user_state_dir().map(|d| d.join("logs"))
}

/// The tray's own state — its jobs' records, the sessions to recover — is
/// the user's, not the machine's: `%LOCALAPPDATA%\daedalus-agent`. Under
/// `DAEDALUS_AGENT_DATA_DIR` (a development run) None: the moved directory.
pub fn user_state_dir() -> Option<PathBuf> {
    if std::env::var_os(crate::core::paths::DATA_DIR_ENV).is_some_and(|v| !v.is_empty()) {
        return None;
    }
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(crate::SERVICE_NAME))
}

// ── the status page's port ────────────────────────────────────────────────

/// Who holds the status page's port when it cannot be bound: not read
/// here (Linux reads /proc/net/tcp).
pub fn port_holder(port: u16) -> Option<String> {
    let _ = port;
    None
}

// ── facts ─────────────────────────────────────────────────────────────────

/// Nothing beyond `COMPUTERNAME`, which facts.rs reads first.
pub fn hostname() -> Option<String> {
    None
}

// ── processes: locks and clocks ───────────────────────────────────────────

/// An exclusive lock on `path` (created if absent): the file opened with no
/// sharing, held while it is open; None when another process has it open,
/// or it cannot be opened (`try_lock_exclusive` tells the two apart).
pub fn lock_exclusive(path: &Path) -> Option<std::fs::File> {
    try_lock_exclusive(path).ok().flatten()
}

/// The same: Ok(None) when another process has it open (a sharing
/// violation), an error when it cannot be opened.
pub fn try_lock_exclusive(path: &Path) -> std::io::Result<Option<std::fs::File>> {
    use std::os::windows::fs::OpenOptionsExt;
    /// `ERROR_SHARING_VIOLATION`.
    const SHARING_VIOLATION: i32 = 32;
    match std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .share_mode(0)
        .open(path)
    {
        Ok(f) => Ok(Some(f)),
        Err(e) if e.raw_os_error() == Some(SHARING_VIOLATION) => Ok(None),
        Err(e) => Err(e),
    }
}

/// systemd's monotonic clock has no meaning here (no Claude unit on
/// Windows).
pub fn monotonic_usec() -> Option<u64> {
    None
}

// ── identity ──────────────────────────────────────────────────────────────

/// How config.toml is written: SYSTEM and Administrators only — it names
/// the controller this machine trusts (T4); the tray, which runs as the
/// user, reads the defaults instead (`config::load_for_user`).
pub const CONFIG_ACCESS: crate::util::Access = crate::util::Access::Private;

/// Windows has no uid: ownership is judged by SID (acl.rs).
pub fn own_uid() -> Option<u32> {
    None
}

// ── update ────────────────────────────────────────────────────────────────

/// Only x86_64 is built; an ARM Windows machine finds no asset of its own
/// and skips every release. Each is (release target, asset name, file
/// name here).
#[cfg(target_arch = "x86_64")]
pub const ASSETS: &[(&str, &str, &str)] = &[
    (
        "x86_64-pc-windows-msvc",
        "daedalus-agent-x86_64-pc-windows-msvc.exe",
        "daedalus-agent.exe",
    ),
    (
        "x86_64-pc-windows-msvc",
        "daedalus-agent-tray-x86_64-pc-windows-msvc.exe",
        "daedalus-agent-tray.exe",
    ),
];
#[cfg(not(target_arch = "x86_64"))]
pub const ASSETS: &[(&str, &str, &str)] = &[(
    "unsupported",
    "daedalus-agent-unsupported",
    "daedalus-agent",
)];
/// Both assets are required here.
pub const OPTIONAL_ASSETS: &[(&str, &str, &str)] = &[];

/// The extension is what makes a file executable here.
pub fn mark_executable(path: &Path) -> std::io::Result<()> {
    let _ = path;
    Ok(())
}

// ── processes ─────────────────────────────────────────────────────────────

/// `CREATE_NO_WINDOW`: a console program started from the tray (a
/// GUI-subsystem process) would otherwise flash a console window; from the
/// service it costs nothing.
pub fn hide_console(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Nothing to add before the start on Windows: `hide_console` sets the
/// creation flags, and the tree is contained once the child exists
/// (`contain`).
pub fn isolate(cmd: &mut Command) {
    let _ = cmd;
}

/// A job object holding a child `exec` runs, and so everything it starts:
/// what `kill_tree` ends at a deadline. None when the job could not be made
/// or the child put in it; the child alone is ended then.
pub struct Tree(Option<windows::Win32::Foundation::HANDLE>);

impl Drop for Tree {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            // SAFETY: the job handle `contain` opened, closed once. No
            // kill-on-close limit is set: a process the child left running
            // on purpose outlives a command that finished.
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(h);
            }
        }
    }
}

/// The child in a job object of its own; its children are born in it.
pub fn contain(child: &std::process::Child) -> Tree {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
    // SAFETY: an unnamed job, and the child's own handle, valid while the
    // Child lives.
    unsafe {
        let Ok(job) = CreateJobObjectW(None, None) else {
            return Tree(None);
        };
        if AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())).is_err() {
            let _ = CloseHandle(job);
            return Tree(None);
        }
        Tree(Some(job))
    }
}

/// Every process in the child's job, and the child: a grandchild holding
/// the output pipes open goes with it.
pub fn kill_tree(child: &mut std::process::Child, tree: &Tree) {
    if let Some(job) = tree.0 {
        // SAFETY: the job handle `contain` opened and the Tree still holds.
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(job, 1);
        }
    }
    let _ = child.kill();
}

/// A tool of Windows' own, from the system directory as the OS names it
/// (never PATH or the working directory, where another `taskkill.exe` or
/// `reg.exe` could stand). None when that directory cannot be read.
pub fn system_tool(name: &str) -> Option<std::path::PathBuf> {
    system_dir().map(|d| std::path::PathBuf::from(d).join(name))
}

/// `C:\Windows\system32`, as the OS names it.
pub fn system_dir() -> Option<String> {
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    let mut buf = [0u16; 260];
    // SAFETY: the buffer and its length.
    let n = unsafe { GetSystemDirectoryW(Some(&mut buf)) } as usize;
    (n > 0 && n < buf.len()).then(|| String::from_utf16_lossy(&buf[..n]))
}

pub fn pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    // SAFETY: a query handle, read once and closed.
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code).is_ok();
        let _ = CloseHandle(h);
        ok && code == STILL_ACTIVE
    }
}

/// Every process's parent, from one Toolhelp snapshot: pid → ppid.
pub fn process_table() -> std::collections::HashMap<u32, u32> {
    telemetry::process_parents()
}

/// Ctrl-C in `serve`'s console, through the console control handler.
pub fn on_interrupt<F: Fn() + Send + Sync + 'static>(f: F) {
    use std::sync::OnceLock;
    use windows::core::BOOL;
    use windows::Win32::System::Console::SetConsoleCtrlHandler;
    static HANDLER: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
    let _ = HANDLER.set(Box::new(f));
    unsafe extern "system" fn on_ctrl(_: u32) -> BOOL {
        if let Some(h) = HANDLER.get() {
            h();
        }
        BOOL(1)
    }
    // SAFETY: the callback only touches a OnceLock that outlives it.
    unsafe {
        let _ = SetConsoleCtrlHandler(Some(on_ctrl), true);
    }
}

// ── Claude Code ───────────────────────────────────────────────────────────

/// The native installer's exe, then npm's two shims.
pub const CLAUDE_CLI_NAMES: &[&str] = &["claude.exe", "claude.cmd", "claude.bat"];

/// The login is a file in the profile here, never a keychain item.
pub fn claude_keychain_login() -> bool {
    false
}

/// A process's working set and CPU time, where this user may open it. Its
/// start is not compared (the CLI records it in another field here) and
/// its command line not read (jobs/proc.rs `ProcStats`).
pub fn process_stats(pid: u32) -> Option<crate::jobs::ProcStats> {
    let (rss_bytes, times) = telemetry::process_usage(pid)?;
    Some(crate::jobs::ProcStats {
        start_ticks: None,
        // 100 ns ticks.
        cpu_ms: times / 10_000,
        rss_bytes,
        args: Vec::new(),
    })
}

// ── HTTPS ─────────────────────────────────────────────────────────────────

/// SChannel, through native-tls: the machine's trust store decides.
pub fn tls(builder: ureq::AgentBuilder) -> ureq::AgentBuilder {
    let tls = native_tls::TlsConnector::new().expect("the OS TLS stack initialises");
    builder.tls_connector(std::sync::Arc::new(tls))
}

// ── the tray program ──────────────────────────────────────────────────────

/// The tray owns the session: it is the one process in the user's desktop
/// session, where the Claude login is.
pub const TRAY_OWNS_SESSION: bool = true;

#[cfg(feature = "tray")]
pub use crate::tray::main as tray_main;
