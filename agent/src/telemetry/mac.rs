//! The macOS collector. Apple's own tools do the reading — `system_profiler`
//! for the hardware, the GPUs, the memory modules and the physical drives,
//! `sysctl`, `vm_stat`, `df`, `mount`, `diskutil`, `netstat`, `pmset`,
//! `ioreg`, `ps`, `launchctl`, `softwareupdate`, `plutil`, `stat`, `dscl`,
//! and `powermetrics` (root only, which the launchd daemon is) for power
//! and, on Intel, die temperatures — plus two Mach calls for the CPU ticks
//! and the load averages. Every command runs with a closed stdin and a
//! deadline, so a wedged tool costs one sample, not the telemetry thread.
//!
//! The four cadences telemetry.rs lays out, and what each reads here:
//!
//! - STATIC (hourly): `SPHardwareDataType` for make, model and firmware,
//!   `SPDisplaysDataType` for the GPUs, `SPMemoryDataType` for the memory
//!   modules, `sysctl` for the processor, `uname` and `sw_vers` for the OS.
//! - SLOW (every ten minutes): `SPNVMeDataType`, `SPSerialATADataType` and
//!   `SPUSBDataType` in one call for the physical drives, `diskutil info /`
//!   to tell which of them carries the boot volume, `launchctl list` for
//!   the system-domain jobs whose last exit was not clean, and the Chromium
//!   browsers: the known bundles under `/Applications` and the console
//!   user's `~/Applications` (`stat -f %Su /dev/console` says who that is,
//!   `dscl` where their home is), each one's `Info.plist` through `plutil`
//!   for the version and bundle id, `ps` for which of them has a process
//!   alive, and the user's LaunchServices handler list (`plutil` again; it
//!   is binary on disk) for which one opens `http`.
//! - SAMPLED (every 15 s): the Mach calls, `vm_stat`, `df` + `mount`,
//!   `ioreg` for the GPU, `powermetrics`, `netstat`, `pmset`, and `ps` for
//!   the heaviest processes.
//! - UPDATES (hourly, on its own thread): `softwareupdate -l` for what is
//!   pending and the install-history plist for what was installed.
//!
//! The parsers take text and are unit-tested on any OS; the functions that
//! run commands are thin and untested here. Anything that cannot be read is
//! `None` with a one-line reason in `errors`. Nothing identifying is copied
//! beyond what the contract asks for: `system_profiler` prints the serial
//! number and the hardware UUID and both are left where they are; a drive's
//! serial is carried, and the open page strips it.
//!
//! Where each part lives: `run` (running a command with a deadline, and
//! the few direct kernel calls), `profiler` (the `system_profiler`
//! parsers: hardware, memory, displays, storage, battery health), `parse`
//! (the parsers for every other tool, and the plist helpers), `updates`,
//! `browsers` and `apps`. This file keeps the collector, its tiers and
//! the deadlines every command runs under.

mod apps;
mod browsers;
mod parse;
mod profiler;
mod run;
mod updates;

pub use updates::read_updates;

use std::collections::HashMap;
use std::process::Command;
use std::time::{Duration, Instant};

use super::{
    Collect, Cpu, GpuSample, Machine, Memory, Network, Os, Sample, Slow, Static, Temperature,
};

use apps::read_apps;
use browsers::{console_home, read_browsers};
use parse::{
    cpu_usage, parse_df, parse_diskutil, parse_ioreg_gpu, parse_launchctl, parse_mount,
    parse_netstat, parse_pmset, parse_powermetrics, parse_ps, parse_swapusage, parse_vm_stat,
    VmStat,
};
use profiler::{
    parse_battery_health, parse_displays, parse_hardware, parse_memory, parse_physical_store,
    parse_storage, BatteryHealth, MemoryProfile,
};
use run::{cpu_ticks, is_apple_silicon, line, load_avg, output_or, run, run_for, sysctl_u64};

/// The fast tools (`sysctl`, `df`, `vm_stat`, `pmset`…) are done in
/// milliseconds; a deadline this long is only for a wedged one.
const QUICK: Duration = Duration::from_secs(10);
/// `system_profiler` walks IOKit; a few seconds on a slow machine.
const PROFILER: Duration = Duration::from_secs(30);
/// `system_profiler SPMemoryDataType` alone is quicker than the display one.
const MEMORY_PROFILER: Duration = Duration::from_secs(15);
/// `system_profiler` over the three storage buses: longer with many drives
/// and a full USB tree, but well short of the ten-minute cadence.
const STORAGE_PROFILER: Duration = Duration::from_secs(20);
/// `ps` over every process: a few hundred milliseconds.
const PS: Duration = Duration::from_secs(5);
/// `softwareupdate -l` without `--no-scan` asks Apple's servers; a minute
/// is not unusual.
const SOFTWAREUPDATE: Duration = Duration::from_secs(90);
/// `powermetrics -n 1 -i 500` returns in about half a second.
const POWERMETRICS: Duration = Duration::from_secs(4);
/// `plutil` over one plist — a bundle's Info.plist, the LaunchServices
/// handler list — is milliseconds; the deadline is for a wedged one.
const PLIST: Duration = Duration::from_secs(5);
/// `stat` on /dev/console and `dscl` for a home directory: instant.
const CONSOLE_USER: Duration = Duration::from_secs(3);

