//! The raw SMBIOS table (`GetSystemFirmwareTable('RSMB')`): the chassis
//! type (structure 3) and the memory arrays and devices (16 and 17), which
//! the registry's BIOS key does not carry. The parser is pure and takes
//! any byte slice, so a truncated or malformed table keeps what parsed.

use windows::Win32::System::SystemInformation::{GetSystemFirmwareTable, RSMB};

use super::meaningful;
use crate::telemetry::MemoryModule;

/// What the raw SMBIOS table says that the registry's BIOS key does not.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Smbios {
    pub(super) form: Option<&'static str>,
    pub(super) slots: Option<u32>,
    pub(super) max_capacity_bytes: Option<u64>,
    pub(super) modules: Vec<MemoryModule>,
}

/// The chassis type (SMBIOS type 3, byte 5, lock bit masked) as a shape.
fn chassis_form(ty: u8) -> Option<&'static str> {
    Some(match ty & 0x7F {
        8..=10 | 14 | 31 | 32 => "laptop",
        30 => "tablet",
        3..=5 | 15 | 16 | 24 => "desktop",
        6 | 7 => "tower",
        35 | 36 => "mini",
        13 => "all-in-one",
        17 | 23 | 25 | 28 | 29 => "server",
        _ => return None,
    })
}

/// The memory type enum (SMBIOS type 17, byte 0x12) as its name.
fn memory_kind(ty: u8) -> Option<&'static str> {
    Some(match ty {
        0x03 => "DRAM",
        0x0F => "SDRAM",
        0x11 => "RDRAM",
        0x12 => "DDR",
        0x13 => "DDR2",
        0x14 => "DDR2 FB-DIMM",
        0x18 => "DDR3",
        0x19 => "FBD2",
        0x1A => "DDR4",
        0x1B => "LPDDR",
        0x1C => "LPDDR2",
        0x1D => "LPDDR3",
        0x1E => "LPDDR4",
        0x20 => "HBM",
        0x21 => "HBM2",
        0x22 => "DDR5",
        0x23 => "LPDDR5",
        0x24 => "HBM3",
        _ => return None,
    })
}

fn u16_at(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

fn u32_at(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}

fn u64_at(b: &[u8], off: usize) -> Option<u64> {
    Some(u64::from(u32_at(b, off)?) | (u64::from(u32_at(b, off + 4)?) << 32))
}

/// A memory device's size in bytes from the type 17 fields: 0 is an
/// empty slot (None), 0xFFFF unknown (None), 0x7FFF "see Extended Size";
/// otherwise bit 15 says kilobytes rather than megabytes.
fn module_size(size: u16, extended_mb: Option<u32>) -> Option<u64> {
    match size {
        0 | 0xFFFF => None,
        0x7FFF => extended_mb
            .map(|mb| u64::from(mb & 0x7FFF_FFFF) << 20)
            .filter(|&b| b > 0),
        s if s & 0x8000 != 0 => Some(u64::from(s & 0x7FFF) << 10),
        s => Some(u64::from(s) << 20),
    }
}

/// A speed field with its 3.2 extension: 0 unknown, 0xFFFF "see extended".
fn module_speed(speed: Option<u16>, extended: Option<u32>) -> Option<u32> {
    match speed? {
        0 => None,
        0xFFFF => extended.filter(|&s| s > 0),
        s => Some(u32::from(s)),
    }
}

/// The type 16 capacity: kilobytes in the u32, or "see the extended field"
/// (bytes) when it holds 0x80000000.
fn array_capacity(kb: u32, extended_bytes: Option<u64>) -> Option<u64> {
    match kb {
        0 => None,
        0x8000_0000 => extended_bytes.filter(|&b| b > 0),
        kb => Some(u64::from(kb) << 10),
    }
}

/// One SMBIOS structure: its formatted area and its strings (1-based in
/// the formatted area's string indices).
struct Structure<'a> {
    ty: u8,
    body: &'a [u8],
    strings: Vec<String>,
}

