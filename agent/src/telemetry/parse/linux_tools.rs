//! The output of the Linux tools the collector runs in its slow and updates
//! tiers — `smartctl -j`, `systemctl`, `nvidia-smi`, the package managers
//! (dpkg, rpm, pacman, flatpak, snap, apt, dnf) and their logs, a browser's
//! `--version` — read from captured text, so they are tested everywhere.

use crate::telemetry::{App, Installed, Service, Update};

use super::meaningful;

// ── drives ──────────────────────────────────────────────────────────────────

/// What `smartctl -j -a /dev/X` says about one drive.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Smart {
    pub model: Option<String>,
    pub serial: Option<String>,
    pub firmware: Option<String>,
    /// SMART's overall verdict: true passed, false failing.
    pub passed: Option<bool>,
    pub temperature_c: Option<f64>,
    pub power_on_hours: Option<u64>,
    /// NVMe's `percentage_used`.
    pub wear_pct: Option<f64>,
    /// NVMe's media and data-integrity errors.
    pub media_errors: Option<u64>,
    /// The drive was asleep and `-n standby` left it so: nothing else read.
    pub standby: bool,
}

/// `smartctl -n standby -j -a /dev/X`. A disk in standby or sleep is not
/// woken: smartctl says so in its messages and reads nothing, which is
/// `standby`, not a failure.
pub fn smartctl(json: &str) -> Option<Smart> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let asleep = v
        .pointer("/smartctl/messages")
        .and_then(|m| m.as_array())
        .is_some_and(|msgs| {
            msgs.iter().any(|m| {
                m.get("string").and_then(|s| s.as_str()).is_some_and(|s| {
                    let s = s.to_ascii_uppercase();
                    s.contains("STANDBY") || s.contains("SLEEP")
                })
            })
        });
    if asleep {
        return Some(Smart {
            standby: true,
            ..Default::default()
        });
    }
    let s = |p: &str| v.pointer(p).and_then(|x| x.as_str()).and_then(meaningful);
    let n = |p: &str| v.pointer(p).and_then(|x| x.as_u64());
    let out = Smart {
        model: s("/model_name"),
        serial: s("/serial_number"),
        firmware: s("/firmware_version"),
        passed: v.pointer("/smart_status/passed").and_then(|x| x.as_bool()),
        temperature_c: n("/temperature/current").map(|t| t as f64),
        power_on_hours: n("/power_on_time/hours"),
        wear_pct: n("/nvme_smart_health_information_log/percentage_used").map(|p| p as f64),
        media_errors: n("/nvme_smart_health_information_log/media_errors"),
        standby: false,
    };
    (out != Smart::default()).then_some(out)
}

// ── services ────────────────────────────────────────────────────────────────

/// `systemctl list-units --failed --type=service --plain --no-legend`: one
/// unit per line, `name load active sub description…`; older versions mark
/// each with a `●`.
pub fn systemctl_failed(text: &str) -> Vec<Service> {
    text.lines()
        .filter_map(|l| {
            let l = l.trim().trim_start_matches('●').trim();
            let mut w = l.split_whitespace();
            let name = w.next()?.to_string();
            let _load = w.next()?;
            let active = w.next()?;
            let _sub = w.next()?;
            let desc = w.collect::<Vec<_>>().join(" ");
            Some(Service {
                name,
                display: (!desc.is_empty()).then_some(desc),
                state: active.to_string(),
                exit_code: None,
            })
        })
        .collect()
}

/// `systemctl show -p Id,ExecMainStatus u1 u2…`: blocks of `Key=value`
/// separated by blank lines; the non-zero exit status by unit name.
pub fn systemctl_exit_codes(text: &str) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    for block in text.split("\n\n") {
        let mut id = None;
        let mut status = None;
        for l in block.lines() {
            match l.split_once('=') {
                Some(("Id", v)) => id = Some(v.trim().to_string()),
                Some(("ExecMainStatus", v)) => status = v.trim().parse::<i64>().ok(),
                _ => {}
            }
        }
        if let (Some(id), Some(s)) = (id, status.filter(|s| *s != 0)) {
            out.push((id, s));
        }
    }
    out
}

// ── GPUs ────────────────────────────────────────────────────────────────────

