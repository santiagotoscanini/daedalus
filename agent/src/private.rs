//! The files that hold trust — the machine's key (`identity.key`) and the
//! controller key it trusts (`controller.json`, link/node.rs) — are read
//! only when their OWNER is one this agent trusts, so a user who could
//! plant one cannot choose the key a machine proves itself with or the
//! controller it believes.
//!
//! Who counts (`owner_trusted`): on Windows, SYSTEM or the Administrators
//! group — what a file the service (LocalSystem) creates is owned by; on
//! macOS and Linux, root or the agent's own user. Reading the owner is the
//! OS's (`os::file_owner`); deciding is here, where it is tested on every
//! OS.
//!
//! On Windows `install` also gives the data directory an explicit,
//! protected DACL (`windows_data_dir_acl`): SYSTEM and Administrators full
//! control, Users read and execute — and Modify on `logs\` alone, where the
//! tray, which runs as the user, writes. Inheritance from ProgramData
//! (which lets Users create files) is cut, and the grants are applied to
//! everything already inside.

use std::ffi::OsString;
use std::path::Path;

use anyhow::{bail, Result};

/// Who owns a file, as far as the decision needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// Windows' LocalSystem.
    System,
    /// Windows' BUILTIN\Administrators.
    Administrators,
    /// A unix uid.
    Uid(u32),
    /// Anyone else.
    Other,
}

/// Whether a file owned by `owner` may be trusted by an agent running as
/// `own_uid` (None on Windows).
pub fn owner_trusted(owner: Owner, own_uid: Option<u32>) -> bool {
    match owner {
        Owner::System | Owner::Administrators => true,
        Owner::Uid(0) => true,
        Owner::Uid(u) => own_uid == Some(u),
        Owner::Other => false,
    }
}

/// Refuse `path` unless its owner is trusted (module doc). A missing file
/// is the caller's business, not this check's.
pub fn check_owner(path: &Path) -> Result<()> {
    let owner = crate::os::file_owner(path)?;
    if !owner_trusted(owner, crate::os::own_uid()) {
        bail!(
            "{} is owned by {owner:?}, not by {}; refusing to read it",
            path.display(),
            if cfg!(windows) {
                "SYSTEM or Administrators"
            } else {
                "root or the agent's user"
            }
        );
    }
    Ok(())
}

/// The `icacls` runs that give the Windows data directory its DACL
/// (module doc), in order. Well-known SIDs, so a localized Windows names
/// the same groups: S-1-5-18 SYSTEM, S-1-5-32-544 Administrators,
/// S-1-5-32-545 Users.
pub fn windows_data_dir_acl(dir: &Path) -> Vec<Vec<OsString>> {
    let arg = |s: &str| OsString::from(s);
    let logs = dir.join("logs");
    vec![
        vec![
            dir.as_os_str().to_owned(),
            arg("/inheritance:r"),
            arg("/grant:r"),
            arg("*S-1-5-18:(OI)(CI)F"),
            arg("/grant:r"),
            arg("*S-1-5-32-544:(OI)(CI)F"),
            arg("/grant:r"),
            arg("*S-1-5-32-545:(OI)(CI)RX"),
        ],
        // Everything already inside takes the directory's grants.
        vec![
            dir.join("*").into_os_string(),
            arg("/reset"),
            arg("/T"),
            arg("/C"),
        ],
        // The tray, running as the user, writes its logs here.
        vec![
            logs.into_os_string(),
            arg("/grant"),
            arg("*S-1-5-32-545:(OI)(CI)M"),
        ],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_os_or_the_agent_owns_what_is_trusted() {
        assert!(owner_trusted(Owner::System, None));
        assert!(owner_trusted(Owner::Administrators, None));
        assert!(!owner_trusted(Owner::Other, None));
        assert!(owner_trusted(Owner::Uid(0), Some(1000)));
        assert!(owner_trusted(Owner::Uid(1000), Some(1000)));
        assert!(!owner_trusted(Owner::Uid(1001), Some(1000)));
        assert!(!owner_trusted(Owner::Uid(1001), None));
    }

    #[test]
    fn the_windows_acl_cuts_inheritance_and_opens_only_the_logs() {
        let runs = windows_data_dir_acl(Path::new("C:/ProgramData/daedalus-agent"));
        let text: Vec<String> = runs
            .iter()
            .map(|r| {
                r.iter()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect();
        assert_eq!(
            text[0],
            "C:/ProgramData/daedalus-agent /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F \
             /grant:r *S-1-5-32-544:(OI)(CI)F /grant:r *S-1-5-32-545:(OI)(CI)RX"
        );
        assert!(text[1].ends_with("* /reset /T /C"), "{}", text[1]);
        assert!(
            text[2].ends_with("logs /grant *S-1-5-32-545:(OI)(CI)M"),
            "{}",
            text[2]
        );
        // Users never get more than read anywhere but logs.
        assert!(!text[0].contains("545:(OI)(CI)M") && !text[0].contains("545:(OI)(CI)F"));
    }

    #[test]
    fn a_file_this_process_made_passes() {
        let p = std::env::temp_dir().join(format!("daedalus-owner-{}", std::process::id()));
        std::fs::write(&p, b"x").unwrap();
        let r = check_owner(&p);
        let _ = std::fs::remove_file(&p);
        // On Windows a test runs as a user, not SYSTEM: only unix is sure.
        if cfg!(unix) {
            assert!(r.is_ok(), "{r:?}");
        }
    }
}
