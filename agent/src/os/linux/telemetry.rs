//! The Linux collector. The kernel's own files do nearly all the reading —
//! `/proc` and `/sys` — so the sample every 15 s never starts a process;
//! the few tools run only in the slow and updates tiers, each with a
//! deadline (exec.rs).
//!
//! The four cadences telemetry.rs lays out, and what each reads here:
//!
//! - STATIC (hourly): `/sys/class/dmi/id` for make, model, firmware and
//!   board (the device tree's model on ARM boards without DMI); the raw
//!   SMBIOS table `/sys/firmware/dmi/tables/DMI` through the shared parser
//!   for the memory modules, slots and chassis — root's to read, which the
//!   service is; `/proc/cpuinfo` and sysfs topology and cpufreq for the
//!   processor; `uname` and os-release for the OS; `/sys/class/drm` for
//!   the GPUs, named from `pci.ids` where the machine has it, and
//!   `nvidia-smi` for an NVIDIA card's name, driver and VRAM (hardware.rs).
//! - SLOW (every ten minutes): `/sys/block` for the physical drives and
//!   `smartctl -j -a` for their health, as root and where smartmontools is
//!   installed (drives.rs); `systemctl` for the services that failed; the
//!   Chromium browsers by their binaries and flatpaks, and the installed
//!   applications — the desktop entries with the system package manager
//!   that owns each, the flatpaks and the snaps (software.rs).
//! - SAMPLED (every 15 s): `/proc/stat` deltas for the processor,
//!   `/proc/loadavg`, `/proc/meminfo`, `/proc/self/mountinfo` + `statvfs`
//!   for the volumes, `/sys/class/net/*/statistics`, hwmon (thermal zones
//!   when there is none) for temperatures and a GPU's power, amdgpu's
//!   `gpu_busy_percent` and VRAM counters, `/sys/class/power_supply`, and
//!   `/proc/<pid>/stat` for the heaviest processes (below).
//! - UPDATES (hourly, on its own thread): apt, dnf or pacman without a
//!   network refresh, their install logs, and whether a reboot is pending
//!   — Debian's flag file, or NixOS's booted generation against the
//!   current one (updates.rs).
//!
//! What cannot be read is `None` with a one-line reason in `errors`; the
//! parsers are OS-neutral, under telemetry/parse/linux_{sys,tools}.rs.

mod drives;
mod hardware;
mod software;
mod updates;

pub use updates::read_updates;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use super::{read, read_line};
use crate::exec;
use crate::telemetry::parse::linux_sys::{self, CpuTimes};
use crate::telemetry::{
    tidy_apps, Collect, Disk, GpuSample, Memory, Network, Process, Sample, Slow, Static,
    Temperature, TOP_PROCESSES,
};

/// A tool's stdout, or why not: "not installed" when it is not on this
/// machine, else exec's reason.
fn tool(name: &str, args: &[&str], deadline: Duration) -> Result<String, String> {
    let path = exec::locate(name).ok_or_else(|| format!("{name} is not installed"))?;
    let mut cmd = Command::new(path);
    cmd.args(args).env("LC_ALL", "C");
    exec::stdout_or(cmd, deadline, exec::Text::Lossy).map_err(|e| format!("{name}: {e}"))
}

/// The same, with the exit code kept: for tools that answer with it.
fn tool_any(name: &str, args: &[&str], deadline: Duration) -> Result<(i32, String), String> {
    let path = exec::locate(name).ok_or_else(|| format!("{name} is not installed"))?;
    let mut cmd = Command::new(path);
    cmd.args(args).env("LC_ALL", "C");
    exec::stdout_any(cmd, deadline, exec::Text::Lossy).map_err(|e| format!("{name}: {e}"))
}

fn is_root() -> bool {
    // SAFETY: no arguments.
    unsafe { libc::geteuid() == 0 }
}

/// What the collector keeps between samples.
#[derive(Default)]
pub struct Collector {
    prev_cpu: Option<CpuTimes>,
    /// Per interface: rx bytes, tx bytes, when read.
    prev_net: HashMap<String, (u64, u64, Instant)>,
    /// Per pid: CPU ticks and when read.
    prev_procs: HashMap<u32, (u64, Instant)>,
    /// The GPUs' sysfs device directories, in `Static::gpus` order.
    gpu_devices: Vec<PathBuf>,
    /// Block device "major:minor" → "nvme" | "ssd" | "hdd", learnt once.
    disk_kinds: HashMap<String, Option<String>>,
}

