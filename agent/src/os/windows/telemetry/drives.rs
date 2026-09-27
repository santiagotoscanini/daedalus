//! The ten-minute tier: the physical drives, their SMART counters and the
//! letters on each, from one PowerShell script (`Get-PhysicalDisk`,
//! `Get-StorageReliabilityCounter`, `Get-Partition`) and its parser.

use std::collections::HashMap;

use serde_json::Value;

use super::powershell::{j_id, j_list, j_str, j_u64};
use super::{collapse_ws, meaningful};
use crate::telemetry::Drive;

/// The ten-minute script: the physical drives, their SMART counters and
/// the drive letters on each, as one JSON document. Each cmdlet is tried
/// on its own so one refusing (`Get-StorageReliabilityCounter` on a
/// virtual disk, say) still leaves the others. Enum-typed properties are
/// cast to strings, since `ConvertTo-Json` would render them as numbers.
/// Single quotes only: the script travels as one `-Command` argument and
/// double quotes would meet the command-line escaping.
pub(super) const DRIVES_SCRIPT: &str = r"
$ErrorActionPreference = 'Stop'
$out = @{ disks = @(); counters = @(); partitions = @(); errors = @() }
try {
  $out.disks = @(Get-PhysicalDisk | Select-Object FriendlyName, SerialNumber, FirmwareVersion, Size, DeviceId,
    @{n='BusType';e={[string]$_.BusType}}, @{n='MediaType';e={[string]$_.MediaType}}, @{n='HealthStatus';e={[string]$_.HealthStatus}})
} catch { $out.errors += ('Get-PhysicalDisk|' + $_.Exception.Message) }
try {
  $out.counters = @(Get-PhysicalDisk | Get-StorageReliabilityCounter | Select-Object DeviceId, Temperature, PowerOnHours, Wear, ReadErrorsTotal, WriteErrorsTotal)
} catch { $out.errors += ('Get-StorageReliabilityCounter|' + $_.Exception.Message) }
try {
  $out.partitions = @(Get-Partition | Where-Object { [int]$_.DriveLetter -gt 0 } | Select-Object DiskNumber, @{n='Letter';e={[string]$_.DriveLetter}})
} catch { $out.errors += ('Get-Partition|' + $_.Exception.Message) }
[pscustomobject]$out | ConvertTo-Json -Compress -Depth 4
";

/// A `BusType` as the page names it: the enum's name lowercased, or the
/// number the CIM class carries when the cast gave one.
fn bus_name(s: &str) -> Option<String> {
    let l = s.trim().to_ascii_lowercase();
    let named = match l.as_str() {
        "" | "unknown" | "0" => return None,
        "1" => "scsi",
        "2" => "atapi",
        "3" => "ata",
        "4" => "1394",
        "5" => "ssa",
        "6" => "fibre channel",
        "7" => "usb",
        "8" => "raid",
        "9" => "iscsi",
        "10" => "sas",
        "11" => "sata",
        "12" => "sd",
        "13" => "mmc",
        "14" => "virtual",
        "15" => "file backed virtual",
        "16" => "storage spaces",
        "17" => "nvme",
        "18" => "scm",
        "19" => "ufs",
        other => other,
    };
    Some(named.to_string())
}

/// A `MediaType` as "ssd" | "hdd" | "scm".
fn media_kind(s: &str) -> Option<&'static str> {
    match s.trim().to_ascii_lowercase().as_str() {
        "ssd" | "4" => Some("ssd"),
        "hdd" | "3" => Some("hdd"),
        "scm" | "5" => Some("scm"),
        _ => None,
    }
}

/// A `HealthStatus` as the page says it.
fn health_name(s: &str) -> Option<&'static str> {
    match s.trim().to_ascii_lowercase().as_str() {
        "healthy" | "0" => Some("healthy"),
        "warning" | "1" => Some("warning"),
        "unhealthy" | "2" => Some("unhealthy"),
        _ => None,
    }
}

/// Whether a bus is one drives come and go on.
fn bus_removable(bus: &str) -> bool {
    matches!(bus, "usb" | "sd" | "mmc" | "1394")
}

