//! The text of Linux's `/proc`, `/sys` and `/etc` files, and the XDG desktop
//! entries: pure readers over captured text, so they are tested everywhere.
//! The Linux collector (os/linux/telemetry.rs) reads the files and hands
//! the text over; nothing here opens one.

use std::collections::HashMap;

use super::meaningful;

/// The uid owning the IPv4 socket that LISTENs on `port` on loopback or on
/// every interface, from /proc/net/tcp (`sl local rem st … uid …`, the
/// addresses as hex `ADDR:PORT`, state `0A` listening).
pub fn tcp_listener_uid(text: &str, port: u16) -> Option<u32> {
    let want = format!("{port:04X}");
    text.lines().skip(1).find_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        let (addr, p) = f.get(1)?.split_once(':')?;
        (p == want && f.get(3) == Some(&"0A") && matches!(addr, "0100007F" | "00000000"))
            .then(|| f.get(7)?.parse().ok())
            .flatten()
    })
}

/// `/etc/os-release` (os-release(5)): `KEY=value`, the value optionally
/// quoted, with backslash escapes inside double quotes.
pub fn os_release(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim();
        let v = if let Some(inner) = v.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            let mut s = String::new();
            let mut chars = inner.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    if let Some(n) = chars.next() {
                        s.push(n);
                    }
                } else {
                    s.push(c);
                }
            }
            s
        } else if let Some(inner) = v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
            inner.to_string()
        } else {
            v.to_string()
        };
        out.insert(k.trim().to_string(), v);
    }
    out
}

/// The OS's name and version as the status page carries them: `NAME`
/// ("Ubuntu", "NixOS"; else `PRETTY_NAME`), and `VERSION_ID` ("24.04",
/// "25.11"; else `BUILD_ID`, which rolling distributions set instead).
pub fn os_name_version(release: &HashMap<String, String>) -> (String, String) {
    let get = |k: &str| release.get(k).filter(|v| !v.is_empty()).cloned();
    let name = get("NAME")
        .or_else(|| get("PRETTY_NAME"))
        .unwrap_or_default();
    let version = get("VERSION_ID")
        .or_else(|| get("BUILD_ID"))
        .unwrap_or_default();
    (name, version)
}

/// What `/proc/cpuinfo` says about the processor.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CpuInfo {
    pub model: Option<String>,
    /// Logical processors: one `processor` stanza each.
    pub threads: u32,
    /// Distinct (package, core) pairs, where x86 states them.
    pub cores: Option<u32>,
    /// The first stanza's `cpu MHz` (x86: the current clock).
    pub mhz: Option<f64>,
}

/// ARM's own cores, by `CPU part` under implementer 0x41, for the aarch64
/// kernels whose cpuinfo has no `model name`.
fn arm_core(part: &str) -> Option<&'static str> {
    Some(match part {
        "0xd03" => "Cortex-A53",
        "0xd04" => "Cortex-A35",
        "0xd05" => "Cortex-A55",
        "0xd07" => "Cortex-A57",
        "0xd08" => "Cortex-A72",
        "0xd09" => "Cortex-A73",
        "0xd0a" => "Cortex-A75",
        "0xd0b" => "Cortex-A76",
        "0xd0c" => "Neoverse-N1",
        "0xd0d" => "Cortex-A77",
        "0xd40" => "Neoverse-V1",
        "0xd41" => "Cortex-A78",
        "0xd44" => "Cortex-X1",
        "0xd46" => "Cortex-A510",
        "0xd47" => "Cortex-A710",
        "0xd48" => "Cortex-X2",
        "0xd49" => "Neoverse-N2",
        "0xd4f" => "Neoverse-V2",
        _ => return None,
    })
}

