//! The identity key's seed wrapped with DPAPI under the machine's scope
//! before it touches disk, so a copy is useless on any other computer —
//! but any process on THIS machine can unwrap it, so keeping local users
//! out rests on the file's ACL (`os::create_private`).

use anyhow::{Context, Result};
use windows::core::w;
use windows::Win32::Foundation::LocalFree;
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN,
    CRYPT_INTEGER_BLOB,
};

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    }
}

fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    // SAFETY: the blob was allocated by DPAPI and is freed exactly once here.
    unsafe {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(out.pbData.cast())));
        v
    }
}

fn protect(seed: &[u8]) -> Result<Vec<u8>> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input blob points at `seed` for the call's duration.
    unsafe {
        CryptProtectData(
            &blob(seed),
            w!("daedalus-agent identity"),
            None,
            None,
            None,
            CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .context("DPAPI protect")?;
    }
    Ok(take(out))
}

fn unprotect(sealed: &[u8]) -> Result<Vec<u8>> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as above.
    unsafe {
        CryptUnprotectData(
            &blob(sealed),
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .context("DPAPI unprotect")?;
    }
    Ok(take(out))
}

pub fn seal(seed: &[u8]) -> Result<Vec<u8>> {
    protect(seed)
}

pub fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    unprotect(sealed)
}
