//! What the machine is and how it is doing: the telemetry the status page
//! carries (`telemetry` block of `/status`) and `/metrics` renders for
//! Prometheus.
//!
//! Three cadences, one document. The STATIC facts — make and model,
//! firmware, board, processor model, core counts, kernel, the memory
//! modules — are read once at start and again every hour. The SLOW ones —
//! the physical drives with their health counters, and the services that
//! should be running and are not — every ten minutes, because they cost a
//! shell-out. The SAMPLED ones — processor and GPU usage, memory, volumes,
//! temperatures, network counters, the heaviest processes — every
//! `SAMPLE_EVERY` on a thread of their own. OS updates are a fourth thing:
//! a search that can take a minute and touch the network, run hourly on its
//! own thread and merged in when it lands. Each platform has a `Collector`
//! (win.rs, mac.rs); anything it cannot read is `None` or an empty list,
//! never a guess, and what went wrong is in `errors` so the page can say so.
//!
//! Two views of the document. The OPEN status page carries `public()`:
//! nothing that identifies a person — no serial numbers, no process list, no
//! service list, no pending updates — because the page answers the whole
//! LAN. The box, holding the node token, reads the full document at
//! `GET /telemetry` (status.rs) and draws the same pages it draws for
//! itself.

use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::state::now_rfc3339;
use crate::status::Shared;

/// How often the sampled facts are read.
pub const SAMPLE_EVERY: Duration = Duration::from_secs(15);
/// How often the slow facts (drives, services) are re-read.
pub const SLOW_EVERY: Duration = Duration::from_secs(600);
/// How often the static facts are re-read (a firmware update, a new drive).
pub const STATIC_EVERY: Duration = Duration::from_secs(3600);
/// How often the OS is asked what updates it has pending.
pub const UPDATES_EVERY: Duration = Duration::from_secs(3600);

/// The machine as hardware: what it is, who made it, what firmware it runs.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Machine {
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    /// "Apple M3 Pro" on a Mac; the firmware vendor's name elsewhere is in `bios_vendor`.
    pub chip: Option<String>,
    pub bios_vendor: Option<String>,
    pub bios_version: Option<String>,
    /// As the firmware states it, e.g. "2025-03-11" or "03/11/2025".
    pub bios_date: Option<String>,
    pub board_manufacturer: Option<String>,
    pub board_product: Option<String>,
    /// What shape the machine is: "laptop" | "desktop" | "tower" | "mini" |
    /// "all-in-one" | "server" | "tablet", from the chassis type (SMBIOS type
    /// 3 on Windows, the model name on a Mac). None when not stated.
    pub form: Option<String>,
}

/// The operating system, beyond the name and version facts.rs already carries.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Os {
    /// The kernel: Darwin's `uname -r` on a Mac, the NT build on Windows.
    pub kernel: Option<String>,
    /// The build string the OS shows in its own About box, when distinct.
    pub build: Option<String>,
    /// When the OS was installed, RFC 3339, when known.
    pub installed_at: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Cpu {
    pub model: Option<String>,
    pub cores: Option<u32>,
    pub threads: Option<u32>,
    /// Base or current frequency, whichever the OS states.
    pub frequency_mhz: Option<u64>,
    /// 0–100 across all logical processors, since the previous sample.
    pub usage_pct: Option<f64>,
    /// 1, 5 and 15 minute load averages, where the OS has them (macOS).
    pub load: Option<[f64; 3]>,
    /// Package temperature, where readable.
    pub temperature_c: Option<f64>,
}

