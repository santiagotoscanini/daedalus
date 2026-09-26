//! The machine and what it is made of: make, model and firmware, the OS
//! build, the processor, the GPUs (static, hourly), and the sampled
//! figures that are not a counter the collector rates itself: memory,
//! the fixed volumes, the battery.

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{
    BusTypeNvme, CreateFileW, GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives,
    GetVolumeInformationW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Ioctl::{
    PropertyStandardQuery, StorageAdapterProperty, StorageDeviceSeekPenaltyProperty,
    DEVICE_SEEK_PENALTY_DESCRIPTOR, IOCTL_STORAGE_QUERY_PROPERTY, STORAGE_ADAPTER_DESCRIPTOR,
    STORAGE_PROPERTY_ID, STORAGE_PROPERTY_QUERY,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
use windows::Win32::System::SystemInformation::{
    GetLogicalProcessorInformationEx, GetSystemInfo, GlobalMemoryStatusEx, RelationProcessorCore,
    MEMORYSTATUSEX, SYSTEM_INFO,
};
use windows::Win32::System::IO::DeviceIoControl;

use super::registry::{reg_dword, reg_sz, reg_uint};
use super::{collapse_ws, from_wide, wide};
use crate::telemetry::{Battery, Cpu, Disk, Gpu, Machine, Memory, Os};

/// `DRIVE_FIXED` from winbase.h — a literal rather than another crate
/// feature (`Win32_System_WindowsProgramming`) for one constant.
const DRIVE_FIXED: u32 = 3;
/// `BusTypeNvme` as the storage descriptor carries it: a byte.
const BUS_TYPE_NVME: u8 = BusTypeNvme.0 as u8;
/// `BATTERY_FLAG_NO_BATTERY` and `BATTERY_FLAG_UNKNOWN` from winbase.h.
const BATTERY_FLAG_NO_BATTERY: u8 = 128;
const BATTERY_FLAG_UNKNOWN: u8 = 255;
/// `BATTERY_PERCENTAGE_UNKNOWN` and `AC_LINE_UNKNOWN`.
const BATTERY_PERCENTAGE_UNKNOWN: u8 = 255;
const AC_LINE_ONLINE: u8 = 1;
const AC_LINE_UNKNOWN: u8 = 255;

const NT: PCWSTR = w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
const BIOS: PCWSTR = w!(r"HARDWARE\DESCRIPTION\System\BIOS");
const CPU0: PCWSTR = w!(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0");

/// The display adapter class, under which each installed driver instance
/// is a four-digit subkey.
const DISPLAY_CLASS: &str =
    r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
/// How many `NNNN` subkeys of the display class to look at. Driver
/// reinstalls leave gaps and push new instances up, so more than the
/// usual 0000–0009 — each miss is one cheap registry call.
const DISPLAY_SLOTS: u32 = 32;

/// The version a GPU vendor markets a driver as. AMD writes it beside the
/// driver's own version (`RadeonSoftwareVersion`, "25.9.2"); NVIDIA hides
/// it in the last five digits of the driver version with the dots removed
/// ("32.0.15.6614" → 56614 → "566.14"). Intel and the rest have no such
/// number a person would recognise.
fn driver_brand(
    vendor: Option<&str>,
    driver: Option<&str>,
    radeon: Option<&str>,
) -> Option<String> {
    match vendor? {
        "AMD" => radeon
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|v| format!("Adrenalin {v}")),
        "NVIDIA" => {
            let digits: String = driver?.chars().filter(char::is_ascii_digit).collect();
            let tail = digits.get(digits.len().checked_sub(5)?..)?;
            Some(format!("GeForce {}.{}", &tail[..3], &tail[3..]))
        }
        _ => None,
    }
}

/// A driver's `DriverDate` ("9-10-2026", month-day-year without padding)
/// as "2026-09-10". None when it is not three numbers.
fn driver_date(s: &str) -> Option<String> {
    let mut it = s.trim().split('-').map(|p| p.trim().parse::<u32>().ok());
    let (m, d, y) = (it.next()??, it.next()??, it.next()??);
    if it.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) || y < 1990 {
        return None;
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// The GPU vendor a driver's description names.
fn vendor_from_name(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    if n.contains("nvidia") || n.contains("geforce") || n.contains("quadro") {
        Some("NVIDIA")
    } else if n.contains("amd") || n.contains("radeon") {
        Some("AMD")
    } else if n.contains("intel") {
        Some("Intel")
    } else {
        None
    }
}

/// Idle, kernel and user time in 100 ns units, as `GetSystemTimes` hands
/// them (kernel includes idle).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct CpuTimes {
    pub(super) idle: u64,
    pub(super) kernel: u64,
    pub(super) user: u64,
}

/// Percent busy between two readings, or None when nothing elapsed.
pub(super) fn cpu_usage(prev: CpuTimes, cur: CpuTimes) -> Option<f64> {
    // A counter that went backwards (a clock step, a resumed machine)
    // describes no interval; say nothing rather than 0 or 100.
    if cur.idle < prev.idle || cur.kernel < prev.kernel || cur.user < prev.user {
        return None;
    }
    let idle = cur.idle - prev.idle;
    let total = (cur.kernel - prev.kernel) + (cur.user - prev.user);
    if total == 0 {
        return None;
    }
    let pct = 100.0 * (1.0 - idle as f64 / total as f64);
    Some(pct.clamp(0.0, 100.0))
}

/// The page file's size from `GlobalMemoryStatusEx`'s commit limit: the
/// limit beyond physical memory. How much of it is IN USE is not derivable
/// from these figures — commit charge is a promise, not a page-file
/// occupancy, and the difference read as "full" on a real machine — so
/// only the total is reported. None when the limit is below physical
/// memory, which cannot describe a real page file.
fn swap_from(total_phys: u64, total_pagefile: u64) -> Option<u64> {
    (total_pagefile >= total_phys).then(|| total_pagefile - total_phys)
}

pub(super) fn read_machine(errors: &mut Vec<String>) -> Machine {
    let m = Machine {
        manufacturer: reg_sz(BIOS, w!("SystemManufacturer")),
        model: reg_sz(BIOS, w!("SystemProductName")),
        chip: None,
        bios_vendor: reg_sz(BIOS, w!("BIOSVendor")),
        bios_version: reg_sz(BIOS, w!("BIOSVersion")),
        bios_date: reg_sz(BIOS, w!("BIOSReleaseDate")),
        board_manufacturer: reg_sz(BIOS, w!("BaseBoardManufacturer")),
        board_product: reg_sz(BIOS, w!("BaseBoardProduct")),
        form: None,
        // Apple's board target: nothing of the kind on a PC.
        target: None,
    };
    if m.manufacturer.is_none() && m.model.is_none() {
        errors.push("machine make and model are not in the registry's BIOS description".into());
    }
    m
}

pub(super) fn read_os(errors: &mut Vec<String>) -> Os {
    let kernel = match (
        reg_sz(NT, w!("CurrentBuildNumber")),
        reg_dword(NT, w!("UBR")),
    ) {
        (Some(b), Some(u)) => Some(format!("{b}.{u}")),
        (Some(b), None) => Some(b),
        _ => {
            errors.push("NT build number is not in the registry".into());
            None
        }
    };
    let installed_at = reg_dword(NT, w!("InstallDate")).and_then(|install| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let install = u64::from(install);
        (install > 0 && install <= now).then(|| crate::state::rfc3339_ago(now - install))
    });
    if installed_at.is_none() {
        errors.push("OS install date is not in the registry".into());
    }
    Os {
        kernel,
        build: reg_sz(NT, w!("BuildLabEx")),
        installed_at,
    }
}

/// Physical cores: one `RelationProcessorCore` entry each.
fn physical_cores() -> Result<u32, String> {
    let mut len: u32 = 0;
    // SAFETY: a size query with no buffer; it fails with the size needed.
    let rc = unsafe { GetLogicalProcessorInformationEx(RelationProcessorCore, None, &mut len) };
    if rc.is_ok() || len == 0 {
        return Err("GetLogicalProcessorInformationEx gave no size".into());
    }
    let mut buf = vec![0u8; len as usize];
    // SAFETY: the buffer is the size the call asked for; entries are read
    // below as bytes within it, never as a struct that could overrun it.
    unsafe {
        GetLogicalProcessorInformationEx(
            RelationProcessorCore,
            Some(buf.as_mut_ptr().cast()),
            &mut len,
        )
        .map_err(|e| format!("GetLogicalProcessorInformationEx failed: {e}"))?;
    }
    let buf = &buf[..(len as usize).min(buf.len())];
    // Each entry starts with Relationship (i32) and Size (u32) and is Size
    // bytes long; the rest varies by relationship and is not needed.
    let mut off = 0usize;
    let mut cores = 0u32;
    while off + 8 <= buf.len() {
        let rel = i32::from_ne_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]);
        let size = u32::from_ne_bytes([buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]]);
        if rel == RelationProcessorCore.0 {
            cores += 1;
        }
        if size == 0 {
            break;
        }
        off += size as usize;
    }
    if cores == 0 {
        return Err("GetLogicalProcessorInformationEx listed no cores".into());
    }
    Ok(cores)
}

