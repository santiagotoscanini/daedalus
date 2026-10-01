//! What this machine is: the facts the status page and the hello carry
//! beyond the agent's own state. Read once at start (none of them change
//! while the service runs) and cheap to read again.
//!
//! The readers are per OS (`os`): on Windows the registry and one kernel
//! call, on macOS `sw_vers` and `sysctl`, on Linux os-release, cpuinfo and
//! meminfo.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::os;
use crate::util::LockExt;

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Facts {
    /// "windows", "macos", "linux" — `std::env::consts::OS`.
    pub os: String,
    /// "Windows 11 Pro"; empty when unknown.
    pub os_name: String,
    /// "24H2 (26100.4652)"; empty when unknown.
    pub os_version: String,
    /// "x86_64", "aarch64".
    pub arch: String,
    /// The processor's marketing name, as the firmware reports it.
    pub cpu: String,
    /// Physical memory, in bytes.
    pub memory_bytes: Option<u64>,
}

pub fn read() -> Facts {
    Facts {
        os: std::env::consts::OS.into(),
        os_name: os::os_name(),
        os_version: os::os_version(),
        arch: std::env::consts::ARCH.into(),
        cpu: os::cpu_name(),
        memory_bytes: os::memory_bytes(),
    }
}

/// How long the machine's name is kept: on macOS reading it is a command
/// (`scutil`), and the status page, every report and every resume ask for
/// it; a rename shows within this.
const NAME_FOR: Duration = Duration::from_secs(60);

/// The machine's name: `COMPUTERNAME` when the environment has it (always
/// on Windows); else the OS's own — on macOS the name the user gave it in
/// System Settings (`scutil --get ComputerName`), which is what Finder and
/// AirDrop show, else `gethostname` (launchd hands a daemon no HOSTNAME),
/// without a DHCP or `.local` suffix; else `HOSTNAME`. Read at most once per
/// `NAME_FOR`.
pub fn hostname() -> String {
    static NAME: Mutex<Option<(Instant, String)>> = Mutex::new(None);
    let mut kept = NAME.lock_ok();
    if let Some((at, name)) = kept.as_ref() {
        if at.elapsed() < NAME_FOR {
            return name.clone();
        }
    }
    let name = read_hostname();
    *kept = Some((Instant::now(), name.clone()));
    name
}

fn read_hostname() -> String {
    if let Ok(n) = std::env::var("COMPUTERNAME") {
        return n;
    }
    if let Some(n) = os::hostname() {
        return n;
    }
    std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".into())
}