/// One stick, as the firmware describes it (SMBIOS type 17; on a Mac the
/// memory is on the package and `system_profiler` describes it as one).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MemoryModule {
    /// The slot's name as the board labels it: "DIMM_A1", "Controller0-ChannelA".
    pub locator: Option<String>,
    pub size_bytes: Option<u64>,
    pub speed_mts: Option<u32>,
    /// "DDR5", "LPDDR5"…
    pub kind: Option<String>,
    pub manufacturer: Option<String>,
    pub part_number: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Memory {
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    /// File cache the OS would drop under pressure: the standby list on
    /// Windows, file-backed pages on a Mac.
    pub cached_bytes: Option<u64>,
    /// Memory held compressed rather than swapped (both OSes do this).
    pub compressed_bytes: Option<u64>,
    /// Windows: the commit charge and its limit (RAM plus pagefile).
    pub committed_bytes: Option<u64>,
    pub commit_limit_bytes: Option<u64>,
    pub swap_total_bytes: Option<u64>,
    pub swap_used_bytes: Option<u64>,
    /// The slots on the board and the ceiling the firmware states, static.
    pub slots: Option<u32>,
    pub max_capacity_bytes: Option<u64>,
    pub modules: Vec<MemoryModule>,
}

/// A mounted volume: what the OS shows as a drive letter or a mount point.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Disk {
    /// "C:" or "/".
    pub mount: String,
    /// The device or volume name, when the OS names it ("Macintosh HD", "Samsung SSD 990").
    pub name: Option<String>,
    pub fs: Option<String>,
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    /// "ssd" | "hdd" | "nvme" | "removable", when known.
    pub kind: Option<String>,
}

/// A physical drive, as opposed to a volume: the object you would replace.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Drive {
    /// The model string, as the drive reports it.
    pub name: String,
    /// Stripped from the open page (`Telemetry::public`).
    pub serial: Option<String>,
    pub firmware: Option<String>,
    pub size_bytes: Option<u64>,
    /// "nvme" | "sata" | "usb" | "thunderbolt" | "sd" | …, lowercase.
    pub bus: Option<String>,
    /// "ssd" | "hdd", when the OS says.
    pub kind: Option<String>,
    /// The OS's own verdict: "healthy" | "warning" | "unhealthy" on Windows,
    /// "verified" | "failing" | "not supported" from SMART on a Mac.
    pub health: Option<String>,
    pub temperature_c: Option<f64>,
    pub power_on_hours: Option<u64>,
    /// Endurance spent, 0–100, where the drive reports it.
    pub wear_pct: Option<f64>,
    pub read_errors: Option<u64>,
    pub write_errors: Option<u64>,
    pub removable: Option<bool>,
    /// The mounts that live on it ("C:", "D:", "/").
    pub volumes: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Gpu {
    pub name: String,
    pub vendor: Option<String>,
    pub driver: Option<String>,
    pub vram_total_bytes: Option<u64>,
    pub vram_used_bytes: Option<u64>,
    /// 0–100, since the previous sample.
    pub usage_pct: Option<f64>,
    pub temperature_c: Option<f64>,
    /// Watts drawn, where readable.
    pub power_w: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Temperature {
    /// "CPU", "GPU", "SSD", "Battery"…
    pub label: String,
    pub celsius: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Network {
    pub interface: String,
    /// Counters since boot, bytes.
    pub rx_bytes: Option<u64>,
    pub tx_bytes: Option<u64>,
    /// Bytes per second since the previous sample.
    pub rx_bps: Option<f64>,
    pub tx_bps: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Battery {
    pub percent: Option<f64>,
    pub charging: Option<bool>,
    /// Design capacity that remains, 0–100, where readable.
    pub health_pct: Option<f64>,
}

/// One of the heaviest processes. Stripped from the open page.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Process {
    /// The image name, without its path: "chrome.exe", "WindowServer".
    pub name: String,
    pub pid: u32,
    /// Resident memory (working set / RSS).
    pub memory_bytes: Option<u64>,
    /// 0–100 of one core, since the previous sample, where measured.
    pub cpu_pct: Option<f64>,
}

/// A Chromium-based browser installed on the machine.
///
/// Read every ten minutes with the drives and services: the version moves
/// when the browser updates itself, and whether it is running is a
/// process-list fact the same read already has. Chrome, Edge, Brave, Arc,
/// Vivaldi, Opera and a bare Chromium are the kinds looked for; Firefox and
/// Safari are not Chromium and are not here.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Browser {
    /// "Google Chrome", "Microsoft Edge", "Brave", "Arc", "Chromium", "Vivaldi", "Opera".
    pub name: String,
    /// "chrome" | "edge" | "brave" | "arc" | "chromium" | "vivaldi" | "opera".
    pub kind: String,
    /// The browser's own version, "128.0.6613.120".
    pub version: Option<String>,
    /// "stable" | "beta" | "dev" | "canary", where the install says.
    pub channel: Option<String>,
    /// Where it is installed. Stripped from the open page: a per-user
    /// install path carries the user's name.
    pub path: Option<String>,
    /// Whether any of its processes is running right now.
    pub running: bool,
    /// Whether it is the console user's default browser for http.
    pub default_browser: bool,
}

/// A service that should be running and is not. Stripped from the open page.
///
/// Windows: an Automatic service that is stopped with an exit code other
/// than 0 or 1077 (never started). macOS: a launchd job in the system domain
/// whose last exit status was non-zero, Apple's own excluded.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Service {
    pub name: String,
    pub display: Option<String>,
    /// "stopped" | "start pending" | "exited"…
    pub state: String,
    pub exit_code: Option<i64>,
}