pub fn cpuinfo(text: &str) -> CpuInfo {
    let mut out = CpuInfo::default();
    let mut pairs = std::collections::HashSet::new();
    let mut physical = String::new();
    let mut implementer = None;
    let mut part = None;
    let mut hardware = None;
    for line in text.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim());
        match k {
            "processor" => out.threads += 1,
            "model name" | "cpu model" if out.model.is_none() => out.model = meaningful(v),
            "cpu MHz" if out.mhz.is_none() => out.mhz = v.parse().ok(),
            "physical id" => physical = v.to_string(),
            "core id" => {
                pairs.insert((physical.clone(), v.to_string()));
            }
            "CPU implementer" if implementer.is_none() => implementer = Some(v.to_string()),
            "CPU part" if part.is_none() => part = Some(v.to_string()),
            "Hardware" => hardware = meaningful(v),
            _ => {}
        }
    }
    if out.model.is_none() {
        out.model = match (implementer.as_deref(), part.as_deref()) {
            (Some("0x41"), Some(p)) => arm_core(p).map(|c| format!("ARM {c}")),
            _ => None,
        }
        .or(hardware);
    }
    if !pairs.is_empty() {
        out.cores = Some(pairs.len() as u32);
    }
    out
}

/// `/proc/meminfo` in bytes, by field name (`MemTotal`, `MemAvailable`…).
pub fn meminfo(text: &str) -> HashMap<String, u64> {
    text.lines()
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            let mut w = v.split_whitespace();
            let n: u64 = w.next()?.parse().ok()?;
            let bytes = match w.next() {
                Some("kB") => n.saturating_mul(1024),
                _ => n,
            };
            Some((k.trim().to_string(), bytes))
        })
        .collect()
}

/// The aggregate `cpu` line of `/proc/stat`: time spent idle (idle plus
/// iowait) and in total, in clock ticks. Guest time is already in user.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CpuTimes {
    pub idle: u64,
    pub total: u64,
}

pub fn proc_stat_cpu(text: &str) -> Option<CpuTimes> {
    let line = text.lines().find(|l| l.starts_with("cpu "))?;
    let v: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .take(8)
        .filter_map(|x| x.parse().ok())
        .collect();
    if v.len() < 4 {
        return None;
    }
    Some(CpuTimes {
        idle: v[3] + v.get(4).copied().unwrap_or(0),
        total: v.iter().sum(),
    })
}

/// Busy share between two readings, 0–100.
pub fn cpu_busy_pct(prev: CpuTimes, now: CpuTimes) -> Option<f64> {
    let total = now.total.checked_sub(prev.total)?;
    let idle = now.idle.checked_sub(prev.idle)?;
    (total > 0)
        .then(|| (100.0 * (total.saturating_sub(idle)) as f64 / total as f64).clamp(0.0, 100.0))
}

/// `/proc/loadavg`: the three averages.
pub fn loadavg(text: &str) -> Option<[f64; 3]> {
    let mut w = text.split_whitespace().map(|x| x.parse::<f64>().ok());
    Some([w.next()??, w.next()??, w.next()??])
}

/// `/proc/uptime`: whole seconds since boot.
pub fn uptime_secs(text: &str) -> Option<u64> {
    let secs: f64 = text.split_whitespace().next()?.parse().ok()?;
    (secs >= 0.0).then_some(secs as u64)
}

/// `/proc/net/route`: the interface of the default route (destination and
/// mask 0, up), the lowest metric when there are several.
pub fn default_route_iface(text: &str) -> Option<String> {
    text.lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 8 {
                return None;
            }
            let flags = u32::from_str_radix(f[3], 16).ok()?;
            let up = flags & 0x1 != 0;
            (f[1] == "00000000" && f[7] == "00000000" && up)
                .then(|| (f[6].parse::<u64>().unwrap_or(u64::MAX), f[0].to_string()))
        })
        .min()
        .map(|(_, iface)| iface)
}

/// One line of `/proc/self/mountinfo`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mount {
    /// "major:minor" of the file system's device.
    pub dev: String,
    /// The subtree of the file system mounted here ("/" unless a bind mount
    /// or a btrfs subvolume).
    pub root: String,
    pub mount_point: String,
    pub fs: String,
    pub source: String,
}

