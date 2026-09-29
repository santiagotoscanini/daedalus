//! The files that hold trust — the machine's key (`identity.key`), the
//! config (`config.toml`, which names the controller), the kept policy
//! (`policy.json`) — are read
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
//! control, Users read and execute (the tray reads the kept policy);
//! inheritance from ProgramData (which lets Users create files) is cut, and
//! the grants are applied to everything already inside. The key, the config
//! and the instance lock are then SYSTEM's and Administrators' alone, and so
//! is `logs\`, the service's — the tray and the session log under the
//! user's own `%LOCALAPPDATA%` (`windows_private_acl`, re-applied at every
//! start of the service, audit D1, D2, D6).

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

/// The files in the Windows data directory that are SYSTEM's and
/// Administrators' alone: the key, the config that names the controller,
/// and the instance lock (which a user could otherwise hold open).
pub const WINDOWS_PRIVATE_FILES: &[&str] = &["identity.key", "config.toml", "agent.lock"];

/// The `icacls` runs that keep the Windows data directory's secrets and
/// the service's logs to SYSTEM and Administrators (module doc): `logs\`
/// protected, inheritance cut, and each file of `WINDOWS_PRIVATE_FILES`
/// that exists the same. Run at install, after `windows_data_dir_acl`, and
/// at every start of the service, so an install an older agent made is
/// brought to it. Well-known SIDs, so a localized Windows names the same
/// groups: S-1-5-18 SYSTEM, S-1-5-32-544 Administrators.
pub fn windows_private_acl(dir: &Path) -> Vec<Vec<OsString>> {
    let arg = |s: &str| OsString::from(s);
    let only_system = |target: &Path, inherit: &str| {
        vec![
            target.as_os_str().to_owned(),
            arg("/inheritance:r"),
            arg("/grant:r"),
            arg(&format!("*S-1-5-18:{inherit}F")),
            arg("/grant:r"),
            arg(&format!("*S-1-5-32-544:{inherit}F")),
            // Whatever else an older install granted by name.
            arg("/remove:g"),
            arg("*S-1-5-32-545"),
            arg("*S-1-5-11"),
            arg("*S-1-1-0"),
        ]
    };
    let mut runs = vec![only_system(&dir.join("logs"), "(OI)(CI)")];
    runs.extend(
        WINDOWS_PRIVATE_FILES
            .iter()
            .map(|f| dir.join(f))
            .filter(|p| p.exists())
            .map(|p| only_system(&p, "")),
    );
    runs
}

/// The `icacls` runs that give the Windows data directory its DACL at
/// install (module doc), in order: SYSTEM and Administrators full control,
/// Users read and execute (the tray reads the kept policy), inheritance
/// from ProgramData cut and everything already inside reset to it — then
/// `windows_private_acl`.
pub fn windows_data_dir_acl(dir: &Path) -> Vec<Vec<OsString>> {
    let arg = |s: &str| OsString::from(s);
    let mut runs = vec![
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
    ];
    runs.extend(windows_private_acl(dir));
    runs
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
    fn the_windows_acl_cuts_inheritance_and_keeps_secrets_and_logs_to_the_system() {
        let dir = std::env::temp_dir().join(format!("daedalus-acl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("identity.key"), b"k").unwrap();
        let runs = windows_data_dir_acl(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        let text: Vec<String> = runs
            .iter()
            .map(|r| {
                r.iter()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect();
        let d = dir.display().to_string();
        assert_eq!(
            text[0],
            format!(
                "{d} /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F \
                 /grant:r *S-1-5-32-544:(OI)(CI)F /grant:r *S-1-5-32-545:(OI)(CI)RX"
            )
        );
        assert!(text[1].ends_with("* /reset /T /C"), "{}", text[1]);
        let only_system = " /inheritance:r /grant:r *S-1-5-18:";
        assert!(
            text[2].contains("logs") && text[2].contains(&format!("{only_system}(OI)(CI)F")),
            "{}",
            text[2]
        );
        // The key that exists is made private; the config and lock that do
        // not are left for their writers.
        assert_eq!(text.len(), 4, "{text:?}");
        assert!(
            text[3].contains("identity.key") && text[3].contains(&format!("{only_system}F")),
            "{}",
            text[3]
        );
        // Users never get more than read, and nothing but the directory.
        for t in &text[2..] {
            assert!(!t.contains("545:"), "{t}");
            assert!(
                t.ends_with("/remove:g *S-1-5-32-545 *S-1-5-11 *S-1-1-0"),
                "{t}"
            );
        }
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