impl Collect for Collector {
    fn read_static(&mut self) -> Static {
        let (s, devices) = hardware::read_static();
        self.gpu_devices = devices;
        s
    }

    fn read_slow(&mut self) -> Slow {
        let mut w = Slow::default();
        let (drives, errors) = drives::read_drives();
        w.drives = drives;
        w.errors.extend(errors);
        software::read_services(&mut w);
        let flatpaks = software::read_flatpaks(&mut w.errors);
        let (browsers, errors) = software::read_browsers(&flatpaks);
        w.browsers = browsers;
        w.errors.extend(errors);
        let (apps, errors) = software::read_apps(flatpaks);
        w.apps = tidy_apps(apps);
        w.errors.extend(errors);
        w
    }

    fn sample(&mut self) -> Sample {
        let mut s = Sample::default();
        self.sample_cpu(&mut s);
        sample_memory(&mut s);
        self.sample_disks(&mut s);
        self.sample_network(&mut s);
        self.sample_sensors(&mut s);
        sample_battery(&mut s);
        self.sample_processes(&mut s);
        s
    }
}

impl Collector {
    fn sample_cpu(&mut self, s: &mut Sample) {
        match read("/proc/stat").and_then(|t| linux_sys::proc_stat_cpu(&t)) {
            Some(now) => {
                s.cpu_usage_pct = self.prev_cpu.and_then(|p| linux_sys::cpu_busy_pct(p, now));
                self.prev_cpu = Some(now);
            }
            None => s.errors.push("/proc/stat is not readable".into()),
        }
        s.load = read("/proc/loadavg").and_then(|t| linux_sys::loadavg(&t));
    }

    /// Every real file system, one per device, with `statvfs`'s numbers.
    fn sample_disks(&mut self, s: &mut Sample) {
        let Some(text) = read("/proc/self/mountinfo") else {
            s.errors.push("/proc/self/mountinfo is not readable".into());
            return;
        };
        for m in linux_sys::volumes(&linux_sys::mountinfo(&text)) {
            let Some((total, free, avail)) = statvfs(&m.mount_point) else {
                continue;
            };
            let kind = self
                .disk_kinds
                .entry(m.dev.clone())
                .or_insert_with(|| block_kind(&m.dev))
                .clone();
            s.disks.push(Disk {
                mount: m.mount_point.clone(),
                name: None,
                fs: Some(m.fs.clone()),
                total_bytes: Some(total),
                used_bytes: Some(total.saturating_sub(free)),
                free_bytes: Some(avail),
                kind,
            });
        }
    }