/// `nvidia-smi --query-gpu=name,driver_version,memory.total
/// --format=csv,noheader,nounits`: name, driver, VRAM in MiB, per GPU.
pub fn nvidia_smi(text: &str) -> Vec<(String, Option<String>, Option<u64>)> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(',').map(str::trim).collect();
            let name = meaningful(f.first()?)?;
            Some((
                name,
                f.get(1).and_then(|d| meaningful(d)),
                f.get(2)
                    .and_then(|m| m.parse::<u64>().ok())
                    .map(|mib| mib << 20),
            ))
        })
        .collect()
}

// ── browsers ────────────────────────────────────────────────────────────────

/// A browser's `--version` line ("Google Chrome 128.0.6613.119", "Vivaldi
/// 6.9.3447.37 stable"): the first word that starts with a digit and has a
/// dot.
pub fn browser_version(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|w| w.starts_with(|c: char| c.is_ascii_digit()) && w.contains('.'))
        .map(str::to_string)
}

// ── updates ─────────────────────────────────────────────────────────────────

/// `apt list --upgradable`: `name/suite version arch [upgradable from: old]`.
/// A suite ending `-security` is a security update.
pub fn apt_upgradable(text: &str) -> Vec<Update> {
    text.lines()
        .filter(|l| l.contains("[upgradable from:"))
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            let (name, suite) = w.next()?.split_once('/')?;
            let version = w.next()?;
            Some(Update {
                title: format!("{name} {version}"),
                id: Some(name.to_string()),
                severity: suite
                    .split(',')
                    .any(|s| s.ends_with("-security"))
                    .then(|| "security".to_string()),
                ..Default::default()
            })
        })
        .collect()
}

/// `dnf -q check-update`: `name.arch  version  repo`, up to the
/// "Obsoleting Packages" section.
pub fn dnf_check_update(text: &str) -> Vec<Update> {
    text.lines()
        .take_while(|l| !l.starts_with("Obsoleting"))
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() != 3 || !f[0].contains('.') || l.starts_with(' ') {
                return None;
            }
            let name = f[0].rsplit_once('.').map(|(n, _)| n).unwrap_or(f[0]);
            Some(Update {
                title: format!("{name} {}", f[1]),
                id: Some(name.to_string()),
                ..Default::default()
            })
        })
        .collect()
}

/// `pacman -Qu`: `name old -> new`, possibly with `[ignored]`.
pub fn pacman_qu(text: &str) -> Vec<Update> {
    text.lines()
        .filter(|l| !l.contains("[ignored]"))
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            (f.len() >= 4 && f[2] == "->").then(|| Update {
                title: format!("{} {}", f[0], f[3]),
                id: Some(f[0].to_string()),
                ..Default::default()
            })
        })
        .collect()
}

/// The last `n` installs of `/var/log/dpkg.log`, newest first:
/// `2026-09-20 10:00:01 status installed firefox:amd64 128.0.3`.
pub fn dpkg_log(text: &str, n: usize) -> Vec<Installed> {
    let mut out: Vec<Installed> = text
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            (f.len() >= 6 && f[2] == "status" && f[3] == "installed").then(|| Installed {
                title: format!("{} {}", f[4].split(':').next().unwrap_or(f[4]), f[5]),
                at: Some(format!("{} {}", f[0], f[1])),
            })
        })
        .collect();
    out.reverse();
    out.truncate(n);
    out
}

/// The last `n` installs and upgrades of `/var/log/pacman.log`, newest
/// first: `[2026-09-20T10:00:01+0200] [ALPM] upgraded linux (6.10.1 -> 6.10.2)`.
pub fn pacman_log(text: &str, n: usize) -> Vec<Installed> {
    let mut out: Vec<Installed> = text
        .lines()
        .filter_map(|l| {
            let (at, rest) = l.strip_prefix('[')?.split_once(']')?;
            let rest = rest.trim().strip_prefix("[ALPM]")?.trim();
            let (verb, rest) = rest.split_once(' ')?;
            if verb != "installed" && verb != "upgraded" {
                return None;
            }
            let (name, versions) = rest.split_once(" (")?;
            let version = versions
                .trim_end_matches(')')
                .rsplit(" -> ")
                .next()
                .unwrap_or("");
            Some(Installed {
                title: format!("{name} {version}"),
                at: Some(at.to_string()),
            })
        })
        .collect();
    out.reverse();
    out.truncate(n);
    out
}

