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

use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{
    App, Battery, Browser, Collect, Cpu, Disk, Drive, Gpu, GpuSample, Installed, Machine, Memory,
    MemoryModule, Network, Os, Process, Sample, Service, Slow, Static, Temperature, Update,
    Updates, TOP_PROCESSES,
};

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
/// Where macOS logs every install, its own updates included.
const INSTALL_HISTORY: &str = "/Library/Receipts/InstallHistory.plist";
/// Where applications install for everyone; the console user's own is
/// `~/Applications`.
const APPLICATIONS: &str = "/Applications";
/// LaunchServices' handler list, under the user's home: which app opens
/// each URL scheme and content type. Binary on disk.
const LS_HANDLERS: &str =
    "Library/Preferences/com.apple.launchservices/com.apple.launchservices.secure.plist";
/// The Chromium browsers looked for: the bundle's name under an
/// Applications folder, then the kind, display name and channel it stands
/// for. Firefox and Safari are not Chromium and are not here.
const BROWSER_BUNDLES: &[(&str, &str, &str, &str)] = &[
    ("Google Chrome.app", "chrome", "Google Chrome", "stable"),
    ("Google Chrome Beta.app", "chrome", "Google Chrome", "beta"),
    ("Google Chrome Dev.app", "chrome", "Google Chrome", "dev"),
    (
        "Google Chrome Canary.app",
        "chrome",
        "Google Chrome",
        "canary",
    ),
    ("Microsoft Edge.app", "edge", "Microsoft Edge", "stable"),
    ("Microsoft Edge Beta.app", "edge", "Microsoft Edge", "beta"),
    ("Microsoft Edge Dev.app", "edge", "Microsoft Edge", "dev"),
    (
        "Microsoft Edge Canary.app",
        "edge",
        "Microsoft Edge",
        "canary",
    ),
    ("Brave Browser.app", "brave", "Brave", "stable"),
    ("Brave Browser Beta.app", "brave", "Brave", "beta"),
    ("Brave Browser Nightly.app", "brave", "Brave", "canary"),
    ("Arc.app", "arc", "Arc", "stable"),
    ("Chromium.app", "chromium", "Chromium", "stable"),
    ("Vivaldi.app", "vivaldi", "Vivaldi", "stable"),
    ("Opera.app", "opera", "Opera", "stable"),
];
/// How many past installs `read_updates` carries.
const INSTALLED_KEPT: usize = 8;
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

// ── running commands ────────────────────────────────────────────────────────

/// A command's whole stdout, or `None` when it fails, prints nothing usable,
/// or is still running at the deadline (then it is killed).
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
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let (etx, erx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        let _ = etx.send(s);
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

fn output(cmd: Command, deadline: Duration) -> Option<String> {
    output_or(cmd, deadline).ok()
}

fn run_for(cmd: &str, args: &[&str], deadline: Duration) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args);
    output(c, deadline)
}

/// A quick command's stdout.
fn run(cmd: &str, args: &[&str]) -> Option<String> {
    run_for(cmd, args, QUICK)
}

/// A quick command's stdout, trimmed; `None` when empty.
fn line(cmd: &str, args: &[&str]) -> Option<String> {
    run(cmd, args)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// An integer sysctl, whatever its width (`hw.physicalcpu` is 32-bit,
/// `hw.memsize` 64-bit).
fn sysctl_u64(name: &str) -> Option<u64> {
    let cname = CString::new(name).ok()?;
    let mut buf = [0u8; 8];
    let mut len = buf.len();
    // SAFETY: the buffer is eight bytes and `len` says so; the kernel writes
    // at most that many and reports how many.
    let rc = unsafe {
        libc::sysctlbyname(
            cname.as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    match len {
        4 => Some(u64::from(u32::from_ne_bytes([
            buf[0], buf[1], buf[2], buf[3],
        ]))),
        8 => Some(u64::from_ne_bytes(buf)),
        _ => None,
    }
}

/// `hw.optional.arm64` is 1 on Apple Silicon, even under Rosetta.
fn is_apple_silicon() -> bool {
    sysctl_u64("hw.optional.arm64") == Some(1)
}

// ── the static half ─────────────────────────────────────────────────────────

/// `system_profiler SPHardwareDataType -json`, without the serial number or
/// the hardware UUID it also prints.
fn parse_hardware(json: &str) -> Option<Machine> {
    let v: Value = serde_json::from_str(json).ok()?;
    let hw = v.get("SPHardwareDataType")?.as_array()?.first()?;
    let s = |k: &str| hw.get(k).and_then(Value::as_str).map(str::to_string);
    let identifier = s("machine_model");
    let model = s("machine_name").or_else(|| identifier.clone());
    let form = model.as_deref().and_then(form_of).map(str::to_string);
    Some(Machine {
        manufacturer: Some("Apple".into()),
        model,
        chip: s("chip_type").or_else(|| s("cpu_type")),
        bios_vendor: Some("Apple".into()),
        bios_version: s("boot_rom_version"),
        // The firmware carries no date of its own; it is versioned with the OS.
        bios_date: None,
        board_manufacturer: Some("Apple".into()),
        board_product: identifier,
        form,
        // `hw.target`; read_static fills it, since it is a sysctl and not
        // in this document.
        target: None,
    })
}

/// What shape the machine is, from its model name ("MacBook Pro", "Mac
/// mini") or, when `system_profiler` gave only that, its identifier
/// ("Macmini8,1", "iMacPro1,1"). Spaces and case are ignored so both read
/// the same; "iMac" is tested before "Mac Pro" because "iMacPro" holds both.
fn form_of(model: &str) -> Option<&'static str> {
    let m: String = model
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if m.contains("book") {
        Some("laptop")
    } else if m.contains("imac") {
        Some("all-in-one")
    } else if m.contains("macmini") {
        Some("mini")
    } else if m.contains("macstudio") || m.contains("macpro") {
        Some("desktop")
    } else {
        None
    }
}

/// What `system_profiler SPMemoryDataType -json` says about the memory.
#[derive(Debug, Default, PartialEq)]
struct MemoryProfile {
    slots: Option<u32>,
    max_capacity_bytes: Option<u64>,
    modules: Vec<MemoryModule>,
}

/// Apple Silicon answers one entry with no slot list — the memory is on the
/// package, so zero slots, the ceiling is what is fitted, and the one module
/// is `total` (`hw.memsize`; the "16 GB" it prints is that number rounded).
/// Intel answers a slot list ("BANK 0/DIMM0"…), one module per fitted
/// DIMM; an empty slot counts as a slot and no module. The firmware states
/// no ceiling on either, so it is the fitted total or nothing.
fn parse_memory(json: &str, total: Option<u64>) -> Option<MemoryProfile> {
    let v: Value = serde_json::from_str(json).ok()?;
    let list = v.get("SPMemoryDataType")?.as_array()?;
    let mut slots = Vec::new();
    for e in list {
        collect_slots(e, &mut slots);
    }
    if slots.is_empty() {
        let e = list.first()?;
        let s = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_string);
        let size = total.or_else(|| s("SPMemoryDataType").as_deref().and_then(parse_size));
        return Some(MemoryProfile {
            slots: Some(0),
            max_capacity_bytes: size,
            modules: vec![MemoryModule {
                locator: Some("on package".into()),
                size_bytes: size,
                speed_mts: None,
                kind: s("dimm_type").or_else(|| s("SPMemoryDataType_Type")),
                manufacturer: s("dimm_manufacturer"),
                part_number: None,
            }],
        });
    }
    let modules = slots
        .iter()
        .filter_map(|e| {
            let s = |k: &str| e.get(k).and_then(Value::as_str);
            let size = s("dimm_size")?;
            let empty = size.eq_ignore_ascii_case("empty")
                || s("dimm_status").is_some_and(|x| x.eq_ignore_ascii_case("empty"));
            if empty {
                return None;
            }
            Some(MemoryModule {
                locator: s("_name").map(str::to_string),
                size_bytes: parse_size(size),
                // "2667 MHz" → 2667.
                speed_mts: s("dimm_speed")
                    .and_then(|x| x.split_whitespace().next())
                    .and_then(|n| n.parse().ok()),
                kind: s("dimm_type").map(str::to_string),
                manufacturer: s("dimm_manufacturer").map(str::to_string),
                part_number: s("dimm_part_number").map(str::to_string),
            })
        })
        .collect();
    Some(MemoryProfile {
        slots: u32::try_from(slots.len()).ok(),
        max_capacity_bytes: None,
        modules,
    })
}

/// The DIMM entries under `_items` (or `items`, as older releases spell
/// it), however deep the controller tree goes. A DIMM is what states a
/// `dimm_size`, "empty" included.
fn collect_slots<'a>(v: &'a Value, out: &mut Vec<&'a Value>) {
    if v.get("dimm_size").is_some() {
        out.push(v);
        return;
    }
    for k in ["_items", "items"] {
        if let Some(list) = v.get(k).and_then(Value::as_array) {
            for e in list {
                collect_slots(e, out);
            }
        }
    }
}

/// "sppci_vendor_amd" → "AMD"; the plain names pass through.
fn gpu_vendor(raw: &str) -> String {
    let v = raw.strip_prefix("sppci_vendor_").unwrap_or(raw);
    match v.to_ascii_lowercase().as_str() {
        "apple" => "Apple".into(),
        "amd" => "AMD".into(),
        "intel" => "Intel".into(),
        "nvidia" => "NVIDIA".into(),
        _ => v.to_string(),
    }
}

/// "16 GB", "1536 MB" → bytes, binary units as Apple counts memory. Anything
/// else ("shared", a bare word) is `None`.
fn parse_size(s: &str) -> Option<u64> {
    let mut it = s.split_whitespace();
    let n: f64 = it.next()?.parse().ok()?;
    let unit = it.next()?.to_ascii_uppercase();
    let mult: u64 = match unit.as_str() {
        "B" | "BYTES" => 1,
        "KB" | "KIB" | "K" => 1 << 10,
        "MB" | "MIB" | "M" => 1 << 20,
        "GB" | "GIB" | "G" => 1 << 30,
        "TB" | "TIB" | "T" => 1 << 40,
        _ => return None,
    };
    (n >= 0.0).then_some((n * mult as f64) as u64)
}

/// `system_profiler SPDisplaysDataType -json`: one `Gpu` per accelerator.
fn parse_displays(json: &str) -> Vec<Gpu> {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let Some(list) = v.get("SPDisplaysDataType").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|g| {
            let s = |k: &str| g.get(k).and_then(Value::as_str);
            let name = s("sppci_model").or_else(|| s("_name"))?.to_string();
            let vendor = s("sppci_vendor")
                .or_else(|| s("spdisplays_vendor"))
                .map(gpu_vendor);
            let vram_total_bytes = s("spdisplays_vram")
                .and_then(parse_size)
                .or_else(|| s("spdisplays_vram_shared").and_then(parse_size));
            Some(Gpu {
                name,
                vendor,
                driver: None,
                vram_total_bytes,
                ..Default::default()
            })
        })
        .collect()
}

// ── the slow half: parsers ──────────────────────────────────────────────────

