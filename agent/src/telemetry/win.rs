//! The Windows collector: registry and Win32 for everything sampled, so a
//! sample costs microseconds and never blocks on a provider. Two tiers are
//! the deliberate exception to "nothing shells out": the ten-minute one
//! (drives) and the hourly one (OS updates) each run ONE hidden PowerShell
//! process, because SMART counters and the Windows Update agent have no
//! Win32 surface — only the Storage cmdlets and the `Microsoft.Update`
//! COM object. Each is killed at its deadline, and the tier answers with
//! an empty list and a line in `errors` rather than a stale or guessed
//! value.
//!
//! What comes from where:
//! - machine and firmware: `HKLM\HARDWARE\DESCRIPTION\System\BIOS`, the
//!   SMBIOS fields the kernel copies there at boot; the chassis type and
//!   the memory modules from the raw SMBIOS table itself
//!   (`GetSystemFirmwareTable('RSMB')`, structures 3, 16 and 17);
//! - kernel build and install date: `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`;
//! - processor: `CentralProcessor\0` for the name and MHz,
//!   `GetLogicalProcessorInformationEx` for cores, `GetSystemInfo` for threads,
//!   `GetSystemTimes` deltas for usage;
//! - GPUs: the display class registry keys (name, driver, VRAM) and the
//!   PDH "GPU Engine" / "GPU Adapter Memory" counters for usage;
//! - memory: `GlobalMemoryStatusEx` for the totals, `GetPerformanceInfo`
//!   for the cache and the commit charge, the "Memory Compression"
//!   process's working set for what is held compressed;
//! - volumes: `GetLogicalDrives` and friends, plus one storage IOCTL per
//!   volume for the media kind;
//! - drives: `Get-PhysicalDisk` joined to `Get-StorageReliabilityCounter`
//!   and `Get-Partition`, in the ten-minute PowerShell;
//! - services: `EnumServicesStatusEx`, with `QueryServiceConfig` on each
//!   stopped one to learn whether it was meant to be running;
//! - processes: a Toolhelp snapshot for names and pids, then
//!   `GetProcessMemoryInfo` and `GetProcessTimes` on each one the service
//!   can open;
//! - network: `GetIfTable2` counters, rated against the previous sample;
//! - battery: `GetSystemPowerStatus`;
//! - OS updates: the `Microsoft.Update.Session` search and `Get-HotFix`, in
//!   the hourly PowerShell; the reboot-pending flag is two registry keys.
//!
//! Temperatures and GPU power are not readable without vendor tools
//! (NVAPI, ADL, or the WMI thermal zone that most consumer firmware leaves
//! empty), so they stay `None` with a line in `errors` saying so. Drive
//! temperatures do come, from the SMART counters.

