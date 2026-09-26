//! The parsers for every tool but `system_profiler`: `launchctl`, `vm_stat`,
//! `sysctl vm.swapusage`, `ps`, `df`, `mount`, `diskutil`, `ioreg`,
//! `powermetrics`, `netstat`, `pmset`; the CPU-tick arithmetic; and the
//! plist helpers the updates, browsers and apps tiers share. Pure functions
//! over text, tested on any OS.

use std::collections::HashMap;

use crate::telemetry::TOP_PROCESSES;
use crate::telemetry::{Battery, Disk, Process, Service};

/// `launchctl list` in the system domain: a "PID\tStatus\tLabel" header,
/// then one row per job — PID "-" when not running, Status its last exit
/// status. The jobs whose last exit was not 0, Apple's own excluded (they
/// exit non-zero as a matter of course), and how many rows there were.
pub(super) fn parse_launchctl(text: &str) -> (Vec<Service>, u32) {
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

/// Busy share between two tick readings, 0–100; `None` when no time passed.
/// The tick counters are 32-bit and wrap, hence the wrapping arithmetic.
pub(super) fn cpu_usage(prev: [u32; 4], now: [u32; 4]) -> Option<f64> {
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

/// The page counts `vm_stat` prints that make "available": free, inactive
/// and speculative pages (active, wired and compressor pages are the rest
/// of "used", which is total minus available) — plus the file-backed pages
/// (the cache the OS drops under pressure) and the pages the compressor
/// holds. In pages, with the page size.
#[derive(Debug, Default, PartialEq)]
pub(super) struct VmStat {
    page_size: u64,
    free: u64,
    inactive: u64,
    speculative: u64,
    file_backed: u64,
    compressor: u64,
}

impl VmStat {
    pub(super) fn available_bytes(&self) -> u64 {
        (self.free + self.inactive + self.speculative) * self.page_size
    }

    pub(super) fn cached_bytes(&self) -> u64 {
        self.file_backed * self.page_size
    }

    pub(super) fn compressed_bytes(&self) -> u64 {
        self.compressor * self.page_size
    }
}

pub(super) fn parse_vm_stat(text: &str) -> Option<VmStat> {
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
pub(super) fn parse_ps(text: &str) -> (Vec<Process>, u32) {
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
pub(super) fn parse_swapusage(text: &str) -> Option<(u64, u64)> {
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
pub(super) fn parse_df(text: &str) -> Vec<Disk> {
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
pub(super) fn parse_mount(text: &str) -> HashMap<String, String> {
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
pub(super) fn parse_diskutil(text: &str) -> (Option<String>, Option<String>) {
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
pub(super) fn parse_ioreg_gpu(text: &str) -> (Option<f64>, Option<u64>) {
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
pub(super) struct PowerMetrics {
    pub(super) cpu_die_c: Option<f64>,
    pub(super) gpu_die_c: Option<f64>,
    cpu_power_w: Option<f64>,
    pub(super) gpu_power_w: Option<f64>,
}

/// "CPU die temperature: 52.39 C" (Intel's smc sampler), "GPU Power: 56 mW"
/// (Apple Silicon's gpu_power sampler) and their siblings.
pub(super) fn parse_powermetrics(text: &str) -> PowerMetrics {
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
pub(super) fn parse_netstat(text: &str) -> Vec<(String, u64, u64)> {
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
pub(super) fn parse_pmset(text: &str) -> Option<Battery> {
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

/// The text of the value after `<key>name</key>` in a plist dict, whatever
/// its tag (`<string>`, `<date>`), the XML entities decoded.
pub(super) fn plist_string(dict: &str, key: &str) -> Option<String> {
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

/// Every `<dict>…</dict>` of a plist, outermost first, each as its own
/// text with the dicts nested in it cut out — so a key lookup on one
/// (`plist_string`) sees that dict's values and not a child's repeat of
/// the same key. With each, how deep it sits: 0 is the root.
pub(super) fn plist_dicts(xml: &str) -> Vec<(usize, String)> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn suffixed_sizes() {
        assert_eq!(parse_suffixed("1250.00M"), Some(1_310_720_000));
        assert_eq!(parse_suffixed("2G"), Some(2 << 30));
        assert_eq!(parse_suffixed("0.00M"), Some(0));
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
}