pub(super) fn read_cpu(errors: &mut Vec<String>) -> Cpu {
    let model = reg_sz(CPU0, w!("ProcessorNameString")).map(|s| collapse_ws(&s));
    if model.is_none() {
        errors.push("processor name is not in the registry".into());
    }
    let cores = match physical_cores() {
        Ok(n) => Some(n),
        Err(e) => {
            errors.push(e);
            None
        }
    };
    let mut si = SYSTEM_INFO::default();
    // SAFETY: the struct is written by the call; it cannot fail.
    unsafe { GetSystemInfo(&mut si) };
    let threads = (si.dwNumberOfProcessors > 0).then_some(si.dwNumberOfProcessors);
    Cpu {
        model,
        cores,
        threads,
        frequency_mhz: reg_dword(CPU0, w!("~MHz")).map(u64::from),
        usage_pct: None,
        load: None,
        temperature_c: None,
    }
}

pub(super) fn read_gpus(errors: &mut Vec<String>) -> Vec<Gpu> {
    let mut out: Vec<Gpu> = Vec::new();
    for i in 0..DISPLAY_SLOTS {
        let sub = wide(&format!(r"{DISPLAY_CLASS}\{i:04}"));
        let sub = PCWSTR(sub.as_ptr());
        let Some(name) = reg_sz(sub, w!("DriverDesc")).map(|s| collapse_ws(&s)) else {
            continue;
        };
        if out.iter().any(|g| g.name == name) {
            continue;
        }
        let vram_total_bytes = reg_uint(sub, w!("HardwareInformation.qwMemorySize"))
            .or_else(|| reg_uint(sub, w!("HardwareInformation.MemorySize")))
            .filter(|&b| b > 0);
        let vendor = vendor_from_name(&name);
        let driver = reg_sz(sub, w!("DriverVersion"));
        let radeon = reg_sz(sub, w!("RadeonSoftwareVersion"));
        out.push(Gpu {
            vendor: vendor.map(str::to_string),
            driver_brand: driver_brand(vendor, driver.as_deref(), radeon.as_deref()),
            driver_date: reg_sz(sub, w!("DriverDate")).and_then(|d| driver_date(&d)),
            driver,
            vram_total_bytes,
            name,
            vram_used_bytes: None,
            usage_pct: None,
            temperature_c: None,
            power_w: None,
        });
    }
    if out.is_empty() {
        errors.push("no display adapter is in the registry's display class".into());
    }
    out
}