/// `system_profiler SPNVMeDataType SPSerialATADataType SPUSBDataType -json`:
/// one `Drive` per physical device. The NVMe and SATA sections list
/// controllers with their drives under `_items`; the USB section is a tree
/// of hubs whose storage devices carry a `Media` list. A drive's partitions
/// are its `volumes`, and a partition states a `mount_point` only when it
/// is mounted directly (HFS+, a FAT stick) — an APFS container's volumes
/// are synthesised on another disk, so the boot volume is found the other
/// way round: `boot_store` is the partition "/" lives on ("disk0s2", from
/// `diskutil info /`), and the drive that owns it gets "/" first in its
/// list. SMART counters (temperature, hours, wear, errors) are not readable
/// without smartmontools and stay `None`; `smart_status` is the verdict.
fn parse_storage(json: &str, boot_store: Option<&str>) -> Vec<Drive> {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (section, bus) in [("SPNVMeDataType", "nvme"), ("SPSerialATADataType", "sata")] {
        if let Some(list) = v.get(section).and_then(Value::as_array) {
            for e in list {
                walk_bus(e, bus, boot_store, &mut out);
            }
        }
    }
    if let Some(list) = v.get("SPUSBDataType").and_then(Value::as_array) {
        for e in list {
            walk_usb(e, boot_store, &mut out);
        }
    }
    out
}

/// A controller and what hangs off it: the drives, or further controllers.
fn walk_bus(v: &Value, bus: &str, boot_store: Option<&str>, out: &mut Vec<Drive>) {
    if let Some(d) = drive_of(v, bus, boot_store) {
        out.push(d);
        return;
    }
    if let Some(list) = v.get("_items").and_then(Value::as_array) {
        for e in list {
            walk_bus(e, bus, boot_store, out);
        }
    }
}

/// A USB hub or device and what hangs off it. A mass-storage device names
/// itself and its serial at the device level and its disks under `Media`.
fn walk_usb(v: &Value, boot_store: Option<&str>, out: &mut Vec<Drive>) {
    if let Some(media) = v.get("Media").and_then(Value::as_array) {
        let device_serial = v.get("serial_num").and_then(Value::as_str);
        for m in media {
            if let Some(mut d) = drive_of(m, "usb", boot_store) {
                if d.serial.is_none() {
                    d.serial = device_serial.map(str::to_string);
                }
                out.push(d);
            }
        }
    }
    if let Some(list) = v.get("_items").and_then(Value::as_array) {
        for e in list {
            walk_usb(e, boot_store, out);
        }
    }
}

/// One item as a drive, when it is one: it names a BSD device and states a
/// size (a controller does neither; an optical drive has no size).
fn drive_of(item: &Value, bus: &str, boot_store: Option<&str>) -> Option<Drive> {
    let s = |k: &str| item.get(k).and_then(Value::as_str);
    let bsd = s("bsd_name")?;
    let size_bytes = item
        .get("size_in_bytes")
        .and_then(Value::as_u64)
        .or_else(|| s("size").and_then(|x| parse_size(&x.replace(',', "."))))?;
    let name = s("device_model").or_else(|| s("_name"))?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let partitions = item.get("volumes").and_then(Value::as_array);
    let boots = boot_store.is_some_and(|store| {
        whole_disk(store) == bsd
            || partitions.is_some_and(|ps| {
                ps.iter()
                    .any(|p| p.get("bsd_name").and_then(Value::as_str) == Some(store))
            })
    });
    let mut volumes: Vec<String> = Vec::new();
    if boots {
        volumes.push("/".into());
    }
    for p in partitions.into_iter().flatten() {
        if let Some(m) = p.get("mount_point").and_then(Value::as_str) {
            if !m.is_empty() && !volumes.iter().any(|v| v == m) {
                volumes.push(m.to_string());
            }
        }
    }
    let kind = if bus == "nvme" {
        Some("ssd".to_string())
    } else {
        medium_kind(item)
    };
    Some(Drive {
        name,
        serial: s("device_serial").map(str::to_string),
        firmware: s("device_revision").map(str::to_string),
        size_bytes: Some(size_bytes),
        bus: Some(bus.to_string()),
        kind,
        health: s("smart_status").map(|h| h.trim().to_ascii_lowercase()),
        removable: s("removable_media").map(|r| r.trim().eq_ignore_ascii_case("yes")),
        volumes,
        ..Default::default()
    })
}

/// "Solid State" | "Rotational" from whichever `*medium_type` key the bus
/// uses (`spsata_medium_type` on SATA; USB states none).
fn medium_kind(item: &Value) -> Option<String> {
    item.as_object()?
        .iter()
        .filter(|(k, _)| k.ends_with("medium_type"))
        .find_map(|(_, v)| {
            let v = v.as_str()?.to_ascii_lowercase();
            if v.contains("solid") {
                Some("ssd".to_string())
            } else if v.contains("rotational") {
                Some("hdd".to_string())
            } else {
                None
            }
        })
}

/// "disk0s2" → "disk0": the whole device a partition belongs to.
fn whole_disk(bsd: &str) -> &str {
    let digits = bsd
        .strip_prefix("disk")
        .map_or(0, |r| r.bytes().take_while(u8::is_ascii_digit).count());
    if digits == 0 {
        bsd
    } else {
        &bsd[.."disk".len() + digits]
    }
}

/// `diskutil info /`: the partition the root volume lives on. On APFS that
/// is "APFS Physical Store" (the volume's own identifier is a synthesised
/// disk); on HFS+ the volume is the partition, so "Device Identifier".
fn parse_physical_store(text: &str) -> Option<String> {
    let field = |name: &str| {
        text.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            if k.trim() != name {
                return None;
            }
            v.split_whitespace()
                .next()
                .map(|s| s.trim_end_matches(',').to_string())
        })
    };
    field("APFS Physical Store").or_else(|| field("Device Identifier"))
}

/// `launchctl list` in the system domain: a "PID\tStatus\tLabel" header,
/// then one row per job — PID "-" when not running, Status its last exit
/// status. The jobs whose last exit was not 0, Apple's own excluded (they
/// exit non-zero as a matter of course), and how many rows there were.
fn parse_launchctl(text: &str) -> (Vec<Service>, u32) {
    let mut count = 0u32;
    let mut down = Vec::new();
    for l in text.lines() {
        let t: Vec<&str> = l.split_whitespace().collect();
        if t.len() < 3 || t[0] == "PID" {
            continue;
        }
        count = count.saturating_add(1);
        let Ok(status) = t[1].parse::<i64>() else {
            continue;
        };
        let label = t[2..].join(" ");
        // A row with a PID is running now; its status is the LAST exit,
        // which for a job launchd restarted — this agent after a self-update,
        // which exits 3 on purpose — is a history, not a failure.
        if status == 0 || t[0] != "-" || label.starts_with("com.apple.") {
            continue;
        }
        down.push(Service {
            name: label,
            display: None,
            state: "exited".into(),
            exit_code: Some(status),
        });
    }
    (down, count)
}

// ── the sampled half: parsers ───────────────────────────────────────────────

extern "C" {
    /// libc's own binding is deprecated in favour of the `mach2` crate, which
    /// this crate does not carry; the symbol is libSystem's.
    fn mach_host_self() -> libc::mach_port_t;
}

/// `host_statistics64` CPU ticks: user, system, idle, nice.
fn cpu_ticks() -> Option<[u32; 4]> {
    let mut info = libc::host_cpu_load_info { cpu_ticks: [0; 4] };
    let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
    // SAFETY: the out-buffer is a host_cpu_load_info and `count` is its size
    // in integers, as the call requires; the host port needs no release.
    let rc = unsafe {
        libc::host_statistics64(
            mach_host_self(),
            libc::HOST_CPU_LOAD_INFO,
            (&mut info as *mut libc::host_cpu_load_info).cast(),
            &mut count,
        )
    };
    if rc != libc::KERN_SUCCESS {
        return None;
    }
    let t = info.cpu_ticks;
    Some([
        t[libc::CPU_STATE_USER as usize],
        t[libc::CPU_STATE_SYSTEM as usize],
        t[libc::CPU_STATE_IDLE as usize],
        t[libc::CPU_STATE_NICE as usize],
    ])
}

/// Busy share between two tick readings, 0–100; `None` when no time passed.
/// The tick counters are 32-bit and wrap, hence the wrapping arithmetic.
fn cpu_usage(prev: [u32; 4], now: [u32; 4]) -> Option<f64> {
    let d: Vec<u64> = prev
        .iter()
        .zip(now.iter())
        .map(|(p, n)| u64::from(n.wrapping_sub(*p)))
        .collect();
    let total: u64 = d.iter().sum();
    if total == 0 {
        return None;
    }
    let idle = d[2];
    Some(100.0 * (1.0 - idle as f64 / total as f64))
}

fn load_avg() -> Option<[f64; 3]> {
    let mut l = [0f64; 3];
    // SAFETY: three doubles, and the call is told there are three.
    let n = unsafe { libc::getloadavg(l.as_mut_ptr(), 3) };
    (n == 3).then_some(l)
}

/// The page counts `vm_stat` prints that make "available": free, inactive
/// and speculative pages (active, wired and compressor pages are the rest
/// of "used", which is total minus available) — plus the file-backed pages
/// (the cache the OS drops under pressure) and the pages the compressor
/// holds. In pages, with the page size.
#[derive(Debug, Default, PartialEq)]
struct VmStat {
    page_size: u64,
    free: u64,
    inactive: u64,
    speculative: u64,
    file_backed: u64,
    compressor: u64,
}

impl VmStat {
    fn available_bytes(&self) -> u64 {
        (self.free + self.inactive + self.speculative) * self.page_size
    }

    fn cached_bytes(&self) -> u64 {
        self.file_backed * self.page_size
    }

    fn compressed_bytes(&self) -> u64 {
        self.compressor * self.page_size
    }
}

fn parse_vm_stat(text: &str) -> Option<VmStat> {
    let mut v = VmStat::default();
    for l in text.lines() {
        let l = l.trim();
        if let Some(rest) = l.strip_prefix("Mach Virtual Memory Statistics:") {
            // "(page size of 16384 bytes)"
            v.page_size = rest
                .split_whitespace()
                .find_map(|w| w.parse::<u64>().ok())
                .unwrap_or(0);
            continue;
        }
        let Some((key, val)) = l.split_once(':') else {
            continue;
        };
        let Ok(n) = val.trim().trim_end_matches('.').parse::<u64>() else {
            continue;
        };
        match key.trim() {
            "Pages free" => v.free = n,
            "Pages inactive" => v.inactive = n,
            "Pages speculative" => v.speculative = n,
            "File-backed pages" => v.file_backed = n,
            "Pages occupied by compressor" => v.compressor = n,
            _ => {}
        }
    }
    (v.page_size > 0).then_some(v)
}

/// `ps -axo pid=,rss=,pcpu=,comm=` rows: the heaviest `TOP_PROCESSES` by
/// resident memory, and how many processes there were. `rss` is in KiB;
/// `pcpu` is percent of one core; `comm` is the executable's full path on
/// macOS and may hold spaces ("…/Google Chrome"), so it is the rest of the
/// row and the name is its last component. Sorted here rather than by
/// `ps -m`, so the flag's exact meaning does not matter.
fn parse_ps(text: &str) -> (Vec<Process>, u32) {
    let mut all: Vec<Process> = text
        .lines()
        .filter_map(|l| {
            let mut rest = l.trim_start();
            let pid: u32 = take_word(&mut rest)?.parse().ok()?;
            let rss_kib: u64 = take_word(&mut rest)?.parse().ok()?;
            let cpu: f64 = take_word(&mut rest)?.parse().ok()?;
            let comm = rest.trim_end();
            let name = comm.rsplit('/').next().unwrap_or(comm).trim();
            if name.is_empty() {
                return None;
            }
            Some(Process {
                name: name.to_string(),
                pid,
                memory_bytes: Some(rss_kib.saturating_mul(1024)),
                cpu_pct: Some(cpu),
            })
        })
        .collect();
    let count = u32::try_from(all.len()).unwrap_or(u32::MAX);
    all.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes).then(a.pid.cmp(&b.pid)));
    all.truncate(TOP_PROCESSES);
    (all, count)
}

/// The next whitespace-delimited word of `rest`, which then starts at the
/// word after it.
fn take_word<'a>(rest: &mut &'a str) -> Option<&'a str> {
    let (w, r) = rest.split_once(char::is_whitespace)?;
    *rest = r.trim_start();
    Some(w)
}

