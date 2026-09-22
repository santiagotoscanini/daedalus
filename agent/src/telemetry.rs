//! What the machine is and how it is doing: the telemetry the status page
//! carries (`telemetry` block of `/status`) and `/metrics` renders for
//! Prometheus.
//!
//! Two kinds of fact, one document. The STATIC ones — make and model,
//! firmware, board, processor model, core counts, kernel — are read once at
//! start and again every hour. The SAMPLED ones — processor and GPU usage,
//! memory, disks, temperatures, network counters — are read every
//! `SAMPLE_EVERY` on a thread of their own. Each platform has a `Collector`
//! (win.rs, mac.rs); anything it cannot read is `None` or an empty list,
//! never a guess, and what went wrong is in `errors` so the page can say so.
//!
//! Nothing here identifies a person: no serial numbers, no user names, no
//! process lists. The document is on the open page, so it stays a
//! description of a machine.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::state::now_rfc3339;
use crate::status::Shared;

/// How often the sampled facts are read.
pub const SAMPLE_EVERY: Duration = Duration::from_secs(15);
/// How often the static facts are re-read (a firmware update, a new drive).
pub const STATIC_EVERY: Duration = Duration::from_secs(3600);

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

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Memory {
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub swap_total_bytes: Option<u64>,
    pub swap_used_bytes: Option<u64>,
}

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
    pub gpus: Vec<Gpu>,
    pub temperatures: Vec<Temperature>,
    pub network: Vec<Network>,
    pub battery: Option<Battery>,
    /// What could not be read, one line each, so the page says "not
    /// readable on this OS" rather than showing a dash without a reason.
    pub errors: Vec<String>,
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
    pub errors: Vec<String>,
}

/// The sampled half.
#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub cpu_usage_pct: Option<f64>,
    pub load: Option<[f64; 3]>,
    pub cpu_temperature_c: Option<f64>,
    pub memory: Memory,
    pub disks: Vec<Disk>,
    /// Indexed like `Static::gpus`; a shorter list leaves the rest unsampled.
    pub gpu_usage: Vec<GpuSample>,
    pub temperatures: Vec<Temperature>,
    pub network: Vec<Network>,
    pub battery: Option<Battery>,
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
/// samples (previous CPU times, previous network counters).
/// The platform's `Collector` is a struct that implements this and `Default`.
pub trait Collect {
    fn read_static(&mut self) -> Static;
    fn sample(&mut self) -> Sample;
}

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::Collector;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::Collector;

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
    fn sample(&mut self) -> Sample {
        Sample::default()
    }
}

/// Static and sampled halves joined into the document.
pub fn assemble(s: &Static, p: &Sample) -> Telemetry {
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
        memory: p.memory.clone(),
        disks: p.disks.clone(),
        gpus,
        temperatures: p.temperatures.clone(),
        network: p.network.clone(),
        battery: p.battery.clone(),
        errors,
    }
}

/// The sampling thread: static facts now and hourly, samples every
/// `SAMPLE_EVERY`, each published to the status page.
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
        "telemetry: static facts read"
    );
    for e in &stat.errors {
        tracing::warn!(error = %e, "telemetry: not readable");
    }
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
        let sample = c.sample();
        shared.set_telemetry(assemble(&stat, &sample));
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
        ("swap_total_bytes", t.memory.swap_total_bytes),
        ("swap_used_bytes", t.memory.swap_used_bytes),
    ] {
        if let Some(v) = v {
            gauge(k, "", v as f64);
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
        let t = assemble(&s, &p);
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
