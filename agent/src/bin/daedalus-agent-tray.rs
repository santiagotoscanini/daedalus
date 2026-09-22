//! The tray icon program: `daedalus-agent-tray.exe`, started at logon by
//! the Run key `install` writes. A GUI-subsystem executable so no console
//! window appears; everything it does is in src/tray.rs.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    #[cfg(any(windows, target_os = "macos"))]
    {
        // Nowhere to print from a windowless program: a failure is written
        // beside the service's logs, where the operator already looks.
        if let Err(e) = daedalus_agent::tray::run() {
            let path = daedalus_agent::config::user_log_dir().join("tray.err");
            let _ = std::fs::create_dir_all(daedalus_agent::config::user_log_dir());
            let _ = std::fs::write(path, format!("{e:#}\n"));
            std::process::exit(1);
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        eprintln!("daedalus-agent-tray is for Windows and macOS in this version");
        std::process::exit(2);
    }
}
