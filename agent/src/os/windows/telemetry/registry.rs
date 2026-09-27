//! Registry reads: typed values under HKLM or any root key, whether a key
//! exists, and a key's subkeys. Every tier reads through these; none of
//! them blocks on anything but the registry itself.

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    RRF_RT_ANY, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

use super::from_wide;

pub(super) fn reg_sz(sub: PCWSTR, value: PCWSTR) -> Option<String> {
    reg_sz_at(HKEY_LOCAL_MACHINE, sub, value)
}

/// A string value under any root key — HKLM, or a user's hive under
/// `HKEY_USERS`. A null `value` reads the key's default value. A
/// `REG_EXPAND_SZ` comes back expanded (as `RegGetValue` does without
/// `RRF_NOEXPAND`), with THIS process's environment, which is the service's.
pub(super) fn reg_sz_at(root: HKEY, sub: PCWSTR, value: PCWSTR) -> Option<String> {
    let mut len: u32 = 0;
    // SAFETY: a size query, then a read into a buffer of that size; `sub`
    // and `value` are NUL-terminated (or null) for the whole call.
    unsafe {
        if RegGetValueW(root, sub, value, RRF_RT_REG_SZ, None, None, Some(&mut len)).is_err() {
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2)];
        if RegGetValueW(
            root,
            sub,
            value,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
        .is_err()
        {
            return None;
        }
        from_wide(&buf)
    }
}

pub(super) fn reg_dword(sub: PCWSTR, value: PCWSTR) -> Option<u32> {
    let mut out: u32 = 0;
    let mut len: u32 = 4;
    // SAFETY: a four-byte read into a u32.
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            sub,
            value,
            RRF_RT_REG_DWORD,
            None,
            Some((&mut out as *mut u32).cast()),
            Some(&mut len),
        )
    };
    rc.is_ok().then_some(out)
}

/// An unsigned integer of whichever width the value has: REG_QWORD,
/// REG_DWORD, or REG_BINARY of 4 or 8 bytes (what display drivers write
/// for `HardwareInformation.MemorySize`). Little-endian, as the registry is.
pub(super) fn reg_uint(sub: PCWSTR, value: PCWSTR) -> Option<u64> {
    let mut buf = [0u8; 8];
    let mut len: u32 = buf.len() as u32;
    // SAFETY: a read of at most eight bytes into an eight-byte buffer;
    // RegGetValueW fails rather than overruns when the value is longer.
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            sub,
            value,
            RRF_RT_ANY,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if rc.is_err() {
        return None;
    }
    match len {
        8 => Some(u64::from_le_bytes(buf)),
        4 => Some(u64::from(u32::from_le_bytes([
            buf[0], buf[1], buf[2], buf[3],
        ]))),
        _ => None,
    }
}

/// Whether a key exists under HKLM: opened for reading and closed again.
pub(super) fn reg_key_exists(sub: PCWSTR) -> bool {
    reg_key_exists_at(HKEY_LOCAL_MACHINE, sub)
}

pub(super) fn reg_key_exists_at(root: HKEY, sub: PCWSTR) -> bool {
    let mut h = HKEY::default();
    // SAFETY: `sub` is NUL-terminated; the handle is written on success
    // and closed right away.
    unsafe {
        if RegOpenKeyExW(root, sub, None, KEY_READ, &mut h) != ERROR_SUCCESS {
            return false;
        }
        let _ = RegCloseKey(h);
    }
    true
}

/// The names of a key's subkeys, in the registry's order.
pub(super) fn reg_subkeys(root: HKEY, sub: PCWSTR) -> Result<Vec<String>, String> {
    let mut h = HKEY::default();
    // SAFETY: the key is opened for reading, enumerated with a name buffer
    // of the registry's maximum key-name length, and closed on every path.
    unsafe {
        let rc = RegOpenKeyExW(root, sub, None, KEY_READ, &mut h);
        if rc != ERROR_SUCCESS {
            return Err(format!("RegOpenKeyEx failed: {}", rc.0));
        }
        let mut out = Vec::new();
        let mut i = 0u32;
        let rc = loop {
            let mut name = [0u16; 256];
            let mut len = name.len() as u32;
            let rc = RegEnumKeyExW(
                h,
                i,
                Some(PWSTR(name.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            );
            if rc != ERROR_SUCCESS {
                break rc;
            }
            out.extend(from_wide(&name));
            i += 1;
        };
        let _ = RegCloseKey(h);
        if rc == ERROR_NO_MORE_ITEMS {
            Ok(out)
        } else {
            Err(format!("RegEnumKeyEx failed: {}", rc.0))
        }
    }
}

/// A DWORD under any root key.
pub(super) fn reg_dword_at(root: HKEY, sub: PCWSTR, value: PCWSTR) -> Option<u32> {
    let mut out: u32 = 0;
    let mut len: u32 = 4;
    // SAFETY: a four-byte read into a u32.
    let rc = unsafe {
        RegGetValueW(
            root,
            sub,
            value,
            RRF_RT_REG_DWORD,
            None,
            Some((&mut out as *mut u32).cast()),
            Some(&mut len),
        )
    };
    rc.is_ok().then_some(out)
}
