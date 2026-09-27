//! Everything that differs by operating system, behind one surface.
//!
//! One module per OS — `windows/`, `macos/`, `linux.rs` — each exporting
//! the SAME names, and exactly one of them selected here. The rest of the
//! crate calls `os::…` and never tests the target itself, so an OS that
//! lacks one of the names below is a compile error on that OS, not an
//! empty string at run time. Linux is today's stub: it builds and serves
//! (`daedalus-agent serve`), and each of its entries says, as a value or an
//! error, that the real thing is Windows- and macOS-only in this version.
//! `unix.rs` holds what macOS and Linux share.
//!
//! The surface, by concern:
//!
//! - paths: the default data directory (config.rs moves it), the tray's
//!   own log directory when it is not the service's, the tray's file name;
//! - facts: the OS's name and version, the processor, the memory, the
//!   machine's name (facts.rs);
//! - network: the adapter the machine talks through, and one SRV lookup
//!   (net.rs, discover.rs);
//! - power: the awake hold, the power plan, what the OS lists as holding
//!   it awake, and the OS's uptime (power.rs);
//! - identity: how the key is sealed on disk and written (identity.rs);
//! - update: the release's asset table, and making a download executable
//!   (update.rs);
//! - processes: running a child without a console window, whether a pid
//!   lives, ending a process tree, and relaying Ctrl-C / SIGTERM;
//! - Claude Code: the command's file names, preparing the server's
//!   command, and whether the login is in the keychain (claude/);
//! - telemetry: the `Collector` and the OS-updates reader (telemetry.rs);
//! - `svc`: installing, removing and running the service, and starting
//!   the tray (the verbs in bin/daedalus-agent.rs, the watchdog in lib.rs);
//! - the tray's entry point, and — where a tray exists — its platform
//!   loop (`tray`, driven by tray.rs).

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

#[cfg(not(any(windows, target_os = "macos")))]
mod linux;
#[cfg(not(any(windows, target_os = "macos")))]
use self::linux as imp;

// paths
pub use imp::{default_data_dir, user_log_dir, TRAY_EXE};
// facts
pub use imp::{cpu_name, hostname, memory_bytes, os_name, os_version};
// network
pub use imp::{primary_adapter, srv_lookup};
// power
pub use imp::{converge_plan, os_uptime_secs, requests_report, Hold};
// identity
pub use imp::{seal, unseal, write_private};
// update
pub use imp::{mark_executable, ASSETS};
// processes
pub use imp::{hide_console, on_interrupt, pid_alive, stop_process_tree};
// Claude Code
pub use imp::{claude_keychain_login, prepare_claude_server, CLAUDE_CLI_NAMES};
// telemetry
pub use imp::{read_updates, Collector};
// the tray program's entry point (a message and an exit where there is none)
pub use imp::tray_main;

/// The service: registered, removed, run, and the tray started from it.
pub mod svc {
    pub use super::imp::svc::{
        install, launch_tray_or_session, run_service, uninstall, WATCHES_TRAY,
    };
}

/// The tray's platform side, where there is a tray: the loop that drives
/// `tray::Tray`, opening a URL or folder, and leaving for a new binary.
#[cfg(any(windows, target_os = "macos"))]
pub mod tray {
    pub use super::imp::tray::{open, relaunch_self, run};
}