use std::collections::HashMap;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_SERVICE_NEVER_STARTED, ERROR_SERVICE_SPECIFIC_ERROR, ERROR_SUCCESS,
    FILETIME, HANDLE,
};
use windows::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIfTable2, IF_TYPE_ETHERNET_CSMACD, IF_TYPE_IEEE80211, MIB_IF_TABLE2,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::Storage::FileSystem::{
    BusTypeNvme, CreateFileW, GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives,
    GetVolumeInformationW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Ioctl::{
    PropertyStandardQuery, StorageAdapterProperty, StorageDeviceSeekPenaltyProperty,
    DEVICE_SEEK_PENALTY_DESCRIPTOR, IOCTL_STORAGE_QUERY_PROPERTY, STORAGE_ADAPTER_DESCRIPTOR,
    STORAGE_PROPERTY_ID, STORAGE_PROPERTY_QUERY,
};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::ProcessStatus::{
    GetPerformanceInfo, GetProcessMemoryInfo, PERFORMANCE_INFORMATION, PROCESS_MEMORY_COUNTERS,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_ANY,
    RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
use windows::Win32::System::Services::{
    CloseServiceHandle, EnumServicesStatusExW, OpenSCManagerW, OpenServiceW, QueryServiceConfigW,
    ENUM_SERVICE_STATUS_PROCESSW, QUERY_SERVICE_CONFIGW, SC_ENUM_PROCESS_INFO, SC_HANDLE,
    SC_MANAGER_ENUMERATE_SERVICE, SERVICE_AUTO_START, SERVICE_CONTINUE_PENDING, SERVICE_PAUSED,
    SERVICE_PAUSE_PENDING, SERVICE_QUERY_CONFIG, SERVICE_RUNNING, SERVICE_START_PENDING,
    SERVICE_STATE_ALL, SERVICE_STATUS_CURRENT_STATE, SERVICE_STOPPED, SERVICE_STOP_PENDING,
    SERVICE_WIN32,
};
use windows::Win32::System::SystemInformation::{
    GetLogicalProcessorInformationEx, GetSystemFirmwareTable, GetSystemInfo, GlobalMemoryStatusEx,
    RelationProcessorCore, MEMORYSTATUSEX, RSMB, SYSTEM_INFO,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::IO::DeviceIoControl;

use super::{
    Battery, Collect, Cpu, Disk, Drive, Gpu, GpuSample, Installed, Machine, Memory, MemoryModule,
    Network, Os, Process, Sample, Service, Slow, Static, Update, Updates, TOP_PROCESSES,
};

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
/// `CREATE_NO_WINDOW`: the shell-outs run from a service, but the flag
/// costs nothing and keeps a console from flashing should the tray ever
/// share this code path.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// One tick of `FILETIME` is 100 ns; this many per second.
const FILETIME_PER_SEC: f64 = 10_000_000.0;

/// How long the ten-minute PowerShell may take before it is killed.
const SLOW_DEADLINE: Duration = Duration::from_secs(60);
/// How long the Windows Update search may take before it is killed.
const UPDATES_DEADLINE: Duration = Duration::from_secs(120);

const NT: PCWSTR = w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
const BIOS: PCWSTR = w!(r"HARDWARE\DESCRIPTION\System\BIOS");
const CPU0: PCWSTR = w!(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
/// The two keys servicing leaves behind while a restart is owed.
const REBOOT_WU: PCWSTR =
    w!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired");
const REBOOT_CBS: PCWSTR =
    w!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending");
/// The display adapter class, under which each installed driver instance
/// is a four-digit subkey.
const DISPLAY_CLASS: &str =
    r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
/// How many `NNNN` subkeys of the display class to look at. Driver
/// reinstalls leave gaps and push new instances up, so more than the
/// usual 0000–0009 — each miss is one cheap registry call.
const DISPLAY_SLOTS: u32 = 32;

const NO_TEMPERATURES: &str = "temperatures are not readable on Windows without vendor tools";
const NO_GPU_TEMPERATURE: &str = "GPU temperature is not readable without vendor tools";

/// The ten-minute script: the physical drives, their SMART counters and
/// the drive letters on each, as one JSON document. Each cmdlet is tried
/// on its own so one refusing (`Get-StorageReliabilityCounter` on a
/// virtual disk, say) still leaves the others. Enum-typed properties are
/// cast to strings, since `ConvertTo-Json` would render them as numbers.
/// Single quotes only: the script travels as one `-Command` argument and
/// double quotes would meet the command-line escaping.
const DRIVES_SCRIPT: &str = r"
$ErrorActionPreference = 'Stop'
$out = @{ disks = @(); counters = @(); partitions = @(); errors = @() }
try {
  $out.disks = @(Get-PhysicalDisk | Select-Object FriendlyName, SerialNumber, FirmwareVersion, Size, DeviceId,
    @{n='BusType';e={[string]$_.BusType}}, @{n='MediaType';e={[string]$_.MediaType}}, @{n='HealthStatus';e={[string]$_.HealthStatus}})
} catch { $out.errors += ('Get-PhysicalDisk|' + $_.Exception.Message) }
try {
  $out.counters = @(Get-PhysicalDisk | Get-StorageReliabilityCounter | Select-Object DeviceId, Temperature, PowerOnHours, Wear, ReadErrorsTotal, WriteErrorsTotal)
} catch { $out.errors += ('Get-StorageReliabilityCounter|' + $_.Exception.Message) }
try {
  $out.partitions = @(Get-Partition | Where-Object { [int]$_.DriveLetter -gt 0 } | Select-Object DiskNumber, @{n='Letter';e={[string]$_.DriveLetter}})
} catch { $out.errors += ('Get-Partition|' + $_.Exception.Message) }
[pscustomobject]$out | ConvertTo-Json -Compress -Depth 4
";

/// The hourly script: what Windows Update has pending, through the same
/// COM agent the Settings page uses, and the last few hotfixes installed.
/// Dates are formatted in the script because `ConvertTo-Json` would
/// render them as `/Date(ms)/`.
const UPDATES_SCRIPT: &str = r"
$ErrorActionPreference = 'Stop'
$out = @{ pending = @(); installed = @(); errors = @() }
try {
  $s = New-Object -ComObject Microsoft.Update.Session
  $r = $s.CreateUpdateSearcher().Search('IsInstalled=0 and IsHidden=0')
  $out.pending = @($r.Updates | ForEach-Object { [pscustomobject]@{
    title = $_.Title; kb = ($_.KBArticleIDs | Select-Object -First 1); size = $_.MaxDownloadSize;
    severity = $_.MsrcSeverity; restart = $_.RebootRequired } })
} catch { $out.errors += ('search|' + $_.Exception.Message) }
try {
  $out.installed = @(Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 8 |
    ForEach-Object { [pscustomobject]@{ id = $_.HotFixID; description = $_.Description; at = $_.InstalledOn.ToString('yyyy-MM-dd') } })
} catch { $out.errors += ('hotfix|' + $_.Exception.Message) }
[pscustomobject]$out | ConvertTo-Json -Compress -Depth 4
";

// ---------------------------------------------------------------- strings

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A NUL-terminated UTF-16 buffer as a trimmed String; None when empty.
fn from_wide(buf: &[u16]) -> Option<String> {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let s = String::from_utf16_lossy(&buf[..end]).trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A firmware or cmdlet string worth showing: trimmed, and not one of the
/// placeholders boards ship with instead of a value.
fn meaningful(s: &str) -> Option<String> {
    let t = collapse_ws(s);
    if t.is_empty() {
        return None;
    }
    let l = t.to_ascii_lowercase();
    let placeholder = matches!(
        l.as_str(),
        "unknown"
            | "not specified"
            | "none"
            | "n/a"
            | "no dimm"
            | "undefined"
            | "not available"
            | "to be filled by o.e.m."
            | "default string"
            | "empty"
    );
    (!placeholder).then_some(t)
}

// --------------------------------------------------------------- registry

fn reg_sz(sub: PCWSTR, value: PCWSTR) -> Option<String> {
    let mut len: u32 = 0;
    // SAFETY: a size query, then a read into a buffer of that size; `sub`
    // and `value` are NUL-terminated for the whole call.
    unsafe {
        if RegGetValueW(
            HKEY_LOCAL_MACHINE,
            sub,
            value,
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut len),
        )
        .is_err()
        {
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2)];
        if RegGetValueW(
            HKEY_LOCAL_MACHINE,
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
        from_wide(&buf)
    }
}

fn reg_dword(sub: PCWSTR, value: PCWSTR) -> Option<u32> {
    let mut out: u32 = 0;
    let mut len: u32 = 4;
    // SAFETY: a four-byte read into a u32.
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
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

/// An unsigned integer of whichever width the value has: REG_QWORD,
/// REG_DWORD, or REG_BINARY of 4 or 8 bytes (what display drivers write
/// for `HardwareInformation.MemorySize`). Little-endian, as the registry is.
fn reg_uint(sub: PCWSTR, value: PCWSTR) -> Option<u64> {
    let mut buf = [0u8; 8];
    let mut len: u32 = buf.len() as u32;
    // SAFETY: a read of at most eight bytes into an eight-byte buffer;
    // RegGetValueW fails rather than overruns when the value is longer.
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            sub,
            value,
            RRF_RT_ANY,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if rc.is_err() {
        return None;
    }
    match len {
        8 => Some(u64::from_le_bytes(buf)),
        4 => Some(u64::from(u32::from_le_bytes([
            buf[0], buf[1], buf[2], buf[3],
        ]))),
        _ => None,
    }
}

/// Whether a key exists under HKLM: opened for reading and closed again.
fn reg_key_exists(sub: PCWSTR) -> bool {
    let mut h = HKEY::default();
    // SAFETY: `sub` is NUL-terminated; the handle is written on success
    // and closed right away.
    unsafe {
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, sub, None, KEY_READ, &mut h) != ERROR_SUCCESS {
            return false;
        }
        let _ = RegCloseKey(h);
    }
    true
}

// ------------------------------------------------------------- pure bits

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
struct CpuTimes {
    idle: u64,
    kernel: u64,
    user: u64,
}

/// Percent busy between two readings, or None when nothing elapsed.
fn cpu_usage(prev: CpuTimes, cur: CpuTimes) -> Option<f64> {
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

/// Bytes per second from two counter readings, or None when the counter
/// went backwards (adapter reset) or no time passed.
fn rate(prev: u64, cur: u64, secs: f64) -> Option<f64> {
    if cur < prev || secs <= 0.0 {
        return None;
    }
    Some((cur - prev) as f64 / secs)
}

/// A process's share of one core between two readings of its kernel+user
/// time (100 ns ticks): 100 % is one core busy the whole interval, and a
/// process on several cores can exceed it.
fn process_cpu(prev: u64, cur: u64, secs: f64) -> Option<f64> {
    rate(prev, cur, secs).map(|ticks_per_sec| (100.0 * ticks_per_sec / FILETIME_PER_SEC).max(0.0))
}

fn filetime_u64(t: FILETIME) -> u64 {
    (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)
}

/// The image name alone: Toolhelp gives it without a path, but a path is
/// stripped should one ever appear.
fn image_name(s: &str) -> String {
    s.rsplit(['\\', '/']).next().unwrap_or(s).to_string()
}

/// A service's state as the page says it.
fn service_state(s: SERVICE_STATUS_CURRENT_STATE) -> &'static str {
    match s {
        SERVICE_STOPPED => "stopped",
        SERVICE_START_PENDING => "start pending",
        SERVICE_STOP_PENDING => "stop pending",
        SERVICE_RUNNING => "running",
        SERVICE_CONTINUE_PENDING => "continue pending",
        SERVICE_PAUSE_PENDING => "pause pending",
        SERVICE_PAUSED => "paused",
        _ => "unknown",
    }
}

/// The exit code a stopped service reports: the service-specific one when
/// the Win32 code says to look there.
fn service_exit_code(win32: u32, specific: u32) -> u32 {
    if win32 == ERROR_SERVICE_SPECIFIC_ERROR.0 {
        specific
    } else {
        win32
    }
}

/// Whether a stopped Automatic service is worth listing: an exit code
/// other than success or "never started" (a trigger-start service that
/// has had no trigger yet).
fn service_is_down(exit: u32) -> bool {
    exit != ERROR_SUCCESS.0 && exit != ERROR_SERVICE_NEVER_STARTED.0
}

// ---------------------------------------------------------------- SMBIOS

/// What the raw SMBIOS table says that the registry's BIOS key does not.
#[derive(Clone, Debug, Default, PartialEq)]
struct Smbios {
    form: Option<&'static str>,
    slots: Option<u32>,
    max_capacity_bytes: Option<u64>,
    modules: Vec<MemoryModule>,
}

/// The chassis type (SMBIOS type 3, byte 5, lock bit masked) as a shape.
fn chassis_form(ty: u8) -> Option<&'static str> {
    Some(match ty & 0x7F {
        8..=10 | 14 | 31 | 32 => "laptop",
        30 => "tablet",
        3..=5 | 15 | 16 | 24 => "desktop",
        6 | 7 => "tower",
        35 | 36 => "mini",
        13 => "all-in-one",
        17 | 23 | 25 | 28 | 29 => "server",
        _ => return None,
    })
}

/// The memory type enum (SMBIOS type 17, byte 0x12) as its name.
fn memory_kind(ty: u8) -> Option<&'static str> {
    Some(match ty {
        0x03 => "DRAM",
        0x0F => "SDRAM",
        0x11 => "RDRAM",
        0x12 => "DDR",
        0x13 => "DDR2",
        0x14 => "DDR2 FB-DIMM",
        0x18 => "DDR3",
        0x19 => "FBD2",
        0x1A => "DDR4",
        0x1B => "LPDDR",
        0x1C => "LPDDR2",
        0x1D => "LPDDR3",
        0x1E => "LPDDR4",
        0x20 => "HBM",
        0x21 => "HBM2",
        0x22 => "DDR5",
        0x23 => "LPDDR5",
        0x24 => "HBM3",
        _ => return None,
    })
}

fn u16_at(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

fn u32_at(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}

fn u64_at(b: &[u8], off: usize) -> Option<u64> {
    Some(u64::from(u32_at(b, off)?) | (u64::from(u32_at(b, off + 4)?) << 32))
}

/// A memory device's size in bytes from the type 17 fields: 0 is an
/// empty slot (None), 0xFFFF unknown (None), 0x7FFF "see Extended Size";
/// otherwise bit 15 says kilobytes rather than megabytes.
fn module_size(size: u16, extended_mb: Option<u32>) -> Option<u64> {
    match size {
        0 | 0xFFFF => None,
        0x7FFF => extended_mb
            .map(|mb| u64::from(mb & 0x7FFF_FFFF) << 20)
            .filter(|&b| b > 0),
        s if s & 0x8000 != 0 => Some(u64::from(s & 0x7FFF) << 10),
        s => Some(u64::from(s) << 20),
    }
}

/// A speed field with its 3.2 extension: 0 unknown, 0xFFFF "see extended".
fn module_speed(speed: Option<u16>, extended: Option<u32>) -> Option<u32> {
    match speed? {
        0 => None,
        0xFFFF => extended.filter(|&s| s > 0),
        s => Some(u32::from(s)),
    }
}

/// The type 16 capacity: kilobytes in the u32, or "see the extended field"
/// (bytes) when it holds 0x80000000.
fn array_capacity(kb: u32, extended_bytes: Option<u64>) -> Option<u64> {
    match kb {
        0 => None,
        0x8000_0000 => extended_bytes.filter(|&b| b > 0),
        kb => Some(u64::from(kb) << 10),
    }
}

/// One SMBIOS structure: its formatted area and its strings (1-based in
/// the formatted area's string indices).
struct Structure<'a> {
    ty: u8,
    body: &'a [u8],
    strings: Vec<String>,
}

impl Structure<'_> {
    /// The string a formatted-area byte at `off` names, when meaningful.
    fn string(&self, off: usize) -> Option<String> {
        let idx = *self.body.get(off)? as usize;
        if idx == 0 {
            return None;
        }
        meaningful(self.strings.get(idx - 1)?)
    }
}

/// The structures of an SMBIOS table (the bytes after `RawSMBIOSData`'s
/// eight-byte header), in order, stopping at the end-of-table marker or
/// at anything malformed.
fn smbios_structures(table: &[u8]) -> Vec<Structure<'_>> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 4 <= table.len() {
        let ty = table[off];
        let len = table[off + 1] as usize;
        if ty == 127 || len < 4 || off + len > table.len() {
            break;
        }
        let body = &table[off..off + len];
        // The string set: NUL-terminated strings, then one more NUL; a
        // structure with no strings is two NULs. An empty string can only
        // be that terminator, so a lone NUL (firmware that skips the
        // second one) ends the set too.
        let mut strings = Vec::new();
        let mut p = off + len;
        loop {
            let start = p;
            while p < table.len() && table[p] != 0 {
                p += 1;
            }
            if p >= table.len() {
                // Truncated inside a string set: keep what parsed.
                out.push(Structure { ty, body, strings });
                return out;
            }
            let empty = p == start;
            if !empty {
                strings.push(String::from_utf8_lossy(&table[start..p]).to_string());
            }
            p += 1;
            if table.get(p) == Some(&0) {
                p += 1;
                break;
            }
            if empty || p >= table.len() {
                break;
            }
        }
        out.push(Structure { ty, body, strings });
        off = p;
    }
    out
}

