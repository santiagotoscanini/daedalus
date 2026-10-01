//! Who owns a file, and the data directory's DACL (private.rs decides).

use std::path::Path;

use anyhow::{bail, Context, Result};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
use windows::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
use windows::Win32::Security::{
    IsWellKnownSid, WinBuiltinAdministratorsSid, WinLocalSystemSid, DACL_SECURITY_INFORMATION,
    OBJECT_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
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

fn icacls(runs: Vec<Vec<std::ffi::OsString>>) -> Result<()> {
    for args in runs {
        let mut cmd = std::process::Command::new(system32("icacls.exe"));
        cmd.args(&args);
        match crate::exec::both(cmd, std::time::Duration::from_secs(60)) {
            Some(r) if r.ok => {}
            Some(r) => bail!("icacls {:?}: {}", args, r.output.trim()),
            None => bail!("icacls {:?}: not run, or no answer in time", args),
        }
    }
    Ok(())
}

/// A program in the system directory, named whole (never searched for).
fn system32(exe: &str) -> std::path::PathBuf {
    std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "C:\\Windows".into())
        .join("System32")
        .join(exe)
}

/// Give the data directory its DACL at install (`private::windows_data_dir_acl`),
/// and remove whatever a user left in `logs\` while ProgramData's grants
/// let them — a link or a file planted where the service opens a log by
/// name (audit D2).
pub fn protect_data_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir.join("logs")).context("creating the logs directory")?;
    icacls(crate::private::windows_data_dir_acl(dir))?;
    clear_planted(&dir.join("logs"));
    Ok(())
}

/// Remove every entry of `dir` that neither SYSTEM nor Administrators own,
/// without following it (a junction or a symlink goes, not its target).
fn clear_planted(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if file_owner(&p).is_ok_and(|o| matches!(o, Owner::System | Owner::Administrators)) {
            continue;
        }
        let gone = match std::fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() => std::fs::remove_dir(&p),
            _ => std::fs::remove_file(&p),
        };
        tracing::warn!(path = %p.display(), removed = gone.is_ok(), "a file in the service's logs that it did not make");
    }
}

/// SYSTEM and Administrators full control, nothing else and nothing
/// inherited: a secret's ACL.
const PRIVATE_SDDL: &str = "D:P(A;;FA;;;SY)(A;;FA;;;BA)";

/// A security descriptor from SDDL, freed when dropped.
struct Descriptor(PSECURITY_DESCRIPTOR);

impl Descriptor {
    fn of(sddl: &str) -> std::io::Result<Self> {
        use windows::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        let text: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: a NUL-terminated SDDL string; freed on drop.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(text.as_ptr()),
                SDDL_REVISION_1,
                &mut sd,
                None,
            )
        }
        .map_err(|e| std::io::Error::other(e.message()))?;
        Ok(Self(sd))
    }
}

impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by the conversion above.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0 .0)));
        }
    }
}

fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

/// A new file with the private ACL from its first moment (no window in
/// which the directory's inherited grants apply), never over anything
/// already there (util.rs `write_atomic`).
pub fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use windows::Win32::Security::SECURITY_ATTRIBUTES;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        FILE_SHARE_NONE,
    };
    let sd = Descriptor::of(PRIVATE_SDDL)?;
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0 .0,
        bInheritHandle: false.into(),
    };
    let name = wide(path);
    // SAFETY: a NUL-terminated name and attributes that outlive the call;
    // the handle is owned by the File from here.
    let h = unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_NONE,
            Some(&attrs),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .map_err(|e| std::io::Error::other(format!("{}: {}", path.display(), e.message())))?;
    // SAFETY: a fresh handle nothing else owns.
    Ok(unsafe { std::fs::File::from_raw_handle(h.0 as RawHandle) })
}

/// A secret file is SYSTEM's and Administrators' alone: refused when its
/// DACL lets anyone else in or inherits from its directory
/// (`private::sddl_is_private`), and when it is not a regular file.
pub fn ensure_private(path: &Path) -> Result<()> {
    let m =
        std::fs::symlink_metadata(path).with_context(|| format!("reading {}", path.display()))?;
    if !m.file_type().is_file() {
        bail!("{} is not a regular file; refusing it", path.display());
    }
    let sddl = sddl_of(path, DACL_SECURITY_INFORMATION)?;
    if !crate::private::sddl_is_private(&sddl) {
        bail!(
            "{} is open beyond SYSTEM and Administrators ({sddl}); a key others could read is \
             not a secret — refusing it (delete it for a new identity)",
            path.display()
        );
    }
    Ok(())
}

/// The parts `info` names of a file's security descriptor, in SDDL.
fn sddl_of(path: &Path, info: OBJECT_SECURITY_INFORMATION) -> Result<String> {
    use windows::core::PWSTR;
    use windows::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1,
    };
    let name = wide(path);
    let mut sd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: a NUL-terminated name; the descriptor the call allocates is
    // freed below.
    let err = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(name.as_ptr()),
            SE_FILE_OBJECT,
            info,
            None,
            None,
            None,
            None,
            &mut sd,
        )
    };
    if err != ERROR_SUCCESS {
        bail!(
            "reading the security of {}: error {}",
            path.display(),
            err.0
        );
    }
    let mut text = PWSTR::null();
    // SAFETY: `sd` is the valid descriptor read above; the string the call
    // allocates is read, then freed.
    let converted = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            sd,
            SDDL_REVISION_1,
            info,
            &mut text,
            None,
        )
    };
    let out = converted.map(|()| unsafe { text.to_string() });
    // SAFETY: both were allocated by the calls above for the caller.
    unsafe {
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        if !text.is_null() {
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        }
    }
    out.with_context(|| format!("reading the security of {}", path.display()))?
        .with_context(|| format!("the security of {} is not text", path.display()))
}