/// `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1250.00M  free = 798.00M
/// (encrypted)" → (total, used) in bytes.
fn parse_swapusage(text: &str) -> Option<(u64, u64)> {
    let mut total = None;
    let mut used = None;
    let words: Vec<&str> = text.split_whitespace().collect();
    for w in words.windows(3) {
        if w[1] != "=" {
            continue;
        }
        let bytes = parse_suffixed(w[2]);
        match w[0] {
            "total" => total = bytes,
            "used" => used = bytes,
            _ => {}
        }
    }
    Some((total?, used?))
}

/// "1250.00M" → bytes; K, M, G, T suffixes, binary.
fn parse_suffixed(s: &str) -> Option<u64> {
    let (num, unit) = s.split_at(s.len() - s.chars().last()?.len_utf8());
    let (num, mult): (&str, u64) = match unit.to_ascii_uppercase().as_str() {
        "K" => (num, 1 << 10),
        "M" => (num, 1 << 20),
        "G" => (num, 1 << 30),
        "T" => (num, 1 << 40),
        "B" => (num, 1),
        _ => (s, 1),
    };
    let n: f64 = num.parse().ok()?;
    (n >= 0.0).then_some((n * mult as f64) as u64)
}

/// One `df -k -P -l` row: (filesystem, mount, total, used, free) in bytes.
/// The mount is found by its leading '/', since both it and the filesystem
/// ("map auto_home") may carry spaces.
fn parse_df_row(row: &str) -> Option<(String, String, u64, u64, u64)> {
    let t: Vec<&str> = row.split_whitespace().collect();
    let i = t.iter().position(|w| w.parse::<u64>().is_ok())?;
    if i == 0 || t.len() < i + 5 {
        return None;
    }
    let blocks: u64 = t[i].parse().ok()?;
    let used: u64 = t[i + 1].parse().ok()?;
    let avail: u64 = t[i + 2].parse().ok()?;
    let m = (i + 3..t.len()).find(|&j| t[j].starts_with('/'))?;
    Some((
        t[..i].join(" "),
        t[m..].join(" "),
        blocks * 1024,
        used * 1024,
        avail * 1024,
    ))
}

/// The volumes worth showing: the root volume, and the ones under
/// `/Volumes/` — external drives, images, extra containers. The rest of
/// an APFS boot container (`/System/Volumes/{Data,VM,Preboot,Update…}`)
/// shares the root's space and would be the same numbers repeated.
fn parse_df(text: &str) -> Vec<Disk> {
    text.lines()
        .skip(1)
        .filter_map(parse_df_row)
        .filter(|(fs, mount, total, _, _)| {
            fs.starts_with("/dev/")
                && *total > 0
                && (mount == "/" || mount.starts_with("/Volumes/"))
        })
        .map(|(_, mount, total, used, free)| Disk {
            name: mount
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            mount,
            total_bytes: Some(total),
            used_bytes: Some(used),
            free_bytes: Some(free),
            ..Default::default()
        })
        .collect()
}

/// `mount` output, "/dev/disk3s1s1 on / (apfs, sealed, local, …)" →
/// mount point → filesystem type.
fn parse_mount(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|l| {
            let (_, rest) = l.split_once(" on ")?;
            let (mount, opts) = rest.rsplit_once(" (")?;
            let fs = opts.trim_end_matches(')').split(',').next()?.trim();
            (!fs.is_empty()).then(|| (mount.to_string(), fs.to_string()))
        })
        .collect()
}

/// `diskutil info /`: the volume's name and whether the medium is solid state.
fn parse_diskutil(text: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut kind = None;
    for l in text.lines() {
        let Some((k, v)) = l.split_once(':') else {
            continue;
        };
        let v = v.trim();
        match k.trim() {
            "Volume Name" if !v.is_empty() && v != "Not applicable (no file system)" => {
                name = Some(v.to_string());
            }
            "Solid State" => {
                kind = match v {
                    "Yes" => Some("ssd".to_string()),
                    "No" => Some("hdd".to_string()),
                    _ => None,
                };
            }
            _ => {}
        }
    }
    (name, kind)
}

/// `ioreg -r -d 1 -c IOAccelerator`: the first accelerator's
/// `PerformanceStatistics` — utilisation and the memory in use.
fn parse_ioreg_gpu(text: &str) -> (Option<f64>, Option<u64>) {
    let stats = text
        .lines()
        .find(|l| l.contains("\"PerformanceStatistics\""))
        .unwrap_or("");
    let usage = ioreg_number(stats, "\"Device Utilization %\"").and_then(|s| s.parse::<f64>().ok());
    let used = ioreg_number(stats, "\"In use system memory\"").and_then(|s| s.parse::<u64>().ok());
    (usage, used)
}

/// The digits after `"key"=` in an inline ioreg dictionary.
fn ioreg_number<'a>(stats: &'a str, key: &str) -> Option<&'a str> {
    let i = stats.find(key)? + key.len();
    let rest = stats[i..].trim_start().strip_prefix('=')?.trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

/// What one `powermetrics` report says.
#[derive(Debug, Default, PartialEq)]
struct PowerMetrics {
    cpu_die_c: Option<f64>,
    gpu_die_c: Option<f64>,
    cpu_power_w: Option<f64>,
    gpu_power_w: Option<f64>,
}

/// "CPU die temperature: 52.39 C" (Intel's smc sampler), "GPU Power: 56 mW"
/// (Apple Silicon's gpu_power sampler) and their siblings.
fn parse_powermetrics(text: &str) -> PowerMetrics {
    let mut p = PowerMetrics::default();
    let number = |s: &str| -> Option<f64> { s.split_whitespace().next()?.parse().ok() };
    let watts = |s: &str| -> Option<f64> {
        let n = number(s)?;
        let unit = s.split_whitespace().nth(1).unwrap_or("W");
        match unit {
            "mW" => Some(n / 1000.0),
            "W" => Some(n),
            _ => None,
        }
    };
    for l in text.lines() {
        let Some((k, v)) = l.split_once(':') else {
            continue;
        };
        let v = v.trim();
        match k.trim() {
            "CPU die temperature" => p.cpu_die_c = number(v),
            "GPU die temperature" => p.gpu_die_c = number(v),
            "CPU Power" => p.cpu_power_w = watts(v),
            "GPU Power" => p.gpu_power_w = watts(v),
            _ => {}
        }
    }
    p
}

/// `netstat -ib` rows: name → (rx bytes, tx bytes), first row per
/// interface (every row of one interface repeats its counters). A name
/// ending in '*' is an interface that is down.
fn parse_netstat(text: &str) -> Vec<(String, u64, u64)> {
    let mut lines = text.lines();
    let Some(header) = lines.next() else {
        return Vec::new();
    };
    let h: Vec<&str> = header.split_whitespace().collect();
    // Distance from the end of the row: robust to an optional trailing column.
    let from_end = |col: &str| h.iter().position(|c| *c == col).map(|i| h.len() - i);
    let (Some(ib), Some(ob)) = (from_end("Ibytes"), from_end("Obytes")) else {
        return Vec::new();
    };
    let mut out: Vec<(String, u64, u64)> = Vec::new();
    for l in lines {
        let t: Vec<&str> = l.split_whitespace().collect();
        if t.len() < ib.max(ob) + 1 {
            continue;
        }
        let name = t[0];
        if name.ends_with('*') || out.iter().any(|(n, _, _)| n == name) {
            continue;
        }
        let (Ok(rx), Ok(tx)) = (
            t[t.len() - ib].parse::<u64>(),
            t[t.len() - ob].parse::<u64>(),
        ) else {
            continue;
        };
        out.push((name.to_string(), rx, tx));
    }
    out
}

/// `pmset -g batt`: percent and whether it is charging; `None` when the
/// machine has no battery ("Now drawing from 'AC Power'" and nothing more).
fn parse_pmset(text: &str) -> Option<Battery> {
    let l = text.lines().find(|l| l.contains("InternalBattery"))?;
    // "…\t85%; discharging; 4:32 remaining present: true"
    let pct_at = l.find('%')?;
    let digits = l[..pct_at].trim_end_matches(|c: char| !c.is_ascii_digit());
    let start = digits
        .rfind(|c: char| !c.is_ascii_digit())
        .map_or(0, |i| i + 1);
    let percent = digits[start..].parse::<f64>().ok();
    let charging = l[pct_at + 1..]
        .trim_start_matches(';')
        .split(';')
        .next()
        .map(|state| {
            let state = state.trim().to_ascii_lowercase();
            state.starts_with("charging") || state.starts_with("finishing charge")
        });
    Some(Battery {
        percent,
        charging,
        health_pct: None,
        cycles: None,
        condition: None,
    })
}

/// What `system_profiler` knows about the battery that `pmset` does not:
/// slow-changing, so read with the slow facts and carried between samples.
#[derive(Clone, Debug, Default, PartialEq)]
struct BatteryHealth {
    /// Of the design capacity, 0–100.
    max_capacity_pct: Option<f64>,
    cycles: Option<u64>,
    /// "Normal", "Service Recommended"…, as macOS words it.
    condition: Option<String>,
}

/// `system_profiler SPPowerDataType -json`, its
/// `sppower_battery_health_info` dict: `…_maximum_capacity` ("85 %") → 85,
/// `…_cycle_count` (a number), `sppower_battery_health` (a word).
fn parse_battery_health(json: &str) -> Option<BatteryHealth> {
    let v: Value = serde_json::from_str(json).ok()?;
    let h = v
        .get("SPPowerDataType")?
        .as_array()?
        .iter()
        .find_map(|e| e.get("sppower_battery_health_info"))?;
    Some(BatteryHealth {
        max_capacity_pct: h
            .get("sppower_battery_health_maximum_capacity")
            .and_then(Value::as_str)
            .and_then(|s| s.trim_end_matches('%').trim().parse::<f64>().ok()),
        cycles: h
            .get("sppower_battery_cycle_count")
            .and_then(|c| c.as_u64().or_else(|| c.as_str()?.trim().parse().ok())),
        condition: h
            .get("sppower_battery_health")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    })
}

// ── OS updates ──────────────────────────────────────────────────────────────

/// `softwareupdate -l` stdout. Since Big Sur each update is two lines:
///
/// ```text
/// * Label: macOS Sonoma 14.6.1-23G93
///     Title: macOS Sonoma 14.6.1, Version: 14.6.1, Size: 1234567KiB, Recommended: YES, Action: restart,
/// ```
///
/// Catalina and before printed the label after "* " and, on the next line,
/// "title (version), 3123456K [recommended] [restart]"; both are read. "No
/// new software available." goes to stderr, so an empty stdout is no update.
fn parse_softwareupdate(text: &str) -> Vec<Update> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let head = lines[i].trim();
        i += 1;
        let Some(head) = head.strip_prefix("* ") else {
            continue;
        };
        let detail = match lines.get(i).map(|d| d.trim()) {
            Some(d) if !d.is_empty() && !d.starts_with("* ") => {
                i += 1;
                d
            }
            _ => "",
        };
        let mut u = Update::default();
        if let Some(label) = head.strip_prefix("Label:") {
            let label = label.trim();
            u.id = Some(label.to_string());
            for field in detail.split(", ") {
                let Some((k, v)) = field.split_once(':') else {
                    continue;
                };
                let v = v.trim().trim_end_matches(',').trim();
                match k.trim() {
                    "Title" => u.title = v.to_string(),
                    "Size" => u.size_bytes = parse_update_size(v),
                    "Recommended" => {
                        if v.eq_ignore_ascii_case("yes") {
                            u.severity = Some("recommended".into());
                        }
                    }
                    "Action" => u.restart = Some(v.eq_ignore_ascii_case("restart")),
                    _ => {}
                }
            }
            if u.title.is_empty() {
                u.title = label.to_string();
            }
        } else {
            let label = head.trim();
            u.id = Some(label.to_string());
            let (desc, tags) = detail.split_once(", ").unwrap_or((detail, ""));
            let title = desc.split(" (").next().unwrap_or(desc).trim();
            u.title = if title.is_empty() {
                label.to_string()
            } else {
                title.to_string()
            };
            u.size_bytes = tags.split_whitespace().next().and_then(parse_update_size);
            if tags.contains("[recommended]") {
                u.severity = Some("recommended".into());
            }
            if !tags.is_empty() {
                u.restart = Some(tags.contains("[restart]"));
            }
        }
        out.push(u);
    }
    out
}