/// `rpm -qa --last`: `name-version-release.arch   Fri 20 Sep 2026 …`,
/// newest first already; the first `n`.
pub fn rpm_last(text: &str, n: usize) -> Vec<Installed> {
    text.lines()
        .filter_map(|l| {
            let (pkg, at) = l.split_once("  ")?;
            Some(Installed {
                title: pkg.trim().to_string(),
                at: meaningful(at),
            })
        })
        .take(n)
        .collect()
}

// ── installed applications ──────────────────────────────────────────────────

/// `dpkg-query -S path…`: `pkg1, pkg2: /path` → the first package owning
/// each path.
pub fn dpkg_owners(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter(|l| !l.starts_with("diversion"))
        .filter_map(|l| {
            let (pkgs, path) = l.split_once(": ")?;
            let pkg = pkgs.split(',').next()?.trim();
            let pkg = pkg.split(':').next().unwrap_or(pkg);
            Some((path.trim().to_string(), pkg.to_string()))
        })
        .collect()
}

/// A package as the system's manager states it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Package {
    pub name: String,
    pub version: Option<String>,
    pub publisher: Option<String>,
    pub size_bytes: Option<u64>,
    /// Seconds since the epoch, where the manager records it (rpm).
    pub installed_epoch: Option<u64>,
}

/// `dpkg-query -W -f '${Package}\t${Version}\t${Maintainer}\t${Installed-Size}\n'`;
/// the size is in KiB.
pub fn dpkg_packages(text: &str) -> Vec<Package> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            Some(Package {
                name: meaningful(f.first()?)?,
                version: f.get(1).and_then(|v| meaningful(v)),
                publisher: f.get(2).and_then(|v| meaningful(v)),
                size_bytes: f
                    .get(3)
                    .and_then(|v| v.trim().parse::<u64>().ok())
                    .map(|k| k << 10),
                installed_epoch: None,
            })
        })
        .collect()
}

/// `rpm -qf --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\t%{SIZE}\t%{INSTALLTIME}\n' path…`:
/// one line per path in order, or `file … is not owned by any package`.
pub fn rpm_owners(text: &str) -> Vec<Option<Package>> {
    text.lines()
        .map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() < 5 {
                return None;
            }
            Some(Package {
                name: meaningful(f[0])?,
                version: meaningful(f[1]),
                publisher: meaningful(f[2]).filter(|v| v != "(none)"),
                size_bytes: f[3].trim().parse().ok(),
                installed_epoch: f[4].trim().parse().ok(),
            })
        })
        .collect()
}

/// `pacman -Qo path…`: `/path is owned by name version`.
pub fn pacman_owners(text: &str) -> Vec<(String, Package)> {
    text.lines()
        .filter_map(|l| {
            let (path, rest) = l.split_once(" is owned by ")?;
            let mut w = rest.split_whitespace();
            Some((
                path.trim().to_string(),
                Package {
                    name: w.next()?.to_string(),
                    version: w.next().map(str::to_string),
                    ..Default::default()
                },
            ))
        })
        .collect()
}

/// `flatpak list --columns=application,name,version,origin,installation`
/// (tab-separated), as apps of `kind` from source "flatpak".
pub fn flatpak_list(text: &str, kind: &str) -> Vec<App> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            let id = meaningful(f.first()?)?;
            let name = f
                .get(1)
                .and_then(|n| meaningful(n))
                .unwrap_or_else(|| id.clone());
            Some(App {
                name,
                version: f.get(2).and_then(|v| meaningful(v)),
                publisher: f.get(3).and_then(|o| meaningful(o)),
                kind: kind.to_string(),
                source: Some("flatpak".into()),
                path: Some(format!(
                    "{}:{id}",
                    f.get(4)
                        .map(|i| i.trim())
                        .filter(|i| !i.is_empty())
                        .unwrap_or("system")
                )),
                ..Default::default()
            })
        })
        .collect()
}

