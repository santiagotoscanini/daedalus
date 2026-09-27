//! What this machine is, from the registry and one kernel call: the OS's
//! name and version, the processor's name, the physical memory.

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