/// The chassis type and the memory arrays and devices from the table.
fn parse_smbios(table: &[u8]) -> Smbios {
    let mut out = Smbios::default();
    // (use, devices, capacity) per Physical Memory Array; the system
    // memory ones (use 3) are what counts, the rest (flash, cache) only
    // when the firmware marks nothing as system memory.
    let mut arrays: Vec<(u8, u32, Option<u64>)> = Vec::new();
    for s in smbios_structures(table) {
        match s.ty {
            3 => {
                if out.form.is_none() {
                    out.form = s.body.get(5).copied().and_then(chassis_form);
                }
            }
            16 => {
                let Some(devices) = u16_at(s.body, 0x0D) else {
                    continue;
                };
                let usage = s.body.get(5).copied().unwrap_or(0);
                let cap =
                    u32_at(s.body, 0x07).and_then(|kb| array_capacity(kb, u64_at(s.body, 0x0F)));
                arrays.push((usage, u32::from(devices), cap));
            }
            17 => {
                let Some(size) = u16_at(s.body, 0x0C) else {
                    continue;
                };
                let size_bytes = module_size(size, u32_at(s.body, 0x1C));
                if size == 0 {
                    continue;
                }
                let configured = module_speed(u16_at(s.body, 0x20), u32_at(s.body, 0x58));
                let rated = module_speed(u16_at(s.body, 0x15), u32_at(s.body, 0x54));
                out.modules.push(MemoryModule {
                    locator: s.string(0x10),
                    size_bytes,
                    speed_mts: configured.or(rated),
                    kind: s
                        .body
                        .get(0x12)
                        .copied()
                        .and_then(memory_kind)
                        .map(str::to_string),
                    manufacturer: s.string(0x17),
                    part_number: s.string(0x1A),
                });
            }
            _ => {}
        }
    }
    let system: Vec<_> = arrays.iter().filter(|a| a.0 == 3).collect();
    let picked: Vec<_> = if system.is_empty() {
        arrays.iter().collect()
    } else {
        system
    };
    if !picked.is_empty() {
        let slots: u32 = picked.iter().map(|a| a.1).sum();
        out.slots = (slots > 0).then_some(slots);
        let cap: u64 = picked.iter().filter_map(|a| a.2).sum();
        out.max_capacity_bytes = (cap > 0).then_some(cap);
    }
    out
}

/// The raw SMBIOS table from the firmware, parsed.
fn read_smbios() -> Result<Smbios, String> {
    // SAFETY: a size query with no buffer.
    let size = unsafe { GetSystemFirmwareTable(RSMB, 0, None) };
    if size == 0 {
        return Err("GetSystemFirmwareTable gave no SMBIOS table".into());
    }
    let mut buf = vec![0u8; size as usize];
    // SAFETY: the buffer is the size the call asked for; it writes at most
    // that many bytes and returns how many.
    let written = unsafe { GetSystemFirmwareTable(RSMB, 0, Some(&mut buf[..])) } as usize;
    if written == 0 || written > buf.len() {
        return Err("GetSystemFirmwareTable did not fill the SMBIOS table".into());
    }
    // RawSMBIOSData: Used20CallingMethod, major, minor, DmiRevision (four
    // bytes), Length (u32), then the table.
    let Some(len) = u32_at(&buf, 4) else {
        return Err("SMBIOS table is shorter than its header".into());
    };
    let end = (8 + len as usize).min(written);
    if end <= 8 {
        return Err("SMBIOS table is empty".into());
    }
    Ok(parse_smbios(&buf[8..end]))
}

// ----------------------------------------------------------- shell-outs

/// Why a command gave nothing, for the error line.
#[derive(Debug, PartialEq)]
enum Failed {
    /// It could not be started at all.
    Spawn(String),
    /// It did not finish within the deadline and was killed.
    Timeout,
    /// It finished with a non-zero status; the first line of stderr, if any.
    Exit(i32, String),
}

impl std::fmt::Display for Failed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failed::Spawn(e) => write!(f, "not started: {e}"),
            Failed::Timeout => write!(f, "no answer in time"),
            Failed::Exit(code, line) if line.is_empty() => write!(f, "exit {code}"),
            Failed::Exit(code, line) => write!(f, "exit {code}: {line}"),
        }
    }
}

/// A command's whole stdout, or why not; killed at the deadline. Bytes are
/// read and converted lossily, so a stray code-page character cannot
/// throw the whole document away.
fn output_or(mut cmd: Command, deadline: Duration) -> Result<String, Failed> {
    let started = Instant::now();
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Failed::Spawn(e.to_string()))?;
    let mut out = child
        .stdout
        .take()
        .ok_or_else(|| Failed::Spawn("no stdout".into()))?;
    let mut err = child.stderr.take();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        let _ = tx.send(String::from_utf8_lossy(&b).into_owned());
    });
    let (etx, erx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_end(&mut b);
        }
        let _ = etx.send(String::from_utf8_lossy(&b).into_owned());
    });
    let text = match rx.recv_timeout(deadline) {
        Ok(t) => t,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failed::Timeout);
        }
    };
    // stdout is closed; the process is exiting. Give it the rest of the
    // deadline rather than a blocking wait.
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(text);
                }
                let stderr = erx
                    .recv_timeout(Duration::from_millis(200))
                    .unwrap_or_default();
                let first = stderr
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("")
                    .trim();
                return Err(Failed::Exit(status.code().unwrap_or(-1), first.to_string()));
            }
            Ok(None) if started.elapsed() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failed::Timeout);
            }
        }
    }
}

