//! The Windows collector: registry and Win32 for everything sampled, so a
//! sample costs microseconds and never blocks on a provider. Two tiers are
//! the deliberate exception to "nothing shells out": the ten-minute one
//! runs two hidden PowerShell processes (drives, Store packages) and the
//! hourly one runs one (OS updates), because SMART counters, Store packages
//! and the Windows Update agent have no Win32 surface — only the Storage
//! and Appx cmdlets and the `Microsoft.Update` COM object. Each is killed
//! at its deadline, and that part answers empty with an error line rather
//! than a stale or guessed value.
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
//! - GPUs: the display class registry keys (name, driver, VRAM, and the
//!   marketed driver version from the value AMD writes beside it or
//!   NVIDIA's digit convention) and the PDH "GPU Engine" / "GPU Adapter
//!   Memory" counters for usage;
//! - memory: `GlobalMemoryStatusEx` for the totals, `GetPerformanceInfo`
//!   for the cache and the commit charge, the "Memory Compression"
//!   process's working set for what is held compressed;
//! - volumes: `GetLogicalDrives` and friends, plus one storage IOCTL per
//!   volume for the media kind;
//! - drives: `Get-PhysicalDisk` joined to `Get-StorageReliabilityCounter`
//!   and `Get-Partition`, in the ten-minute PowerShell;
//! - services: `EnumServicesStatusEx`, with `QueryServiceConfig` on each
//!   one down with a failure exit code, to learn whether it was meant to
//!   be running;
//! - browsers: the Chromium family, from the registry's `App Paths` keys
//!   (HKLM, its WOW6432Node twin, and the console user's own hive, where
//!   a per-user Chrome or Brave registers) and the well-known install
//!   directories under Program Files and the user's Local AppData when
//!   the registry names nothing; the version from the exe's own version
//!   resource (`GetFileVersionInfo`), or the `NNN.N.NNNN.NNN` directory
//!   Chromium keeps beside it; whether one is running from a Toolhelp
//!   snapshot of its own (`processes`); the default browser from the
//!   console user's `UrlAssociations\http\UserChoice`. The console user is
//!   the session token the service may take as LocalSystem
//!   (`WTSQueryUserToken`), or failing that the loaded `HKEY_USERS` hive
//!   with a `Volatile Environment`;
//! - apps: the Uninstall keys (HKLM, its 32-bit view, the console user's
//!   hive), the Epic launcher's manifests under ProgramData, and the Store
//!   packages through `Get-AppxPackage` in the second ten-minute
//!   PowerShell, with a deadline of its own;
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
//!
//! Where each part lives: `hardware` (machine, OS, processor, GPUs,
//! memory, volumes, battery), `smbios` (the raw firmware table),
//! `registry` (the value readers everything else uses), `powershell` (the
//! bounded shell-out and its JSON helpers), `drives` and `updates` (the
//! two PowerShell tiers), `pdh` (the GPU counters), `processes`,
//! `services`, `browsers` and `apps`. This file keeps the collector and
//! the drives' and updates' deadlines (the Store's is in `apps`).

mod apps;
mod browsers;
mod drives;
mod hardware;
mod pdh;
mod powershell;
mod processes;
mod registry;
mod services;
mod smbios;
mod updates;

pub use updates::read_updates;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::FILETIME;
use windows::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIfTable2, IF_TYPE_ETHERNET_CSMACD, IF_TYPE_IEEE80211, MIB_IF_TABLE2,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::System::Threading::GetSystemTimes;

use super::{Collect, GpuSample, Network, Process, Sample, Slow, Static, TOP_PROCESSES};

use apps::read_apps;
use browsers::read_browsers;
use drives::{parse_drives, DRIVES_SCRIPT};
use hardware::{
    cpu_usage, read_battery, read_cpu, read_disks, read_gpus, read_machine, read_memory, read_os,
    CpuTimes,
};
use pdh::Pdh;
use powershell::{powershell_json, script_errors};
use processes::{process_cpu, process_snapshot, process_usage};
use services::read_services;
use smbios::{read_smbios, Smbios};

/// How long the drives PowerShell may take before it is killed.
const SLOW_DEADLINE: Duration = Duration::from_secs(60);
/// How long the Windows Update search may take before it is killed.
const UPDATES_DEADLINE: Duration = Duration::from_secs(120);

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
        // Registry and file stats only; a machine with no Chromium browser
        // answers with an empty list and nothing in `errors`.
        let browsers = read_browsers(&mut errors);
        // Registry, the Epic manifests, and one bounded PowerShell for the
        // Store; a machine that installed nothing answers with an empty list.
        let apps = read_apps(&mut errors);
        Slow {
            drives,
            services,
            service_count,
            browsers,
            apps,
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
        // Machine-wide totals, on `gpu_main` (see `read_static`); the rest
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn names_and_placeholders() {
        assert_eq!(meaningful("  To Be Filled By O.E.M. "), None);
        assert_eq!(meaningful("Unknown"), None);
        assert_eq!(meaningful(" Kingston  "), Some("Kingston".into()));
    }
}
