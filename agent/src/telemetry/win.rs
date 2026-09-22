//! The Windows collector: registry and Win32 only, nothing that shells out
//! and no WMI, so a sample costs microseconds and never blocks on a
//! provider.
//!
//! What comes from where:
//! - machine and firmware: `HKLM\HARDWARE\DESCRIPTION\System\BIOS`, the
//!   SMBIOS fields the kernel copies there at boot;
//! - kernel build and install date: `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`;
//! - processor: `CentralProcessor\0` for the name and MHz,
//!   `GetLogicalProcessorInformationEx` for cores, `GetSystemInfo` for threads,
//!   `GetSystemTimes` deltas for usage;
//! - GPUs: the display class registry keys (name, driver, VRAM) and the
//!   PDH "GPU Engine" / "GPU Adapter Memory" counters for usage;
//! - memory: `GlobalMemoryStatusEx`; disks: `GetLogicalDrives` and friends,
//!   plus one storage IOCTL per drive for the media kind;
//! - network: `GetIfTable2` counters, rated against the previous sample;
//! - battery: `GetSystemPowerStatus`.
//!
//! Temperatures and GPU power are not readable without vendor tools
//! (NVAPI, ADL, or the WMI thermal zone that most consumer firmware leaves
//! empty), so they stay `None` with a line in `errors` saying so.

use std::collections::HashMap;
use std::time::Instant;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIfTable2, IF_TYPE_ETHERNET_CSMACD, IF_TYPE_IEEE80211, MIB_IF_TABLE2,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
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
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_ANY, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
use windows::Win32::System::SystemInformation::{
    GetLogicalProcessorInformationEx, GetSystemInfo, GlobalMemoryStatusEx, RelationProcessorCore,
    MEMORYSTATUSEX, SYSTEM_INFO,
};
use windows::Win32::System::Threading::GetSystemTimes;
use windows::Win32::System::IO::DeviceIoControl;

use super::{
    Battery, Collect, Cpu, Disk, Gpu, GpuSample, Machine, Memory, Network, Os, Sample, Static,
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

const NO_TEMPERATURES: &str = "temperatures are not readable on Windows without vendor tools";
const NO_GPU_TEMPERATURE: &str = "GPU temperature is not readable without vendor tools";

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

/// Swap totals from `GlobalMemoryStatusEx`'s commit figures. The page
/// file is the commit limit beyond physical memory; "used" is the commit
/// charge beyond what is physically in use, which is a proxy — commit and
/// physical use are different books, so a negative difference is clamped
/// to 0 — and both are None when the limit is below physical memory,
/// which cannot describe a real page file.
fn swap_from(
    total_phys: u64,
    avail_phys: u64,
    total_pagefile: u64,
    avail_pagefile: u64,
) -> (Option<u64>, Option<u64>) {
    if total_pagefile < total_phys || avail_pagefile > total_pagefile {
        return (None, None);
    }
    let swap_total = total_pagefile - total_phys;
    let phys_used = total_phys.saturating_sub(avail_phys);
    let committed = total_pagefile - avail_pagefile;
    let swap_used = committed.saturating_sub(phys_used).min(swap_total);
    (Some(swap_total), Some(swap_used))
}

/// Bytes per second from two counter readings, or None when the counter
/// went backwards (adapter reset) or no time passed.
fn rate(prev: u64, cur: u64, secs: f64) -> Option<f64> {
    if cur < prev || secs <= 0.0 {
        return None;
    }
    Some((cur - prev) as f64 / secs)
}

fn filetime_u64(t: FILETIME) -> u64 {
    (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)
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
    prev_at: Option<Instant>,
    pdh: Option<Pdh>,
    /// Set once opening PDH failed, so a failure is reported once and not
    /// retried every 15 s.
    pdh_failed: Option<String>,
    /// How many GPUs the last `read_static` found; `gpu_usage` is indexed
    /// like that list.
    gpu_count: usize,
}

impl Collect for Collector {
    fn read_static(&mut self) -> Static {
        let mut errors = Vec::new();
        let machine = read_machine(&mut errors);
        let os = read_os(&mut errors);
        let cpu = read_cpu(&mut errors);
        let gpus = read_gpus(&mut errors);
        self.gpu_count = gpus.len();
        Static {
            machine,
            os,
            cpu,
            gpus,
            errors,
        }
    }

    fn sample(&mut self) -> Sample {
        let mut errors = Vec::new();
        let now = Instant::now();
        let elapsed = self.prev_at.map(|t| now.duration_since(t).as_secs_f64());
        self.prev_at = Some(now);

        let cpu_usage_pct = self.sample_cpu(&mut errors);
        let memory = read_memory(&mut errors);
        let disks = read_disks(&mut errors);
        let gpu_usage = self.sample_gpus(&mut errors);
        let network = self.sample_network(elapsed, &mut errors);
        let battery = read_battery();
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
            Ok(v) => out[0].usage_pct = Some(v.clamp(0.0, 100.0)),
            Err(rc) => errors.push(format!("GPU usage counter not read: PDH {rc:#010x}")),
        }
        match Pdh::sum(pdh.vram) {
            Ok(v) if v >= 0.0 => out[0].vram_used_bytes = Some(v as u64),
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
    let (swap_total_bytes, swap_used_bytes) = swap_from(
        m.ullTotalPhys,
        m.ullAvailPhys,
        m.ullTotalPageFile,
        m.ullAvailPageFile,
    );
    Memory {
        total_bytes: Some(m.ullTotalPhys),
        used_bytes: Some(m.ullTotalPhys.saturating_sub(m.ullAvailPhys)),
        available_bytes: Some(m.ullAvailPhys),
        swap_total_bytes,
        swap_used_bytes,
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
    fn swap_from_commit_figures() {
        // 16 GiB physical, 12 GiB free, 24 GiB commit limit, 15 GiB free commit.
        let g = 1u64 << 30;
        let (total, used) = swap_from(16 * g, 12 * g, 24 * g, 15 * g);
        assert_eq!(total, Some(8 * g));
        assert_eq!(used, Some(5 * g));
        // Commit below physical use: nothing paged out.
        assert_eq!(swap_from(16 * g, 4 * g, 24 * g, 20 * g).1, Some(0));
        // No page file at all.
        assert_eq!(swap_from(16 * g, 4 * g, 16 * g, 8 * g), (Some(0), Some(0)));
        // A limit below physical memory describes nothing.
        assert_eq!(swap_from(16 * g, 4 * g, 8 * g, 4 * g), (None, None));
    }

    #[test]
    fn rate_handles_resets_and_zero_time() {
        assert_eq!(rate(100, 400, 15.0), Some(20.0));
        assert_eq!(rate(400, 100, 15.0), None);
        assert_eq!(rate(100, 400, 0.0), None);
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
}