/// "1234567KiB", "3123456K", "512MiB" → bytes; a bare number is bytes.
fn parse_update_size(s: &str) -> Option<u64> {
    let s = s.trim();
    let split = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    if unit.trim().is_empty() {
        return num.parse().ok();
    }
    parse_size(&format!("{num} {}", unit.trim()))
}

/// `/Library/Receipts/InstallHistory.plist` as XML: an array of dicts with
/// `date`, `displayName`, `displayVersion` and `processName`, oldest first.
/// The OS's own installs are the ones `softwareupdated` or the OS Installer
/// wrote, or whose name starts with "macOS"; the last `keep` of them,
/// newest first. The version is appended when the name does not carry it.
fn parse_install_history(xml: &str, keep: usize) -> Vec<Installed> {
    let mut out: Vec<Installed> = xml
        .split("<dict>")
        .skip(1)
        .filter_map(|d| {
            let d = d.split("</dict>").next().unwrap_or(d);
            let name = plist_string(d, "displayName")?;
            let process = plist_string(d, "processName").unwrap_or_default();
            let ours = matches!(process.as_str(), "softwareupdated" | "OS Installer")
                || name.starts_with("macOS");
            if !ours || name.is_empty() {
                return None;
            }
            let version = plist_string(d, "displayVersion").unwrap_or_default();
            let title = if version.is_empty() || name.contains(&version) {
                name
            } else {
                format!("{name} {version}")
            };
            Some(Installed {
                title,
                at: plist_string(d, "date").filter(|s| !s.is_empty()),
            })
        })
        .collect();
    let mut out = out.split_off(out.len().saturating_sub(keep));
    out.reverse();
    out
}

/// The text of the value after `<key>name</key>` in a plist dict, whatever
/// its tag (`<string>`, `<date>`), the XML entities decoded.
fn plist_string(dict: &str, key: &str) -> Option<String> {
    let tag = format!("<key>{key}</key>");
    let after = &dict[dict.find(&tag)? + tag.len()..];
    let open = after.find('<')?;
    let close = open + after[open..].find('>')? + 1;
    if after[open..close].ends_with("/>") {
        return Some(String::new());
    }
    let end = close + after[close..].find('<')?;
    Some(
        after[close..end]
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&"),
    )
}

/// A plist as XML, whatever it is on disk: `plutil -convert xml1 -o -`
/// reads binary and XML alike (and `-o -` leaves the file alone); when that
/// fails the file itself is read, which serves an XML one.
fn plist_xml(path: &str, deadline: Duration) -> Result<String, Failed> {
    let mut plutil = Command::new("plutil");
    plutil.args(["-convert", "xml1", "-o", "-", path]);
    output_or(plutil, deadline)
        .or_else(|_| std::fs::read_to_string(path).map_err(|e| Failed::Spawn(e.to_string())))
}

/// Every `<dict>…</dict>` of a plist, outermost first, each as its own
/// text with the dicts nested in it cut out — so a key lookup on one
/// (`plist_string`) sees that dict's values and not a child's repeat of
/// the same key. With each, how deep it sits: 0 is the root.
fn plist_dicts(xml: &str) -> Vec<(usize, String)> {
    const OPEN: &str = "<dict>";
    const CLOSE: &str = "</dict>";
    // (where `<dict>` starts, where `</dict>` starts, depth), in closing order.
    let mut spans: Vec<(usize, usize, usize)> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut i = 0;
    loop {
        let open = xml[i..].find(OPEN).map(|o| i + o);
        let close = xml[i..].find(CLOSE).map(|c| i + c);
        match (open, close) {
            (Some(o), Some(c)) if o < c => {
                stack.push(o);
                i = o + OPEN.len();
            }
            (Some(o), None) => {
                stack.push(o);
                i = o + OPEN.len();
            }
            (_, Some(c)) => {
                if let Some(o) = stack.pop() {
                    spans.push((o, c, stack.len()));
                }
                i = c + CLOSE.len();
            }
            (None, None) => break,
        }
    }
    spans.sort_unstable();
    spans
        .iter()
        .map(|&(open, close, depth)| {
            let mut own = String::new();
            let mut cursor = open + OPEN.len();
            for &(o, c, d) in &spans {
                if d == depth + 1 && o > open && c < close {
                    own.push_str(&xml[cursor..o]);
                    cursor = c + CLOSE.len();
                }
            }
            own.push_str(&xml[cursor..close]);
            (depth, own)
        })
        .collect()
}

/// What the OS's updater says, hourly on its own thread. The pending list
/// is `softwareupdate -l --no-scan` — the OS's own last scan, so no
/// network and a second; when that is refused, one real scan, which asks
/// Apple's servers and can take a minute. The installed list is the
/// receipts history, read through `plutil -convert xml1` (its `json`
/// output refuses the `<date>` values this file is full of) or straight
/// from the file, which is XML on disk anyway. macOS keeps no "restart
/// pending" flag a tool can read, so that stays `None`.
pub fn read_updates() -> Updates {
    let mut u = Updates {
        checked_at: Some(crate::state::now_rfc3339()),
        ..Default::default()
    };
    let mut cached = Command::new("softwareupdate");
    cached.args(["-l", "--no-scan"]);
    let listed = output_or(cached, SOFTWAREUPDATE).or_else(|_| {
        let mut scan = Command::new("softwareupdate");
        scan.arg("-l");
        output_or(scan, SOFTWAREUPDATE)
    });
    match listed {
        Ok(text) => u.pending = parse_softwareupdate(&text),
        Err(e) => u.error = Some(format!("softwareupdate -l failed ({e})")),
    }
    match plist_xml(INSTALL_HISTORY, QUICK) {
        Ok(xml) => u.installed = parse_install_history(&xml, INSTALLED_KEPT),
        Err(e) => {
            let line = format!("install history not readable ({e})");
            u.error = Some(match u.error.take() {
                Some(first) => format!("{first}; {line}"),
                None => line,
            });
        }
    }
    u
}

// ── browsers ────────────────────────────────────────────────────────────────

/// The kind, display name and channel a bundle name stands for, when it is
/// one of the Chromium browsers looked for ("Google Chrome Beta.app" →
/// chrome, "Google Chrome", beta).
fn browser_bundle(file: &str) -> Option<(&'static str, &'static str, &'static str)> {
    BROWSER_BUNDLES
        .iter()
        .find(|b| b.0 == file)
        .map(|b| (b.1, b.2, b.3))
}

/// What a bundle's `Info.plist` says about it.
#[derive(Debug, Default, PartialEq)]
struct BundleInfo {
    /// `CFBundleShortVersionString`: "128.0.6613.120".
    version: Option<String>,
    /// `CFBundleIdentifier`: "com.google.Chrome".
    id: Option<String>,
}