pub(super) fn read_memory(errors: &mut Vec<String>) -> Memory {
    let mut m = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY: the struct's length field is set, as the call requires.
    if let Err(e) = unsafe { GlobalMemoryStatusEx(&mut m) } {
        errors.push(format!("GlobalMemoryStatusEx failed: {e}"));
        return Memory::default();
    }
    let swap_total_bytes = swap_from(m.ullTotalPhys, m.ullTotalPageFile);
    let swap_used_bytes = None;
    let mut pi = PERFORMANCE_INFORMATION {
        cb: std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32,
        ..Default::default()
    };
    // SAFETY: the struct and its size are passed together.
    let perf = unsafe { GetPerformanceInfo(&mut pi, pi.cb) };
    let (cached_bytes, committed_bytes, commit_limit_bytes) = match perf {
        Ok(()) => {
            let page = pi.PageSize as u64;
            let pages = |n: usize| Some((n as u64).saturating_mul(page));
            (
                pages(pi.SystemCache),
                pages(pi.CommitTotal),
                pages(pi.CommitLimit),
            )
        }
        Err(e) => {
            errors.push(format!("GetPerformanceInfo failed: {e}"));
            (None, None, None)
        }
    };
    Memory {
        total_bytes: Some(m.ullTotalPhys),
        used_bytes: Some(m.ullTotalPhys.saturating_sub(m.ullAvailPhys)),
        available_bytes: Some(m.ullAvailPhys),
        cached_bytes,
        compressed_bytes: None,
        committed_bytes,
        commit_limit_bytes,
        swap_total_bytes,
        swap_used_bytes,
        slots: None,
        max_capacity_bytes: None,
        modules: Vec::new(),
    }
}