/// Windows PowerShell, by its full path (the service's PATH is minimal),
/// running one script with no profile, no prompt and no window; its
/// stdout parsed as JSON.
fn powershell_json(script: &str, deadline: Duration) -> Result<Value, String> {
    let exe = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("powershell.exe"));
    let mut cmd = Command::new(exe);
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-NoLogo",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let text = output_or(cmd, deadline).map_err(|e| format!("PowerShell {e}"))?;
    let text = text.trim();
    if text.is_empty() {
        return Err("PowerShell printed nothing".into());
    }
    serde_json::from_str(text).map_err(|e| format!("PowerShell output is not JSON: {e}"))
}

// ------------------------------------------------------------- JSON bits

/// A property as a trimmed, non-empty string.
fn j_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A property as an unsigned integer: a JSON number, a float that is one,
/// or a numeric string (COM decimals reach JSON either way).
fn j_u64(v: &Value, key: &str) -> Option<u64> {
    let x = v.get(key)?;
    x.as_u64()
        .or_else(|| x.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64))
        .or_else(|| x.as_str()?.trim().parse().ok())
}

/// A property that identifies (a disk number, a KB number), whether it
/// came as a number or a string.
fn j_id(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// A property that is a list: `ConvertTo-Json` unwraps a single element,
/// so one object counts as a list of one.
fn j_list(v: &Value, key: &str) -> Vec<Value> {
    match v.get(key) {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::Null) | None => Vec::new(),
        Some(x) => vec![x.clone()],
    }
}

/// The script's own `name|message` error lines, prefixed for the page.
fn script_errors(v: &Value, label: impl Fn(&str) -> String) -> Vec<String> {
    j_list(v, "errors")
        .iter()
        .filter_map(Value::as_str)
        .map(|line| {
            let (what, msg) = line.split_once('|').unwrap_or((line, ""));
            let msg = msg.lines().next().unwrap_or("").trim();
            if msg.is_empty() {
                format!("{}: {what} refused", label(what))
            } else {
                format!("{}: {what} refused: {msg}", label(what))
            }
        })
        .collect()
}

/// A `BusType` as the page names it: the enum's name lowercased, or the
/// number the CIM class carries when the cast gave one.
fn bus_name(s: &str) -> Option<String> {
    let l = s.trim().to_ascii_lowercase();
    let named = match l.as_str() {
        "" | "unknown" | "0" => return None,
        "1" => "scsi",
        "2" => "atapi",
        "3" => "ata",
        "4" => "1394",
        "5" => "ssa",
        "6" => "fibre channel",
        "7" => "usb",
        "8" => "raid",
        "9" => "iscsi",
        "10" => "sas",
        "11" => "sata",
        "12" => "sd",
        "13" => "mmc",
        "14" => "virtual",
        "15" => "file backed virtual",
        "16" => "storage spaces",
        "17" => "nvme",
        "18" => "scm",
        "19" => "ufs",
        other => other,
    };
    Some(named.to_string())
}

/// A `MediaType` as "ssd" | "hdd" | "scm".
fn media_kind(s: &str) -> Option<&'static str> {
    match s.trim().to_ascii_lowercase().as_str() {
        "ssd" | "4" => Some("ssd"),
        "hdd" | "3" => Some("hdd"),
        "scm" | "5" => Some("scm"),
        _ => None,
    }
}

/// A `HealthStatus` as the page says it.
fn health_name(s: &str) -> Option<&'static str> {
    match s.trim().to_ascii_lowercase().as_str() {
        "healthy" | "0" => Some("healthy"),
        "warning" | "1" => Some("warning"),
        "unhealthy" | "2" => Some("unhealthy"),
        _ => None,
    }
}

/// Whether a bus is one drives come and go on.
fn bus_removable(bus: &str) -> bool {
    matches!(bus, "usb" | "sd" | "mmc" | "1394")
}

/// The drives from the ten-minute script's document.
fn parse_drives(v: &Value) -> Vec<Drive> {
    // DeviceId → the SMART counters for it.
    let counters: HashMap<String, Value> = j_list(v, "counters")
        .into_iter()
        .filter_map(|c| Some((j_id(&c, "DeviceId")?, c)))
        .collect();
    // DiskNumber → the drive letters on it.
    let mut letters: HashMap<String, Vec<String>> = HashMap::new();
    for p in j_list(v, "partitions") {
        let (Some(disk), Some(letter)) = (j_id(&p, "DiskNumber"), j_str(&p, "Letter")) else {
            continue;
        };
        let Some(c) = letter.chars().next().filter(char::is_ascii_alphabetic) else {
            continue;
        };
        letters
            .entry(disk)
            .or_default()
            .push(format!("{}:", c.to_ascii_uppercase()));
    }
    let mut out = Vec::new();
    for d in j_list(v, "disks") {
        let id = j_id(&d, "DeviceId");
        let bus = j_str(&d, "BusType").and_then(|s| bus_name(&s));
        let c = id.as_ref().and_then(|id| counters.get(id));
        let mut volumes = id
            .as_ref()
            .and_then(|id| letters.get(id))
            .cloned()
            .unwrap_or_default();
        volumes.sort();
        volumes.dedup();
        out.push(Drive {
            name: j_str(&d, "FriendlyName")
                .map(|s| collapse_ws(&s))
                .unwrap_or_else(|| format!("Disk {}", id.as_deref().unwrap_or("?"))),
            serial: j_str(&d, "SerialNumber").and_then(|s| meaningful(&s)),
            firmware: j_str(&d, "FirmwareVersion").and_then(|s| meaningful(&s)),
            size_bytes: j_u64(&d, "Size").filter(|&b| b > 0),
            kind: j_str(&d, "MediaType")
                .and_then(|s| media_kind(&s))
                .map(str::to_string),
            health: j_str(&d, "HealthStatus")
                .and_then(|s| health_name(&s))
                .map(str::to_string),
            // A reading of 0 °C is a counter the drive does not keep.
            temperature_c: c
                .and_then(|c| j_u64(c, "Temperature"))
                .filter(|&t| t > 0)
                .map(|t| t as f64),
            power_on_hours: c.and_then(|c| j_u64(c, "PowerOnHours")),
            wear_pct: c
                .and_then(|c| j_u64(c, "Wear"))
                .map(|w| (w as f64).min(100.0)),
            read_errors: c.and_then(|c| j_u64(c, "ReadErrorsTotal")),
            write_errors: c.and_then(|c| j_u64(c, "WriteErrorsTotal")),
            removable: bus.as_deref().map(bus_removable),
            bus,
            volumes,
        });
    }
    out
}

/// The severity as the page says it; the COM object gives "" for none.
fn severity_name(s: &str) -> Option<String> {
    let l = s.trim().to_ascii_lowercase();
    (!l.is_empty()).then_some(l)
}

/// "KB5043076" from whatever the KB number came as.
fn kb_id(s: &str) -> Option<String> {
    let t = s.trim();
    let digits = t
        .strip_prefix("KB")
        .or_else(|| t.strip_prefix("kb"))
        .unwrap_or(t);
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
        .then(|| format!("KB{digits}"))
}

/// The updates document from the hourly script's output.
fn parse_updates(v: &Value) -> Updates {
    let pending = j_list(v, "pending")
        .iter()
        .filter_map(|u| {
            Some(Update {
                title: collapse_ws(&j_str(u, "title")?),
                id: j_id(u, "kb").and_then(|k| kb_id(&k)),
                size_bytes: j_u64(u, "size").filter(|&b| b > 0),
                severity: j_str(u, "severity").and_then(|s| severity_name(&s)),
                restart: u.get("restart").and_then(Value::as_bool),
            })
        })
        .collect();
    let installed = j_list(v, "installed")
        .iter()
        .filter_map(|h| {
            let id = j_str(h, "id")?;
            let title = match j_str(h, "description") {
                Some(d) => format!("{id} {d}"),
                None => id,
            };
            Some(Installed {
                title,
                at: j_str(h, "at"),
            })
        })
        .collect();
    let errors = script_errors(v, |what| {
        match what {
            "search" => "Windows Update search",
            "hotfix" => "installed updates",
            _ => "OS updates",
        }
        .to_string()
    });
    Updates {
        checked_at: None,
        pending,
        installed,
        reboot_pending: None,
        error: errors.into_iter().next(),
    }
}

// ------------------------------------------------------------------ PDH

/// The GPU counter query, opened once and collected every sample.
struct Pdh {
    query: PDH_HQUERY,
    usage: PDH_HCOUNTER,
    vram: PDH_HCOUNTER,
    /// Collections so far; rate counters carry a value from the second on.
    collections: u32,
}