/// Where applications install for everyone; the console user's own is
/// `~/Applications`.
const APPLICATIONS: &str = "/Applications";

/// Battery health and the root volume's name are read once per this many
/// samples (a hundred at 15 s is 25 minutes); both are static-ish and
/// `system_profiler`/`diskutil` are not free.
const SLOW_EVERY: u32 = 100;

/// What the collector keeps between samples.
#[derive(Default)]
pub struct Collector {
    /// user, system, idle, nice ticks at the previous sample.
    prev_ticks: Option<[u32; 4]>,
    /// Per interface: rx bytes, tx bytes, when read.
    prev_net: HashMap<String, (u64, u64, Instant)>,
    /// Samples since the slow facts were last read; `None` means never.
    slow_age: Option<u32>,
    battery_health: Option<BatteryHealth>,
    /// The root volume's name and kind, from `diskutil info /`.
    root_volume: (Option<String>, Option<String>),
}

// ── the collector ───────────────────────────────────────────────────────────

impl Collect for Collector {
    fn read_static(&mut self) -> Static {
        let mut errors = Vec::new();

        let mut machine = run_for(
            "system_profiler",
            &["SPHardwareDataType", "-json"],
            PROFILER,
        )
        .and_then(|j| parse_hardware(&j))
        .unwrap_or_else(|| {
            errors.push("system_profiler SPHardwareDataType gave nothing usable".into());
            Machine {
                manufacturer: Some("Apple".into()),
                ..Default::default()
            }
        });
        // The board target Apple's catalogue names machines by ("J516sAP");
        // a sysctl Apple Silicon and the last Intel Macs both answer.
        machine.target = line("sysctl", &["-n", "hw.target"]);

        // Setup Assistant marks its completion with this file; macOS keeps no
        // other install date (the receipts under /var/db/receipts are per
        // package, and `sw_vers` has none). Its mtime is when the machine was
        // set up — an in-place upgrade keeps it, as it should.
        let installed_at = std::fs::metadata("/var/db/.AppleSetupDone")
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| std::time::SystemTime::now().duration_since(t).ok())
            .map(|ago| crate::state::rfc3339_ago(ago.as_secs()));
        let os = Os {
            kernel: line("uname", &["-r"]),
            build: line("sw_vers", &["--buildVersion"]),
            installed_at,
        };

        let cpu = Cpu {
            model: line("sysctl", &["-n", "machdep.cpu.brand_string"]),
            cores: sysctl_u64("hw.physicalcpu").and_then(|n| u32::try_from(n).ok()),
            threads: sysctl_u64("hw.logicalcpu").and_then(|n| u32::try_from(n).ok()),
            // Intel states it; Apple Silicon has no such sysctl.
            frequency_mhz: sysctl_u64("hw.cpufrequency").map(|hz| hz / 1_000_000),
            ..Default::default()
        };
        if cpu.model.is_none() {
            errors.push("machdep.cpu.brand_string is not readable".into());
        }

        let gpus = match run_for(
            "system_profiler",
            &["SPDisplaysDataType", "-json"],
            PROFILER,
        ) {
            Some(j) => parse_displays(&j),
            None => {
                errors.push("system_profiler SPDisplaysDataType failed".into());
                Vec::new()
            }
        };

        // The memory modules; the fitted total is hw.memsize, which the
        // sample reads too.
        let memory = run_for(
            "system_profiler",
            &["SPMemoryDataType", "-json"],
            MEMORY_PROFILER,
        )
        .and_then(|j| parse_memory(&j, sysctl_u64("hw.memsize")))
        .unwrap_or_else(|| {
            errors.push("system_profiler SPMemoryDataType gave nothing usable".into());
            MemoryProfile::default()
        });