/// mountinfo escapes space, tab, newline and backslash as `\ooo`.
fn unescape_octal(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' {
            if let Some(n) = s
                .get(i + 1..i + 4)
                .and_then(|o| u8::from_str_radix(o, 8).ok())
            {
                out.push(n);
                i += 4;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn mountinfo(text: &str) -> Vec<Mount> {
    text.lines()
        .filter_map(|l| {
            let (left, right) = l.split_once(" - ")?;
            let lf: Vec<&str> = left.split_whitespace().collect();
            let rf: Vec<&str> = right.split_whitespace().collect();
            if lf.len() < 5 || rf.len() < 2 {
                return None;
            }
            Some(Mount {
                dev: lf[2].to_string(),
                root: unescape_octal(lf[3]),
                mount_point: unescape_octal(lf[4]),
                fs: rf[0].to_string(),
                source: unescape_octal(rf[1]),
            })
        })
        .collect()
}

/// File systems that hold a person's data on a disk of this machine: not
/// the kernel's pseudo file systems, not memory, not the network, not a
/// snap's squashfs image or a container's overlay.
pub fn is_real_fs(fs: &str) -> bool {
    matches!(
        fs,
        "ext2"
            | "ext3"
            | "ext4"
            | "xfs"
            | "btrfs"
            | "zfs"
            | "bcachefs"
            | "f2fs"
            | "jfs"
            | "reiserfs"
            | "vfat"
            | "exfat"
            | "ntfs"
            | "ntfs3"
            | "fuseblk"
            | "hfsplus"
            | "apfs"
    )
}

/// The volumes worth listing: real file systems, one mount per device
/// (a bind mount or a second view of the same file system is not another
/// volume), the shortest mount point kept.
pub fn volumes(mounts: &[Mount]) -> Vec<Mount> {
    let mut by_dev: Vec<Mount> = Vec::new();
    for m in mounts.iter().filter(|m| is_real_fs(&m.fs)) {
        match by_dev.iter_mut().find(|k| k.dev == m.dev) {
            Some(k) if m.mount_point.len() < k.mount_point.len() => *k = m.clone(),
            Some(_) => {}
            None => by_dev.push(m.clone()),
        }
    }
    by_dev.sort_by(|a, b| a.mount_point.cmp(&b.mount_point));
    by_dev
}

/// What `/proc/<pid>/stat` says about one process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PidStat {
    pub comm: String,
    /// utime + stime, clock ticks.
    pub ticks: u64,
    /// Resident set, pages.
    pub rss_pages: u64,
}

/// `pid (comm) state ppid …`: comm may hold spaces and parentheses, so the
/// fields are counted from the LAST `)`. utime and stime are fields 14 and
/// 15, rss is 24 (proc(5), 1-based).
pub fn pid_stat(text: &str) -> Option<PidStat> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let comm = text.get(open + 1..close)?.to_string();
    let rest: Vec<&str> = text.get(close + 1..)?.split_whitespace().collect();
    // rest[0] is field 3 (state).
    let f = |n: usize| rest.get(n - 3).and_then(|x| x.parse::<u64>().ok());
    Some(PidStat {
        comm,
        ticks: f(14)? + f(15)?,
        rss_pages: f(24)?,
    })
}

