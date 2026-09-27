//! What this machine is: the facts the status page and the hello carry
//! beyond the agent's own state. Read once at start (none of them change
//! while the service runs) and cheap to read again.
//!
//! The readers are per OS (`os`): on Windows the registry and one kernel
//! call, on macOS `sw_vers` and `sysctl`, on Linux os-release, cpuinfo and
//! meminfo.

use serde::Serialize;

use crate::os;

#[derive(Clone, Debug, Default, Serialize)]
pub struct Facts {
    /// "windows", "macos", "linux" — `std::env::consts::OS`.
    pub os: &'static str,
    /// "Windows 11 Pro"; empty when unknown.
    pub os_name: String,
    /// "24H2 (26100.4652)"; empty when unknown.
    pub os_version: String,
    /// "x86_64", "aarch64".
    pub arch: &'static str,
    /// The processor's marketing name, as the firmware reports it.
    pub cpu: String,
    /// Physical memory, in bytes.
    pub memory_bytes: Option<u64>,
}

pub fn read() -> Facts {
    Facts {
        os: std::env::consts::OS,
        os_name: os::os_name(),
        os_version: os::os_version(),
        arch: std::env::consts::ARCH,
        cpu: os::cpu_name(),
        memory_bytes: os::memory_bytes(),
    }
}

/// The machine's name: `COMPUTERNAME` when the environment has it (always
/// on Windows); else the OS's own — on macOS the name the user gave it in
/// System Settings (`scutil --get ComputerName`), which is what Finder and
/// AirDrop show, else `gethostname` (launchd hands a daemon no HOSTNAME),
/// without a DHCP or `.local` suffix; else `HOSTNAME`.
pub fn hostname() -> String {
    if let Ok(n) = std::env::var("COMPUTERNAME") {
        return n;
    }
    if let Some(n) = os::hostname() {
        return n;
    }
    std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".into())
}