        Static {
            machine,
            os,
            cpu,
            gpus,
            memory_slots: memory.slots,
            memory_max_capacity_bytes: memory.max_capacity_bytes,
            memory_modules: memory.modules,
            errors,
        }
    }

    fn read_slow(&mut self) -> Slow {
        let mut w = Slow::default();

        // Drives: the three buses in one call, and which one boots.
        let boot_store = run("diskutil", &["info", "/"]).and_then(|t| parse_physical_store(&t));
        let mut profiler = Command::new("system_profiler");
        profiler.args([
            "SPNVMeDataType",
            "SPSerialATADataType",
            "SPUSBDataType",
            "-json",
        ]);
        match output_or(profiler, STORAGE_PROFILER) {
            Ok(j) => {
                w.drives = parse_storage(&j, boot_store.as_deref());
                if w.drives.is_empty() {
                    w.errors
                        .push("system_profiler lists no drive on NVMe, SATA or USB".into());
                } else {
                    w.errors
                        .push("drive SMART counters: not readable without smartmontools".into());
                }
            }
            Err(e) => w
                .errors
                .push(format!("system_profiler storage types failed ({e})")),
        }

        // Services: the system domain, since the daemon is root.
        match run("launchctl", &["list"]) {
            Some(t) => {
                let (down, count) = parse_launchctl(&t);
                w.services = down;
                w.service_count = Some(count);
            }
            None => w.errors.push("launchctl list failed".into()),
        }

        // Browsers: the Chromium bundles, for the console user where there
        // is one (their own Applications folder and their default browser).
        let home = console_home();
        let (browsers, errors) = read_browsers(home.as_deref());
        w.browsers = browsers;
        w.errors.extend(errors);

        // Everything else installed, from the same folders.
        let (apps, errors) = read_apps(home.as_deref());
        w.apps = apps;
        w.errors.extend(errors);

        w
    }

    fn sample(&mut self) -> Sample {
        let mut s = Sample::default();
        let apple_silicon = is_apple_silicon();

        // Slow, static-ish facts: on the first sample and every SLOW_EVERY after.
        let refresh_slow = self.slow_age.is_none_or(|n| n >= SLOW_EVERY);
        self.slow_age = Some(if refresh_slow {
            0
        } else {
            self.slow_age.unwrap_or(0) + 1
        });

        self.sample_cpu(&mut s);
        self.sample_memory(&mut s);
        self.sample_disks(&mut s, refresh_slow);
        self.sample_gpus(&mut s, apple_silicon);
        self.sample_network(&mut s);
        self.sample_battery(&mut s, refresh_slow);
        self.sample_processes(&mut s);

        s
    }
}

/// The sample's steps, in the order `sample` runs them; each fills its
/// part of the sample and adds its own lines to `errors`.
impl Collector {
    /// CPU: ticks since the previous sample, and the load averages.
    fn sample_cpu(&mut self, s: &mut Sample) {
        match cpu_ticks() {
            Some(now) => {
                s.cpu_usage_pct = self.prev_ticks.and_then(|prev| cpu_usage(prev, now));
                self.prev_ticks = Some(now);
            }
            None => s
                .errors
                .push("host_statistics64 refused HOST_CPU_LOAD_INFO".into()),
        }
        s.load = load_avg();
    }

    fn sample_memory(&mut self, s: &mut Sample) {
        let total = sysctl_u64("hw.memsize");
        let vm = run("vm_stat", &[]).and_then(|t| parse_vm_stat(&t));
        if vm.is_none() {
            s.errors.push("vm_stat gave nothing usable".into());
        }
        let available = vm.as_ref().map(VmStat::available_bytes);
        let swap = line("sysctl", &["-n", "vm.swapusage"]).and_then(|t| parse_swapusage(&t));
        s.memory = Memory {
            total_bytes: total,
            used_bytes: total.zip(available).map(|(t, a)| t.saturating_sub(a)),
            available_bytes: available,
            cached_bytes: vm.as_ref().map(VmStat::cached_bytes),
            compressed_bytes: vm.as_ref().map(VmStat::compressed_bytes),
            // A commit charge is a Windows notion; macOS overcommits.
            committed_bytes: None,
            commit_limit_bytes: None,
            swap_total_bytes: swap.map(|(t, _)| t),
            swap_used_bytes: swap.map(|(_, u)| u),
            // Slots, ceiling and modules are static; `assemble` fills them.
            ..Default::default()
        };
    }

    /// Every local volume from `df`, its file system from `mount`, and the
    /// root volume's name and kind (re-read with the slow facts).
    fn sample_disks(&mut self, s: &mut Sample, refresh_slow: bool) {
        if refresh_slow {
            self.root_volume = run("diskutil", &["info", "/"])
                .map(|t| parse_diskutil(&t))
                .unwrap_or_default();
        }
        match run("df", &["-k", "-P", "-l"]) {
            Some(t) => {
                let types = run("mount", &[])
                    .map(|m| parse_mount(&m))
                    .unwrap_or_default();
                s.disks = parse_df(&t);
                for d in &mut s.disks {
                    d.fs = types.get(&d.mount).cloned();
                    if d.mount == "/" {
                        let (name, kind) = &self.root_volume;
                        d.name = name.clone();
                        d.kind = kind.clone();
                    }
                }
            }
            None => s.errors.push("df failed".into()),
        }
    }

