//! The macOS collector. Apple's own tools do the reading — `system_profiler`
//! for the hardware and the GPUs, `sysctl`, `vm_stat`, `df`, `mount`,
//! `diskutil`, `netstat`, `pmset`, `ioreg`, and `powermetrics` (root only,
//! which the launchd daemon is) for power and, on Intel, die temperatures —
//! plus two Mach calls for the CPU ticks and the load averages. Every command
//! runs with a closed stdin and a deadline, so a wedged tool costs one sample,
//! not the telemetry thread.
//!
//! The parsers take text and are unit-tested on any OS; the functions that
//! run commands are thin and untested here. Anything that cannot be read is
//! `None` with a one-line reason in `errors`. Nothing identifying is copied:
//! `system_profiler` prints the serial number and the hardware UUID and both
//! are left where they are.

use std::collections::HashMap;
use std::ffi::CString;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{
    Battery, Collect, Cpu, Disk, Gpu, GpuSample, Machine, Memory, Network, Os, Sample, Static,
    Temperature,
};

/// The fast tools (`sysctl`, `df`, `vm_stat`, `pmset`…) are done in
/// milliseconds; a deadline this long is only for a wedged one.
const QUICK: Duration = Duration::from_secs(10);
/// `system_profiler` walks IOKit; a few seconds on a slow machine.
const PROFILER: Duration = Duration::from_secs(30);
/// `powermetrics -n 1 -i 500` returns in about half a second.
const POWERMETRICS: Duration = Duration::from_secs(4);
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
    battery_health_pct: Option<f64>,
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
    Some(Machine {
        manufacturer: Some("Apple".into()),
        model: s("machine_name").or_else(|| identifier.clone()),
        chip: s("chip_type").or_else(|| s("cpu_type")),
        bios_vendor: Some("Apple".into()),
        bios_version: s("boot_rom_version"),
        // The firmware carries no date of its own; it is versioned with the OS.
        bios_date: None,
        board_manufacturer: Some("Apple".into()),
        board_product: identifier,
    })
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
/// of "used", which is total minus available). In pages, with the page size.
#[derive(Debug, Default, PartialEq)]
struct VmStat {
    page_size: u64,
    free: u64,
    inactive: u64,
    speculative: u64,
}

impl VmStat {
    fn available_bytes(&self) -> u64 {
        (self.free + self.inactive + self.speculative) * self.page_size
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
            _ => {}
        }
    }
    (v.page_size > 0).then_some(v)
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
    })
}

/// `system_profiler SPPowerDataType -json`:
/// `sppower_battery_health_info.sppower_battery_health_maximum_capacity`
/// ("85 %") → 85.
fn parse_battery_health(json: &str) -> Option<f64> {
    let v: Value = serde_json::from_str(json).ok()?;
    v.get("SPPowerDataType")?
        .as_array()?
        .iter()
        .find_map(|e| e.get("sppower_battery_health_info"))
        .and_then(|h| h.get("sppower_battery_health_maximum_capacity"))
        .and_then(Value::as_str)
        .and_then(|s| s.trim_end_matches('%').trim().parse::<f64>().ok())
}

// ── the collector ───────────────────────────────────────────────────────────

impl Collect for Collector {
    fn read_static(&mut self) -> Static {
        let mut errors = Vec::new();

        let machine = run_for(
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

        Static {
            machine,
            os,
            cpu,
            gpus,
            errors,
        }
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
            swap_total_bytes: swap.map(|(t, _)| t),
            swap_used_bytes: swap.map(|(_, u)| u),
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
                        self.battery_health_pct =
                            run_for("system_profiler", &["SPPowerDataType", "-json"], PROFILER)
                                .and_then(|j| parse_battery_health(&j));
                    }
                    b.health_pct = self.battery_health_pct;
                    s.battery = Some(b);
                }
            }
            None => s.errors.push("pmset -g batt failed".into()),
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
        let dump = format!("{m:?}");
        assert!(!dump.contains("C02XXXXXXXXX") && !dump.contains("ABCD-1234"));
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
                 Pages occupied by compressor:             20000.\n";
        let v = parse_vm_stat(t).expect("parses");
        assert_eq!(v.page_size, 16384);
        assert_eq!(v.free, 12345);
        assert_eq!(v.inactive, 300000);
        assert_eq!(v.speculative, 5000);
        assert_eq!(v.available_bytes(), (12345 + 300000 + 5000) * 16384);
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
        assert_eq!(parse_battery_health(j), Some(85.0));
        assert_eq!(parse_battery_health(r#"{"SPPowerDataType":[]}"#), None);
    }
}
