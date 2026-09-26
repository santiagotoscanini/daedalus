//! The `system_profiler` documents: the machine, the memory modules and
//! the GPUs (static), the physical drives with the boot volume's store
//! from `diskutil` (slow), and the battery's health (every hundredth
//! sample). Pure functions over JSON text, tested on any OS.

use serde_json::Value;

use crate::telemetry::{Drive, Gpu, Machine, MemoryModule};

/// `system_profiler SPHardwareDataType -json`, without the serial number or
/// the hardware UUID it also prints.
pub(super) fn parse_hardware(json: &str) -> Option<Machine> {
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
pub(super) struct MemoryProfile {
    pub(super) slots: Option<u32>,
    pub(super) max_capacity_bytes: Option<u64>,
    pub(super) modules: Vec<MemoryModule>,
}

/// Apple Silicon answers one entry with no slot list — the memory is on the
/// package, so zero slots, the ceiling is what is fitted, and the one module
/// is `total` (`hw.memsize`; the "16 GB" it prints is that number rounded).
/// Intel answers a slot list ("BANK 0/DIMM0"…), one module per fitted
/// DIMM; an empty slot counts as a slot and no module. The firmware states
/// no ceiling on either, so it is the fitted total or nothing.
pub(super) fn parse_memory(json: &str, total: Option<u64>) -> Option<MemoryProfile> {
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
pub(super) fn parse_size(s: &str) -> Option<u64> {
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
pub(super) fn parse_displays(json: &str) -> Vec<Gpu> {
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
pub(super) fn parse_storage(json: &str, boot_store: Option<&str>) -> Vec<Drive> {
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
pub(super) fn parse_physical_store(text: &str) -> Option<String> {
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

/// What `system_profiler` knows about the battery that `pmset` does not:
/// slow-changing, so read with the slow facts and carried between samples.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct BatteryHealth {
    /// Of the design capacity, 0–100.
    pub(super) max_capacity_pct: Option<f64>,
    pub(super) cycles: Option<u64>,
    /// "Normal", "Service Recommended"…, as macOS words it.
    pub(super) condition: Option<String>,
}

/// `system_profiler SPPowerDataType -json`, its
/// `sppower_battery_health_info` dict: `…_maximum_capacity` ("85 %") → 85,
/// `…_cycle_count` (a number), `sppower_battery_health` (a word).
pub(super) fn parse_battery_health(json: &str) -> Option<BatteryHealth> {
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
}