/// One update the OS has pending.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Update {
    pub title: String,
    /// "KB5043076" on Windows, the label on a Mac.
    pub id: Option<String>,
    pub size_bytes: Option<u64>,
    /// "critical" | "important" | "moderate" | "low" | "recommended"…
    pub severity: Option<String>,
    /// Whether installing it restarts the machine, where stated.
    pub restart: Option<bool>,
}

/// One update the OS installed.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Installed {
    pub title: String,
    /// RFC 3339, or the date as the OS states it.
    pub at: Option<String>,
}

/// What the OS's own updater says. Stripped from the open page.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Updates {
    /// When the search ran, RFC 3339.
    pub checked_at: Option<String>,
    pub pending: Vec<Update>,
    /// The most recent few, newest first.
    pub installed: Vec<Installed>,
    /// Whether the OS is waiting for a restart to finish an install.
    pub reboot_pending: Option<bool>,
    /// Why the search did not answer, when it did not.
    pub error: Option<String>,
}

/// The whole document.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Telemetry {
    pub sampled_at: String,
    pub machine: Machine,
    pub os: Os,
    pub cpu: Cpu,
    pub memory: Memory,
    pub disks: Vec<Disk>,
    pub drives: Vec<Drive>,
    pub gpus: Vec<Gpu>,
    pub temperatures: Vec<Temperature>,
    pub network: Vec<Network>,
    pub battery: Option<Battery>,
    /// The heaviest by memory, at most `TOP_PROCESSES`.
    pub processes: Vec<Process>,
    pub process_count: Option<u32>,
    pub services: Vec<Service>,
    /// How many services the OS has in total, for the "n of m" the page says.
    pub service_count: Option<u32>,
    /// The Chromium-based browsers installed, read with the slow facts.
    pub browsers: Vec<Browser>,
    /// None until the first search lands.
    pub updates: Option<Updates>,
    /// What could not be read, one line each, so the page says "not
    /// readable on this OS" rather than showing a dash without a reason.
    pub errors: Vec<String>,
}

/// How many processes the sample keeps.
pub const TOP_PROCESSES: usize = 12;

impl Telemetry {
    /// The document as the open status page carries it: the machine, not
    /// the person using it.
    pub fn public(&self) -> Telemetry {
        let mut t = self.clone();
        for d in &mut t.drives {
            d.serial = None;
        }
        t.processes.clear();
        t.services.clear();
        for b in &mut t.browsers {
            b.path = None;
        }
        t.updates = None;
        t
    }
}

