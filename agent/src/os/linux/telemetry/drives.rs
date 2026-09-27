//! The physical drives: `/sys/block` for what they are and which volumes
//! live on them, `smartctl -j -a` for their health where smartmontools is
//! installed and the agent is root (the service is).

use std::path::Path;
use std::time::Duration;

use super::super::{read, read_line};
use super::{is_root, tool_any};
use crate::telemetry::parse::{linux_sys, linux_tools, meaningful};
use crate::telemetry::Drive;

/// One drive's SMART read; a spun-down disk may take a few seconds.
const SMARTCTL: Duration = Duration::from_secs(20);

/// Not drives: loop and RAM devices, device-mapper and md volumes, network
/// block devices, optical and floppy drives.
fn is_physical(name: &str) -> bool {
    !["loop", "ram", "zram", "dm-", "md", "nbd", "sr", "fd", "zd"]
        .iter()
        .any(|p| name.starts_with(p))
}

/// The bus, from where the device sits in sysfs.
fn bus_of(name: &str, sys_path: &str) -> Option<String> {
    Some(
        if name.starts_with("nvme") {
            "nvme"
        } else if sys_path.contains("/usb") {
            "usb"
        } else if name.starts_with("mmcblk") {
            "sd"
        } else if name.starts_with("vd") || sys_path.contains("/virtio") {
            "virtio"
        } else if sys_path.contains("/ata") {
            "sata"
        } else if sys_path.contains("/host") {
            "scsi"
        } else {
            return None;
        }
        .to_string(),
    )
}

pub(super) fn read_drives() -> (Vec<Drive>, Vec<String>) {
    let mut errors = Vec::new();
    let Ok(dir) = std::fs::read_dir("/sys/block") else {
        return (Vec::new(), vec!["/sys/block is not readable".into()]);
    };
    // Which mount points live on which partition, by its /dev name.
    let mounts: Vec<(String, String)> = read("/proc/self/mountinfo")
        .map(|t| {
            linux_sys::mountinfo(&t)
                .into_iter()
                .filter(|m| linux_sys::is_real_fs(&m.fs))
                .filter_map(|m| {
                    let dev = m.source.strip_prefix("/dev/")?.to_string();
                    Some((dev, m.mount_point))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut names: Vec<String> = dir
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_physical(n))
        .collect();
    names.sort();

    let smart_ok = if !is_root() {
        errors.push("drive health: SMART needs root (the service reads it)".into());
        false
    } else if crate::exec::locate("smartctl").is_none() {
        errors.push("drive health: smartctl is not installed (smartmontools)".into());
        false
    } else {
        true
    };

    let mut drives = Vec::new();
    for name in names {
        let base = Path::new("/sys/block").join(&name);
        let sys_path = std::fs::canonicalize(&base)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let dev = base.join("device");
        let size = read_line(base.join("size"))
            .and_then(|s| s.parse::<u64>().ok())
            .map(|sectors| sectors * 512)
            .filter(|b| *b > 0);
        let Some(size_bytes) = size else {
            continue; // an empty card reader slot
        };
        let rotational = read_line(base.join("queue/rotational"));
        let mut d = Drive {
            name: read_line(dev.join("model"))
                .and_then(|m| meaningful(&m))
                .unwrap_or_else(|| name.clone()),
            serial: read_line(dev.join("serial")).and_then(|s| meaningful(&s)),
            firmware: read_line(dev.join("firmware_rev"))
                .or_else(|| read_line(dev.join("rev")))
                .and_then(|f| meaningful(&f)),
            size_bytes: Some(size_bytes),
            bus: bus_of(&name, &sys_path),
            kind: match rotational.as_deref() {
                Some("1") => Some("hdd".into()),
                Some("0") => Some("ssd".into()),
                _ => None,
            },
            removable: read_line(base.join("removable")).map(|r| r == "1"),
            volumes: mounts
                .iter()
                .filter(|(part, _)| part.starts_with(&name))
                .map(|(_, mount)| mount.clone())
                .collect(),
            ..Default::default()
        };
        if smart_ok {
            let path = format!("/dev/{name}");
            // smartctl's exit code is a bit mask of findings; the JSON is
            // the answer either way. `-n standby` never spins up a sleeping
            // disk to read it: an asleep drive is reported as asleep.
            match tool_any("smartctl", &["-n", "standby", "-j", "-a", &path], SMARTCTL) {
                Ok((_, json)) => match linux_tools::smartctl(&json) {
                    Some(s) if s.standby => d.health = Some("asleep".into()),
                    Some(s) => {
                        d.name = s.model.unwrap_or(d.name);
                        d.serial = s.serial.or(d.serial);
                        d.firmware = s.firmware.or(d.firmware);
                        d.health = s
                            .passed
                            .map(|p| if p { "verified" } else { "failing" }.to_string());
                        d.temperature_c = s.temperature_c;
                        d.power_on_hours = s.power_on_hours;
                        d.wear_pct = s.wear_pct;
                        d.read_errors = s.media_errors;
                    }
                    None => errors.push(format!("{path}: smartctl reported nothing usable")),
                },
                Err(e) => errors.push(format!("{path}: {e}")),
            }
        }
        drives.push(d);
    }
    (drives, errors)
}
