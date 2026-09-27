//! The tray icon program: `daedalus-agent-tray.exe`, started at logon by
//! the Run key `install` writes (on macOS the LaunchAgent, on Linux the XDG
//! autostart entry). A GUI-subsystem executable on Windows so no console
//! window appears; the UI is src/tray.rs — over the Claude session it runs
//! (src/session.rs) on Windows and macOS, over the session unit it shows on
//! Linux — and the platform loop is the OS's (src/os/*/tray.rs). Built only
//! with the `tray` feature.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    daedalus_agent::os::tray_main();
}