    /// Physical interfaces (those with a `device`) and the default route's,
    /// with byte counters and rates since the previous sample.
    fn sample_network(&mut self, s: &mut Sample) {
        let primary = read("/proc/net/route").and_then(|t| linux_sys::default_route_iface(&t));
        let Ok(dir) = std::fs::read_dir("/sys/class/net") else {
            s.errors.push("/sys/class/net is not readable".into());
            return;
        };
        let mut names: Vec<String> = dir
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| {
                primary.as_deref() == Some(n.as_str())
                    || Path::new("/sys/class/net").join(n).join("device").exists()
            })
            .collect();
        names.sort();
        let now = Instant::now();
        for name in names {
            let stat = |f: &str| {
                read_line(format!("/sys/class/net/{name}/statistics/{f}"))
                    .and_then(|v| v.parse::<u64>().ok())
            };
            let (Some(rx), Some(tx)) = (stat("rx_bytes"), stat("tx_bytes")) else {
                continue;
            };
            let (rx_bps, tx_bps) = match self.prev_net.get(&name) {
                Some((prx, ptx, at)) if rx >= *prx && tx >= *ptx => {
                    let secs = now.duration_since(*at).as_secs_f64();
                    if secs > 0.0 {
                        (
                            Some((rx - prx) as f64 / secs),
                            Some((tx - ptx) as f64 / secs),
                        )
                    } else {
                        (None, None)
                    }
                }
                _ => (None, None),
            };
            self.prev_net.insert(name.clone(), (rx, tx, now));
            s.network.push(Network {
                interface: name,
                rx_bytes: Some(rx),
                tx_bytes: Some(tx),
                rx_bps,
                tx_bps,
            });
        }
    }

    /// hwmon's temperatures (the thermal zones where there is no hwmon),
    /// the processor's package reading, and each GPU's usage, VRAM,
    /// temperature and power from its own device directory.
    fn sample_sensors(&mut self, s: &mut Sample) {
        let mut gpu = vec![GpuSample::default(); self.gpu_devices.len()];
        let gpu_dirs: Vec<Option<PathBuf>> = self
            .gpu_devices
            .iter()
            .map(|d| std::fs::canonicalize(d).ok())
            .collect();
        for (i, dev) in self.gpu_devices.iter().enumerate() {
            let n = |f: &str| read_line(dev.join(f)).and_then(|v| v.parse::<u64>().ok());
            gpu[i].usage_pct = n("gpu_busy_percent").map(|p| p as f64);
            gpu[i].vram_used_bytes = n("mem_info_vram_used");
        }
        if let Ok(dir) = std::fs::read_dir("/sys/class/hwmon") {
            let mut hwmons: Vec<PathBuf> = dir.flatten().map(|e| e.path()).collect();
            hwmons.sort();
            for h in hwmons {
                let chip = read_line(h.join("name")).unwrap_or_default();
                let owner = std::fs::canonicalize(h.join("device")).ok();
                let gpu_index = owner
                    .as_ref()
                    .and_then(|o| gpu_dirs.iter().position(|g| g.as_ref() == Some(o)));
                for (label, celsius) in hwmon_temps(&h) {
                    if let Some(g) = gpu_index {
                        gpu[g].temperature_c.get_or_insert(celsius);
                    }
                    if s.cpu_temperature_c.is_none()
                        && linux_sys::is_cpu_package(&chip, label.as_deref())
                    {
                        s.cpu_temperature_c = Some(celsius);
                    }
                    s.temperatures.push(Temperature {
                        label: linux_sys::hwmon_label(&chip, label.as_deref()),
                        celsius,
                    });
                }
                if let Some(g) = gpu_index {
                    let micro = read_line(h.join("power1_average"))
                        .or_else(|| read_line(h.join("power1_input")))
                        .and_then(|v| v.parse::<f64>().ok());
                    gpu[g].power_w = micro.map(|uw| uw / 1_000_000.0);
                }
            }
        }
        if s.temperatures.is_empty() {
            s.temperatures = thermal_zones();
            if s.cpu_temperature_c.is_none() {
                s.cpu_temperature_c = s
                    .temperatures
                    .iter()
                    .find(|t| t.label.contains("cpu") || t.label.contains("x86_pkg"))
                    .map(|t| t.celsius);
            }
        }
        if s.temperatures.is_empty() {
            s.errors
                .push("no temperature sensor is exposed (hwmon, thermal zones)".into());
        }
        s.gpu_usage = gpu;
    }

    /// The heaviest processes by resident memory, with CPU since the
    /// previous sample; the count of every process.
    fn sample_processes(&mut self, s: &mut Sample) {
        let Ok(dir) = std::fs::read_dir("/proc") else {
            s.errors.push("/proc is not readable".into());
            return;
        };
        // SAFETY: sysconf with constant names.
        let (tick, page) = unsafe {
            (
                libc::sysconf(libc::_SC_CLK_TCK).max(1) as f64,
                libc::sysconf(libc::_SC_PAGESIZE).max(1) as u64,
            )
        };
        let now = Instant::now();
        let mut seen: HashMap<u32, (u64, Instant)> = HashMap::new();
        let mut all: Vec<Process> = Vec::new();
        for e in dir.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
                continue;
            };
            let Some(st) = read(e.path().join("stat")).and_then(|t| linux_sys::pid_stat(&t)) else {
                continue;
            };
            let cpu_pct = self.prev_procs.get(&pid).and_then(|(ticks, at)| {
                let secs = now.duration_since(*at).as_secs_f64();
                (secs > 0.0 && st.ticks >= *ticks)
                    .then(|| 100.0 * (st.ticks - ticks) as f64 / tick / secs)
            });
            seen.insert(pid, (st.ticks, now));
            all.push(Process {
                name: st.comm,
                pid,
                memory_bytes: Some(st.rss_pages * page),
                cpu_pct,
            });
        }
        self.prev_procs = seen;
        s.process_count = Some(all.len() as u32);
        all.sort_by_key(|p| std::cmp::Reverse(p.memory_bytes));
        all.truncate(TOP_PROCESSES);
        s.processes = all;
    }
}

