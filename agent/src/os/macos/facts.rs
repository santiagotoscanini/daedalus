//! What this Mac is: `sw_vers` and `sysctl` for the OS, the processor and
//! the memory, and the name the user gave it.

use super::stdout_of;

/// One line of a command's stdout, trimmed; empty when it fails.
fn line(cmd: &str, args: &[&str]) -> String {
    stdout_of(cmd, args).trim().to_string()
}

/// "macOS" — `sw_vers` says so; the edition is the version.
pub fn os_name() -> String {
    line("sw_vers", &["--productName"])
}

/// "15.1 (24B83)".
pub fn os_version() -> String {
    let v = line("sw_vers", &["--productVersion"]);
    let b = line("sw_vers", &["--buildVersion"]);
    match (v.is_empty(), b.is_empty()) {
        (false, false) => format!("{v} ({b})"),
        (false, true) => v,
        _ => b,
    }
}

pub fn cpu_name() -> String {
    line("sysctl", &["-n", "machdep.cpu.brand_string"])
}

pub fn memory_bytes() -> Option<u64> {
    line("sysctl", &["-n", "hw.memsize"]).parse().ok()
}

/// The name the user gave the Mac in System Settings (`scutil --get
/// ComputerName`), which is what Finder and AirDrop show; else
/// `gethostname` without its `.local`.
pub fn hostname() -> Option<String> {
    Some(line("scutil", &["--get", "ComputerName"]))
        .filter(|n| !n.is_empty())
        .or_else(super::super::unix::short_hostname)
}