/// The static half, read rarely.
#[derive(Clone, Debug, Default)]
pub struct Static {
    pub machine: Machine,
    pub os: Os,
    /// Model, cores, threads and frequency; usage and load are sampled.
    pub cpu: Cpu,
    /// Names, vendors, drivers and VRAM totals; usage is sampled.
    pub gpus: Vec<Gpu>,
    pub memory_slots: Option<u32>,
    pub memory_max_capacity_bytes: Option<u64>,
    pub memory_modules: Vec<MemoryModule>,
    pub errors: Vec<String>,
}

/// The slow half: a shell-out or two, every ten minutes.
#[derive(Clone, Debug, Default)]
pub struct Slow {
    pub drives: Vec<Drive>,
    pub services: Vec<Service>,
    pub service_count: Option<u32>,
    /// The Chromium-based browsers installed, read with the slow facts.
    pub browsers: Vec<Browser>,
    pub errors: Vec<String>,
}

/// The sampled half.
#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub cpu_usage_pct: Option<f64>,
    pub load: Option<[f64; 3]>,
    pub cpu_temperature_c: Option<f64>,
    /// Everything but the static slots/ceiling/modules, which `assemble` fills.
    pub memory: Memory,
    pub disks: Vec<Disk>,
    /// Indexed like `Static::gpus`; a shorter list leaves the rest unsampled.
    pub gpu_usage: Vec<GpuSample>,
    pub temperatures: Vec<Temperature>,
    pub network: Vec<Network>,
    pub battery: Option<Battery>,
    pub processes: Vec<Process>,
    pub process_count: Option<u32>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct GpuSample {
    pub vram_used_bytes: Option<u64>,
    pub usage_pct: Option<f64>,
    pub temperature_c: Option<f64>,
    pub power_w: Option<f64>,
}

/// What a platform provides. The collector keeps whatever it needs between
/// samples (previous CPU times, previous network counters, previous
/// per-process CPU times).
/// The platform's `Collector` is a struct that implements this and `Default`.
pub trait Collect {
    fn read_static(&mut self) -> Static;
    fn read_slow(&mut self) -> Slow;
    fn sample(&mut self) -> Sample;
}

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::{read_updates, Collector};

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::{read_updates, Collector};

