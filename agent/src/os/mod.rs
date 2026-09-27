//! Everything that differs by operating system, behind one surface.
//!
//! One module per OS — `windows/`, `macos/`, `linux/` — each exporting
//! the SAME names, and exactly one of them selected here. The rest of the
//! crate calls `os::…` and never tests the target itself, so an OS that
//! lacks one of the names below is a compile error on that OS, not an
//! empty string at run time. `unix.rs` holds what macOS and Linux share.
//!
//! The surface, by concern:
//!
//! - paths: the default data directory (config.rs moves it), the user's
//!   own log directory when it is not the service's, the tray's file name;
//! - facts: the OS's name and version, the processor, the memory, the
//!   machine's name (facts.rs);
//! - network: the adapter the machine talks through, and one SRV lookup
//!   (net.rs, discover.rs);
//! - HTTPS: the TLS stack the one client uses (http.rs);
//! - power: the awake hold, the power plan, what the OS lists as holding
//!   it awake, and the OS's uptime (power.rs);
//! - identity: how the key is sealed on disk and written (identity.rs);
//! - update: the release's asset table — required and optional — and
//!   making a download executable (update.rs);
//! - processes: running a child without a console window, whether a pid
//!   lives, ending a process tree, and relaying Ctrl-C / SIGTERM;
//! - the local API socket: a unix socket served to this process's own uid
//!   by its peer credentials, made and cleaned up (api/; unix.rs — Windows
//!   is never a controller and refuses);
//! - Claude Code: the command's file names, preparing the server's
//!   command, whether the login is in the keychain, and how the session
//!   runs the server by default (`CLAUDE_RC`, claude/);
//! - telemetry: the `Collector` and the OS-updates reader (telemetry.rs);
//! - `svc`: installing, removing and running the service, and starting
//!   the tray (the verbs in bin/daedalus-agent.rs, the watchdog in lib.rs);
//! - the tray: whether it owns the session or shows one that runs
//!   elsewhere (`TRAY_OWNS_SESSION`, tray.rs), its entry point, and its
//!   platform loop (`tray`, driven by tray.rs).

#[cfg(unix)]
mod unix;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as imp;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use self::macos as imp;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use self::linux as imp;

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
compile_error!("daedalus-agent builds for Windows, macOS and Linux");

// paths
pub use imp::{default_data_dir, user_log_dir, TRAY_EXE};
// facts
pub use imp::{cpu_name, hostname, memory_bytes, os_name, os_version};
// network
pub use imp::{primary_adapter, srv_lookup};
// HTTPS
pub use imp::tls;
// power
pub use imp::{converge_plan, os_uptime_secs, requests_report, Hold};
// identity
pub use imp::{file_owner, own_uid, seal, unseal, write_private};
// update
pub use imp::{mark_executable, ASSETS, OPTIONAL_ASSETS};
// processes, a single-instance lock, the monotonic clock
pub use imp::{
    hide_console, lock_exclusive, monotonic_usec, on_interrupt, pid_alive, stop_process_tree,
};
// the controller's local API socket (api/)
pub use imp::{serve_local_socket, LocalSocket};
// Claude Code
pub use imp::{claude_keychain_login, prepare_claude_server, CLAUDE_CLI_NAMES, CLAUDE_RC};
// telemetry
pub use imp::{read_updates, Collector};
// the tray: its relation to the session, and the tray program's entry point
#[cfg(feature = "tray")]
pub use imp::tray_main;
pub use imp::TRAY_OWNS_SESSION;

/// The service: registered, removed, run, and the tray started from it.
pub mod svc {
    pub use super::imp::svc::{
        install, launch_tray_or_session, run_service, uninstall, WATCHES_TRAY,
    };
}

/// The tray's platform side: the loop that drives `tray::Tray`, opening a
/// URL or folder, and leaving for a new binary.
#[cfg(feature = "tray")]
pub mod tray {
    pub use super::imp::tray::{open, relaunch_self, run};
}