/// The drives from the ten-minute script's document.
pub(super) fn parse_drives(v: &Value) -> Vec<Drive> {
    // DeviceId → the SMART counters for it.
    let counters: HashMap<String, Value> = j_list(v, "counters")
        .into_iter()
        .filter_map(|c| Some((j_id(&c, "DeviceId")?, c)))
        .collect();
    // DiskNumber → the drive letters on it.
    let mut letters: HashMap<String, Vec<String>> = HashMap::new();
    for p in j_list(v, "partitions") {
        let (Some(disk), Some(letter)) = (j_id(&p, "DiskNumber"), j_str(&p, "Letter")) else {
            continue;
        };
        let Some(c) = letter.chars().next().filter(char::is_ascii_alphabetic) else {
            continue;
        };
        letters
            .entry(disk)
            .or_default()
            .push(format!("{}:", c.to_ascii_uppercase()));
    }
    let mut out = Vec::new();
    for d in j_list(v, "disks") {
        let id = j_id(&d, "DeviceId");
        let bus = j_str(&d, "BusType").and_then(|s| bus_name(&s));
        let c = id.as_ref().and_then(|id| counters.get(id));
        // A physical disk's DeviceId is the disk number `Get-Partition` names.
        let mut volumes = id
            .as_ref()
            .and_then(|id| letters.get(id))
            .cloned()
            .unwrap_or_default();
        volumes.sort();
        volumes.dedup();
        out.push(Drive {
            name: j_str(&d, "FriendlyName")
                .map(|s| collapse_ws(&s))
                .unwrap_or_else(|| format!("Disk {}", id.as_deref().unwrap_or("?"))),
            serial: j_str(&d, "SerialNumber").and_then(|s| meaningful(&s)),
            firmware: j_str(&d, "FirmwareVersion").and_then(|s| meaningful(&s)),
            size_bytes: j_u64(&d, "Size").filter(|&b| b > 0),
            kind: j_str(&d, "MediaType")
                .and_then(|s| media_kind(&s))
                .map(str::to_string),
            health: j_str(&d, "HealthStatus")
                .and_then(|s| health_name(&s))
                .map(str::to_string),
            // A reading of 0 °C is a counter the drive does not keep.
            temperature_c: c
                .and_then(|c| j_u64(c, "Temperature"))
                .filter(|&t| t > 0)
                .map(|t| t as f64),
            power_on_hours: c.and_then(|c| j_u64(c, "PowerOnHours")),
            wear_pct: c
                .and_then(|c| j_u64(c, "Wear"))
                .map(|w| (w as f64).min(100.0)),
            read_errors: c.and_then(|c| j_u64(c, "ReadErrorsTotal")),
            write_errors: c.and_then(|c| j_u64(c, "WriteErrorsTotal")),
            removable: bus.as_deref().map(bus_removable),
            bus,
            volumes,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::powershell::script_errors;
    use super::*;

    #[test]
    fn drives_from_script_document() {
        let v: Value = serde_json::from_str(
            r#"{
              "disks": [
                {"FriendlyName":"Samsung SSD 990 PRO 2TB","SerialNumber":" S6Z2NJ0T ","FirmwareVersion":"4B2QJXD7",
                 "Size":2000398934016,"DeviceId":"0","BusType":"NVMe","MediaType":"SSD","HealthStatus":"Healthy"},
                {"FriendlyName":"ST4000DM004","SerialNumber":"","FirmwareVersion":"0001",
                 "Size":4000787030016,"DeviceId":"1","BusType":"11","MediaType":"3","HealthStatus":"Warning"},
                {"FriendlyName":"Flash","DeviceId":"2","BusType":"USB","MediaType":"Unspecified","HealthStatus":"Unknown"}
              ],
              "counters": {"DeviceId":"0","Temperature":41,"PowerOnHours":1234,"Wear":3,"ReadErrorsTotal":0,"WriteErrorsTotal":0},
              "partitions": [
                {"DiskNumber":0,"Letter":"C"},{"DiskNumber":0,"Letter":"D"},{"DiskNumber":1,"Letter":"e"}
              ],
              "errors": ["Get-StorageReliabilityCounter|Access denied.\nsecond line"]
            }"#,
        )
        .expect("json");
        let d = parse_drives(&v);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0].name, "Samsung SSD 990 PRO 2TB");
        assert_eq!(d[0].serial.as_deref(), Some("S6Z2NJ0T"));
        assert_eq!(d[0].bus.as_deref(), Some("nvme"));
        assert_eq!(d[0].kind.as_deref(), Some("ssd"));
        assert_eq!(d[0].health.as_deref(), Some("healthy"));
        assert_eq!(d[0].temperature_c, Some(41.0));
        assert_eq!(d[0].power_on_hours, Some(1234));
        assert_eq!(d[0].wear_pct, Some(3.0));
        assert_eq!(d[0].removable, Some(false));
        assert_eq!(d[0].volumes, vec!["C:".to_string(), "D:".to_string()]);
        assert_eq!(d[1].serial, None);
        assert_eq!(d[1].bus.as_deref(), Some("sata"));
        assert_eq!(d[1].kind.as_deref(), Some("hdd"));
        assert_eq!(d[1].health.as_deref(), Some("warning"));
        assert_eq!(d[1].temperature_c, None);
        assert_eq!(d[1].volumes, vec!["E:".to_string()]);
        assert_eq!(d[2].bus.as_deref(), Some("usb"));
        assert_eq!(d[2].kind, None);
        assert_eq!(d[2].health, None);
        assert_eq!(d[2].removable, Some(true));
        assert!(d[2].volumes.is_empty());
        let errs = script_errors(&v, |_| "SMART counters".into());
        assert_eq!(
            errs,
            vec![
                "SMART counters: Get-StorageReliabilityCounter refused: Access denied.".to_string()
            ]
        );
    }
}