/// One `IOCTL_STORAGE_QUERY_PROPERTY` on an open volume, into `out`: how
/// many bytes the driver filled, or None when it refused the query.
fn storage_query(h: HANDLE, id: STORAGE_PROPERTY_ID, out: &mut [u8]) -> Option<usize> {
    let q = STORAGE_PROPERTY_QUERY {
        PropertyId: id,
        QueryType: PropertyStandardQuery,
        AdditionalParameters: [0],
    };
    let mut returned: u32 = 0;
    // SAFETY: the query struct and output buffer outlive the call and their
    // sizes are passed with them.
    let rc = unsafe {
        DeviceIoControl(
            h,
            IOCTL_STORAGE_QUERY_PROPERTY,
            Some((&q as *const STORAGE_PROPERTY_QUERY).cast()),
            std::mem::size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            Some(out.as_mut_ptr().cast()),
            out.len() as u32,
            Some(std::ptr::from_mut(&mut returned)),
            None,
        )
    };
    rc.ok().map(|()| (returned as usize).min(out.len()))
}

/// "nvme" | "ssd" | "hdd" for a volume, from its bus type and seek
/// penalty; None when the volume will not say (a virtual disk, a RAID).
fn drive_kind(letter: char) -> Option<&'static str> {
    let path = wide(&format!(r"\\.\{letter}:"));
    // SAFETY: the path is NUL-terminated; zero access is enough for a
    // property query, and the handle is closed below on every path.
    let h = unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            0,
            FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0),
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }
    .ok()?;
    let kind = {
        // The descriptors are read as bytes at the fields' offsets rather
        // than as the structs, whose `bool` fields a driver may fill with
        // any non-zero byte.
        let bus_at = std::mem::offset_of!(STORAGE_ADAPTER_DESCRIPTOR, BusType);
        let mut adapter = vec![0u8; std::mem::size_of::<STORAGE_ADAPTER_DESCRIPTOR>()];
        let nvme = storage_query(h, StorageAdapterProperty, &mut adapter)
            .is_some_and(|n| n > bus_at && adapter[bus_at] == BUS_TYPE_NVME);
        if nvme {
            Some("nvme")
        } else {
            let penalty_at =
                std::mem::offset_of!(DEVICE_SEEK_PENALTY_DESCRIPTOR, IncursSeekPenalty);
            let mut seek = vec![0u8; std::mem::size_of::<DEVICE_SEEK_PENALTY_DESCRIPTOR>()];
            storage_query(h, StorageDeviceSeekPenaltyProperty, &mut seek)
                .filter(|&n| n > penalty_at)
                .map(|_| if seek[penalty_at] == 0 { "ssd" } else { "hdd" })
        }
    };
    // SAFETY: the handle came from CreateFileW above and is closed once.
    unsafe {
        let _ = CloseHandle(h);
    }
    kind
}

/// Every fixed drive. Removable ones are skipped: they come and go between
/// samples, and querying an empty reader can spin it up.
pub(super) fn read_disks(errors: &mut Vec<String>) -> Vec<Disk> {
    // SAFETY: no arguments, no state.
    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        errors.push("GetLogicalDrives listed no drives".into());
        return Vec::new();
    }
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = char::from(b'A' + i as u8);
        let root = wide(&format!(r"{letter}:\"));
        let root = PCWSTR(root.as_ptr());
        // SAFETY: a NUL-terminated root path.
        if unsafe { GetDriveTypeW(root) } != DRIVE_FIXED {
            continue;
        }
        let mut label = [0u16; 261];
        let mut fs = [0u16; 261];
        // SAFETY: both buffers are passed with their lengths; the serial
        // number, which would identify the machine, is not asked for.
        let vol = unsafe {
            GetVolumeInformationW(
                root,
                Some(&mut label[..]),
                None,
                None,
                None,
                Some(&mut fs[..]),
            )
        };
        let (name, fs) = match vol {
            Ok(()) => (from_wide(&label), from_wide(&fs)),
            Err(e) => {
                errors.push(format!("{letter}: volume information not read: {e}"));
                (None, None)
            }
        };
        let mut total: u64 = 0;
        let mut free: u64 = 0;
        // SAFETY: two u64s the call writes.
        let space = unsafe {
            GetDiskFreeSpaceExW(
                root,
                None,
                Some(std::ptr::from_mut(&mut total)),
                Some(std::ptr::from_mut(&mut free)),
            )
        };
        let (total_bytes, used_bytes, free_bytes) = match space {
            Ok(()) => (Some(total), Some(total.saturating_sub(free)), Some(free)),
            Err(e) => {
                errors.push(format!("{letter}: disk space not read: {e}"));
                (None, None, None)
            }
        };
        out.push(Disk {
            mount: format!("{letter}:"),
            name,
            fs,
            total_bytes,
            used_bytes,
            free_bytes,
            kind: drive_kind(letter).map(str::to_string),
        });
    }
    out
}