impl Structure<'_> {
    /// The string a formatted-area byte at `off` names, when meaningful.
    fn string(&self, off: usize) -> Option<String> {
        let idx = *self.body.get(off)? as usize;
        if idx == 0 {
            return None;
        }
        meaningful(self.strings.get(idx - 1)?)
    }
}

/// The structures of an SMBIOS table (the bytes after `RawSMBIOSData`'s
/// eight-byte header), in order, stopping at the end-of-table marker or
/// at anything malformed.
fn smbios_structures(table: &[u8]) -> Vec<Structure<'_>> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 4 <= table.len() {
        let ty = table[off];
        let len = table[off + 1] as usize;
        if ty == 127 || len < 4 || off + len > table.len() {
            break;
        }
        let body = &table[off..off + len];
        // The string set: NUL-terminated strings, then one more NUL; a
        // structure with no strings is two NULs. An empty string can only
        // be that terminator, so a lone NUL (firmware that skips the
        // second one) ends the set too.
        let mut strings = Vec::new();
        let mut p = off + len;
        loop {
            let start = p;
            while p < table.len() && table[p] != 0 {
                p += 1;
            }
            if p >= table.len() {
                // Truncated inside a string set: keep what parsed.
                out.push(Structure { ty, body, strings });
                return out;
            }
            let empty = p == start;
            if !empty {
                strings.push(String::from_utf8_lossy(&table[start..p]).to_string());
            }
            p += 1;
            if table.get(p) == Some(&0) {
                p += 1;
                break;
            }
            if empty || p >= table.len() {
                break;
            }
        }
        out.push(Structure { ty, body, strings });
        off = p;
    }
    out
}

/// The chassis type and the memory arrays and devices from the table.
fn parse_smbios(table: &[u8]) -> Smbios {
    let mut out = Smbios::default();
    // (use, devices, capacity) per Physical Memory Array; the system
    // memory ones (use 3) are what counts, the rest (flash, cache) only
    // when the firmware marks nothing as system memory.
    let mut arrays: Vec<(u8, u32, Option<u64>)> = Vec::new();
    for s in smbios_structures(table) {
        match s.ty {
            3 => {
                if out.form.is_none() {
                    out.form = s.body.get(5).copied().and_then(chassis_form);
                }
            }
            16 => {
                let Some(devices) = u16_at(s.body, 0x0D) else {
                    continue;
                };
                let usage = s.body.get(5).copied().unwrap_or(0);
                let cap =
                    u32_at(s.body, 0x07).and_then(|kb| array_capacity(kb, u64_at(s.body, 0x0F)));
                arrays.push((usage, u32::from(devices), cap));
            }
            17 => {
                let Some(size) = u16_at(s.body, 0x0C) else {
                    continue;
                };
                let size_bytes = module_size(size, u32_at(s.body, 0x1C));
                if size == 0 {
                    continue;
                }
                let configured = module_speed(u16_at(s.body, 0x20), u32_at(s.body, 0x58));
                let rated = module_speed(u16_at(s.body, 0x15), u32_at(s.body, 0x54));
                out.modules.push(MemoryModule {
                    locator: s.string(0x10),
                    size_bytes,
                    speed_mts: configured.or(rated),
                    kind: s
                        .body
                        .get(0x12)
                        .copied()
                        .and_then(memory_kind)
                        .map(str::to_string),
                    manufacturer: s.string(0x17),
                    part_number: s.string(0x1A),
                });
            }
            _ => {}
        }
    }
    let system: Vec<_> = arrays.iter().filter(|a| a.0 == 3).collect();
    let picked: Vec<_> = if system.is_empty() {
        arrays.iter().collect()
    } else {
        system
    };
    if !picked.is_empty() {
        let slots: u32 = picked.iter().map(|a| a.1).sum();
        out.slots = (slots > 0).then_some(slots);
        let cap: u64 = picked.iter().filter_map(|a| a.2).sum();
        out.max_capacity_bytes = (cap > 0).then_some(cap);
    }
    out
}

