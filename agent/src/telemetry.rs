//! What the machine is and how it is doing: the telemetry the status page
//! carries (`telemetry` block of `/status`) and `/metrics` renders for
//! Prometheus.
//!
//! Three cadences, one document. The STATIC facts — make and model,
//! firmware, board, processor model, core counts, kernel, the memory
//! modules — are read once at start and again every hour. The SLOW ones —
//! the physical drives with their health counters, the services that
//! should be running and are not, the browsers and the installed
//! applications — every ten minutes, because they cost a shell-out. The
//! SAMPLED ones — processor and GPU usage, memory, volumes,
//! temperatures, network counters, the heaviest processes — every
//! `SAMPLE_EVERY` on a thread of their own. OS updates are a fourth thing:
//! a search that can take a minute and touch the network, run hourly on its
//! own thread and merged in when it lands. Each platform has a `Collector`
//! (win.rs, mac.rs); anything it cannot read is `None` or an empty list,
//! never a guess, and what went wrong is in `errors` so the page can say so.
//!
//! Two views of the document. The OPEN status page carries `public()`:
//! nothing that identifies a person — no serial numbers, no process list, no
//! service list, no updates, no installed applications, no browser install
//! paths — because the page answers the whole LAN. The box, holding the
//! node token, reads the full document at `GET /telemetry` (status.rs) and
//! draws the same pages it draws for itself.
//!
//! The document's types are in model.rs and its Prometheus rendering in
//! metrics.rs; both are re-exported here.

mod metrics;
mod model;

pub use metrics::metrics_text;
pub use model::{
    App, Battery, Browser, Cpu, Disk, Drive, Gpu, GpuSample, Installed, Machine, Memory,
    MemoryModule, Network, Os, Process, Sample, Service, Slow, Static, Telemetry, Temperature,
    Update, Updates,
};

use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use crate::state::now_rfc3339;
use crate::status::Shared;

/// How often the sampled facts are read.
pub const SAMPLE_EVERY: Duration = Duration::from_secs(15);
/// How often the slow facts (drives, services, browsers, apps) are re-read.
pub const SLOW_EVERY: Duration = Duration::from_secs(600);
/// How often the static facts are re-read (a firmware update, a new drive).
pub const STATIC_EVERY: Duration = Duration::from_secs(3600);
/// How often the OS is asked what updates it has pending.
pub const UPDATES_EVERY: Duration = Duration::from_secs(3600);

/// How many processes the sample keeps.
pub const TOP_PROCESSES: usize = 12;

/// The inventory in the order the page lists it: by name, case aside, one
/// entry per (name, version): Windows' 64-bit and 32-bit Uninstall views
/// both list a product that registered under each, and a Mac can hold the
/// same bundle in `/Applications` and `~/Applications`.
pub fn tidy_apps(mut apps: Vec<App>) -> Vec<App> {
    apps.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.version.cmp(&b.version))
    });
    apps.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name) && a.version == b.version);
    apps
}

/// What a platform provides. The collector keeps whatever it needs between
/// samples (previous CPU times, previous network counters, previous
/// per-process CPU times). The platform's `Collector` implements this and
/// `Default`.
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
pub fn assemble(
    s: &Static,
    w: &Slow,
    p: &Sample,
    updates: Option<&Updates>,
    providers: Vec<crate::providers::ProviderReport>,
) -> Telemetry {
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
        apps: w.apps.clone(),
        app_count: Some(w.apps.len()),
        updates: updates.cloned(),
        providers,
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
        apps = slow.apps.len(),
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
        // Presence, every sample: a refused port answers at once, and the
        // page should say "running" within a tick of the server starting.
        let providers = crate::providers::detect(&shared.policy(), &slow.apps);
        shared.set_telemetry(assemble(&stat, &slow, &sample, updates.as_ref(), providers));
    }
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
            apps: vec![App {
                name: "Steam".into(),
                kind: "launcher".into(),
                path: Some(r"C:\Program Files (x86)\Steam".into()),
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
        let t = assemble(&s, &w, &p, Some(&u), Vec::new());
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
        assert_eq!(t.apps.len(), 1);
        assert!(open.apps.is_empty());
        assert_eq!(open.app_count, Some(1));
        assert_eq!(t.cpu.model.as_deref(), Some("X"));
        assert_eq!(t.cpu.usage_pct, Some(12.5));
        assert_eq!(t.gpus[0].vram_total_bytes, Some(16));
        assert_eq!(t.gpus[0].usage_pct, Some(50.0));
        assert_eq!(t.errors, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn apps_are_sorted_and_deduped() {
        let app = |name: &str, version: Option<&str>| App {
            name: name.into(),
            version: version.map(str::to_string),
            kind: "app".into(),
            ..Default::default()
        };
        let apps = tidy_apps(vec![
            app("zoom", Some("6.0")),
            app("Arc", None),
            app("Zoom", Some("6.0")),
            app("Zoom", Some("5.0")),
        ]);
        let names: Vec<(&str, Option<&str>)> = apps
            .iter()
            .map(|a| (a.name.as_str(), a.version.as_deref()))
            .collect();
        assert_eq!(
            names,
            vec![("Arc", None), ("Zoom", Some("5.0")), ("zoom", Some("6.0"))]
        );
        let m = metrics_text(
            &Telemetry {
                apps,
                ..Default::default()
            },
            "0.10.0",
            "PC",
        );
        assert!(m.contains("daedalus_agent_apps{host=\"PC\",kind=\"app\"} 3\n"));
    }
}