/// `snap list`: a header, then `Name Version Rev Tracking Publisher Notes`;
/// the bases, `core*` and `snapd` are runtimes.
pub fn snap_list(text: &str) -> Vec<App> {
    text.lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 5 {
                return None;
            }
            let notes = f.get(5).copied().unwrap_or("-");
            let runtime = notes
                .split(',')
                .any(|n| matches!(n, "base" | "core" | "snapd"))
                || f[0].starts_with("core")
                || f[0] == "snapd";
            Some(App {
                name: f[0].to_string(),
                version: Some(f[1].to_string()),
                publisher: Some(f[4].trim_end_matches('✓').trim_end_matches('*').to_string()),
                kind: if runtime { "runtime" } else { "app" }.into(),
                source: Some("snap".into()),
                ..Default::default()
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smartctl_nvme_and_nothing() {
        let j = r#"{"device":{"name":"/dev/nvme0","type":"nvme","protocol":"NVMe"},
            "model_name":"Samsung SSD 990 PRO 2TB","serial_number":"S7KHNJ0W","firmware_version":"4B2QJXD7",
            "smart_status":{"passed":true},"temperature":{"current":41},"power_on_time":{"hours":3120},
            "nvme_smart_health_information_log":{"percentage_used":2,"media_errors":0}}"#;
        let s = smartctl(j).unwrap();
        assert_eq!(s.model.as_deref(), Some("Samsung SSD 990 PRO 2TB"));
        assert_eq!(s.serial.as_deref(), Some("S7KHNJ0W"));
        assert_eq!(s.passed, Some(true));
        assert_eq!(s.temperature_c, Some(41.0));
        assert_eq!(s.power_on_hours, Some(3120));
        assert_eq!(s.wear_pct, Some(2.0));
        assert_eq!(s.media_errors, Some(0));
        let ata = r#"{"model_name":"WDC WD161KFGX","smart_status":{"passed":false},"power_on_time":{"hours":9}}"#;
        assert_eq!(smartctl(ata).unwrap().passed, Some(false));
        assert_eq!(smartctl(r#"{"smartctl":{"exit_status":2}}"#), None);
        // `-n standby` on a sleeping disk: asleep, nothing read, no error.
        let asleep = r#"{"smartctl":{"exit_status":2,"messages":[{"string":"Device is in STANDBY mode, exit(2)","severity":"information"}]},
            "device":{"name":"/dev/sdb","type":"sat"}}"#;
        let s = smartctl(asleep).unwrap();
        assert!(s.standby);
        assert_eq!(s.passed, None);
        assert!(!smartctl(ata).unwrap().standby);
        assert_eq!(smartctl("not json"), None);
    }

    #[test]
    fn failed_units_and_their_codes() {
        let t = "● backup.service loaded failed failed Nightly backup\nfoo.service loaded failed failed\n";
        let s = systemctl_failed(t);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "backup.service");
        assert_eq!(s[0].display.as_deref(), Some("Nightly backup"));
        assert_eq!(s[0].state, "failed");
        assert_eq!(s[1].display, None);
        assert!(systemctl_failed("").is_empty());
        let show = "Id=backup.service\nExecMainStatus=3\n\nId=foo.service\nExecMainStatus=0\n";
        assert_eq!(
            systemctl_exit_codes(show),
            vec![("backup.service".to_string(), 3)]
        );
    }

    #[test]
    fn nvidia_and_browser_versions() {
        let g = nvidia_smi("NVIDIA GeForce RTX 4090, 560.35.03, 24564\n");
        assert_eq!(
            g,
            vec![(
                "NVIDIA GeForce RTX 4090".into(),
                Some("560.35.03".into()),
                Some(24564 << 20)
            )]
        );
        assert_eq!(
            browser_version("Google Chrome 128.0.6613.119 ").as_deref(),
            Some("128.0.6613.119")
        );
        assert_eq!(
            browser_version("Vivaldi 6.9.3447.37 stable").as_deref(),
            Some("6.9.3447.37")
        );
        assert_eq!(
            browser_version("Chromium 128.0.6613.119 Arch Linux").as_deref(),
            Some("128.0.6613.119")
        );
        assert_eq!(browser_version("nope"), None);
    }

    #[test]
    fn pending_updates_per_manager() {
        let apt = "Listing...\nfirefox/noble-updates 128.0.3 amd64 [upgradable from: 128.0.2]\n\
                   openssl/noble-security,noble-updates 3.0.13-0ubuntu3.4 amd64 [upgradable from: 3.0.13-0ubuntu3.3]\n";
        let a = apt_upgradable(apt);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].title, "firefox 128.0.3");
        assert_eq!(a[0].severity, None);
        assert_eq!(a[1].severity.as_deref(), Some("security"));
        let dnf = "\nkernel.x86_64    6.10.3-200.fc40    updates\nvim-minimal.x86_64  2:9.1.6-1.fc40  updates\n\
                   Obsoleting Packages\nfoo.x86_64  1-1  updates\n";
        let d = dnf_check_update(dnf);
        assert_eq!(d.len(), 2);
        assert_eq!(d[1].id.as_deref(), Some("vim-minimal"));
        let p = pacman_qu("linux 6.10.1.arch1-1 -> 6.10.2.arch1-1\nfoo 1-1 -> 2-1 [ignored]\n");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "linux 6.10.2.arch1-1");
    }

    #[test]
    fn install_logs_newest_first() {
        let dpkg = "2026-09-19 09:00:00 status installed a:amd64 1\n2026-09-20 10:00:01 upgrade firefox:amd64 1 2\n\
                    2026-09-20 10:00:02 status installed firefox:amd64 128.0.3\n";
        let d = dpkg_log(dpkg, 5);
        assert_eq!(d[0].title, "firefox 128.0.3");
        assert_eq!(d[0].at.as_deref(), Some("2026-09-20 10:00:02"));
        assert_eq!(d.len(), 2);
        assert_eq!(dpkg_log(dpkg, 1).len(), 1);
        let pac = "[2026-09-20T10:00:01+0200] [ALPM] upgraded linux (6.10.1 -> 6.10.2)\n\
                   [2026-09-20T10:00:02+0200] [ALPM] installed foo (1.0-1)\n[2026-09-20T10:00:03+0200] [PACMAN] Running x\n";
        let p = pacman_log(pac, 5);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].title, "foo 1.0-1");
        assert_eq!(p[1].title, "linux 6.10.2");
        let rpm = rpm_last("firefox-128.0.3-1.fc40.x86_64   Fri 20 Sep 2026 10:00:01 AM CEST\nx-1-1.noarch  Thu 19 Sep 2026\n", 1);
        assert_eq!(rpm.len(), 1);
        assert_eq!(
            rpm[0].at.as_deref(),
            Some("Fri 20 Sep 2026 10:00:01 AM CEST")
        );
    }

    #[test]
    fn owners_and_package_lists() {
        let o = dpkg_owners("firefox, firefox-l10n: /usr/share/applications/firefox.desktop\n\
                             diversion by x from: /y\nsteam-installer:amd64: /usr/share/applications/steam.desktop\n");
        assert_eq!(
            o[0],
            (
                "/usr/share/applications/firefox.desktop".into(),
                "firefox".into()
            )
        );
        assert_eq!(o[1].1, "steam-installer");
        let p = dpkg_packages("firefox\t128.0.3\tUbuntu Mozilla Team <x@y>\t250000\n");
        assert_eq!(p[0].size_bytes, Some(250_000 << 10));
        let r = rpm_owners(
            "firefox\t128.0.3-1.fc40\tFedora Project\t270000000\t1726819201\n\
                            file /usr/share/applications/x.desktop is not owned by any package\n",
        );
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].as_ref().unwrap().installed_epoch, Some(1_726_819_201));
        assert!(r[1].is_none());
        let pac = pacman_owners(
            "/usr/share/applications/firefox.desktop is owned by firefox 128.0.3-1\n",
        );
        assert_eq!(pac[0].1.version.as_deref(), Some("128.0.3-1"));
        let f = flatpak_list(
            "com.valvesoftware.Steam\tSteam\t1.0.0.81\tflathub\tsystem\n",
            "app",
        );
        assert_eq!(f[0].name, "Steam");
        assert_eq!(f[0].path.as_deref(), Some("system:com.valvesoftware.Steam"));
        let s = snap_list("Name  Version  Rev  Tracking  Publisher  Notes\ncore22  20240111  1122  latest/stable  canonical✓  base\n\
                           firefox  128.0.3  4650  latest/stable  mozilla✓  -\n");
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].kind, "runtime");
        assert_eq!(s[1].kind, "app");
        assert_eq!(s[1].publisher.as_deref(), Some("mozilla"));
    }
}
