//! The static tier: the machine (DMI, or the device tree on an ARM board),
//! the memory modules from the raw SMBIOS table, the OS, the processor and
//! the GPUs.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::super::{read, read_line};
use super::tool;
use crate::telemetry::parse::{linux_sys, linux_tools, meaningful, smbios};
use crate::telemetry::{Cpu, Gpu, Machine, Os, Static};

const DMI: &str = "/sys/class/dmi/id";
const SMBIOS_TABLE: &str = "/sys/firmware/dmi/tables/DMI";
/// Where distributions keep the PCI id database lspci reads.
const PCI_IDS: &[&str] = &[
    "/usr/share/hwdata/pci.ids",
    "/usr/share/misc/pci.ids",
    "/usr/share/pci.ids",
    "/run/current-system/sw/share/hwdata/pci.ids",
];
/// `nvidia-smi` answers in a second; the deadline is for a wedged driver.
const NVIDIA_SMI: Duration = Duration::from_secs(15);

fn dmi(field: &str) -> Option<String> {
    read_line(Path::new(DMI).join(field)).and_then(|v| meaningful(&v))
}

/// The static facts, and the GPUs' device directories for the sample.
pub(super) fn read_static() -> (Static, Vec<PathBuf>) {
    let mut errors = Vec::new();

    let mut machine = Machine {
        manufacturer: dmi("sys_vendor"),
        model: dmi("product_name"),
        bios_vendor: dmi("bios_vendor"),
        bios_version: dmi("bios_version"),
        bios_date: dmi("bios_date"),
        board_manufacturer: dmi("board_vendor"),
        board_product: dmi("board_name"),
        ..Default::default()
    };
    if machine.model.is_none() {
        // ARM boards: the device tree names the machine, NUL-terminated.
        machine.model = read("/sys/firmware/devicetree/base/model")
            .and_then(|m| meaningful(m.trim_end_matches('\0')));
    }
    if machine.model.is_none() && machine.manufacturer.is_none() {
        errors.push("no DMI or device-tree identity (/sys/class/dmi/id)".into());
    }

    // The raw table: the memory modules, the slots, and the chassis again.
    let table = match std::fs::read(SMBIOS_TABLE) {
        Ok(bytes) => Some(smbios::parse_smbios(&bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            errors.push(format!(
                "memory modules: the SMBIOS table ({SMBIOS_TABLE}) is readable by root only"
            ));
            None
        }
        Err(_) => {
            errors.push(format!("memory modules: no SMBIOS table ({SMBIOS_TABLE})"));
            None
        }
    };
    machine.form = dmi("chassis_type")
        .and_then(|t| t.parse::<u8>().ok())
        .and_then(smbios::chassis_form)
        .or_else(|| table.as_ref().and_then(|t| t.form))
        .map(str::to_string);

    let release = read("/etc/os-release")
        .map(|t| linux_sys::os_release(&t))
        .unwrap_or_default();
    let os = Os {
        kernel: kernel_release(),
        build: release
            .get("BUILD_ID")
            .or_else(|| release.get("VERSION"))
            .cloned()
            .filter(|b| !b.is_empty()),
        // The root file system's birth: when the machine was installed.
        installed_at: std::fs::metadata("/")
            .and_then(|m| m.created())
            .ok()
            .and_then(|t| std::time::SystemTime::now().duration_since(t).ok())
            .map(|ago| crate::state::rfc3339_ago(ago.as_secs())),
    };

    let cpu = read_cpu(&mut errors);
    let (gpus, devices) = read_gpus(&mut errors);

    let s = Static {
        machine,
        os,
        cpu,
        gpus,
        memory_slots: table.as_ref().and_then(|t| t.slots),
        memory_max_capacity_bytes: table.as_ref().and_then(|t| t.max_capacity_bytes),
        memory_modules: table.map(|t| t.modules).unwrap_or_default(),
        errors,
    };
    (s, devices)
}

/// `uname -r`, from the kernel.
fn kernel_release() -> Option<String> {
    // SAFETY: a zeroed out-struct the call fills.
    let mut u: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut u) } != 0 {
        return None;
    }
    // SAFETY: the kernel NUL-terminates the field.
    let r = unsafe { std::ffi::CStr::from_ptr(u.release.as_ptr()) };
    Some(r.to_string_lossy().into_owned())
}

