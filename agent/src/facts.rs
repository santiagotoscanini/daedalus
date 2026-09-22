//! What this machine is: the facts the status page and the hello carry
//! beyond the agent's own state. Read once at start (none of them change
//! while the service runs) and cheap to read again.
//!
//! On Windows they come from the registry and one kernel call, on macOS
//! from `sw_vers` and `sysctl`; elsewhere
//! they are empty, which the readers on the box tolerate.

use serde::Serialize;

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
        os_name: os_name(),
        os_version: os_version(),
        arch: std::env::consts::ARCH,
        cpu: cpu_name(),
        memory_bytes: memory_bytes(),
    }
}

#[cfg(windows)]
mod win {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };

    fn read_sz(key: HKEY, sub: PCWSTR, value: PCWSTR) -> Option<String> {
        let mut len: u32 = 0;
        // SAFETY: a size query, then a read into a buffer of that size.
        unsafe {
            if RegGetValueW(key, sub, value, RRF_RT_REG_SZ, None, None, Some(&mut len)).is_err() {
                return None;
            }
            let mut buf = vec![0u16; (len as usize).div_ceil(2)];
            if RegGetValueW(
                key,
                sub,
                value,
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut len),
            )
            .is_err()
            {
                return None;
            }
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..end]).trim().to_string())
        }
    }

    fn read_dword(key: HKEY, sub: PCWSTR, value: PCWSTR) -> Option<u32> {
        let mut out: u32 = 0;
        let mut len: u32 = 4;
        // SAFETY: a four-byte read into a u32.
        let rc = unsafe {
            RegGetValueW(
                key,
                sub,
                value,
                RRF_RT_REG_DWORD,
                None,
                Some((&mut out as *mut u32).cast()),
                Some(&mut len),
            )
        };
        rc.is_ok().then_some(out)
    }

    const NT: PCWSTR = w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");

    pub fn os_name() -> String {
        let name = read_sz(HKEY_LOCAL_MACHINE, NT, w!("ProductName")).unwrap_or_default();
        // The registry still says "Windows 10" on Windows 11 — Microsoft never
        // changed the string. The build number is the truth: 22000 and up is 11.
        let build = read_sz(HKEY_LOCAL_MACHINE, NT, w!("CurrentBuildNumber"))
            .and_then(|b| b.parse::<u32>().ok())
            .unwrap_or(0);
        if build >= 22_000 && name.starts_with("Windows 10") {
            name.replacen("Windows 10", "Windows 11", 1)
        } else {
            name
        }
    }

    pub fn os_version() -> String {
        let display = read_sz(HKEY_LOCAL_MACHINE, NT, w!("DisplayVersion")).unwrap_or_default();
        let build = read_sz(HKEY_LOCAL_MACHINE, NT, w!("CurrentBuildNumber")).unwrap_or_default();
        let ubr = read_dword(HKEY_LOCAL_MACHINE, NT, w!("UBR"));
        match (display.is_empty(), build.is_empty(), ubr) {
            (false, false, Some(u)) => format!("{display} ({build}.{u})"),
            (false, false, None) => format!("{display} ({build})"),
            (false, true, _) => display,
            (true, false, _) => build,
            _ => String::new(),
        }
    }

    pub fn cpu_name() -> String {
        read_sz(
            HKEY_LOCAL_MACHINE,
            w!(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0"),
            w!("ProcessorNameString"),
        )
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
    }

    pub fn memory_bytes() -> Option<u64> {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut m = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // SAFETY: the struct's length field is set, as the call requires.
        unsafe { GlobalMemoryStatusEx(&mut m).ok()? };
        Some(m.ullTotalPhys)
    }
}

#[cfg(windows)]
use win::{cpu_name, memory_bytes, os_name, os_version};

#[cfg(target_os = "macos")]
mod mac {
    /// One line of a command's stdout, trimmed; empty when it fails.
    fn line(cmd: &str, args: &[&str]) -> String {
        std::process::Command::new(cmd)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
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
}

#[cfg(target_os = "macos")]
use mac::{cpu_name, memory_bytes, os_name, os_version};

#[cfg(not(any(windows, target_os = "macos")))]
fn os_name() -> String {
    String::new()
}
#[cfg(not(any(windows, target_os = "macos")))]
fn os_version() -> String {
    String::new()
}
#[cfg(not(any(windows, target_os = "macos")))]
fn cpu_name() -> String {
    String::new()
}
#[cfg(not(any(windows, target_os = "macos")))]
fn memory_bytes() -> Option<u64> {
    None
}