impl Pdh {
    fn open() -> Result<Self, String> {
        let mut query = PDH_HQUERY::default();
        // SAFETY: a fresh query handle is written on success.
        let rc = unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) };
        if rc != 0 {
            return Err(format!("PdhOpenQuery failed: {rc:#010x}"));
        }
        let mut usage = PDH_HCOUNTER::default();
        let mut vram = PDH_HCOUNTER::default();
        // The 3D engine is what "GPU %" means in Task Manager; the memory
        // counter is the dedicated (on-board) usage per adapter. English
        // names, so a localised Windows resolves them too.
        // SAFETY: the query is open; each counter handle is written on success.
        let rc_usage = unsafe {
            PdhAddEnglishCounterW(
                query,
                w!(r"\GPU Engine(*engtype_3D)\Utilization Percentage"),
                0,
                &mut usage,
            )
        };
        // SAFETY: as above.
        let rc_vram = unsafe {
            PdhAddEnglishCounterW(
                query,
                w!(r"\GPU Adapter Memory(*)\Dedicated Usage"),
                0,
                &mut vram,
            )
        };
        if rc_usage != 0 || rc_vram != 0 {
            // SAFETY: closing the query this function opened.
            unsafe {
                PdhCloseQuery(query);
            }
            return Err(format!(
                "GPU performance counters not added: usage {rc_usage:#010x}, memory {rc_vram:#010x}"
            ));
        }
        Ok(Self {
            query,
            usage,
            vram,
            collections: 0,
        })
    }

    fn collect(&mut self) -> Result<(), String> {
        // SAFETY: the query is open for the life of `self`.
        let rc = unsafe { PdhCollectQueryData(self.query) };
        if rc != 0 {
            return Err(format!("PdhCollectQueryData failed: {rc:#010x}"));
        }
        self.collections += 1;
        Ok(())
    }

    /// The sum of a wildcard counter's instances, `_Total` excluded.
    fn sum(counter: PDH_HCOUNTER) -> Result<f64, u32> {
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        // SAFETY: a size query with no buffer.
        let rc = unsafe {
            PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None)
        };
        if rc != PDH_MORE_DATA {
            return Err(rc);
        }
        // u64-backed so the items (pointer + f64) are aligned; the
        // instance names follow the items inside the same buffer.
        let mut buf = vec![0u64; (size as usize).div_ceil(8).max(1)];
        // SAFETY: the buffer is the size PDH asked for; the item slice is
        // `count` entries within it, and each name pointer points into it.
        unsafe {
            let rc = PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                Some(buf.as_mut_ptr().cast()),
            );
            if rc != 0 {
                return Err(rc);
            }
            let items = std::slice::from_raw_parts(
                buf.as_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
                count as usize,
            );
            let mut total = 0.0;
            for it in items {
                let status = it.FmtValue.CStatus;
                if status != PDH_CSTATUS_VALID_DATA && status != PDH_CSTATUS_NEW_DATA {
                    continue;
                }
                if !it.szName.is_null() && it.szName.as_wide().starts_with(&wide("_Total")[..6]) {
                    continue;
                }
                // Formatted as PDH_FMT_DOUBLE, so this member is the live one.
                total += it.FmtValue.Anonymous.doubleValue;
            }
            Ok(total)
        }
    }
}

impl Drop for Pdh {
    fn drop(&mut self) {
        // SAFETY: the query was opened by `open` and is closed once.
        unsafe {
            PdhCloseQuery(self.query);
        }
    }
}

// ------------------------------------------------------------ collector

#[derive(Default)]
pub struct Collector {
    prev_cpu: Option<CpuTimes>,
    /// Interface alias → (rx, tx) at the previous sample.
    prev_net: HashMap<String, (u64, u64)>,
    /// Pid → kernel+user time (100 ns) at the previous sample; pids that
    /// vanished are dropped each sample.
    prev_proc: HashMap<u32, u64>,
    prev_at: Option<Instant>,
    pdh: Option<Pdh>,
    /// Set once opening PDH failed, so a failure is reported once and not
    /// retried every 15 s.
    pdh_failed: Option<String>,
    /// How many GPUs the last `read_static` found; `gpu_usage` is indexed
    /// like that list.
    gpu_count: usize,
    /// Which GPU the machine-wide counters are attributed to.
    gpu_main: usize,
}

impl Collect for Collector {
    fn read_static(&mut self) -> Static {
        let mut errors = Vec::new();
        let mut machine = read_machine(&mut errors);
        let os = read_os(&mut errors);
        let cpu = read_cpu(&mut errors);
        let gpus = read_gpus(&mut errors);
        let smbios = match read_smbios() {
            Ok(s) => s,
            Err(e) => {
                errors.push(format!("chassis and memory modules: {e}"));
                Smbios::default()
            }
        };
        machine.form = smbios.form.map(str::to_string);
        self.gpu_count = gpus.len();
        // The counters carry a LUID per instance while the registry keys do
        // not, so the machine's totals go on the GPU with the most memory —
        // the discrete card on a machine that has one, the only one otherwise.
        self.gpu_main = gpus
            .iter()
            .enumerate()
            .max_by_key(|(_, g)| g.vram_total_bytes.unwrap_or(0))
            .map(|(i, _)| i)
            .unwrap_or(0);
        Static {
            machine,
            os,
            cpu,
            gpus,
            memory_slots: smbios.slots,
            memory_max_capacity_bytes: smbios.max_capacity_bytes,
            memory_modules: smbios.modules,
            errors,
        }
    }

    fn read_slow(&mut self) -> Slow {
        let mut errors = Vec::new();
        let drives = match powershell_json(DRIVES_SCRIPT, SLOW_DEADLINE) {
            Ok(v) => {
                errors.extend(script_errors(&v, |what| {
                    match what {
                        "Get-StorageReliabilityCounter" => "SMART counters",
                        "Get-Partition" => "drive volumes",
                        _ => "drives",
                    }
                    .to_string()
                }));
                parse_drives(&v)
            }
            Err(e) => {
                errors.push(format!("drives: {e}"));
                Vec::new()
            }
        };
        let (services, service_count) = match read_services() {
            Ok((s, n)) => (s, Some(n)),
            Err(e) => {
                errors.push(format!("services: {e}"));
                (Vec::new(), None)
            }
        };
        Slow {
            drives,
            services,
            service_count,
            errors,
        }
    }

    fn sample(&mut self) -> Sample {
        let mut errors = Vec::new();
        let now = Instant::now();
        let elapsed = self.prev_at.map(|t| now.duration_since(t).as_secs_f64());
        self.prev_at = Some(now);

        let cpu_usage_pct = self.sample_cpu(&mut errors);
        let mut memory = read_memory(&mut errors);
        let disks = read_disks(&mut errors);
        let gpu_usage = self.sample_gpus(&mut errors);
        let network = self.sample_network(elapsed, &mut errors);
        let battery = read_battery();
        let (processes, process_count, compressed) = self.sample_processes(elapsed, &mut errors);
        memory.compressed_bytes = compressed;
        errors.push(NO_TEMPERATURES.into());

        Sample {
            cpu_usage_pct,
            load: None,
            cpu_temperature_c: None,
            memory,
            disks,
            gpu_usage,
            temperatures: Vec::new(),
            network,
            battery,
            processes,
            process_count,
            errors,
        }
    }
}

impl Collector {
    fn sample_cpu(&mut self, errors: &mut Vec<String>) -> Option<f64> {
        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: three FILETIMEs the call writes.
        let rc = unsafe {
            GetSystemTimes(
                Some(std::ptr::from_mut(&mut idle)),
                Some(std::ptr::from_mut(&mut kernel)),
                Some(std::ptr::from_mut(&mut user)),
            )
        };
        if let Err(e) = rc {
            errors.push(format!("GetSystemTimes failed: {e}"));
            self.prev_cpu = None;
            return None;
        }
        let cur = CpuTimes {
            idle: filetime_u64(idle),
            kernel: filetime_u64(kernel),
            user: filetime_u64(user),
        };
        let pct = self.prev_cpu.and_then(|prev| cpu_usage(prev, cur));
        self.prev_cpu = Some(cur);
        pct
    }