/// The processor: cpuinfo's model and threads, the physical cores as the
/// distinct sibling sets of sysfs's topology (every architecture has
/// them), and cpufreq's ceiling.
fn read_cpu(errors: &mut Vec<String>) -> Cpu {
    let info = read("/proc/cpuinfo")
        .map(|t| linux_sys::cpuinfo(&t))
        .unwrap_or_default();
    if info.model.is_none() {
        errors.push("the processor's model is not stated in /proc/cpuinfo".into());
    }
    let mut siblings = BTreeSet::new();
    let mut threads = 0u32;
    if let Ok(dir) = std::fs::read_dir("/sys/devices/system/cpu") {
        for e in dir.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_cpu = name
                .strip_prefix("cpu")
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
            if !is_cpu {
                continue;
            }
            threads += 1;
            let topo = e.path().join("topology");
            if let Some(set) = read_line(topo.join("core_cpus_list"))
                .or_else(|| read_line(topo.join("thread_siblings_list")))
            {
                siblings.insert(set);
            }
        }
    }
    let khz = read_line("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq")
        .and_then(|v| v.parse::<u64>().ok());
    Cpu {
        model: info.model,
        cores: (!siblings.is_empty())
            .then_some(siblings.len() as u32)
            .or(info.cores),
        threads: Some(if info.threads > 0 {
            info.threads
        } else {
            threads
        })
        .filter(|t| *t > 0),
        frequency_mhz: khz.map(|k| k / 1000).or(info.mhz.map(|m| m.round() as u64)),
        ..Default::default()
    }
}

fn hex_id(path: &Path) -> Option<u16> {
    let v = read_line(path)?;
    u16::from_str_radix(v.trim_start_matches("0x"), 16).ok()
}

/// Every DRM card (`/sys/class/drm/cardN`, not its connectors): the PCI ids
/// named from pci.ids, the kernel driver and its version, amdgpu's VRAM;
/// NVIDIA's name, driver and VRAM from `nvidia-smi`.
fn read_gpus(errors: &mut Vec<String>) -> (Vec<Gpu>, Vec<PathBuf>) {
    let Ok(dir) = std::fs::read_dir("/sys/class/drm") else {
        return (Vec::new(), Vec::new());
    };
    let mut cards: Vec<PathBuf> = dir
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().is_some_and(|n| {
                n.to_string_lossy()
                    .strip_prefix("card")
                    .is_some_and(|k| !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()))
            })
        })
        .collect();
    cards.sort();
    let ids = PCI_IDS.iter().find_map(read);
    let kernel = kernel_release();
    let mut gpus = Vec::new();
    let mut devices = Vec::new();
    for card in cards {
        let dev = card.join("device");
        let Some(vendor) = hex_id(&dev.join("vendor")) else {
            continue;
        };
        let device = hex_id(&dev.join("device")).unwrap_or(0);
        let driver = std::fs::read_link(dev.join("driver"))
            .ok()
            .and_then(|l| l.file_name().map(|n| n.to_string_lossy().into_owned()));
        let (vendor_name, device_name) = ids
            .as_deref()
            .map(|t| linux_sys::pci_names(t, vendor, device))
            .unwrap_or((None, None));
        let vendor_short = linux_sys::gpu_vendor(vendor)
            .map(str::to_string)
            .or(vendor_name);
        let name = device_name.unwrap_or_else(|| {
            format!(
                "{} GPU [{vendor:04x}:{device:04x}]",
                vendor_short.as_deref().unwrap_or("PCI")
            )
        });
        let driver = driver.map(|d| {
            let version = read_line(format!("/sys/module/{d}/version")).or(kernel.clone());
            match version {
                Some(v) => format!("{d} {v}"),
                None => d,
            }
        });
        gpus.push(Gpu {
            name,
            vendor: vendor_short,
            driver,
            vram_total_bytes: read_line(dev.join("mem_info_vram_total"))
                .and_then(|v| v.parse().ok()),
            ..Default::default()
        });
        devices.push(dev);
    }
    // NVIDIA's own tool, for what its driver keeps out of sysfs.
    let nvidia: Vec<usize> = gpus
        .iter()
        .enumerate()
        .filter(|(_, g)| g.vendor.as_deref() == Some("NVIDIA"))
        .map(|(i, _)| i)
        .collect();
    if !nvidia.is_empty() {
        match tool(
            "nvidia-smi",
            &[
                "--query-gpu=name,driver_version,memory.total",
                "--format=csv,noheader,nounits",
            ],
            NVIDIA_SMI,
        ) {
            Ok(t) => {
                for (i, (name, driver, vram)) in nvidia.iter().zip(linux_tools::nvidia_smi(&t)) {
                    let g = &mut gpus[*i];
                    g.name = name;
                    g.driver = driver.map(|d| format!("nvidia {d}")).or(g.driver.take());
                    g.vram_total_bytes = vram.or(g.vram_total_bytes);
                }
            }
            Err(e) => errors.push(format!("NVIDIA GPU name and VRAM not read ({e})")),
        }
        errors.push(
            "NVIDIA GPU usage is not sampled (nvidia-smi is kept out of the 15 s sample)".into(),
        );
    }
    (gpus, devices)
}