    /// GPU: IOKit's accelerator statistics for the first accelerator, then
    /// `powermetrics` for its power and die temperature — which also gives
    /// the CPU die temperature on Intel.
    fn sample_gpus(&mut self, s: &mut Sample, apple_silicon: bool) {
        let mut gpu = GpuSample::default();
        match run("ioreg", &["-r", "-d", "1", "-c", "IOAccelerator"]) {
            Some(t) => {
                let (usage, used) = parse_ioreg_gpu(&t);
                if usage.is_none() {
                    s.errors
                        .push("the GPU driver reports no Device Utilization %".into());
                }
                gpu.usage_pct = usage;
                gpu.vram_used_bytes = used;
            }
            None => s.errors.push("ioreg -c IOAccelerator failed".into()),
        }

        // powermetrics: power on Apple Silicon, die temperatures on Intel
        // (its smc sampler; Apple Silicon has none and prints no temperature).
        let samplers = if apple_silicon {
            "thermal,cpu_power,gpu_power"
        } else {
            "smc,thermal,cpu_power,gpu_power"
        };
        let mut pm = Command::new("powermetrics");
        pm.args(["--samplers", samplers, "-n", "1", "-i", "500"]);
        match output_or(pm, POWERMETRICS) {
            Ok(t) => {
                let p = parse_powermetrics(&t);
                s.cpu_temperature_c = p.cpu_die_c;
                gpu.temperature_c = p.gpu_die_c;
                gpu.power_w = p.gpu_power_w;
                if let Some(c) = p.cpu_die_c {
                    s.temperatures.push(Temperature {
                        label: "CPU die".into(),
                        celsius: c,
                    });
                }
                if let Some(c) = p.gpu_die_c {
                    s.temperatures.push(Temperature {
                        label: "GPU die".into(),
                        celsius: c,
                    });
                }
                if s.temperatures.is_empty() {
                    s.errors.push(if apple_silicon {
                        "temperatures are not exposed by powermetrics on Apple Silicon".into()
                    } else {
                        "powermetrics printed no die temperature".into()
                    });
                }
            }
            Err(e) => s
                .errors
                .push(format!("powermetrics failed ({e}); it needs root")),
        }
        s.gpu_usage.push(gpu);
    }

    /// Network: the default route's interface plus every en*/bridge* that
    /// is up and has moved bytes.
    fn sample_network(&mut self, s: &mut Sample) {
        let primary = run("route", &["-n", "get", "default"]).and_then(|r| {
            r.lines()
                .find_map(|l| l.trim().strip_prefix("interface:"))
                .map(|s| s.trim().to_string())
        });
        match run("netstat", &["-ib"]) {
            Some(t) => {
                let now = Instant::now();
                for (name, rx, tx) in parse_netstat(&t) {
                    let keep = primary.as_deref() == Some(name.as_str())
                        || ((name.starts_with("en") || name.starts_with("bridge")) && rx + tx > 0);
                    if !keep {
                        continue;
                    }
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
            None => s.errors.push("netstat -ib failed".into()),
        }
    }

    /// Battery: charge from `pmset`, health from `system_profiler` (re-read
    /// with the slow facts and carried between samples).
    fn sample_battery(&mut self, s: &mut Sample, refresh_slow: bool) {
        match run("pmset", &["-g", "batt"]) {
            Some(t) => {
                if let Some(mut b) = parse_pmset(&t) {
                    if refresh_slow {
                        self.battery_health =
                            run_for("system_profiler", &["SPPowerDataType", "-json"], PROFILER)
                                .and_then(|j| parse_battery_health(&j));
                    }
                    if let Some(h) = &self.battery_health {
                        b.health_pct = h.max_capacity_pct;
                        b.cycles = h.cycles;
                        b.condition = h.condition.clone();
                    }
                    s.battery = Some(b);
                }
            }
            None => s.errors.push("pmset -g batt failed".into()),
        }
    }

    /// Processes: the heaviest by resident memory, and the count.
    fn sample_processes(&mut self, s: &mut Sample) {
        let mut ps = Command::new("ps");
        ps.args(["-axo", "pid=,rss=,pcpu=,comm="]);
        match output_or(ps, PS) {
            Ok(t) => {
                let (top, count) = parse_ps(&t);
                s.processes = top;
                s.process_count = Some(count);
            }
            Err(e) => s.errors.push(format!("ps failed ({e})")),
        }
    }
}
