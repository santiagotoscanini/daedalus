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
//! - `telemetry`: the collector and its tiers.
//!
//! The small things are here: paths, processes, the Claude command's names.

mod acl;
mod dns;
mod dpapi;
mod facts;
mod net;
mod power;
pub mod service;
mod telemetry;
#[cfg(feature = "tray")]
pub mod tray;

pub use acl::{file_owner, protect_data_dir};
pub use dns::srv_lookup;
pub use dpapi::{seal, unseal};
pub use facts::{cpu_name, memory_bytes, os_name, os_version};
pub use net::primary_adapter;
pub use power::{converge_plan, os_uptime_secs, requests_report, Hold};
pub use service as svc;
pub use telemetry::{read_updates, Collector};

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use anyhow::{Context, Result};

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

/// The tray writes beside the service: ProgramData lets a user create
/// files there.
pub fn user_log_dir() -> Option<PathBuf> {
    None
}

// ── facts ─────────────────────────────────────────────────────────────────

/// Nothing beyond `COMPUTERNAME`, which facts.rs reads first.
pub fn hostname() -> Option<String> {
    None
}

// ── processes: locks and clocks ───────────────────────────────────────────

/// An exclusive lock on `path` (created if absent): the file opened with no
/// sharing, held while it is open; None when another process has it open.
pub fn lock_exclusive(path: &Path) -> Option<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .share_mode(0)
        .open(path)
        .ok()
}

/// systemd's monotonic clock has no meaning here (no Claude unit on
/// Windows).
pub fn monotonic_usec() -> Option<u64> {
    None
}

// ── the local API socket ──────────────────────────────────────────────────

/// The controller's API socket is a unix socket with peer credentials;
/// Windows is never a controller (role.rs), so there is none to hold.
pub enum LocalSocket {}

/// Dropping one stops it where it exists (unix.rs); here none can.
impl Drop for LocalSocket {
    fn drop(&mut self) {
        match *self {}
    }
}

/// Refused: controller mode, the only role that serves the socket, runs on
/// Linux (the box).
pub fn serve_local_socket<F>(
    path: &Path,
    _limits: &crate::api::Limits,
    _on_conn: F,
) -> Result<LocalSocket>
where
    F: Fn(crate::api::conn::Conn) + Send + Sync + 'static,
{
    anyhow::bail!(
        "no local API socket at {} on Windows: controller mode runs on the box, a Linux machine",
        path.display()
    )
}

// ── identity ──────────────────────────────────────────────────────────────

/// The directory's DACL (`install`, private.rs) lets Users read, not
/// write; DPAPI binds the seed to this machine.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))
}

/// Windows has no uid: ownership is judged by SID (acl.rs).
pub fn own_uid() -> Option<u32> {
    None
}

// ── update ────────────────────────────────────────────────────────────────

/// Only x86_64 is built; an ARM Windows machine finds no asset of its own
/// and skips every release.
#[cfg(target_arch = "x86_64")]
pub const ASSETS: &[(&str, &str)] = &[
    (
        "daedalus-agent-x86_64-pc-windows-msvc.exe",
        "daedalus-agent.exe",
    ),
    (
        "daedalus-agent-tray-x86_64-pc-windows-msvc.exe",
        "daedalus-agent-tray.exe",
    ),
];
#[cfg(not(target_arch = "x86_64"))]
pub const ASSETS: &[(&str, &str)] = &[("daedalus-agent-unsupported", "daedalus-agent")];
/// Both assets are required here.
pub const OPTIONAL_ASSETS: &[(&str, &str)] = &[];

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

/// The whole tree: a `.cmd` launcher's node, and the sessions the server
/// spawned. `kill` alone would orphan them. The caller kills and reaps the
/// child itself after.
pub fn stop_process_tree(child: &mut Child) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &child.id().to_string(), "/T", "/F"]);
    let _ = hide_console(&mut cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
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

/// Nothing to add: the tree is reached through `taskkill /T`, and the
/// tray's PATH is the user's.
pub fn prepare_claude_server(cmd: &mut Command, home: Option<&Path>) {
    let _ = (cmd, home);
}

/// The login is a file in the profile here, never a keychain item.
pub fn claude_keychain_login() -> bool {
    false
}

/// The server is the tray's child: the tray only restarts when an update
/// asks it to.
pub const CLAUDE_RC: crate::config::ClaudeRc = crate::config::ClaudeRc::Child;

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
