//! The tray icon program: `daedalus-agent-tray.exe`, started at logon by
//! the Run key `install` writes (on macOS, the LaunchAgent). A GUI-subsystem
//! executable on Windows so no console window appears; the UI is
//! src/tray.rs over the Claude session in src/session.rs, and the platform
//! loop is the OS's (src/os/*/tray.rs). On an OS without a tray it says so
//! and exits 2.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    daedalus_agent::os::tray_main();
}