/// Everywhere else: nothing but the errors saying so.
#[cfg(not(any(windows, target_os = "macos")))]
#[derive(Default)]
pub struct Collector;
#[cfg(not(any(windows, target_os = "macos")))]
impl Collect for Collector {
    fn read_static(&mut self) -> Static {
        Static {
            errors: vec!["telemetry is Windows- and macOS-only in this version".into()],
            ..Default::default()
        }
    }
    fn read_slow(&mut self) -> Slow {
        Slow::default()
    }
    fn sample(&mut self) -> Sample {
        Sample::default()
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn read_updates() -> Updates {
    Updates {
        checked_at: Some(now_rfc3339()),
        error: Some("OS updates are read on Windows and macOS only".into()),
        ..Default::default()
    }
}

/// Static, slow and sampled halves joined into the document.
pub fn assemble(s: &Static, w: &Slow, p: &Sample, updates: Option<&Updates>) -> Telemetry {
    let gpus = s
        .gpus
        .iter()
        .enumerate()
        .map(|(i, g)| {
            let mut g = g.clone();
            if let Some(u) = p.gpu_usage.get(i) {
                g.vram_used_bytes = u.vram_used_bytes;
                g.usage_pct = u.usage_pct;
                g.temperature_c = u.temperature_c;
                g.power_w = u.power_w;
            }
            g
        })
        .collect();
    let mut errors = s.errors.clone();
    errors.extend(w.errors.iter().cloned());
    errors.extend(p.errors.iter().cloned());
    errors.dedup();
    Telemetry {
        sampled_at: now_rfc3339(),
        machine: s.machine.clone(),
        os: s.os.clone(),
        cpu: Cpu {
            usage_pct: p.cpu_usage_pct,
            load: p.load,
            temperature_c: p.cpu_temperature_c,
            ..s.cpu.clone()
        },
        memory: Memory {
            slots: s.memory_slots,
            max_capacity_bytes: s.memory_max_capacity_bytes,
            modules: s.memory_modules.clone(),
            ..p.memory.clone()
        },
        disks: p.disks.clone(),
        drives: w.drives.clone(),
        gpus,
        temperatures: p.temperatures.clone(),
        network: p.network.clone(),
        battery: p.battery.clone(),
        processes: p.processes.clone(),
        process_count: p.process_count,
        services: w.services.clone(),
        service_count: w.service_count,
        browsers: w.browsers.clone(),
        updates: updates.cloned(),
        errors,
    }
}

/// The sampling thread: static facts now and hourly, slow facts now and
/// every ten minutes, samples every `SAMPLE_EVERY`, each published to the
/// status page. The updates search runs on a thread of its own and is
/// merged in whenever it answers, so a slow search never stalls a sample.
pub fn run_loop(shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    #[allow(clippy::default_constructed_unit_structs)]
    let mut c = Collector::default();
    let mut stat = c.read_static();
    let mut stat_at = std::time::Instant::now();
    tracing::info!(
        model = stat.machine.model.as_deref().unwrap_or(""),
        bios = stat.machine.bios_version.as_deref().unwrap_or(""),
        cpu = stat.cpu.model.as_deref().unwrap_or(""),
        gpus = stat.gpus.len(),
        modules = stat.memory_modules.len(),
        "telemetry: static facts read"
    );
    for e in &stat.errors {
        tracing::warn!(error = %e, "telemetry: not readable");
    }
    let mut slow = c.read_slow();
    let mut slow_at = std::time::Instant::now();
    tracing::info!(
        drives = slow.drives.len(),
        services_down = slow.services.len(),
        browsers = slow.browsers.len(),
        "telemetry: slow facts read"
    );
    for e in &slow.errors {
        tracing::warn!(error = %e, "telemetry: not readable");
    }
    let mut updates: Option<Updates> = None;
    let mut updates_rx: Option<mpsc::Receiver<Updates>> = None;
    let mut updates_at: Option<std::time::Instant> = None;
    // A first sample primes the deltas; the second is the first published.
    let _ = c.sample();
    let mut wait = Duration::from_secs(2);
    loop {
        if crate::update::sleep_until(&stop, wait) {
            return;
        }
        wait = SAMPLE_EVERY;
        if stat_at.elapsed() > STATIC_EVERY {
            stat = c.read_static();
            stat_at = std::time::Instant::now();
        }
        if slow_at.elapsed() > SLOW_EVERY {
            slow = c.read_slow();
            slow_at = std::time::Instant::now();
        }
        if let Some(rx) = &updates_rx {
            match rx.try_recv() {
                Ok(u) => {
                    tracing::info!(
                        pending = u.pending.len(),
                        error = u.error.as_deref().unwrap_or(""),
                        "telemetry: OS updates read"
                    );
                    updates = Some(u);
                    updates_rx = None;
                }
                Err(mpsc::TryRecvError::Disconnected) => updates_rx = None,
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if updates_rx.is_none() && updates_at.is_none_or(|at| at.elapsed() > UPDATES_EVERY) {
            let (tx, rx) = mpsc::channel();
            updates_rx = Some(rx);
            updates_at = Some(std::time::Instant::now());
            let spawned = std::thread::Builder::new()
                .name("os-updates".into())
                .spawn(move || {
                    let _ = tx.send(read_updates());
                });
            if spawned.is_err() {
                updates_rx = None;
            }
        }
        let sample = c.sample();
        shared.set_telemetry(assemble(&stat, &slow, &sample, updates.as_ref()));
    }
}
/// Prometheus text exposition of the document. Gauges only; the counters
/// the OS keeps (network bytes) are exposed as counters.
pub fn metrics_text(t: &Telemetry, agent_version: &str, hostname: &str) -> String {
    let mut out = String::new();
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let host = esc(hostname);
    let mut gauge = |name: &str, labels: &str, v: f64| {
        let sep = if labels.is_empty() { "" } else { "," };
        out.push_str(&format!(
            "daedalus_agent_{name}{{host=\"{host}\"{sep}{labels}}} {v}\n"
        ));
    };
    gauge(
        "info",
        &format!(
            "version=\"{}\",model=\"{}\",bios=\"{}\",cpu=\"{}\"",
            esc(agent_version),
            esc(t.machine.model.as_deref().unwrap_or("")),
            esc(t.machine.bios_version.as_deref().unwrap_or("")),
            esc(t.cpu.model.as_deref().unwrap_or(""))
        ),
        1.0,
    );
    if let Some(v) = t.cpu.usage_pct {
        gauge("cpu_usage_percent", "", v);
    }
    if let Some(v) = t.cpu.temperature_c {
        gauge("cpu_temperature_celsius", "", v);
    }
    if let Some([a, b, c]) = t.cpu.load {
        gauge("load1", "", a);
        gauge("load5", "", b);
        gauge("load15", "", c);
    }
    for (k, v) in [
        ("memory_total_bytes", t.memory.total_bytes),
        ("memory_used_bytes", t.memory.used_bytes),
        ("memory_available_bytes", t.memory.available_bytes),
        ("memory_cached_bytes", t.memory.cached_bytes),
        ("memory_compressed_bytes", t.memory.compressed_bytes),
        ("memory_committed_bytes", t.memory.committed_bytes),
        ("memory_commit_limit_bytes", t.memory.commit_limit_bytes),
        ("swap_total_bytes", t.memory.swap_total_bytes),
        ("swap_used_bytes", t.memory.swap_used_bytes),
    ] {
        if let Some(v) = v {
            gauge(k, "", v as f64);
        }
    }
    if let Some(v) = t.process_count {
        gauge("processes", "", f64::from(v));
    }
    gauge("services_down", "", t.services.len() as f64);
    for b in &t.browsers {
        gauge(
            "browser_info",
            &format!(
                "browser=\"{}\",version=\"{}\",running=\"{}\"",
                esc(&b.kind),
                esc(b.version.as_deref().unwrap_or("")),
                if b.running { "1" } else { "0" }
            ),
            1.0,
        );
    }
    if let Some(u) = &t.updates {
        gauge("os_updates_pending", "", u.pending.len() as f64);
        if let Some(r) = u.reboot_pending {
            gauge("os_reboot_pending", "", if r { 1.0 } else { 0.0 });
        }
    }
    for d in &t.drives {
        let l = format!("drive=\"{}\"", esc(&d.name));
        if let Some(v) = d.temperature_c {
            gauge("drive_temperature_celsius", &l, v);
        }
        if let Some(v) = d.power_on_hours {
            gauge("drive_power_on_hours", &l, v as f64);
        }
        if let Some(v) = d.wear_pct {
            gauge("drive_wear_percent", &l, v);
        }
        if let Some(h) = &d.health {
            gauge(
                "drive_healthy",
                &l,
                if matches!(h.as_str(), "healthy" | "verified") {
                    1.0
                } else {
                    0.0
                },
            );
        }
    }
    for d in &t.disks {
        let l = format!("mount=\"{}\"", esc(&d.mount));
        for (k, v) in [
            ("disk_total_bytes", d.total_bytes),
            ("disk_used_bytes", d.used_bytes),
            ("disk_free_bytes", d.free_bytes),
        ] {
            if let Some(v) = v {
                gauge(k, &l, v as f64);
            }
        }
    }
    for (i, g) in t.gpus.iter().enumerate() {
        let l = format!("gpu=\"{i}\",name=\"{}\"", esc(&g.name));
        if let Some(v) = g.usage_pct {
            gauge("gpu_usage_percent", &l, v);
        }
        if let Some(v) = g.temperature_c {
            gauge("gpu_temperature_celsius", &l, v);
        }
        if let Some(v) = g.power_w {
            gauge("gpu_power_watts", &l, v);
        }
        if let Some(v) = g.vram_total_bytes {
            gauge("gpu_vram_total_bytes", &l, v as f64);
        }
        if let Some(v) = g.vram_used_bytes {
            gauge("gpu_vram_used_bytes", &l, v as f64);
        }
    }
    for x in &t.temperatures {
        gauge(
            "temperature_celsius",
            &format!("sensor=\"{}\"", esc(&x.label)),
            x.celsius,
        );
    }
    for n in &t.network {
        let l = format!("interface=\"{}\"", esc(&n.interface));
        if let Some(v) = n.rx_bytes {
            gauge("network_receive_bytes_total", &l, v as f64);
        }
        if let Some(v) = n.tx_bytes {
            gauge("network_transmit_bytes_total", &l, v as f64);
        }
    }
    if let Some(b) = &t.battery {
        if let Some(v) = b.percent {
            gauge("battery_percent", "", v);
        }
        if let Some(v) = b.health_pct {
            gauge("battery_health_percent", "", v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assemble_joins_static_and_sample() {
        let s = Static {
            cpu: Cpu {
                model: Some("X".into()),
                cores: Some(8),
                ..Default::default()
            },
            gpus: vec![Gpu {
                name: "G".into(),
                vram_total_bytes: Some(16),
                ..Default::default()
            }],
            errors: vec!["a".into()],
            ..Default::default()
        };
        let p = Sample {
            cpu_usage_pct: Some(12.5),
            gpu_usage: vec![GpuSample {
                usage_pct: Some(50.0),
                ..Default::default()
            }],
            errors: vec!["a".into(), "b".into()],
            ..Default::default()
        };
        let w = Slow {
            drives: vec![Drive {
                name: "D".into(),
                serial: Some("S123".into()),
                ..Default::default()
            }],
            browsers: vec![Browser {
                name: "Google Chrome".into(),
                kind: "chrome".into(),
                version: Some("128.0".into()),
                path: Some("C:\\Users\\x\\chrome.exe".into()),
                ..Default::default()
            }],
            services: vec![Service {
                name: "svc".into(),
                state: "stopped".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let u = Updates {
            pending: vec![Update {
                title: "KB1".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let t = assemble(&s, &w, &p, Some(&u));
        assert_eq!(t.drives[0].serial.as_deref(), Some("S123"));
        assert_eq!(t.services.len(), 1);
        assert_eq!(t.updates.as_ref().map(|u| u.pending.len()), Some(1));
        // The open page: the machine, never the person.
        let open = t.public();
        assert_eq!(open.drives[0].serial, None);
        assert_eq!(open.drives[0].name, "D");
        assert!(open.services.is_empty());
        assert_eq!(open.browsers[0].path, None);
        assert_eq!(open.browsers[0].version.as_deref(), Some("128.0"));
        assert!(open.processes.is_empty());
        assert!(open.updates.is_none());
        assert_eq!(t.cpu.model.as_deref(), Some("X"));
        assert_eq!(t.cpu.usage_pct, Some(12.5));
        assert_eq!(t.gpus[0].vram_total_bytes, Some(16));
        assert_eq!(t.gpus[0].usage_pct, Some(50.0));
        assert_eq!(t.errors, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn metrics_render_with_labels_escaped() {
        let t = Telemetry {
            cpu: Cpu {
                model: Some("A \"B\"".into()),
                usage_pct: Some(3.0),
                ..Default::default()
            },
            disks: vec![Disk {
                mount: "C:".into(),
                total_bytes: Some(10),
                ..Default::default()
            }],
            ..Default::default()
        };
        let m = metrics_text(&t, "0.7.0", "PC");
        assert!(m.contains("daedalus_agent_cpu_usage_percent{host=\"PC\"} 3\n"));
        assert!(m.contains("daedalus_agent_disk_total_bytes{host=\"PC\",mount=\"C:\"} 10\n"));
        assert!(m.contains("cpu=\"A \\\"B\\\"\""));
    }
}