/// A bundle's `Info.plist` as XML: the version and bundle id from its root
/// dict — the dicts nested in it (document types, URL types) do not get a
/// say. `None` when there is no dict at all, which is not a plist.
fn parse_bundle_info(xml: &str) -> Option<BundleInfo> {
    let (_, root) = plist_dicts(xml)
        .into_iter()
        .find(|(depth, _)| *depth == 0)?;
    let s = |k: &str| {
        plist_string(&root, k)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    Some(BundleInfo {
        version: s("CFBundleShortVersionString"),
        id: s("CFBundleIdentifier"),
    })
}

/// LaunchServices' handler list as XML: the bundle id the console user
/// opens `http` with, lowercased. Each `LSHandlers` entry is a dict naming
/// a URL scheme or a content type and the handler per role; the
/// `LSHandlerPreferredVersions` dict newer entries nest repeats the role
/// keys with "-", which is why the lookup sees each dict's own values only.
/// No entry for http means nobody chose — Safari stands in, and it is not
/// Chromium — so `None`.
fn parse_http_handler(xml: &str) -> Option<String> {
    plist_dicts(xml).iter().find_map(|(_, d)| {
        let scheme = plist_string(d, "LSHandlerURLScheme")?;
        if !scheme.trim().eq_ignore_ascii_case("http") {
            return None;
        }
        ["LSHandlerRoleAll", "LSHandlerRoleViewer"]
            .iter()
            .find_map(|role| plist_string(d, role))
            .map(|id| id.trim().to_ascii_lowercase())
            .filter(|id| !id.is_empty() && id != "-")
    })
}

/// Whether `ps -axo comm=` lists a process inside the bundle. `comm` is
/// the executable's full path, and a bundle's own binary
/// (`Contents/MacOS/…`) and its helpers (`Contents/Frameworks/…`) all start
/// with the bundle's path; the '/' after it keeps "Google Chrome.app" from
/// matching "Google Chrome.app 2".
fn bundle_running(ps: &str, bundle: &str) -> bool {
    ps.lines().any(|l| {
        l.trim()
            .strip_prefix(bundle)
            .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// `dscl . -read /Users/<name> NFSHomeDirectory` → "NFSHomeDirectory:
/// /Users/name", the value.
fn parse_dscl_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == key)
            .then(|| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// The console user's home. `/dev/console` is owned by whoever is logged
/// in at the login window — root when nobody is, and Setup Assistant's
/// `_mbsetupuser` before there is anybody — and Directory Services says
/// where their home is; `/Users/<name>` when it does not answer.
fn console_home() -> Option<String> {
    let mut stat = Command::new("stat");
    stat.args(["-f", "%Su", "/dev/console"]);
    let name = output(stat, CONSOLE_USER)?.trim().to_string();
    if name.is_empty() || name == "root" || name.starts_with('_') {
        return None;
    }
    let mut dscl = Command::new("dscl");
    dscl.args([".", "-read", &format!("/Users/{name}"), "NFSHomeDirectory"]);
    Some(
        output(dscl, CONSOLE_USER)
            .and_then(|t| parse_dscl_value(&t, "NFSHomeDirectory"))
            .unwrap_or_else(|| format!("/Users/{name}")),
    )
}

/// A known browser bundle found in an Applications folder.
struct FoundBundle {
    /// "Google Chrome.app" — what the error lines name.
    file: String,
    kind: &'static str,
    name: &'static str,
    channel: &'static str,
    /// The bundle's full path.
    path: String,
}

/// The known browser bundles in one Applications folder. A folder that is
/// not there — the console user may have no `~/Applications` — is empty;
/// one that cannot be read is `Err`.
fn browser_bundles_in(dir: &str) -> std::io::Result<Vec<FoundBundle>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let file = entry.file_name();
        let Some(file) = file.to_str() else {
            continue;
        };
        let Some((kind, name, channel)) = browser_bundle(file) else {
            continue;
        };
        let path = format!("{dir}/{file}");
        if Path::new(&path).is_dir() {
            out.push(FoundBundle {
                file: file.to_string(),
                kind,
                name,
                channel,
                path,
            });
        }
    }
    Ok(out)
}

/// The Chromium browsers installed, and what could not be read about them.
/// Every known bundle under `/Applications` and the console user's
/// `~/Applications` is one; its `Info.plist` gives the version and bundle
/// id, one `ps` says which have a process alive, and the console user's
/// LaunchServices handler list says which one opens `http`. A bundle whose
/// Info.plist cannot be read is still listed, without a version, and is one
/// line in the errors; nothing installed is nothing to say. The error lines
/// name the bundle, never its path: a per-user path carries the user's
/// name and the errors reach the open page.
fn read_browsers(home: Option<&str>) -> (Vec<Browser>, Vec<String>) {
    let mut errors = Vec::new();
    let mut dirs = vec![APPLICATIONS.to_string()];
    if let Some(home) = home {
        dirs.push(format!("{home}/Applications"));
    }
    // Each browser with its bundle id, which the default-browser match needs.
    let mut found: Vec<(Browser, Option<String>)> = Vec::new();
    for (i, dir) in dirs.iter().enumerate() {
        let bundles = match browser_bundles_in(dir) {
            Ok(b) => b,
            Err(e) => {
                let which = if i == 0 {
                    APPLICATIONS
                } else {
                    "~/Applications"
                };
                errors.push(format!("{which} is not readable ({e})"));
                continue;
            }
        };
        for b in bundles {
            let info = match plist_xml(&format!("{}/Contents/Info.plist", b.path), PLIST) {
                Ok(xml) => parse_bundle_info(&xml).unwrap_or_else(|| {
                    errors.push(format!("{}: Info.plist holds no dict", b.file));
                    BundleInfo::default()
                }),
                Err(e) => {
                    errors.push(format!("{}: Info.plist not readable ({e})", b.file));
                    BundleInfo::default()
                }
            };
            found.push((
                Browser {
                    name: b.name.into(),
                    kind: b.kind.into(),
                    version: info.version,
                    channel: Some(b.channel.into()),
                    path: Some(b.path),
                    running: false,
                    default_browser: false,
                },
                info.id,
            ));
        }
    }
    if found.is_empty() {
        return (Vec::new(), errors);
    }

    let mut ps = Command::new("ps");
    ps.args(["-axww", "-o", "comm="]);
    match output_or(ps, PS) {
        Ok(t) => {
            for (b, _) in &mut found {
                b.running = b.path.as_deref().is_some_and(|p| bundle_running(&t, p));
            }
        }
        Err(e) => errors.push(format!("ps failed ({e}); which browsers run is not known")),
    }

    match home {
        Some(home) => match plist_xml(&format!("{home}/{LS_HANDLERS}"), PLIST) {
            Ok(xml) => {
                if let Some(handler) = parse_http_handler(&xml) {
                    for (b, id) in &mut found {
                        b.default_browser = id
                            .as_deref()
                            .is_some_and(|id| id.eq_ignore_ascii_case(&handler));
                    }
                }
            }
            Err(e) => errors.push(format!(
                "default browser not known: the LaunchServices handler list is not readable ({e})"
            )),
        },
        None => errors.push("default browser not known: nobody is logged in at the console".into()),
    }

    found.sort_by(|a, b| a.0.kind.cmp(&b.0.kind).then(a.0.path.cmp(&b.0.path)));
    (found.into_iter().map(|(b, _)| b).collect(), errors)
}

// ── installed applications ──────────────────────────────────────────────────

/// How long the whole inventory may take: a hundred bundles, each an
/// `Info.plist` read and now and then a `plutil`, is seconds; this is for
/// a network volume that stopped answering.
const APPS_DEADLINE: Duration = Duration::from_secs(45);
/// Where Homebrew keeps the casks it installed, on Apple Silicon and Intel.
const CASKROOMS: &[&str] = &["/opt/homebrew/Caskroom", "/usr/local/Caskroom"];

/// The `.app` bundles in a folder, and — one level down — in the folders
/// that are not bundles themselves (`/Applications/Utilities`,
/// `/Applications/Setapp`). A folder that is not there is empty.
fn app_bundles_in(dir: &str) -> std::io::Result<Vec<String>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Some(file) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let path = format!("{dir}/{file}");
        if !Path::new(&path).is_dir() {
            continue;
        }
        if file.ends_with(".app") {
            out.push(path);
        } else if !file.starts_with('.') {
            if let Ok(inner) = std::fs::read_dir(&path) {
                out.extend(inner.flatten().filter_map(|e| {
                    let f = e.file_name().to_str()?.to_string();
                    let p = format!("{path}/{f}");
                    (f.ends_with(".app") && Path::new(&p).is_dir()).then_some(p)
                }));
            }
        }
    }
    Ok(out)
}

/// What an application's `Info.plist` says about it.
#[derive(Clone, Debug, Default, PartialEq)]
struct AppInfo {
    /// `CFBundleDisplayName`, else `CFBundleName`.
    name: Option<String>,
    /// `CFBundleShortVersionString`, else `CFBundleVersion` (a build number).
    version: Option<String>,
    id: Option<String>,
}

fn parse_app_info(xml: &str) -> Option<AppInfo> {
    let (_, root) = plist_dicts(xml)
        .into_iter()
        .find(|(depth, _)| *depth == 0)?;
    let s = |k: &str| {
        plist_string(&root, k)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    Some(AppInfo {
        name: s("CFBundleDisplayName").or_else(|| s("CFBundleName")),
        version: s("CFBundleShortVersionString").or_else(|| s("CFBundleVersion")),
        id: s("CFBundleIdentifier"),
    })
}

/// A bundle's `Info.plist` as XML: most are XML on disk and are read as a
/// file; a binary one goes through `plutil`.
fn app_plist_xml(path: &str) -> Result<String, Failed> {
    if let Ok(text) = std::fs::read_to_string(path) {
        let head = text.trim_start_matches('\u{feff}').trim_start();
        if head.starts_with("<?xml") || head.starts_with("<plist") {
            return Ok(text);
        }
    }
    plist_xml(path, PLIST)
}

/// The `.app` names Homebrew's caskrooms hold, so a bundle copied (not
/// linked) into /Applications is still known as Homebrew's.
fn caskroom_apps() -> HashSet<String> {
    let mut out = HashSet::new();
    for room in CASKROOMS {
        let Ok(casks) = std::fs::read_dir(room) else {
            continue;
        };
        for cask in casks.flatten() {
            let Ok(versions) = std::fs::read_dir(cask.path()) else {
                continue;
            };
            for v in versions.flatten() {
                let Ok(files) = std::fs::read_dir(v.path()) else {
                    continue;
                };
                out.extend(files.flatten().filter_map(|f| {
                    let name = f.file_name().to_str()?.to_string();
                    name.ends_with(".app").then_some(name)
                }));
            }
        }
    }
    out
}

/// Where a bundle came from: the App Store leaves a receipt, Homebrew
/// links or copies from its caskroom, Setapp has its own folder, Apple's
/// own carry Apple's bundle prefix, and the rest were dragged in.
fn app_source(path: &str, file: &str, id: Option<&str>, casks: &HashSet<String>) -> &'static str {
    if Path::new(&format!("{path}/Contents/_MASReceipt/receipt")).is_file() {
        return "app-store";
    }
    let linked_from_cask = std::fs::read_link(path)
        .ok()
        .is_some_and(|t| t.to_string_lossy().contains("/Caskroom/"));
    if linked_from_cask || casks.contains(file) {
        return "homebrew";
    }
    if path.starts_with("/Applications/Setapp/") {
        return "setapp";
    }
    if id.is_some_and(|i| i.starts_with("com.apple.")) {
        return "apple";
    }
    "applications"
}

/// A file's modification day, "YYYY-MM-DD".
fn modified_day(path: &str) -> Option<String> {
    let t = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    let ago = std::time::SystemTime::now().duration_since(t).ok()?;
    let stamp = crate::state::rfc3339_ago(ago.as_secs());
    stamp.get(..10).map(str::to_string)
}