/// The raw SMBIOS table from the firmware, parsed.
pub(super) fn read_smbios() -> Result<Smbios, String> {
    // SAFETY: a size query with no buffer.
    let size = unsafe { GetSystemFirmwareTable(RSMB, 0, None) };
    if size == 0 {
        return Err("GetSystemFirmwareTable gave no SMBIOS table".into());
    }
    let mut buf = vec![0u8; size as usize];
    // SAFETY: the buffer is the size the call asked for; it writes at most
    // that many bytes and returns how many.
    let written = unsafe { GetSystemFirmwareTable(RSMB, 0, Some(&mut buf[..])) } as usize;
    if written == 0 || written > buf.len() {
        return Err("GetSystemFirmwareTable did not fill the SMBIOS table".into());
    }
    // RawSMBIOSData: Used20CallingMethod, major, minor, DmiRevision (four
    // bytes), Length (u32), then the table.
    let Some(len) = u32_at(&buf, 4) else {
        return Err("SMBIOS table is shorter than its header".into());
    };
    let end = (8 + len as usize).min(written);
    if end <= 8 {
        return Err("SMBIOS table is empty".into());
    }
    Ok(parse_smbios(&buf[8..end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One SMBIOS structure: header, formatted bytes, strings, terminator
    /// (two NULs when there are no strings, as the spec says).
    fn structure(ty: u8, handle: u16, formatted: &[u8], strings: &[&str]) -> Vec<u8> {
        let len = 4 + formatted.len();
        let mut b = vec![ty, len as u8, handle as u8, (handle >> 8) as u8];
        b.extend_from_slice(formatted);
        for s in strings {
            b.extend_from_slice(s.as_bytes());
            b.push(0);
        }
        if strings.is_empty() {
            b.push(0);
        }
        b.push(0);
        b
    }

    #[test]
    fn smbios_chassis_arrays_and_devices() {
        let mut table = Vec::new();
        // Type 3: manufacturer string 1, chassis type 10 (notebook) with the
        // lock bit set.
        table.extend(structure(
            3,
            0x0300,
            &[1, 0x80 | 10, 0, 0, 0],
            &["Dell Inc."],
        ));
        // Type 16: system memory (use 3), max capacity "see extended", two
        // devices, extended max 64 GiB.
        let mut f16 = vec![3, 3, 3];
        f16.extend_from_slice(&0x8000_0000u32.to_le_bytes());
        f16.extend_from_slice(&0xFFFEu16.to_le_bytes());
        f16.extend_from_slice(&2u16.to_le_bytes());
        f16.extend_from_slice(&(64u64 << 30).to_le_bytes());
        table.extend(structure(16, 0x1000, &f16, &[]));
        // Type 17: one 16 GiB DDR5 at 5600 configured (4800 rated), one empty.
        let mut f17 = vec![0u8; 0x5C - 4];
        f17[0x0C - 4..0x0E - 4].copy_from_slice(&(16 * 1024u16).to_le_bytes());
        f17[0x10 - 4] = 1; // locator
        f17[0x12 - 4] = 0x22; // DDR5
        f17[0x15 - 4..0x17 - 4].copy_from_slice(&4800u16.to_le_bytes());
        f17[0x17 - 4] = 2; // manufacturer
        f17[0x1A - 4] = 3; // part number
        f17[0x20 - 4..0x22 - 4].copy_from_slice(&5600u16.to_le_bytes());
        table.extend(structure(
            17,
            0x1100,
            &f17,
            &["DIMM_A1", "Kingston", "KF556C40-16 "],
        ));
        let mut empty = vec![0u8; 0x5C - 4];
        empty[0x10 - 4] = 1;
        table.extend(structure(17, 0x1101, &empty, &["DIMM_B1"]));
        // Type 127: end of table, then junk that must not be read.
        table.extend(structure(127, 0x7F00, &[], &[]));
        table.extend_from_slice(&[17, 200, 0, 0, 1, 2, 3]);

        let s = parse_smbios(&table);
        assert_eq!(s.form, Some("laptop"));
        assert_eq!(s.slots, Some(2));
        assert_eq!(s.max_capacity_bytes, Some(64 << 30));
        assert_eq!(s.modules.len(), 1);
        let m = &s.modules[0];
        assert_eq!(m.locator.as_deref(), Some("DIMM_A1"));
        assert_eq!(m.size_bytes, Some(16 << 30));
        assert_eq!(m.speed_mts, Some(5600));
        assert_eq!(m.kind.as_deref(), Some("DDR5"));
        assert_eq!(m.manufacturer.as_deref(), Some("Kingston"));
        assert_eq!(m.part_number.as_deref(), Some("KF556C40-16"));
    }

    #[test]
    fn smbios_short_structures_and_extended_size() {
        // A 2.1-era type 17 (21 bytes) with a size in KB, no speed fields;
        // a type 16 with a plain capacity in KB and use "flash" (not
        // system memory), which is counted only because nothing else is.
        let mut f17 = vec![0u8; 0x15 - 4];
        f17[0x0C - 4..0x0E - 4].copy_from_slice(&(0x8000u16 | 512).to_le_bytes());
        f17[0x12 - 4] = 0x18;
        let mut f16 = vec![3, 4, 3];
        f16.extend_from_slice(&(8u32 << 20).to_le_bytes());
        f16.extend_from_slice(&0xFFFEu16.to_le_bytes());
        f16.extend_from_slice(&4u16.to_le_bytes());
        let mut table = structure(16, 1, &f16, &[]);
        table.extend(structure(17, 2, &f17, &[]));
        // A 2.7 type 17 that says "see extended size": 32 GiB.
        let mut f17x = vec![0u8; 0x22 - 4];
        f17x[0x0C - 4..0x0E - 4].copy_from_slice(&0x7FFFu16.to_le_bytes());
        f17x[0x1C - 4..0x20 - 4].copy_from_slice(&(32 * 1024u32).to_le_bytes());
        table.extend(structure(17, 3, &f17x, &[]));
        let s = parse_smbios(&table);
        assert_eq!(s.form, None);
        assert_eq!(s.slots, Some(4));
        assert_eq!(s.max_capacity_bytes, Some(8 << 30));
        assert_eq!(s.modules.len(), 2);
        assert_eq!(s.modules[0].size_bytes, Some(512 << 10));
        assert_eq!(s.modules[0].speed_mts, None);
        assert_eq!(s.modules[0].kind.as_deref(), Some("DDR3"));
        assert_eq!(s.modules[1].size_bytes, Some(32 << 30));
        // Truncated inside the last string set: what parsed is kept, no
        // panic; truncated inside the last formatted area: that one is
        // dropped.
        assert_eq!(parse_smbios(&table[..table.len() - 1]).modules.len(), 2);
        assert_eq!(parse_smbios(&table[..table.len() - 3]).modules.len(), 1);
        assert_eq!(parse_smbios(&[]), Smbios::default());
        // Firmware that ends a string-less structure with ONE NUL: the
        // next header still lines up.
        let mut lone = structure(16, 1, &f16, &[]);
        lone.pop();
        lone.extend(structure(17, 2, &f17, &[]));
        let s = parse_smbios(&lone);
        assert_eq!(s.slots, Some(4));
        assert_eq!(s.modules.len(), 1);
    }

    #[test]
    fn chassis_and_memory_enums() {
        assert_eq!(chassis_form(3), Some("desktop"));
        assert_eq!(chassis_form(7), Some("tower"));
        assert_eq!(chassis_form(13), Some("all-in-one"));
        assert_eq!(chassis_form(23), Some("server"));
        assert_eq!(chassis_form(31), Some("laptop"));
        assert_eq!(chassis_form(35), Some("mini"));
        assert_eq!(chassis_form(2), None);
        assert_eq!(memory_kind(0x1A), Some("DDR4"));
        assert_eq!(memory_kind(0x23), Some("LPDDR5"));
        assert_eq!(memory_kind(0x02), None);
        assert_eq!(module_size(0xFFFF, None), None);
        assert_eq!(module_size(0x7FFF, None), None);
        assert_eq!(module_speed(Some(0xFFFF), Some(8800)), Some(8800));
        assert_eq!(array_capacity(0x8000_0000, None), None);
    }
}