    fn sample_gpus(&mut self, errors: &mut Vec<String>) -> Vec<GpuSample> {
        if self.gpu_count == 0 {
            return Vec::new();
        }
        errors.push(NO_GPU_TEMPERATURE.into());
        let mut out = vec![GpuSample::default(); self.gpu_count];
        if self.pdh.is_none() && self.pdh_failed.is_none() {
            match Pdh::open() {
                Ok(p) => self.pdh = Some(p),
                Err(e) => self.pdh_failed = Some(e),
            }
        }
        if let Some(e) = &self.pdh_failed {
            errors.push(format!("GPU usage is not readable: {e}"));
            return out;
        }
        let Some(pdh) = self.pdh.as_mut() else {
            return out;
        };
        if let Err(e) = pdh.collect() {
            errors.push(format!("GPU usage is not readable: {e}"));
            return out;
        }
        // Rate counters have a value only from the second collection on;
        // the first sample is the primer and reports nothing.
        if pdh.collections < 2 {
            return out;
        }
        // The counters carry a LUID per instance while the registry keys do
        // not, so the machine's total goes on the first GPU and the rest
        // stay unsampled.
        match Pdh::sum(pdh.usage) {
            Ok(v) => out[self.gpu_main].usage_pct = Some(v.clamp(0.0, 100.0)),
            Err(rc) => errors.push(format!("GPU usage counter not read: PDH {rc:#010x}")),
        }
        match Pdh::sum(pdh.vram) {
            Ok(v) if v >= 0.0 => out[self.gpu_main].vram_used_bytes = Some(v as u64),
            Ok(_) => {}
            Err(rc) => errors.push(format!("GPU memory counter not read: PDH {rc:#010x}")),
        }
        out
    }

    fn sample_network(&mut self, elapsed: Option<f64>, errors: &mut Vec<String>) -> Vec<Network> {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        // SAFETY: the table is allocated by the call and freed by
        // FreeMibTable after its rows are copied out.
        let rows: Vec<(String, u64, u64)> = unsafe {
            let rc = GetIfTable2(&mut table);
            if rc.is_err() || table.is_null() {
                errors.push(format!("GetIfTable2 failed: {}", rc.0));
                return Vec::new();
            }
            let n = (*table).NumEntries as usize;
            let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), n);
            let picked = rows
                .iter()
                .filter(|r| r.OperStatus == IfOperStatusUp)
                .filter(|r| r.Type == IF_TYPE_ETHERNET_CSMACD || r.Type == IF_TYPE_IEEE80211)
                .filter(|r| r.PhysicalAddressLength > 0)
                // The filter drivers stacked on an adapter (WFP, QoS…) are
                // listed as interfaces of their own with the same counters.
                // The SDK's bitfield: HardwareInterface is bit 0, FilterInterface
                // bit 1 (the crate exposes the byte, not the fields).
                .filter(|r| r.InterfaceAndOperStatusFlags._bitfield & 0x02 == 0)
                .map(|r| {
                    let name = from_wide(&r.Alias)
                        .or_else(|| from_wide(&r.Description))
                        .unwrap_or_else(|| format!("if{}", r.InterfaceIndex));
                    (name, r.InOctets, r.OutOctets)
                })
                .collect();
            FreeMibTable(table.cast());
            picked
        };
        let mut seen = HashMap::new();
        let mut out = Vec::with_capacity(rows.len());
        for (name, rx, tx) in rows {
            let (rx_bps, tx_bps) = match (self.prev_net.get(&name), elapsed) {
                (Some(&(prx, ptx)), Some(secs)) => (rate(prx, rx, secs), rate(ptx, tx, secs)),
                _ => (None, None),
            };
            seen.insert(name.clone(), (rx, tx));
            out.push(Network {
                interface: name,
                rx_bytes: Some(rx),
                tx_bytes: Some(tx),
                rx_bps,
                tx_bps,
            });
        }
        self.prev_net = seen;
        out
    }

    /// The heaviest processes by working set, how many there are, and the
    /// working set of the "Memory Compression" process (what the OS holds
    /// compressed). A process the service cannot open — a protected one —
    /// keeps its name and pid with no memory figure and sorts last.
    fn sample_processes(
        &mut self,
        elapsed: Option<f64>,
        errors: &mut Vec<String>,
    ) -> (Vec<Process>, Option<u32>, Option<u64>) {
        let entries = match process_snapshot() {
            Ok(e) => e,
            Err(e) => {
                errors.push(format!("processes: {e}"));
                self.prev_proc.clear();
                return (Vec::new(), None, None);
            }
        };
        let count = u32::try_from(entries.len()).ok();
        let mut seen = HashMap::with_capacity(entries.len());
        let mut compressed = None;
        let mut all: Vec<Process> = Vec::with_capacity(entries.len());
        for (pid, name) in entries {
            // Pid 0 is the idle process: its "CPU time" is the idle time.
            if pid == 0 {
                continue;
            }
            let (memory_bytes, times) = process_usage(pid).unzip();
            let cpu_pct = match (times, self.prev_proc.get(&pid), elapsed) {
                (Some(cur), Some(&prev), Some(secs)) => process_cpu(prev, cur, secs),
                _ => None,
            };
            if let Some(t) = times {
                seen.insert(pid, t);
            }
            if name == "Memory Compression" {
                compressed = memory_bytes;
            }
            all.push(Process {
                name,
                pid,
                memory_bytes,
                cpu_pct,
            });
        }
        self.prev_proc = seen;
        // Heaviest first; None (unreadable) sorts below every figure.
        all.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes).then(a.pid.cmp(&b.pid)));
        all.truncate(TOP_PROCESSES);
        (all, count, compressed)
    }
}

// --------------------------------------------------------------- static

fn read_machine(errors: &mut Vec<String>) -> Machine {
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
    };
    if m.manufacturer.is_none() && m.model.is_none() {
        errors.push("machine make and model are not in the registry's BIOS description".into());
    }
    m
}

