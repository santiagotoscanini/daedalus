//! Processes: one Toolhelp snapshot for names and pids, then each one's
//! working set and CPU time where the service can open it. The browsers
//! read takes a snapshot of its own through `process_snapshot` to tell
//! which browser is running.

use windows::Win32::Foundation::{CloseHandle, FILETIME};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::{filetime_u64, from_wide, rate};

/// One tick of `FILETIME` is 100 ns; this many per second.
const FILETIME_PER_SEC: f64 = 10_000_000.0;

/// A process's share of one core between two readings of its kernel+user
/// time (100 ns ticks): 100 % is one core busy the whole interval, and a
/// process on several cores can exceed it.
pub(super) fn process_cpu(prev: u64, cur: u64, secs: f64) -> Option<f64> {
    rate(prev, cur, secs).map(|ticks_per_sec| (100.0 * ticks_per_sec / FILETIME_PER_SEC).max(0.0))
}

/// The image name alone: Toolhelp gives it without a path, but a path is
/// stripped should one ever appear.
fn image_name(s: &str) -> String {
    s.rsplit(['\\', '/']).next().unwrap_or(s).to_string()
}

/// Every process's pid and image name, from one Toolhelp snapshot.
pub(super) fn process_snapshot() -> Result<Vec<(u32, String)>, String> {
    // SAFETY: the snapshot handle is closed below on every path.
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|e| format!("CreateToolhelp32Snapshot failed: {e}"))?;
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut out = Vec::new();
    // SAFETY: the entry's size field is set, as the calls require; the
    // exe name is a NUL-terminated array inside the entry.
    unsafe {
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let name = from_wide(&entry.szExeFile)
                .map(|n| image_name(&n))
                .unwrap_or_else(|| format!("pid {}", entry.th32ProcessID));
            out.push((entry.th32ProcessID, name));
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    Ok(out)
}

/// A process's working set and its kernel+user time (100 ns), or None
/// when it cannot be opened (a protected process) or has just exited.
pub(super) fn process_usage(pid: u32) -> Option<(u64, u64)> {
    // SAFETY: the handle is closed below on every path.
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut pmc = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: the counters struct is passed with its size; the four
    // FILETIMEs are written by the call.
    let (mem, times) = unsafe {
        let mem = GetProcessMemoryInfo(h, &mut pmc, pmc.cb).map(|()| pmc.WorkingSetSize as u64);
        let times = GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user)
            .map(|()| filetime_u64(kernel).saturating_add(filetime_u64(user)));
        let _ = CloseHandle(h);
        (mem, times)
    };
    Some((mem.ok()?, times.ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_cpu_is_percent_of_one_core() {
        // 15 s of ticks in 15 s: one core, the whole time.
        let ticks = 15 * 10_000_000;
        assert_eq!(process_cpu(0, ticks, 15.0), Some(100.0));
        assert_eq!(process_cpu(0, ticks / 4, 15.0), Some(25.0));
        assert_eq!(process_cpu(ticks, 0, 15.0), None);
    }

    #[test]
    fn image_names() {
        assert_eq!(image_name(r"C:\Windows\explorer.exe"), "explorer.exe");
        assert_eq!(image_name("chrome.exe"), "chrome.exe");
    }
}