/// A `/sys/class/power_supply/*/uevent` of a battery, as the page's
/// battery: charge, charging, health against design, cycles. None when it
/// is not a battery (an AC adapter, a mouse's `scope=Device` battery).
pub fn battery_uevent(text: &str) -> Option<crate::telemetry::Battery> {
    let kv: HashMap<&str, &str> = text
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim_start_matches("POWER_SUPPLY_"), v.trim()))
        .collect();
    if kv.get("TYPE") != Some(&"Battery") || kv.get("SCOPE") == Some(&"Device") {
        return None;
    }
    let n = |k: &str| kv.get(k).and_then(|v| v.parse::<f64>().ok());
    let full = n("ENERGY_FULL").or_else(|| n("CHARGE_FULL"));
    let design = n("ENERGY_FULL_DESIGN").or_else(|| n("CHARGE_FULL_DESIGN"));
    let status = kv.get("STATUS").copied();
    Some(crate::telemetry::Battery {
        percent: n("CAPACITY"),
        charging: status.map(|s| s == "Charging" || s == "Full"),
        health_pct: full
            .zip(design)
            .filter(|(_, d)| *d > 0.0)
            .map(|(f, d)| (100.0 * f / d).min(100.0)),
        cycles: n("CYCLE_COUNT").filter(|c| *c > 0.0).map(|c| c as u64),
        condition: kv
            .get("HEALTH")
            .filter(|h| !h.is_empty() && **h != "Unknown")
            .map(|h| h.to_string()),
    })
}

/// A hwmon reading's label on the page: the chip's name with the sensor's
/// own label, the CPU's and GPU's chips named as such.
pub fn hwmon_label(chip: &str, label: Option<&str>) -> String {
    let label = label.map(str::trim).filter(|l| !l.is_empty());
    let chip_name = match chip {
        "k10temp" | "zenpower" | "coretemp" | "cpu_thermal" | "soc_thermal" => "CPU",
        "amdgpu" | "nouveau" | "radeon" | "i915" | "xe" => "GPU",
        "nvme" => "NVMe",
        "drivetemp" => "Drive",
        "acpitz" => "ACPI",
        "iwlwifi_1" | "iwlwifi" => "Wi-Fi",
        other => other,
    };
    match label {
        Some(l) => format!("{chip_name} {l}"),
        None => chip_name.to_string(),
    }
}

/// Whether a hwmon reading is the processor's package or die temperature:
/// AMD's Tctl/Tdie, Intel's "Package id 0", an ARM SoC's cpu_thermal.
pub fn is_cpu_package(chip: &str, label: Option<&str>) -> bool {
    match chip {
        "k10temp" | "zenpower" => matches!(label, Some("Tctl") | Some("Tdie") | None),
        "coretemp" => label.is_some_and(|l| l.starts_with("Package id")),
        "cpu_thermal" | "soc_thermal" => true,
        _ => false,
    }
}

/// The vendor and device names for a PCI id pair from `pci.ids` (the
/// hwdata file lspci reads): a vendor line `10de  NVIDIA Corporation` at
/// the start of a line, its devices indented by one tab.
pub fn pci_names(text: &str, vendor: u16, device: u16) -> (Option<String>, Option<String>) {
    let v = format!("{vendor:04x}");
    let d = format!("{device:04x}");
    let mut vendor_name = None;
    let mut in_vendor = false;
    for line in text.lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if !line.starts_with('\t') {
            if in_vendor {
                break;
            }
            if let Some(rest) = line.strip_prefix(&v) {
                if rest.starts_with(' ') {
                    in_vendor = true;
                    vendor_name = Some(rest.trim().to_string());
                }
            }
            continue;
        }
        if in_vendor && !line.starts_with("\t\t") {
            if let Some(rest) = line[1..].strip_prefix(&d) {
                if rest.starts_with(' ') {
                    return (vendor_name, Some(rest.trim().to_string()));
                }
            }
        }
    }
    (vendor_name, None)
}

/// A GPU vendor's short name from its PCI vendor id.
pub fn gpu_vendor(id: u16) -> Option<&'static str> {
    Some(match id {
        0x10de => "NVIDIA",
        0x1002 => "AMD",
        0x8086 => "Intel",
        0x1af4 => "Red Hat (virtio)",
        0x15ad => "VMware",
        0x1234 => "QEMU",
        _ => return None,
    })
}

/// The part of an XDG desktop entry the inventory uses.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DesktopEntry {
    pub name: String,
    /// `NoDisplay` or `Hidden`: not an application a person launches.
    pub hidden: bool,
    /// `Type=Application`.
    pub application: bool,
    pub categories: Vec<String>,
}