fn read_os(errors: &mut Vec<String>) -> Os {
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

fn read_cpu(errors: &mut Vec<String>) -> Cpu {
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

fn read_gpus(errors: &mut Vec<String>) -> Vec<Gpu> {
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
        out.push(Gpu {
            vendor: vendor_from_name(&name).map(str::to_string),
            driver: reg_sz(sub, w!("DriverVersion")),
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

// ----------------------------------------------------------------- slow

/// A service-control handle closed on drop, whatever path returns.
struct ScHandle(SC_HANDLE);

impl Drop for ScHandle {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by the caller and is closed once.
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}

/// Whether a service is configured to start automatically (delayed or
/// not: both are `SERVICE_AUTO_START`). None when the config is refused.
fn service_is_automatic(scm: SC_HANDLE, name: PCWSTR) -> Option<bool> {
    // SAFETY: the manager handle is open; the name is a NUL-terminated
    // string inside the enumeration buffer, which outlives this call.
    let h = ScHandle(unsafe { OpenServiceW(scm, name, SERVICE_QUERY_CONFIG) }.ok()?);
    let mut needed: u32 = 0;
    // SAFETY: a size query with no buffer.
    let _ = unsafe { QueryServiceConfigW(h.0, None, 0, &mut needed) };
    if needed == 0 {
        return None;
    }
    // u64-backed so the struct's pointers are aligned; the strings it
    // points at follow it in the same buffer.
    let mut buf = vec![0u64; (needed as usize).div_ceil(8).max(1)];
    let size = u32::try_from(buf.len() * 8).ok()?;
    // SAFETY: the buffer is at least the size the call asked for and is
    // read as the struct at its start only after the call filled it.
    let start = unsafe {
        QueryServiceConfigW(
            h.0,
            Some(buf.as_mut_ptr().cast::<QUERY_SERVICE_CONFIGW>()),
            size,
            &mut needed,
        )
        .ok()?;
        (*buf.as_ptr().cast::<QUERY_SERVICE_CONFIGW>()).dwStartType
    };
    Some(start == SERVICE_AUTO_START)
}

/// Every Win32 service's status, and which Automatic ones are down.
fn read_services() -> Result<(Vec<Service>, u32), String> {
    // SAFETY: the local manager, for enumeration only; the handle is
    // closed by `ScHandle`.
    let scm = ScHandle(
        unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_ENUMERATE_SERVICE) }
            .map_err(|e| format!("OpenSCManager failed: {e}"))?,
    );
    let mut needed: u32 = 0;
    let mut count: u32 = 0;
    let mut resume: u32 = 0;
    // SAFETY: a size query with no buffer; it fails with the size needed.
    let _ = unsafe {
        EnumServicesStatusExW(
            scm.0,
            SC_ENUM_PROCESS_INFO,
            SERVICE_WIN32,
            SERVICE_STATE_ALL,
            None,
            &mut needed,
            &mut count,
            Some(&mut resume),
            PCWSTR::null(),
        )
    };
    if needed == 0 {
        return Err("EnumServicesStatusEx gave no size".into());
    }
    // Room for the services plus a few installed between the two calls;
    // u64-backed so the entries (pointers) are aligned.
    let mut buf = vec![0u64; (needed as usize + 4096).div_ceil(8)];
    resume = 0;
    // SAFETY: the buffer is passed with its length; the entries are read as
    // a slice of `count` structs at its start, and each name pointer points
    // into the same buffer, which outlives every read.
    let (services, total) = unsafe {
        let bytes = std::slice::from_raw_parts_mut(buf.as_mut_ptr().cast::<u8>(), buf.len() * 8);
        EnumServicesStatusExW(
            scm.0,
            SC_ENUM_PROCESS_INFO,
            SERVICE_WIN32,
            SERVICE_STATE_ALL,
            Some(bytes),
            &mut needed,
            &mut count,
            Some(&mut resume),
            PCWSTR::null(),
        )
        .map_err(|e| format!("EnumServicesStatusEx failed: {e}"))?;
        let entries = std::slice::from_raw_parts(
            buf.as_ptr().cast::<ENUM_SERVICE_STATUS_PROCESSW>(),
            count as usize,
        );
        let mut down = Vec::new();
        for e in entries {
            let st = &e.ServiceStatusProcess;
            if st.dwCurrentState == SERVICE_RUNNING || e.lpServiceName.is_null() {
                continue;
            }
            let exit = service_exit_code(st.dwWin32ExitCode, st.dwServiceSpecificExitCode);
            if !service_is_down(exit) {
                continue;
            }
            let name_ptr = PCWSTR(e.lpServiceName.as_ptr());
            if service_is_automatic(scm.0, name_ptr) != Some(true) {
                continue;
            }
            let name = String::from_utf16_lossy(e.lpServiceName.as_wide())
                .trim()
                .to_string();
            let display = (!e.lpDisplayName.is_null())
                .then(|| String::from_utf16_lossy(e.lpDisplayName.as_wide()))
                .and_then(|d| meaningful(&d))
                .filter(|d| d != &name);
            down.push(Service {
                name,
                display,
                state: service_state(st.dwCurrentState).to_string(),
                exit_code: Some(i64::from(exit)),
            });
        }
        (down, count)
    };
    Ok((services, total))
}

// --------------------------------------------------------------- sampled

fn read_memory(errors: &mut Vec<String>) -> Memory {
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

/// Every process's pid and image name, from one Toolhelp snapshot.
fn process_snapshot() -> Result<Vec<(u32, String)>, String> {
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
fn process_usage(pid: u32) -> Option<(u64, u64)> {
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
fn read_disks(errors: &mut Vec<String>) -> Vec<Disk> {
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

fn read_battery() -> Option<Battery> {
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
    })
}

// -------------------------------------------------------------- updates

/// What Windows Update has pending and recently installed, on the hourly
/// thread: the COM search through PowerShell, the reboot flag from the
/// registry. A failed search leaves `error` set and whatever else was read.
pub fn read_updates() -> Updates {
    let mut u = match powershell_json(UPDATES_SCRIPT, UPDATES_DEADLINE) {
        Ok(v) => parse_updates(&v),
        Err(e) => Updates {
            error: Some(format!("Windows Update search: {e}")),
            ..Default::default()
        },
    };
    u.checked_at = Some(crate::state::now_rfc3339());
    u.reboot_pending = Some(reg_key_exists(REBOOT_WU) || reg_key_exists(REBOOT_CBS));
    u
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
    fn rate_handles_resets_and_zero_time() {
        assert_eq!(rate(100, 400, 15.0), Some(20.0));
        assert_eq!(rate(400, 100, 15.0), None);
        assert_eq!(rate(100, 400, 0.0), None);
    }

    #[test]
    fn process_cpu_is_percent_of_one_core() {
        // 15 s of ticks in 15 s: one core, the whole time.
        let ticks = 15 * 10_000_000;
        assert_eq!(process_cpu(0, ticks, 15.0), Some(100.0));
        assert_eq!(process_cpu(0, ticks / 4, 15.0), Some(25.0));
        assert_eq!(process_cpu(ticks, 0, 15.0), None);
    }

    #[test]
    fn wide_round_trips_and_trims() {
        let w = wide("  Samsung SSD  ");
        assert_eq!(w.last(), Some(&0));
        assert_eq!(from_wide(&w).as_deref(), Some("Samsung SSD"));
        assert_eq!(from_wide(&[0, 65, 66]), None);
        assert_eq!(
            collapse_ws("Intel(R)   Core(TM)  i9"),
            "Intel(R) Core(TM) i9"
        );
    }

    #[test]
    fn filetime_joins_halves() {
        let t = FILETIME {
            dwLowDateTime: 1,
            dwHighDateTime: 2,
        };
        assert_eq!(filetime_u64(t), (2 << 32) | 1);
    }

    #[test]
    fn names_and_placeholders() {
        assert_eq!(image_name(r"C:\Windows\explorer.exe"), "explorer.exe");
        assert_eq!(image_name("chrome.exe"), "chrome.exe");
        assert_eq!(meaningful("  To Be Filled By O.E.M. "), None);
        assert_eq!(meaningful("Unknown"), None);
        assert_eq!(meaningful(" Kingston  "), Some("Kingston".into()));
        assert_eq!(kb_id("5043076"), Some("KB5043076".into()));
        assert_eq!(kb_id("KB5043076"), Some("KB5043076".into()));
        assert_eq!(kb_id("n/a"), None);
    }

    #[test]
    fn service_filters() {
        assert_eq!(service_state(SERVICE_STOPPED), "stopped");
        assert_eq!(service_state(SERVICE_START_PENDING), "start pending");
        assert_eq!(service_exit_code(1066, 42), 42);
        assert_eq!(service_exit_code(5, 42), 5);
        assert!(!service_is_down(0));
        assert!(!service_is_down(1077));
        assert!(service_is_down(1053));
    }

    /// One SMBIOS structure: header, formatted bytes, strings, terminator
    /// (two NULs when there are no strings, as the spec says).
    fn structure(ty: u8, handle: u16, formatted: &[u8], strings: &[&str]) -> Vec<u8> {
        let len = 4 + formatted.len();
        let mut b = vec![ty, len as u8, handle as u8, (handle >> 8) as u8];
        b.extend_from_slice(formatted);
        for s in strings {
            b.extend_from_slice(s.as_bytes());
            b.push(0);
        }
        if strings.is_empty() {
            b.push(0);
        }
        b.push(0);
        b
    }

    #[test]
    fn smbios_chassis_arrays_and_devices() {
        let mut table = Vec::new();
        // Type 3: manufacturer string 1, chassis type 10 (notebook) with the
        // lock bit set.
        table.extend(structure(
            3,
            0x0300,
            &[1, 0x80 | 10, 0, 0, 0],
            &["Dell Inc."],
        ));
        // Type 16: system memory (use 3), max capacity "see extended", two
        // devices, extended max 64 GiB.
        let mut f16 = vec![3, 3, 3];
        f16.extend_from_slice(&0x8000_0000u32.to_le_bytes());
        f16.extend_from_slice(&0xFFFEu16.to_le_bytes());
        f16.extend_from_slice(&2u16.to_le_bytes());
        f16.extend_from_slice(&(64u64 << 30).to_le_bytes());
        table.extend(structure(16, 0x1000, &f16, &[]));
        // Type 17: one 16 GiB DDR5 at 5600 configured (4800 rated), one empty.
        let mut f17 = vec![0u8; 0x5C - 4];
        f17[0x0C - 4..0x0E - 4].copy_from_slice(&(16 * 1024u16).to_le_bytes());
        f17[0x10 - 4] = 1; // locator
        f17[0x12 - 4] = 0x22; // DDR5
        f17[0x15 - 4..0x17 - 4].copy_from_slice(&4800u16.to_le_bytes());
        f17[0x17 - 4] = 2; // manufacturer
        f17[0x1A - 4] = 3; // part number
        f17[0x20 - 4..0x22 - 4].copy_from_slice(&5600u16.to_le_bytes());
        table.extend(structure(
            17,
            0x1100,
            &f17,
            &["DIMM_A1", "Kingston", "KF556C40-16 "],
        ));
        let mut empty = vec![0u8; 0x5C - 4];
        empty[0x10 - 4] = 1;
        table.extend(structure(17, 0x1101, &empty, &["DIMM_B1"]));
        // Type 127: end of table, then junk that must not be read.
        table.extend(structure(127, 0x7F00, &[], &[]));
        table.extend_from_slice(&[17, 200, 0, 0, 1, 2, 3]);

        let s = parse_smbios(&table);
        assert_eq!(s.form, Some("laptop"));
        assert_eq!(s.slots, Some(2));
        assert_eq!(s.max_capacity_bytes, Some(64 << 30));
        assert_eq!(s.modules.len(), 1);
        let m = &s.modules[0];
        assert_eq!(m.locator.as_deref(), Some("DIMM_A1"));
        assert_eq!(m.size_bytes, Some(16 << 30));
        assert_eq!(m.speed_mts, Some(5600));
        assert_eq!(m.kind.as_deref(), Some("DDR5"));
        assert_eq!(m.manufacturer.as_deref(), Some("Kingston"));
        assert_eq!(m.part_number.as_deref(), Some("KF556C40-16"));
    }

    #[test]
    fn smbios_short_structures_and_extended_size() {
        // A 2.1-era type 17 (21 bytes) with a size in KB, no speed fields;
        // a type 16 with a plain capacity in KB and use "flash" (not
        // system memory), which is counted only because nothing else is.
        let mut f17 = vec![0u8; 0x15 - 4];
        f17[0x0C - 4..0x0E - 4].copy_from_slice(&(0x8000u16 | 512).to_le_bytes());
        f17[0x12 - 4] = 0x18;
        let mut f16 = vec![3, 4, 3];
        f16.extend_from_slice(&(8u32 << 20).to_le_bytes());
        f16.extend_from_slice(&0xFFFEu16.to_le_bytes());
        f16.extend_from_slice(&4u16.to_le_bytes());
        let mut table = structure(16, 1, &f16, &[]);
        table.extend(structure(17, 2, &f17, &[]));
        // A 2.7 type 17 that says "see extended size": 32 GiB.
        let mut f17x = vec![0u8; 0x22 - 4];
        f17x[0x0C - 4..0x0E - 4].copy_from_slice(&0x7FFFu16.to_le_bytes());
        f17x[0x1C - 4..0x20 - 4].copy_from_slice(&(32 * 1024u32).to_le_bytes());
        table.extend(structure(17, 3, &f17x, &[]));
        let s = parse_smbios(&table);
        assert_eq!(s.form, None);
        assert_eq!(s.slots, Some(4));
        assert_eq!(s.max_capacity_bytes, Some(8 << 30));
        assert_eq!(s.modules.len(), 2);
        assert_eq!(s.modules[0].size_bytes, Some(512 << 10));
        assert_eq!(s.modules[0].speed_mts, None);
        assert_eq!(s.modules[0].kind.as_deref(), Some("DDR3"));
        assert_eq!(s.modules[1].size_bytes, Some(32 << 30));
        // Truncated inside the last string set: what parsed is kept, no
        // panic; truncated inside the last formatted area: that one is
        // dropped.
        assert_eq!(parse_smbios(&table[..table.len() - 1]).modules.len(), 2);
        assert_eq!(parse_smbios(&table[..table.len() - 3]).modules.len(), 1);
        assert_eq!(parse_smbios(&[]), Smbios::default());
        // Firmware that ends a string-less structure with ONE NUL: the
        // next header still lines up.
        let mut lone = structure(16, 1, &f16, &[]);
        lone.pop();
        lone.extend(structure(17, 2, &f17, &[]));
        let s = parse_smbios(&lone);
        assert_eq!(s.slots, Some(4));
        assert_eq!(s.modules.len(), 1);
    }

    #[test]
    fn chassis_and_memory_enums() {
        assert_eq!(chassis_form(3), Some("desktop"));
        assert_eq!(chassis_form(7), Some("tower"));
        assert_eq!(chassis_form(13), Some("all-in-one"));
        assert_eq!(chassis_form(23), Some("server"));
        assert_eq!(chassis_form(31), Some("laptop"));
        assert_eq!(chassis_form(35), Some("mini"));
        assert_eq!(chassis_form(2), None);
        assert_eq!(memory_kind(0x1A), Some("DDR4"));
        assert_eq!(memory_kind(0x23), Some("LPDDR5"));
        assert_eq!(memory_kind(0x02), None);
        assert_eq!(module_size(0xFFFF, None), None);
        assert_eq!(module_size(0x7FFF, None), None);
        assert_eq!(module_speed(Some(0xFFFF), Some(8800)), Some(8800));
        assert_eq!(array_capacity(0x8000_0000, None), None);
    }

    #[test]
    fn drives_from_script_document() {
        let v: Value = serde_json::from_str(
            r#"{
              "disks": [
                {"FriendlyName":"Samsung SSD 990 PRO 2TB","SerialNumber":" S6Z2NJ0T ","FirmwareVersion":"4B2QJXD7",
                 "Size":2000398934016,"DeviceId":"0","BusType":"NVMe","MediaType":"SSD","HealthStatus":"Healthy"},
                {"FriendlyName":"ST4000DM004","SerialNumber":"","FirmwareVersion":"0001",
                 "Size":4000787030016,"DeviceId":"1","BusType":"11","MediaType":"3","HealthStatus":"Warning"},
                {"FriendlyName":"Flash","DeviceId":"2","BusType":"USB","MediaType":"Unspecified","HealthStatus":"Unknown"}
              ],
              "counters": {"DeviceId":"0","Temperature":41,"PowerOnHours":1234,"Wear":3,"ReadErrorsTotal":0,"WriteErrorsTotal":0},
              "partitions": [
                {"DiskNumber":0,"Letter":"C"},{"DiskNumber":0,"Letter":"D"},{"DiskNumber":1,"Letter":"e"}
              ],
              "errors": ["Get-StorageReliabilityCounter|Access denied.\nsecond line"]
            }"#,
        )
        .expect("json");
        let d = parse_drives(&v);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0].name, "Samsung SSD 990 PRO 2TB");
        assert_eq!(d[0].serial.as_deref(), Some("S6Z2NJ0T"));
        assert_eq!(d[0].bus.as_deref(), Some("nvme"));
        assert_eq!(d[0].kind.as_deref(), Some("ssd"));
        assert_eq!(d[0].health.as_deref(), Some("healthy"));
        assert_eq!(d[0].temperature_c, Some(41.0));
        assert_eq!(d[0].power_on_hours, Some(1234));
        assert_eq!(d[0].wear_pct, Some(3.0));
        assert_eq!(d[0].removable, Some(false));
        assert_eq!(d[0].volumes, vec!["C:".to_string(), "D:".to_string()]);
        assert_eq!(d[1].serial, None);
        assert_eq!(d[1].bus.as_deref(), Some("sata"));
        assert_eq!(d[1].kind.as_deref(), Some("hdd"));
        assert_eq!(d[1].health.as_deref(), Some("warning"));
        assert_eq!(d[1].temperature_c, None);
        assert_eq!(d[1].volumes, vec!["E:".to_string()]);
        assert_eq!(d[2].bus.as_deref(), Some("usb"));
        assert_eq!(d[2].kind, None);
        assert_eq!(d[2].health, None);
        assert_eq!(d[2].removable, Some(true));
        assert!(d[2].volumes.is_empty());
        let errs = script_errors(&v, |_| "SMART counters".into());
        assert_eq!(
            errs,
            vec![
                "SMART counters: Get-StorageReliabilityCounter refused: Access denied.".to_string()
            ]
        );
    }

    #[test]
    fn updates_from_script_document() {
        let v: Value = serde_json::from_str(
            r#"{
              "pending": {"title":"2025-09 Cumulative Update  (KB5043076)","kb":"5043076","size":734003200,"severity":"Important","restart":true},
              "installed": [
                {"id":"KB5041585","description":"Security Update","at":"2025-08-14"},
                {"id":"KB5039895","description":null,"at":"2025-07-10"}
              ],
              "errors": []
            }"#,
        )
        .expect("json");
        let u = parse_updates(&v);
        assert_eq!(u.pending.len(), 1);
        assert_eq!(u.pending[0].title, "2025-09 Cumulative Update (KB5043076)");
        assert_eq!(u.pending[0].id.as_deref(), Some("KB5043076"));
        assert_eq!(u.pending[0].size_bytes, Some(734_003_200));
        assert_eq!(u.pending[0].severity.as_deref(), Some("important"));
        assert_eq!(u.pending[0].restart, Some(true));
        assert_eq!(u.installed.len(), 2);
        assert_eq!(u.installed[0].title, "KB5041585 Security Update");
        assert_eq!(u.installed[0].at.as_deref(), Some("2025-08-14"));
        assert_eq!(u.installed[1].title, "KB5039895");
        assert_eq!(u.error, None);
        let failed: Value =
            serde_json::from_str(r#"{"pending":[],"installed":[],"errors":["search|0x80240438"]}"#)
                .expect("json");
        let u = parse_updates(&failed);
        assert!(u.pending.is_empty());
        assert_eq!(
            u.error.as_deref(),
            Some("Windows Update search: search refused: 0x80240438")
        );
    }
}