fn sample_memory(s: &mut Sample) {
    let Some(m) = read("/proc/meminfo").map(|t| linux_sys::meminfo(&t)) else {
        s.errors.push("/proc/meminfo is not readable".into());
        return;
    };
    let g = |k: &str| m.get(k).copied();
    let total = g("MemTotal");
    let available = g("MemAvailable");
    s.memory = Memory {
        total_bytes: total,
        used_bytes: total.zip(available).map(|(t, a)| t.saturating_sub(a)),
        available_bytes: available,
        cached_bytes: g("Cached").map(|c| c + g("SReclaimable").unwrap_or(0)),
        compressed_bytes: None,
        committed_bytes: g("Committed_AS"),
        commit_limit_bytes: g("CommitLimit"),
        swap_total_bytes: g("SwapTotal"),
        swap_used_bytes: g("SwapTotal")
            .zip(g("SwapFree"))
            .map(|(t, f)| t.saturating_sub(f)),
        ..Default::default()
    };
}

/// The first battery that is the machine's own.
fn sample_battery(s: &mut Sample) {
    let Ok(dir) = std::fs::read_dir("/sys/class/power_supply") else {
        return;
    };
    let mut supplies: Vec<PathBuf> = dir.flatten().map(|e| e.path()).collect();
    supplies.sort();
    s.battery = supplies
        .iter()
        .find_map(|p| read(p.join("uevent")).and_then(|t| linux_sys::battery_uevent(&t)));
}

/// Total, free (root's) and available bytes of a mounted file system.
fn statvfs(mount: &str) -> Option<(u64, u64, u64)> {
    let c = std::ffi::CString::new(mount).ok()?;
    // SAFETY: a zeroed out-struct and a NUL-terminated path.
    let mut v: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut v) } != 0 {
        return None;
    }
    let f = v.f_frsize as u64;
    let total = v.f_blocks as u64 * f;
    (total > 0).then(|| (total, v.f_bfree as u64 * f, v.f_bavail as u64 * f))
}

/// The kind of the disk under a "major:minor": nvme, ssd or hdd, from the
/// whole disk's queue (a partition has none of its own). None for a file
/// system with no block device of its own (ZFS, btrfs over several).
fn block_kind(dev: &str) -> Option<String> {
    let mut p = std::fs::canonicalize(format!("/sys/dev/block/{dev}")).ok()?;
    if p.join("partition").exists() {
        p = p.parent()?.to_path_buf();
    }
    let name = p.file_name()?.to_string_lossy().into_owned();
    if name.starts_with("nvme") {
        return Some("nvme".into());
    }
    match read_line(p.join("queue/rotational")).as_deref() {
        Some("1") => Some("hdd".into()),
        Some("0") => Some("ssd".into()),
        _ => None,
    }
}

/// One hwmon chip's temperatures: its `temp*_input`s (millidegrees), each
/// with its `temp*_label` when there is one.
fn hwmon_temps(h: &Path) -> Vec<(Option<String>, f64)> {
    let Ok(dir) = std::fs::read_dir(h) else {
        return Vec::new();
    };
    let mut inputs: Vec<String> = dir
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("temp") && n.ends_with("_input"))
        .collect();
    inputs.sort_by_key(|n| {
        n.trim_start_matches("temp")
            .trim_end_matches("_input")
            .parse::<u32>()
            .unwrap_or(0)
    });
    inputs
        .into_iter()
        .filter_map(|input| {
            let milli: f64 = read_line(h.join(&input))?.parse().ok()?;
            let label = read_line(h.join(input.replace("_input", "_label")));
            // A sensor that reads absurd values is absent, not hot.
            let c = milli / 1000.0;
            (c > -40.0 && c < 150.0).then_some((label, c))
        })
        .collect()
}

/// `/sys/class/thermal/thermal_zone*`: type and millidegrees.
fn thermal_zones() -> Vec<Temperature> {
    let Ok(dir) = std::fs::read_dir("/sys/class/thermal") else {
        return Vec::new();
    };
    let mut zones: Vec<PathBuf> = dir
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("thermal_zone"))
        })
        .collect();
    zones.sort();
    zones
        .iter()
        .filter_map(|z| {
            let label = read_line(z.join("type"))?;
            let milli: f64 = read_line(z.join("temp"))?.parse().ok()?;
            let c = milli / 1000.0;
            (c > -40.0 && c < 150.0).then_some(Temperature { label, celsius: c })
        })
        .collect()
}
