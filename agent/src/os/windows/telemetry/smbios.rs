//! Reading the raw SMBIOS table (`GetSystemFirmwareTable('RSMB')`); the
//! parser is OS-neutral (telemetry/parse/smbios.rs).

use windows::Win32::System::SystemInformation::{GetSystemFirmwareTable, RSMB};

use crate::telemetry::parse::smbios::{parse_smbios, u32_at, Smbios};

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