/// Everything installed under `/Applications` (and one folder down) and
/// the console user's `~/Applications`: name and version from each
/// bundle's `Info.plist`, the day the bundle was written, and where it
/// came from. Homebrew's own list is not asked for — `brew` refuses to run
/// as root, which the daemon is. The error lines name bundles, not paths,
/// as the browsers' do.
fn read_apps(home: Option<&str>) -> (Vec<App>, Vec<String>) {
    let started = Instant::now();
    let mut errors = Vec::new();
    let mut dirs = vec![APPLICATIONS.to_string()];
    if let Some(home) = home {
        dirs.push(format!("{home}/Applications"));
    }
    let casks = caskroom_apps();
    let mut out = Vec::new();
    'dirs: for (i, dir) in dirs.iter().enumerate() {
        let bundles = match app_bundles_in(dir) {
            Ok(b) => b,
            Err(e) => {
                let which = if i == 0 {
                    APPLICATIONS
                } else {
                    "~/Applications"
                };
                errors.push(format!("apps: {which} is not readable ({e})"));
                continue;
            }
        };
        for path in bundles {
            if started.elapsed() > APPS_DEADLINE {
                errors.push(format!(
                    "apps: inventory cut short after {} bundles",
                    out.len()
                ));
                break 'dirs;
            }
            let file = path.rsplit('/').next().unwrap_or(&path).to_string();
            let info = match app_plist_xml(&format!("{path}/Contents/Info.plist")) {
                Ok(xml) => parse_app_info(&xml).unwrap_or_default(),
                Err(e) => {
                    errors.push(format!("apps: {file}: Info.plist not readable ({e})"));
                    AppInfo::default()
                }
            };
            let source = app_source(&path, &file, info.id.as_deref(), &casks);
            let name = info
                .name
                .unwrap_or_else(|| file.trim_end_matches(".app").to_string());
            out.push(App {
                kind: if file == "Steam.app" {
                    "launcher"
                } else {
                    "app"
                }
                .into(),
                version: info.version,
                publisher: None,
                installed_at: modified_day(&path),
                size_bytes: None,
                source: Some(source.into()),
                path: Some(path),
                name,
            });
        }
    }
    (super::tidy_apps(out), errors)
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

        // CPU: ticks since the previous sample.
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

        // Memory.
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

        // Disks.
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

        // GPU: IOKit's accelerator statistics for the first accelerator.
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

        // Network: the default route's interface plus every en*/bridge* that
        // is up and has moved bytes.
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

        // Battery.
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

        // Processes: the heaviest by resident memory, and the count.
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

        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardware_keeps_model_and_drops_identity() {
        let j = r#"{"SPHardwareDataType":[{"_name":"hardware_overview",
            "boot_rom_version":"10151.101.3","chip_type":"Apple M1 Pro",
            "machine_model":"MacBookPro18,3","machine_name":"MacBook Pro",
            "serial_number":"C02XXXXXXXXX","platform_UUID":"ABCD-1234"}]}"#;
        let m = parse_hardware(j).expect("parses");
        assert_eq!(m.model.as_deref(), Some("MacBook Pro"));
        assert_eq!(m.board_product.as_deref(), Some("MacBookPro18,3"));
        assert_eq!(m.chip.as_deref(), Some("Apple M1 Pro"));
        assert_eq!(m.bios_version.as_deref(), Some("10151.101.3"));
        assert_eq!(m.manufacturer.as_deref(), Some("Apple"));
        assert_eq!(m.form.as_deref(), Some("laptop"));
        let dump = format!("{m:?}");
        assert!(!dump.contains("C02XXXXXXXXX") && !dump.contains("ABCD-1234"));
    }

    #[test]
    fn form_from_name_or_identifier() {
        assert_eq!(form_of("MacBook Air"), Some("laptop"));
        assert_eq!(form_of("MacBookPro16,1"), Some("laptop"));
        assert_eq!(form_of("Mac mini"), Some("mini"));
        assert_eq!(form_of("Macmini8,1"), Some("mini"));
        assert_eq!(form_of("Mac Studio"), Some("desktop"));
        assert_eq!(form_of("MacPro7,1"), Some("desktop"));
        assert_eq!(form_of("iMac"), Some("all-in-one"));
        assert_eq!(form_of("iMacPro1,1"), Some("all-in-one"));
        assert_eq!(form_of("Virtual Machine"), None);
    }

    #[test]
    fn memory_apple_silicon_is_one_module_on_package() {
        let j = r#"{"SPMemoryDataType":[{"SPMemoryDataType":"36 GB",
            "dimm_manufacturer":"Apple","dimm_type":"LPDDR5"}]}"#;
        let m = parse_memory(j, Some(36 << 30)).expect("parses");
        assert_eq!(m.slots, Some(0));
        assert_eq!(m.max_capacity_bytes, Some(36 << 30));
        assert_eq!(m.modules.len(), 1);
        let module = &m.modules[0];
        assert_eq!(module.locator.as_deref(), Some("on package"));
        assert_eq!(module.size_bytes, Some(36 << 30));
        assert_eq!(module.kind.as_deref(), Some("LPDDR5"));
        assert_eq!(module.manufacturer.as_deref(), Some("Apple"));
        assert_eq!(module.speed_mts, None);
        // Without hw.memsize the printed size stands in.
        let m = parse_memory(j, None).expect("parses");
        assert_eq!(m.modules[0].size_bytes, Some(36 << 30));
    }

    #[test]
    fn memory_intel_is_one_module_per_fitted_dimm() {
        let j = r#"{"SPMemoryDataType":[{"_name":"Memory Slots","_items":[
            {"_name":"BANK 0/DIMM0","dimm_manufacturer":"0x802C","dimm_part_number":"0x3842",
             "dimm_serial_number":"0xDEADBEEF","dimm_size":"8 GB","dimm_speed":"2667 MHz",
             "dimm_status":"ok","dimm_type":"DDR4"},
            {"_name":"BANK 2/DIMM1","dimm_size":"8 GB","dimm_speed":"2667 MHz",
             "dimm_status":"ok","dimm_type":"DDR4"},
            {"_name":"BANK 1/DIMM0","dimm_size":"empty","dimm_status":"empty"}],
            "global_ecc_state":"ecc_disabled","is_memory_upgradeable":"Yes"}]}"#;
        let m = parse_memory(j, Some(16 << 30)).expect("parses");
        assert_eq!(m.slots, Some(3));
        assert_eq!(m.max_capacity_bytes, None);
        assert_eq!(m.modules.len(), 2);
        assert_eq!(m.modules[0].locator.as_deref(), Some("BANK 0/DIMM0"));
        assert_eq!(m.modules[0].size_bytes, Some(8 << 30));
        assert_eq!(m.modules[0].speed_mts, Some(2667));
        assert_eq!(m.modules[0].kind.as_deref(), Some("DDR4"));
        assert_eq!(m.modules[0].part_number.as_deref(), Some("0x3842"));
        assert!(!format!("{m:?}").contains("0xDEADBEEF"));
        assert_eq!(parse_memory("nope", None), None);
    }

    #[test]
    fn storage_nvme_sata_usb_and_the_boot_volume() {
        let j = r#"{
          "SPNVMeDataType":[{"_name":"Apple SSD Controller","_items":[
            {"_name":"APPLE SSD AP0512Z","bsd_name":"disk0","detachable_drive":"no",
             "device_model":"APPLE SSD AP0512Z","device_revision":"387.100.","device_serial":"0ba0NVME",
             "partition_map_type":"guid_partition_map_type","removable_media":"no",
             "size":"500,28 GB","size_in_bytes":500277790720,"smart_status":"Verified",
             "volumes":[{"_name":"disk0s1","bsd_name":"disk0s1","iocontent":"Apple_APFS_ISC","size_in_bytes":524288000},
                        {"_name":"disk0s2","bsd_name":"disk0s2","iocontent":"Apple_APFS","size_in_bytes":494384795648}]}]}],
          "SPSerialATADataType":[{"_name":"Intel 8 Series Chipset","_items":[
            {"_name":"WDC WD10EZEX","bsd_name":"disk1","device_model":"WDC WD10EZEX-00BN5A0",
             "device_revision":"01.01A01","device_serial":"WD-SATA1","removable_media":"no",
             "size":"1 TB","size_in_bytes":1000204886016,"smart_status":"Not Supported",
             "spsata_medium_type":"Rotational",
             "volumes":[{"_name":"Data","bsd_name":"disk1s2","file_system":"Journaled HFS+","mount_point":"/Volumes/Data"}]},
            {"_name":"MATSHITADVD-R UJ-8A8","device_model":"MATSHITADVD-R UJ-8A8","spsata_drive_type":"optical"}]}],
          "SPUSBDataType":[{"_name":"USB31Bus","_items":[
            {"_name":"USB Hub","_items":[
              {"_name":"Ultra Fit","manufacturer":"SanDisk","serial_num":"4C53USB",
               "Media":[{"_name":"Ultra Fit","bsd_name":"disk4","removable_media":"yes",
                         "size":"30,9 GB","size_in_bytes":30934745088,"smart_status":"Verified",
                         "volumes":[{"_name":"USB","bsd_name":"disk4s1","file_system":"MS-DOS FAT32","mount_point":"/Volumes/USB"}]}]}]}]}]
        }"#;
        let d = parse_storage(j, Some("disk0s2"));
        assert_eq!(d.len(), 3, "{d:?}");
        assert_eq!(d[0].name, "APPLE SSD AP0512Z");
        assert_eq!(d[0].serial.as_deref(), Some("0ba0NVME"));
        assert_eq!(d[0].firmware.as_deref(), Some("387.100."));
        assert_eq!(d[0].size_bytes, Some(500277790720));
        assert_eq!(d[0].bus.as_deref(), Some("nvme"));
        assert_eq!(d[0].kind.as_deref(), Some("ssd"));
        assert_eq!(d[0].health.as_deref(), Some("verified"));
        assert_eq!(d[0].removable, Some(false));
        assert_eq!(d[0].volumes, vec!["/".to_string()]);
        assert_eq!(d[0].temperature_c, None);
        assert_eq!(d[1].name, "WDC WD10EZEX-00BN5A0");
        assert_eq!(d[1].bus.as_deref(), Some("sata"));
        assert_eq!(d[1].kind.as_deref(), Some("hdd"));
        assert_eq!(d[1].health.as_deref(), Some("not supported"));
        assert_eq!(d[1].volumes, vec!["/Volumes/Data".to_string()]);
        assert_eq!(d[2].name, "Ultra Fit");
        assert_eq!(d[2].bus.as_deref(), Some("usb"));
        assert_eq!(d[2].serial.as_deref(), Some("4C53USB"));
        assert_eq!(d[2].kind, None);
        assert_eq!(d[2].removable, Some(true));
        assert_eq!(d[2].volumes, vec!["/Volumes/USB".to_string()]);
        // The boot volume can also be named by the whole disk, or by nothing.
        assert_eq!(
            parse_storage(j, Some("disk1s2"))[1].volumes,
            vec!["/", "/Volumes/Data"]
        );
        assert!(parse_storage(j, None)[0].volumes.is_empty());
        assert!(parse_storage("not json", None).is_empty());
    }

    #[test]
    fn boot_store_from_diskutil() {
        assert_eq!(whole_disk("disk0s2"), "disk0");
        assert_eq!(whole_disk("disk12"), "disk12");
        assert_eq!(whole_disk("nvme0"), "nvme0");
        let apfs = "   Device Identifier:         disk3s1s1\n\
                    \x20  Part of Whole:             disk3\n\
                    \x20  Mount Point:               /\n\
                    \x20  APFS Container:            disk3\n\
                    \x20  APFS Physical Store:       disk0s2\n";
        assert_eq!(parse_physical_store(apfs).as_deref(), Some("disk0s2"));
        let hfs = "   Device Identifier:         disk1s2\n   Part of Whole:             disk1\n";
        assert_eq!(parse_physical_store(hfs).as_deref(), Some("disk1s2"));
        assert_eq!(parse_physical_store(""), None);
    }

    #[test]
    fn launchctl_rows_keep_failed_third_party_jobs() {
        let t = "PID\tStatus\tLabel\n\
                 -\t0\tcom.apple.xpc.launchd.unmanaged.loginwindow.101\n\
                 123\t0\tcom.openssh.sshd\n\
                 -\t78\tcom.apple.mdworker.shared\n\
                 -\t1\tcom.example.backup\n\
                 -\t-9\tio.tailscale.ipn.system\n\
                 456\t0\tme.daedalus.agent\n\
                 789\t3\tme.toscanini.daedalus-agent\n";
        let (down, count) = parse_launchctl(t);
        assert_eq!(count, 7);
        let names: Vec<&str> = down.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["com.example.backup", "io.tailscale.ipn.system"]);
        assert_eq!(down[0].exit_code, Some(1));
        assert_eq!(down[1].exit_code, Some(-9));
        assert_eq!(down[0].state, "exited");
        assert_eq!(down[0].display, None);
        assert_eq!(parse_launchctl(""), (Vec::new(), 0));
    }

    #[test]
    fn ps_rows_top_by_rss_with_spaced_paths() {
        let t = "    1   8192   0.1 /sbin/launchd\n\
                 \x20 512 262144  12.5 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n\
                 \x20 300  65536   0.0 /System/Library/CoreServices/WindowServer\n\
                 \x20   0   1024   0.0 kernel_task\n\
                 garbage line\n";
        let (top, count) = parse_ps(t);
        assert_eq!(count, 4);
        assert_eq!(top.len(), 4);
        assert_eq!(top[0].name, "Google Chrome");
        assert_eq!(top[0].pid, 512);
        assert_eq!(top[0].memory_bytes, Some(262144 * 1024));
        assert_eq!(top[0].cpu_pct, Some(12.5));
        assert_eq!(top[1].name, "WindowServer");
        assert_eq!(top[3].name, "kernel_task");
        // More rows than TOP_PROCESSES are cut, the count is not.
        let many: String = (1..=20)
            .map(|i| format!("{i} {} 0.0 /bin/p{i}\n", 1000 * i))
            .collect();
        let (top, count) = parse_ps(&many);
        assert_eq!(count, 20);
        assert_eq!(top.len(), TOP_PROCESSES);
        assert_eq!(top[0].name, "p20");
    }

    #[test]
    fn softwareupdate_modern_and_catalina() {
        let modern = "Software Update Tool\n\nFinding available software\n\
            Software Update found the following new or updated software:\n\
            * Label: macOS Sonoma 14.6.1-23G93\n\
            \tTitle: macOS Sonoma 14.6.1, Version: 14.6.1, Size: 1234567KiB, Recommended: YES, Action: restart,\n\
            * Label: Command Line Tools for Xcode-15.3\n\
            \tTitle: Command Line Tools for Xcode, Version: 15.3, Size: 728512KiB, Recommended: YES,\n";
        let u = parse_softwareupdate(modern);
        assert_eq!(u.len(), 2);
        assert_eq!(u[0].title, "macOS Sonoma 14.6.1");
        assert_eq!(u[0].id.as_deref(), Some("macOS Sonoma 14.6.1-23G93"));
        assert_eq!(u[0].size_bytes, Some(1234567 * 1024));
        assert_eq!(u[0].severity.as_deref(), Some("recommended"));
        assert_eq!(u[0].restart, Some(true));
        assert_eq!(u[1].title, "Command Line Tools for Xcode");
        assert_eq!(u[1].size_bytes, Some(728512 * 1024));
        assert_eq!(u[1].restart, None);
        let old = "Software Update found the following new or updated software:\n\
            \x20  * macOS Catalina 10.15.7 Update-10.15.7\n\
            \tmacOS Catalina 10.15.7 Update (10.15.7), 3123456K [recommended] [restart]\n";
        let u = parse_softwareupdate(old);
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].title, "macOS Catalina 10.15.7 Update");
        assert_eq!(
            u[0].id.as_deref(),
            Some("macOS Catalina 10.15.7 Update-10.15.7")
        );
        assert_eq!(u[0].size_bytes, Some(3123456 * 1024));
        assert_eq!(u[0].severity.as_deref(), Some("recommended"));
        assert_eq!(u[0].restart, Some(true));
        assert!(parse_softwareupdate("Software Update Tool\n").is_empty());
        assert!(parse_softwareupdate("").is_empty());
        assert_eq!(parse_update_size("512MiB"), Some(512 << 20));
        assert_eq!(parse_update_size("4096"), Some(4096));
        assert_eq!(parse_update_size("lots"), None);
    }

    #[test]
    fn install_history_last_os_installs_newest_first() {
        let entry = |date: &str, name: &str, version: &str, process: &str| {
            format!(
                "<dict>\n\t<key>date</key>\n\t<date>{date}</date>\n\t<key>displayName</key>\n\t<string>{name}</string>\n\
                 \t<key>displayVersion</key>\n\t<string>{version}</string>\n\t<key>packageIdentifiers</key>\n\
                 \t<array>\n\t\t<string>com.apple.pkg.x</string>\n\t</array>\n\
                 \t<key>processName</key>\n\t<string>{process}</string>\n</dict>\n"
            )
        };
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<array>\n",
        );
        xml += &entry("2024-01-01T00:00:00Z", "Google Chrome", "120", "Installer");
        for i in 1..=9 {
            xml += &entry(
                &format!("2025-0{i}-01T00:00:00Z"),
                "macOS Sonoma",
                &format!("14.{i}"),
                "softwareupdated",
            );
        }
        xml += &entry(
            "2025-10-01T00:00:00Z",
            "macOS Sequoia 15.0",
            "15.0",
            "OS Installer",
        );
        xml += &entry(
            "2025-11-01T00:00:00Z",
            "Rosetta &amp; Friends",
            "",
            "softwareupdated",
        );
        xml += "</array>\n</plist>\n";
        let h = parse_install_history(&xml, 8);
        assert_eq!(h.len(), 8);
        assert_eq!(h[0].title, "Rosetta & Friends");
        assert_eq!(h[0].at.as_deref(), Some("2025-11-01T00:00:00Z"));
        assert_eq!(h[1].title, "macOS Sequoia 15.0");
        assert_eq!(h[2].title, "macOS Sonoma 14.9");
        assert_eq!(h[7].title, "macOS Sonoma 14.4");
        assert!(h.iter().all(|i| !i.title.contains("Chrome")));
        assert!(parse_install_history("<plist/>", 8).is_empty());
        assert_eq!(
            plist_string("<key>a</key><string/>", "a").as_deref(),
            Some("")
        );
    }

    #[test]
    fn hardware_intel_falls_back_to_cpu_type() {
        let j = r#"{"SPHardwareDataType":[{"machine_model":"MacBookPro16,1",
            "cpu_type":"8-Core Intel Core i9","boot_rom_version":"2069.80.3.0.0"}]}"#;
        let m = parse_hardware(j).expect("parses");
        assert_eq!(m.model.as_deref(), Some("MacBookPro16,1"));
        assert_eq!(m.chip.as_deref(), Some("8-Core Intel Core i9"));
    }

    #[test]
    fn sizes() {
        assert_eq!(parse_size("16 GB"), Some(16 << 30));
        assert_eq!(parse_size("1536 MB"), Some(1536 << 20));
        assert_eq!(parse_size("shared"), None);
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_suffixed("1250.00M"), Some(1_310_720_000));
        assert_eq!(parse_suffixed("2G"), Some(2 << 30));
        assert_eq!(parse_suffixed("0.00M"), Some(0));
    }

    #[test]
    fn displays_apple_silicon_and_discrete() {
        let j = r#"{"SPDisplaysDataType":[
            {"_name":"Apple M1 Pro","spdisplays_vendor":"sppci_vendor_Apple",
             "sppci_model":"Apple M1 Pro","sppci_cores":"16"},
            {"_name":"Radeon Pro 5500M","spdisplays_vendor":"sppci_vendor_amd",
             "sppci_model":"AMD Radeon Pro 5500M","spdisplays_vram":"4 GB"},
            {"_name":"Intel UHD Graphics 630","sppci_vendor":"Intel",
             "sppci_model":"Intel UHD Graphics 630","spdisplays_vram_shared":"1536 MB"}]}"#;
        let g = parse_displays(j);
        assert_eq!(g.len(), 3);
        assert_eq!(g[0].name, "Apple M1 Pro");
        assert_eq!(g[0].vendor.as_deref(), Some("Apple"));
        assert_eq!(g[0].vram_total_bytes, None);
        assert_eq!(g[1].vendor.as_deref(), Some("AMD"));
        assert_eq!(g[1].vram_total_bytes, Some(4 << 30));
        assert_eq!(g[2].vram_total_bytes, Some(1536 << 20));
        assert!(parse_displays("not json").is_empty());
    }

    #[test]
    fn cpu_usage_from_ticks() {
        let prev = [100, 50, 800, 0];
        let now = [200, 100, 1000, 0];
        // busy 150 of 350
        let u = cpu_usage(prev, now).expect("some time passed");
        assert!((u - 42.857).abs() < 0.01, "{u}");
        assert_eq!(cpu_usage(prev, prev), None);
        // A wrapped counter still yields a sane delta.
        let u = cpu_usage([u32::MAX - 5, 0, 0, 0], [4, 0, 10, 0]).expect("wraps");
        assert!((u - 50.0).abs() < 0.01, "{u}");
    }

    #[test]
    fn vm_stat_pages() {
        let t = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
                 Pages free:                               12345.\n\
                 Pages active:                            400000.\n\
                 Pages inactive:                          300000.\n\
                 Pages speculative:                         5000.\n\
                 Pages throttled:                              0.\n\
                 Pages wired down:                        150000.\n\
                 Pages purgeable:                           1000.\n\
                 \"Translation faults\":                 123456789.\n\
                 Pages occupied by compressor:             20000.\n\
                 File-backed pages:                       100000.\n\
                 Anonymous pages:                         600000.\n";
        let v = parse_vm_stat(t).expect("parses");
        assert_eq!(v.page_size, 16384);
        assert_eq!(v.free, 12345);
        assert_eq!(v.inactive, 300000);
        assert_eq!(v.speculative, 5000);
        assert_eq!(v.available_bytes(), (12345 + 300000 + 5000) * 16384);
        assert_eq!(v.cached_bytes(), 100000 * 16384);
        assert_eq!(v.compressed_bytes(), 20000 * 16384);
        assert_eq!(parse_vm_stat("garbage"), None);
    }

    #[test]
    fn swapusage() {
        let t = "total = 2048.00M  used = 1250.00M  free = 798.00M  (encrypted)";
        assert_eq!(parse_swapusage(t), Some((2048 << 20, 1_310_720_000)));
        assert_eq!(
            parse_swapusage("total = 0.00M  used = 0.00M  free = 0.00M"),
            Some((0, 0))
        );
        assert_eq!(parse_swapusage(""), None);
    }

    #[test]
    fn df_rows_and_filter() {
        let t = "Filesystem     1024-blocks      Used Available Capacity  Mounted on\n\
                 /dev/disk3s1s1   482797904  10262888 227150976     5%    /\n\
                 devfs                  204       204         0   100%    /dev\n\
                 /dev/disk3s6     482797904   4194320 227150976     2%    /System/Volumes/VM\n\
                 /dev/disk3s2     482797904   6291456 227150976     3%    /System/Volumes/Preboot\n\
                 /dev/disk3s5     482797904 240001024 227150976    52%    /System/Volumes/Data\n\
                 map auto_home            0         0         0   100%    /System/Volumes/Data/home\n\
                 /dev/disk5s1      976285184 512000000 464285184    53%    /Volumes/My Backup\n";
        let d = parse_df(t);
        let mounts: Vec<&str> = d.iter().map(|x| x.mount.as_str()).collect();
        assert_eq!(mounts, vec!["/", "/Volumes/My Backup"]);
        assert_eq!(d[0].total_bytes, Some(482797904 * 1024));
        assert_eq!(d[0].used_bytes, Some(10262888 * 1024));
        assert_eq!(d[0].free_bytes, Some(227150976 * 1024));
        assert_eq!(d[1].name.as_deref(), Some("My Backup"));
        let row = parse_df_row("map auto_home  0 0 0 100% /System/Volumes/Data/home");
        assert_eq!(
            row.map(|r| (r.0, r.1)),
            Some(("map auto_home".into(), "/System/Volumes/Data/home".into()))
        );
    }

    #[test]
    fn mount_types_and_diskutil() {
        let t = "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n\
                 devfs on /dev (devfs, local, nobrowse)\n\
                 /dev/disk5s1 on /Volumes/My Backup (hfs, local, journaled)\n";
        let m = parse_mount(t);
        assert_eq!(m.get("/").map(String::as_str), Some("apfs"));
        assert_eq!(m.get("/Volumes/My Backup").map(String::as_str), Some("hfs"));
        let d = "   Device Identifier:         disk3s1s1\n\
                 \x20  Volume Name:               Macintosh HD\n\
                 \x20  Solid State:               Yes\n\
                 \x20  Protocol:                  Apple Fabric\n";
        assert_eq!(
            parse_diskutil(d),
            (Some("Macintosh HD".into()), Some("ssd".into()))
        );
        assert_eq!(
            parse_diskutil("Solid State: No\n"),
            (None, Some("hdd".into()))
        );
    }

    #[test]
    fn ioreg_gpu_statistics() {
        let t = "+-o AGXAcceleratorG13G  <class AGXAcceleratorG13G, id 0x100000389>\n\
                 \x20   {\n\
                 \x20     \"IOClass\" = \"AGXAcceleratorG13G\"\n\
                 \x20     \"PerformanceStatistics\" = {\"Alloc system memory\"=1234567,\"Device Utilization %\"=37,\"In use system memory\"=987654321,\"Renderer Utilization %\"=30}\n\
                 \x20   }\n";
        assert_eq!(parse_ioreg_gpu(t), (Some(37.0), Some(987654321)));
        assert_eq!(parse_ioreg_gpu("nothing here"), (None, None));
        let intel = "\"PerformanceStatistics\" = {\"GPU Activity(%)\"=12}";
        assert_eq!(parse_ioreg_gpu(intel), (None, None));
    }

    #[test]
    fn powermetrics_lines() {
        let intel = "**** SMC sensors ****\n\nCPU Thermal level: 47\nFan: 1200 rpm\n\
                     CPU die temperature: 52.39 C\nGPU die temperature: 48.12 C\n";
        let p = parse_powermetrics(intel);
        assert_eq!(p.cpu_die_c, Some(52.39));
        assert_eq!(p.gpu_die_c, Some(48.12));
        assert_eq!(p.gpu_power_w, None);
        let m1 = "**** Processor usage ****\n\nCPU Power: 1234 mW\nGPU Power: 56 mW\n\
                  ANE Power: 0 mW\nCombined Power (CPU + GPU + ANE): 1290 mW\n\n\
                  **** Thermal pressure ****\n\nCurrent pressure level: Nominal\n";
        let p = parse_powermetrics(m1);
        assert_eq!(p.cpu_die_c, None);
        assert_eq!(p.cpu_power_w, Some(1.234));
        assert_eq!(p.gpu_power_w, Some(0.056));
    }

    #[test]
    fn netstat_rows() {
        let t = "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll\n\
                 lo0        16384 <Link#1>                        1000     0     100000     1000     0     100000     0\n\
                 lo0        16384 127           127.0.0.1         1000     0     100000     1000     0     100000     0\n\
                 gif0*      1280  <Link#2>                           0     0          0        0     0          0     0\n\
                 en0        1500  <Link#4>      aa:bb:cc:dd:ee:ff 500000     0 1234567890   400000     0  987654321     0\n\
                 en0        1500  192.168.0     192.168.0.10      500000     0 1234567890   400000     0  987654321     0\n";
        let rows = parse_netstat(t);
        assert_eq!(
            rows,
            vec![
                ("lo0".to_string(), 100000, 100000),
                ("en0".to_string(), 1234567890, 987654321)
            ]
        );
        assert!(parse_netstat("").is_empty());
    }

    #[test]
    fn pmset_lines() {
        let laptop = "Now drawing from 'Battery Power'\n \
                      -InternalBattery-0 (id=1234567)\t85%; discharging; 4:32 remaining present: true\n";
        let b = parse_pmset(laptop).expect("has a battery");
        assert_eq!(b.percent, Some(85.0));
        assert_eq!(b.charging, Some(false));
        let plugged = "Now drawing from 'AC Power'\n \
                       -InternalBattery-0 (id=1234567)\t72%; charging; 1:10 remaining present: true\n";
        assert_eq!(parse_pmset(plugged).and_then(|b| b.charging), Some(true));
        let full = "Now drawing from 'AC Power'\n \
                    -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
        assert_eq!(parse_pmset(full).and_then(|b| b.charging), Some(false));
        assert!(parse_pmset("Now drawing from 'AC Power'\n").is_none());
    }

    #[test]
    fn battery_health() {
        let j = r#"{"SPPowerDataType":[
            {"_name":"spbattery_information",
             "sppower_battery_health_info":{"sppower_battery_cycle_count":123,
               "sppower_battery_health":"Good",
               "sppower_battery_health_maximum_capacity":"85 %"}},
            {"_name":"sppower_ac_charger_information"}]}"#;
        assert_eq!(
            parse_battery_health(j),
            Some(BatteryHealth {
                max_capacity_pct: Some(85.0),
                cycles: Some(123),
                condition: Some("Good".into()),
            })
        );
        assert_eq!(parse_battery_health(r#"{"SPPowerDataType":[]}"#), None);
    }

    #[test]
    fn browser_bundles_by_name() {
        assert_eq!(
            browser_bundle("Google Chrome.app"),
            Some(("chrome", "Google Chrome", "stable"))
        );
        assert_eq!(
            browser_bundle("Google Chrome Canary.app"),
            Some(("chrome", "Google Chrome", "canary"))
        );
        assert_eq!(
            browser_bundle("Microsoft Edge Dev.app"),
            Some(("edge", "Microsoft Edge", "dev"))
        );
        assert_eq!(
            browser_bundle("Brave Browser Nightly.app"),
            Some(("brave", "Brave", "canary"))
        );
        assert_eq!(browser_bundle("Arc.app"), Some(("arc", "Arc", "stable")));
        assert_eq!(
            browser_bundle("Chromium.app"),
            Some(("chromium", "Chromium", "stable"))
        );
        assert_eq!(
            browser_bundle("Vivaldi.app"),
            Some(("vivaldi", "Vivaldi", "stable"))
        );
        assert_eq!(
            browser_bundle("Opera.app"),
            Some(("opera", "Opera", "stable"))
        );
        assert_eq!(browser_bundle("Safari.app"), None);
        assert_eq!(browser_bundle("Firefox.app"), None);
        // Every kind the contract names is one of the table's, and the
        // table's names are the ones the page shows.
        for (_, kind, _, _) in BROWSER_BUNDLES {
            assert!(matches!(
                *kind,
                "chrome" | "edge" | "brave" | "arc" | "chromium" | "vivaldi" | "opera"
            ));
        }
    }

    #[test]
    fn plist_dicts_cut_nested_ones_out() {
        let xml = "<plist><dict>\n<key>a</key><string>1</string>\n\
                   <key>inner</key><dict><key>a</key><string>2</string>\
                   <dict><key>a</key><string>3</string></dict></dict>\n\
                   <key>b</key><string>4</string>\n</dict></plist>";
        let d = plist_dicts(xml);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0].0, 0);
        assert_eq!(plist_string(&d[0].1, "a").as_deref(), Some("1"));
        assert_eq!(plist_string(&d[0].1, "b").as_deref(), Some("4"));
        assert_eq!(d[1].0, 1);
        assert_eq!(plist_string(&d[1].1, "a").as_deref(), Some("2"));
        assert_eq!(d[2].0, 2);
        assert_eq!(plist_string(&d[2].1, "a").as_deref(), Some("3"));
        assert!(plist_dicts("<plist><array/></plist>").is_empty());
        // An unclosed dict is not a dict.
        assert!(plist_dicts("<dict><key>a</key>").is_empty());
    }

    #[test]
    fn bundle_info_from_info_plist() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
            <plist version=\"1.0\">\n<dict>\n\
            \t<key>CFBundleDocumentTypes</key>\n\t<array>\n\t\t<dict>\n\
            \t\t\t<key>CFBundleTypeName</key>\n\t\t\t<string>HTML document</string>\n\
            \t\t\t<key>CFBundleIdentifier</key>\n\t\t\t<string>not.this.one</string>\n\
            \t\t</dict>\n\t</array>\n\
            \t<key>CFBundleIdentifier</key>\n\t<string>com.google.Chrome</string>\n\
            \t<key>CFBundleShortVersionString</key>\n\t<string>128.0.6613.120</string>\n\
            \t<key>CFBundleVersion</key>\n\t<string>6613.120</string>\n\
            </dict>\n</plist>\n";
        assert_eq!(
            parse_bundle_info(xml),
            Some(BundleInfo {
                version: Some("128.0.6613.120".into()),
                id: Some("com.google.Chrome".into()),
            })
        );
        assert_eq!(
            parse_bundle_info("<plist><dict><key>x</key><string>y</string></dict></plist>"),
            Some(BundleInfo::default())
        );
        assert_eq!(parse_bundle_info("bplist00\u{0}garbage"), None);
    }

    #[test]
    fn app_info_from_info_plist() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n\
            \t<key>CFBundleIdentifier</key>\n\t<string>com.apple.Safari</string>\n\
            \t<key>CFBundleName</key>\n\t<string>Safari</string>\n\
            \t<key>CFBundleShortVersionString</key>\n\t<string>26.0</string>\n\
            \t<key>CFBundleVersion</key>\n\t<string>21619</string>\n\
            </dict>\n</plist>\n";
        assert_eq!(
            parse_app_info(xml),
            Some(AppInfo {
                name: Some("Safari".into()),
                version: Some("26.0".into()),
                id: Some("com.apple.Safari".into()),
            })
        );
        // The display name wins over the name, the build stands in for a
        // missing marketing version.
        let xml = "<plist version=\"1.0\"><dict>\
            <key>CFBundleName</key><string>obsidian</string>\
            <key>CFBundleDisplayName</key><string>Obsidian</string>\
            <key>CFBundleVersion</key><string>1.8.10</string>\
            </dict></plist>";
        assert_eq!(
            parse_app_info(xml),
            Some(AppInfo {
                name: Some("Obsidian".into()),
                version: Some("1.8.10".into()),
                id: None,
            })
        );
        assert_eq!(parse_app_info("bplist00\u{0}garbage"), None);

        let casks: HashSet<String> = ["Obsidian.app".to_string()].into_iter().collect();
        assert_eq!(
            app_source(
                "/Applications/Obsidian.app",
                "Obsidian.app",
                Some("md.obsidian"),
                &casks
            ),
            "homebrew"
        );
        assert_eq!(
            app_source(
                "/Applications/Setapp/Bartender.app",
                "Bartender.app",
                None,
                &casks
            ),
            "setapp"
        );
        assert_eq!(
            app_source(
                "/Applications/Safari.app",
                "Safari.app",
                Some("com.apple.Safari"),
                &casks
            ),
            "apple"
        );
        assert_eq!(
            app_source(
                "/Applications/Zed.app",
                "Zed.app",
                Some("dev.zed.Zed"),
                &casks
            ),
            "applications"
        );
    }

    #[test]
    fn launchservices_http_handler() {
        let entry = |scheme: &str, role: &str, id: &str| {
            format!(
                "\t\t<dict>\n\t\t\t<key>LSHandlerPreferredVersions</key>\n\t\t\t<dict>\n\
                 \t\t\t\t<key>{role}</key>\n\t\t\t\t<string>-</string>\n\t\t\t</dict>\n\
                 \t\t\t<key>{role}</key>\n\t\t\t<string>{id}</string>\n\
                 \t\t\t<key>LSHandlerURLScheme</key>\n\t\t\t<string>{scheme}</string>\n\
                 \t\t</dict>\n"
            )
        };
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n\
             \t<key>LSHandlers</key>\n\t<array>\n\
             \t\t<dict>\n\t\t\t<key>LSHandlerContentType</key>\n\t\t\t<string>public.html</string>\n\
             \t\t\t<key>LSHandlerRoleAll</key>\n\t\t\t<string>com.apple.safari</string>\n\t\t</dict>\n",
        );
        xml += &entry("mailto", "LSHandlerRoleAll", "com.apple.mail");
        xml += &entry("http", "LSHandlerRoleAll", "com.microsoft.edgemac");
        xml += &entry("https", "LSHandlerRoleAll", "com.microsoft.edgemac");
        xml += "\t</array>\n</dict>\n</plist>\n";
        assert_eq!(
            parse_http_handler(&xml).as_deref(),
            Some("com.microsoft.edgemac")
        );
        // The viewer role stands in when there is no all-roles handler.
        let viewer = format!(
            "<plist><dict><key>LSHandlers</key><array>{}</array></dict></plist>",
            entry("HTTP", "LSHandlerRoleViewer", "company.thebrowser.Browser")
        );
        assert_eq!(
            parse_http_handler(&viewer).as_deref(),
            Some("company.thebrowser.browser")
        );
        // No http entry: nobody chose, and Safari is not Chromium.
        let none = format!(
            "<plist><dict><key>LSHandlers</key><array>{}</array></dict></plist>",
            entry("mailto", "LSHandlerRoleAll", "com.apple.mail")
        );
        assert_eq!(parse_http_handler(&none), None);
        assert_eq!(parse_http_handler(""), None);
    }

    #[test]
    fn running_bundles_from_ps() {
        let chrome = "/Applications/Google Chrome.app";
        let ps = "/sbin/launchd\n\
            /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n\
            /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/128.0.6613.120/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)\n\
            /Applications/Google Chrome.app 2/Contents/MacOS/Google Chrome\n\
            /Users/x/Applications/Brave Browser.app/Contents/MacOS/Brave Browser\n\
            kernel_task\n";
        assert!(bundle_running(ps, chrome));
        assert!(bundle_running(
            ps,
            "/Users/x/Applications/Brave Browser.app"
        ));
        assert!(!bundle_running(ps, "/Applications/Brave Browser.app"));
        assert!(!bundle_running(ps, "/Applications/Microsoft Edge.app"));
        // The stray copy is a different bundle, so it alone does not count.
        let stray = "/Applications/Google Chrome.app 2/Contents/MacOS/Google Chrome\n";
        assert!(!bundle_running(stray, chrome));
        assert!(!bundle_running("", chrome));
        assert_eq!(
            parse_dscl_value("NFSHomeDirectory: /Users/santiago\n", "NFSHomeDirectory").as_deref(),
            Some("/Users/santiago")
        );
        assert_eq!(
            parse_dscl_value("<dscl_cmd> DS Error: -14136", "NFSHomeDirectory"),
            None
        );
    }
}