pub(super) fn read_battery() -> Option<Battery> {
    let mut s = SYSTEM_POWER_STATUS::default();
    // SAFETY: the struct is written by the call.
    unsafe { GetSystemPowerStatus(&mut s) }.ok()?;
    if s.BatteryFlag & BATTERY_FLAG_NO_BATTERY != 0 || s.BatteryFlag == BATTERY_FLAG_UNKNOWN {
        return None;
    }
    let percent = (s.BatteryLifePercent != BATTERY_PERCENTAGE_UNKNOWN)
        .then(|| f64::from(s.BatteryLifePercent.min(100)));
    let charging = (s.ACLineStatus != AC_LINE_UNKNOWN).then_some(s.ACLineStatus == AC_LINE_ONLINE);
    Some(Battery {
        percent,
        charging,
        health_pct: None,
        cycles: None,
        condition: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendor_from_driver_description() {
        assert_eq!(vendor_from_name("NVIDIA GeForce RTX 4070"), Some("NVIDIA"));
        assert_eq!(vendor_from_name("AMD Radeon RX 7800 XT"), Some("AMD"));
        assert_eq!(vendor_from_name("Intel(R) UHD Graphics 770"), Some("Intel"));
        assert_eq!(vendor_from_name("Microsoft Basic Display Adapter"), None);
    }

    #[test]
    fn cpu_usage_from_time_deltas() {
        let a = CpuTimes {
            idle: 1_000,
            kernel: 2_000,
            user: 1_000,
        };
        // 300 idle out of 400 + 600 busy-or-idle ticks: 70 % busy.
        let b = CpuTimes {
            idle: 1_300,
            kernel: 2_400,
            user: 1_600,
        };
        let pct = cpu_usage(a, b).expect("time passed");
        assert!((pct - 70.0).abs() < 1e-9);
        assert_eq!(cpu_usage(a, a), None);
        // A counter that went backwards is no interval at all.
        let c = CpuTimes {
            idle: 900,
            kernel: 2_400,
            user: 1_600,
        };
        assert_eq!(cpu_usage(a, c), None);
    }

    #[test]
    fn swap_from_commit_limit() {
        let g = 1u64 << 30;
        assert_eq!(swap_from(16 * g, 24 * g), Some(8 * g));
        assert_eq!(swap_from(16 * g, 16 * g), Some(0));
        assert_eq!(swap_from(16 * g, 8 * g), None);
    }

    #[test]
    fn driver_brand_and_date() {
        assert_eq!(
            driver_brand(Some("AMD"), Some("32.0.31041.1004"), Some("25.9.2")).as_deref(),
            Some("Adrenalin 25.9.2")
        );
        assert_eq!(
            driver_brand(Some("AMD"), Some("32.0.31041.1004"), None),
            None
        );
        assert_eq!(
            driver_brand(Some("NVIDIA"), Some("32.0.15.6614"), None).as_deref(),
            Some("GeForce 566.14")
        );
        assert_eq!(
            driver_brand(Some("NVIDIA"), Some("31.0.15.5222"), Some("x")).as_deref(),
            Some("GeForce 552.22")
        );
        assert_eq!(driver_brand(Some("NVIDIA"), Some("1.2"), None), None);
        assert_eq!(
            driver_brand(Some("Intel"), Some("32.0.101.6078"), None),
            None
        );
        assert_eq!(driver_brand(None, Some("1.0.0.0"), None), None);
        assert_eq!(driver_date("9-10-2026").as_deref(), Some("2026-09-10"));
        assert_eq!(driver_date("12-1-2025").as_deref(), Some("2025-12-01"));
        assert_eq!(driver_date("2026-09-10"), None);
        assert_eq!(driver_date("13-1-2025"), None);
    }
}