/// The `[Desktop Entry]` group of a `.desktop` file: the untranslated
/// `Name`, and what says whether it is a launchable application.
pub fn desktop_entry(text: &str) -> Option<DesktopEntry> {
    let mut out = DesktopEntry::default();
    let mut in_group = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_group {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match (k.trim(), v.trim()) {
            ("Name", v) => out.name = v.to_string(),
            ("Type", v) => out.application = v == "Application",
            ("NoDisplay" | "Hidden", "true") => out.hidden = true,
            ("Categories", v) => {
                out.categories = v
                    .split(';')
                    .filter(|c| !c.is_empty())
                    .map(str::to_string)
                    .collect()
            }
            _ => {}
        }
    }
    (!out.name.is_empty()).then_some(out)
}

/// A nix store path's package name and version:
/// `/nix/store/<32-char hash>-firefox-128.0.3/share/…` → ("firefox",
/// "128.0.3"). The version starts at the first `-` followed by a digit.
pub fn nix_store_name_version(path: &str) -> Option<(String, Option<String>)> {
    let rest = path.strip_prefix("/nix/store/")?;
    let dir = rest.split('/').next()?;
    let (hash, name) = dir.split_at_checked(33)?;
    if !hash.ends_with('-') {
        return None;
    }
    let bytes = name.as_bytes();
    let cut = (0..bytes.len().saturating_sub(1))
        .find(|&i| bytes[i] == b'-' && bytes[i + 1].is_ascii_digit());
    Some(match cut {
        Some(i) => (name[..i].to_string(), Some(name[i + 1..].to_string())),
        None => (name.to_string(), None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_listener_of_a_port_is_found_by_its_owner() {
        let t = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1E6B 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 12345 1\n   1: 0100007F:1E6C 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 2 1\n";
        assert_eq!(tcp_listener_uid(t, 7787), Some(1001));
        assert_eq!(
            tcp_listener_uid(t, 7788),
            None,
            "established, not listening"
        );
        assert_eq!(tcp_listener_uid(t, 80), None);
    }

    #[test]
    fn os_release_quotes_and_the_fallbacks() {
        let r = os_release(
            "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n# c\nID=ubuntu\n",
        );
        assert_eq!(os_name_version(&r), ("Ubuntu".into(), "24.04".into()));
        let nix = os_release("NAME=NixOS\nVERSION_ID=\"25.11\"\nBUILD_ID=\"25.11.20260901.abc\"\n");
        assert_eq!(os_name_version(&nix), ("NixOS".into(), "25.11".into()));
        let arch =
            os_release("NAME=\"Arch Linux\"\nPRETTY_NAME=\"Arch Linux\"\nBUILD_ID=rolling\n");
        assert_eq!(
            os_name_version(&arch),
            ("Arch Linux".into(), "rolling".into())
        );
        let esc = os_release("PRETTY_NAME=\"a \\\"b\\\"\"\nX='y z'\n");
        assert_eq!(esc["PRETTY_NAME"], "a \"b\"");
        assert_eq!(esc["X"], "y z");
    }

    #[test]
    fn cpuinfo_on_x86_and_arm() {
        let x86 = "processor\t: 0\nmodel name\t: AMD Ryzen 9 7950X 16-Core Processor\ncpu MHz\t\t: 3000.123\n\
                   physical id\t: 0\ncore id\t\t: 0\n\nprocessor\t: 1\nmodel name\t: AMD Ryzen 9 7950X 16-Core Processor\n\
                   physical id\t: 0\ncore id\t\t: 0\n\nprocessor\t: 2\nphysical id\t: 0\ncore id\t\t: 1\n";
        let c = cpuinfo(x86);
        assert_eq!(
            c.model.as_deref(),
            Some("AMD Ryzen 9 7950X 16-Core Processor")
        );
        assert_eq!((c.threads, c.cores), (3, Some(2)));
        assert_eq!(c.mhz, Some(3000.123));
        let arm =
            "processor\t: 0\nBogoMIPS\t: 50.00\nCPU implementer\t: 0x41\nCPU part\t: 0xd0c\n\n\
                   processor\t: 1\nCPU implementer\t: 0x41\nCPU part\t: 0xd0c\n";
        let a = cpuinfo(arm);
        assert_eq!(a.model.as_deref(), Some("ARM Neoverse-N1"));
        assert_eq!((a.threads, a.cores, a.mhz), (2, None, None));
        let pi = "processor : 0\nCPU implementer : 0x42\nCPU part : 0x001\nHardware : BCM2835\n";
        assert_eq!(cpuinfo(pi).model.as_deref(), Some("BCM2835"));
    }

    #[test]
    fn meminfo_stat_loadavg_uptime() {
        let m = meminfo(
            "MemTotal:       65536000 kB\nMemAvailable:   32768000 kB\nHugePages_Total:       0\n",
        );
        assert_eq!(m["MemTotal"], 65_536_000 * 1024);
        assert_eq!(m["HugePages_Total"], 0);
        let a = proc_stat_cpu("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4\n").unwrap();
        assert_eq!(
            a,
            CpuTimes {
                idle: 800,
                total: 1000
            }
        );
        let b = proc_stat_cpu("cpu  200 0 200 1500 100 0 0 0 0 0\n").unwrap();
        assert_eq!(cpu_busy_pct(a, b), Some(20.0));
        assert_eq!(cpu_busy_pct(b, a), None);
        assert_eq!(cpu_busy_pct(a, a), None);
        assert_eq!(
            loadavg("0.52 0.58 0.59 1/1024 12345\n"),
            Some([0.52, 0.58, 0.59])
        );
        assert_eq!(loadavg("x"), None);
        assert_eq!(uptime_secs("350735.47 234388.90\n"), Some(350_735));
    }

    #[test]
    fn the_default_route_is_the_lowest_metric() {
        let t =
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n\
                 wlp2s0\t00000000\t0100A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n\
                 enp3s0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n\
                 enp3s0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n";
        assert_eq!(default_route_iface(t).as_deref(), Some("enp3s0"));
        assert_eq!(default_route_iface("Iface\tDestination\n"), None);
    }

    #[test]
    fn mountinfo_volumes_one_per_device() {
        let t = "22 1 0:21 / / rw,relatime shared:1 - zfs rpool/root rw,xattr\n\
                 23 22 0:5 / /proc rw - proc proc rw\n\
                 24 22 0:21 /nix/store /nix/store ro - zfs rpool/root rw\n\
                 25 22 259:1 / /boot rw - vfat /dev/nvme0n1p1 rw\n\
                 26 22 8:17 / /mnt/My\\040Disk rw - ext4 /dev/sdb1 rw\n\
                 27 22 0:40 / /run/user/1000 rw - tmpfs tmpfs rw\n\
                 28 22 7:3 / /snap/core/1 ro - squashfs /dev/loop3 ro\n";
        let all = mountinfo(t);
        assert_eq!(all.len(), 7);
        assert_eq!(all[4].mount_point, "/mnt/My Disk");
        let v = volumes(&all);
        let points: Vec<&str> = v.iter().map(|m| m.mount_point.as_str()).collect();
        assert_eq!(points, ["/", "/boot", "/mnt/My Disk"]);
        assert_eq!(v[1].source, "/dev/nvme0n1p1");
    }

    #[test]
    fn pid_stat_counts_from_the_last_paren() {
        let t = "1234 (Web Content (x)) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 30 0 \
                 9876 1234567890 5000 18446744073709551615";
        let p = pid_stat(t).unwrap();
        assert_eq!(p.comm, "Web Content (x)");
        assert_eq!(p.ticks, 300);
        assert_eq!(p.rss_pages, 5000);
        assert_eq!(pid_stat("garbage"), None);
    }

    #[test]
    fn batteries_and_not_batteries() {
        let b = battery_uevent(
            "POWER_SUPPLY_NAME=BAT0\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_STATUS=Discharging\n\
             POWER_SUPPLY_CYCLE_COUNT=312\nPOWER_SUPPLY_ENERGY_FULL_DESIGN=57000000\n\
             POWER_SUPPLY_ENERGY_FULL=51300000\nPOWER_SUPPLY_CAPACITY=87\n",
        )
        .unwrap();
        assert_eq!(b.percent, Some(87.0));
        assert_eq!(b.charging, Some(false));
        assert_eq!(b.cycles, Some(312));
        assert!((b.health_pct.unwrap() - 90.0).abs() < 1e-9);
        assert!(battery_uevent("POWER_SUPPLY_TYPE=Mains\nPOWER_SUPPLY_ONLINE=1\n").is_none());
        assert!(battery_uevent("POWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_SCOPE=Device\n").is_none());
    }

    #[test]
    fn hwmon_names() {
        assert_eq!(hwmon_label("k10temp", Some("Tctl")), "CPU Tctl");
        assert_eq!(hwmon_label("amdgpu", Some("edge")), "GPU edge");
        assert_eq!(hwmon_label("nvme", Some("Composite")), "NVMe Composite");
        assert_eq!(hwmon_label("acpitz", None), "ACPI");
        assert_eq!(hwmon_label("it8688", Some("SYSTIN")), "it8688 SYSTIN");
        assert!(is_cpu_package("coretemp", Some("Package id 0")));
        assert!(!is_cpu_package("coretemp", Some("Core 3")));
        assert!(is_cpu_package("k10temp", Some("Tctl")));
        assert!(!is_cpu_package("k10temp", Some("Tccd1")));
    }

    #[test]
    fn pci_ids_lookup() {
        let ids = "# comment\n1002  Advanced Micro Devices, Inc. [AMD/ATI]\n\t744c  Navi 31 [Radeon RX 7900 XT/7900 XTX]\n\
                   \t\t1002 0e3b  Radeon RX 7900 GRE\n10de  NVIDIA Corporation\n\t2684  AD102 [GeForce RTX 4090]\n";
        assert_eq!(
            pci_names(ids, 0x10de, 0x2684),
            (
                Some("NVIDIA Corporation".into()),
                Some("AD102 [GeForce RTX 4090]".into())
            )
        );
        assert_eq!(
            pci_names(ids, 0x1002, 0x744c).1.as_deref(),
            Some("Navi 31 [Radeon RX 7900 XT/7900 XTX]")
        );
        assert_eq!(pci_names(ids, 0x1002, 0x0e3b).1, None);
        assert_eq!(pci_names(ids, 0x8086, 0x1234), (None, None));
    }

    #[test]
    fn desktop_entries_and_store_paths() {
        let e = desktop_entry(
            "[Desktop Entry]\nName=Steam\nName[de]=Dampf\nType=Application\nCategories=Network;Game;\n\
             [Desktop Action x]\nName=Other\n",
        )
        .unwrap();
        assert_eq!(e.name, "Steam");
        assert!(e.application && !e.hidden);
        assert_eq!(e.categories, ["Network", "Game"]);
        assert!(
            desktop_entry("[Desktop Entry]\nName=x\nNoDisplay=true\n")
                .unwrap()
                .hidden
        );
        assert!(desktop_entry("[Other]\nName=x\n").is_none());
        assert_eq!(
            nix_store_name_version(
                "/nix/store/0123456789abcdefghijklmnopqrstuv-firefox-128.0.3/share/applications/firefox.desktop"
            ),
            Some(("firefox".into(), Some("128.0.3".into())))
        );
        assert_eq!(
            nix_store_name_version(
                "/nix/store/0123456789abcdefghijklmnopqrstuv-gnome-console-47.1/x"
            ),
            Some(("gnome-console".into(), Some("47.1".into())))
        );
        assert_eq!(nix_store_name_version("/usr/share/x"), None);
    }
}
