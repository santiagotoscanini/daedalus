//! Who owns a file, and the data directory's DACL (private.rs decides).

use std::path::Path;

use anyhow::{bail, Context, Result};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
use windows::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
use windows::Win32::Security::{
    IsWellKnownSid, WinBuiltinAdministratorsSid, WinLocalSystemSid, OWNER_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID,
};

use crate::private::Owner;

/// The file's owner SID, as far as private.rs needs to know it.
pub fn file_owner(path: &Path) -> Result<Owner> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut owner = PSID::default();
    let mut sd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: `wide` is NUL-terminated and outlives the call; the two out
    // pointers are valid; the descriptor the call allocates is freed below
    // and `owner` points into it, so it is read before that.
    let err = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            &mut sd,
        )
    };
    if err != ERROR_SUCCESS {
        bail!("reading the owner of {}: error {}", path.display(), err.0);
    }
    // SAFETY: `owner` is a SID inside `sd`, alive until LocalFree.
    let who = unsafe {
        if IsWellKnownSid(owner, WinLocalSystemSid).as_bool() {
            Owner::System
        } else if IsWellKnownSid(owner, WinBuiltinAdministratorsSid).as_bool() {
            Owner::Administrators
        } else {
            Owner::Other
        }
    };
    // SAFETY: `sd` was allocated by GetNamedSecurityInfoW for the caller.
    unsafe {
        let _ = LocalFree(Some(HLOCAL(sd.0)));
    }
    Ok(who)
}

/// Give the data directory its DACL (`private::windows_data_dir_acl`).
pub fn protect_data_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir.join("logs")).context("creating the logs directory")?;
    for args in crate::private::windows_data_dir_acl(dir) {
        let out = std::process::Command::new("icacls")
            .args(&args)
            .output()
            .context("running icacls")?;
        if !out.status.success() {
            bail!(
                "icacls {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stdout).trim()
            );
        }
    }
    Ok(())
}
