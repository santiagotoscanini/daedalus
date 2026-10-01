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
//! user's own `%LOCALAPPDATA%` (`windows_private_acl`, audit D1, D2, D6).
//! A secret the service reads later must still be so (`sddl_is_private`),
//! or it is refused, as unix refuses one others may read.

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
/// that exists the same. Run at install, after `windows_data_dir_acl`.
/// Well-known SIDs, so a localized Windows names the same
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

/// One ACE of a DACL in SDDL: its type (`A` allows, `D` denies) and whom
/// it names.
struct Ace<'a> {
    kind: &'a str,
    sid: &'a str,
}

/// The DACL of a security descriptor in SDDL (`O:…G:…D:…S:…`): its flags
/// (`P` protected, `AI`, `AR`) and its ACEs. None when it has no `D:`.
fn sddl_dacl(sddl: &str) -> Option<(&str, Vec<Ace<'_>>)> {
    let d = &sddl[sddl.find("D:")? + 2..];
    // The SACL, when there is one, follows outside the parentheses.
    let d = match d.find(")S:") {
        Some(i) => &d[..=i],
        None => d.split_once("S:").map_or(d, |(a, _)| a),
    };
    let (flags, mut rest) = d.split_at(d.find('(').unwrap_or(d.len()));
    let mut aces = Vec::new();
    while let Some(body) = rest.strip_prefix('(') {
        let end = body.find(')')?;
        let f: Vec<&str> = body[..end].split(';').collect();
        let [kind, _, _, _, _, sid] = f[..] else {
            return None;
        };
        aces.push(Ace { kind, sid });
        rest = &body[end + 1..];
    }
    rest.is_empty().then_some((flags, aces))
}

/// A SID as SDDL may spell it, as the alias it has: SYSTEM is `SY`,
/// Administrators `BA`, CREATOR OWNER `CO`.
fn sid_alias(sid: &str) -> &str {
    match sid {
        "S-1-5-18" => "SY",
        "S-1-5-32-544" => "BA",
        "S-1-3-0" => "CO",
        s => s,
    }
}

/// Whether a file's descriptor, in SDDL, keeps it a secret: a protected
/// DACL (nothing inherited from the directory) whose every grant is
/// SYSTEM's or Administrators' — what `create_private` and
/// `windows_private_acl` give it. A null DACL (everyone) is not.
pub fn sddl_is_private(sddl: &str) -> bool {
    let Some((flags, aces)) = sddl_dacl(sddl) else {
        return false;
    };
    flags.replace("AI", "").replace("AR", "").contains('P')
        && !flags.contains("NO_ACCESS_CONTROL")
        && aces
            .iter()
            .all(|a| a.kind == "D" || matches!(sid_alias(a.sid), "SY" | "BA"))
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
            assert!(!t.contains("545"), "{t}");
        }
    }

    #[test]
    fn a_secret_is_private_only_with_a_protected_dacl_for_the_system_alone() {
        // What `create_private` gives a file, and what icacls leaves.
        assert!(sddl_is_private("D:P(A;;FA;;;SY)(A;;FA;;;BA)"));
        assert!(sddl_is_private("O:BAD:PAI(A;;FA;;;SY)(A;;FA;;;BA)"));
        assert!(sddl_is_private(
            "D:P(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(D;;FA;;;WD)"
        ));
        // Inherited grants (no P), a user's read, a null DACL, none at all.
        assert!(!sddl_is_private("D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)"));
        assert!(!sddl_is_private("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)"));
        assert!(!sddl_is_private(
            "D:P(A;;FA;;;SY)(A;;0x1200a9;;;S-1-5-21-1-2-3-1001)"
        ));
        assert!(!sddl_is_private("D:NO_ACCESS_CONTROL"));
        assert!(!sddl_is_private("O:BA"));
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
