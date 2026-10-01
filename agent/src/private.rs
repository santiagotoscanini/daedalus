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

/// One ACE of a DACL in SDDL: its type (`A` allows, `D` denies), its
/// rights, and whom it names.
struct Ace<'a> {
    kind: &'a str,
    rights: &'a str,
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
        let [kind, _, rights, _, _, sid] = f[..] else {
            return None;
        };
        aces.push(Ace { kind, rights, sid });
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

/// TrustedInstaller, which owns and writes what Windows ships under
/// Program Files.
const TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

/// The access mask an ACE's rights field names: hex, or the two-letter
/// aliases SDDL writes. None for one it does not know.
fn sddl_rights(r: &str) -> Option<u32> {
    if let Some(hex) = r.strip_prefix("0x").or_else(|| r.strip_prefix("0X")) {
        return u32::from_str_radix(hex, 16).ok();
    }
    if !r.is_ascii() || !r.len().is_multiple_of(2) {
        return None;
    }
    (0..r.len()).step_by(2).try_fold(0u32, |m, i| {
        Some(
            m | match &r[i..i + 2] {
                "GA" => 0x1000_0000,
                "GX" => 0x2000_0000,
                "GW" => 0x4000_0000,
                "GR" => 0x8000_0000,
                "FA" => 0x001F_01FF,
                "FR" => 0x0012_0089,
                "FW" => 0x0012_0116,
                "FX" => 0x0012_00A0,
                "SD" => 0x0001_0000,
                "RC" => 0x0002_0000,
                "WD" => 0x0004_0000,
                "WO" => 0x0008_0000,
                "CC" => 0x1,
                "DC" => 0x2,
                "LC" => 0x4,
                "SW" => 0x8,
                "RP" => 0x10,
                "WP" => 0x20,
                "DT" => 0x40,
                "LO" => 0x80,
                "CR" => 0x100,
                _ => return None,
            },
        )
    })
}

/// What lets a holder change a file or a directory's contents, or its
/// security: write data, append (or add a subdirectory), write extended
/// attributes, delete a child, write attributes, delete, change the DACL,
/// take ownership, and generic write and all.
const WRITE_RIGHTS: u32 =
    0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x1_0000 | 0x4_0000 | 0x8_0000 | 0x1000_0000 | 0x4000_0000;

/// Whether a descriptor, in SDDL with its owner and DACL, keeps what the
/// service runs as LocalSystem out of anyone else's reach: owned by
/// SYSTEM, Administrators or TrustedInstaller, and no grant to write it
/// (`WRITE_RIGHTS`) for anyone but them and CREATOR OWNER (which an
/// inherited ACE turns into the owner of what is made inside). Why not,
/// when it does not.
pub fn sddl_admins_alone_write(sddl: &str) -> Result<(), String> {
    let trusted = |sid: &str| matches!(sid_alias(sid), "SY" | "BA") || sid == TRUSTED_INSTALLER;
    let owner = sddl
        .strip_prefix("O:")
        .map(|o| &o[..o.find("G:").or_else(|| o.find("D:")).unwrap_or(o.len())]);
    match owner {
        Some(o) if trusted(o) => {}
        Some(o) => return Err(format!("it is owned by {o}")),
        None => return Err("its owner could not be read".into()),
    }
    let Some((flags, aces)) = sddl_dacl(sddl) else {
        return Err("its DACL could not be read".into());
    };
    if flags.contains("NO_ACCESS_CONTROL") {
        return Err("it has no DACL: everyone may write it".into());
    }
    for a in aces.iter().filter(|a| a.kind != "D") {
        let Some(mask) = sddl_rights(a.rights) else {
            return Err(format!(
                "{} holds rights {:?} that are not understood",
                a.sid, a.rights
            ));
        };
        if mask & WRITE_RIGHTS != 0 && !trusted(a.sid) && sid_alias(a.sid) != "CO" {
            return Err(format!("{} may write to it", a.sid));
        }
    }
    Ok(())
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
    fn the_service_runs_only_from_where_administrators_alone_write() {
        // `%ProgramFiles%\daedalus-agent` as install.ps1 makes it: owned by
        // Administrators, Program Files' grants inherited — users read and
        // execute, app packages too.
        let ti = TRUSTED_INSTALLER;
        let made = format!(
            "O:BAD:AI(A;ID;FA;;;{ti})(A;CIIOID;GA;;;{ti})(A;ID;0x1301bf;;;SY)\
             (A;OICIIOID;GA;;;SY)(A;ID;0x1301bf;;;BA)(A;OICIIOID;GA;;;BA)\
             (A;ID;0x1200a9;;;BU)(A;OICIIOID;GXGR;;;BU)(A;OICIIOID;GA;;;CO)\
             (A;ID;0x1200a9;;;AC)(A;OICIIOID;GXGR;;;AC)"
        );
        assert_eq!(sddl_admins_alone_write(&made), Ok(()));
        assert_eq!(
            sddl_admins_alone_write(&format!("O:{ti}D:PAI(A;;FA;;;SY)")),
            Ok(())
        );
        // A user who may write in it, or own it; everyone; rights not
        // understood; no DACL at all.
        let user = "S-1-5-21-1-2-3-1001";
        for (sddl, why) in [
            (format!("{made}(A;OICI;0x1301bf;;;{user})"), "may write"),
            (format!("{made}(A;;FW;;;BU)"), "may write"),
            (format!("{made}(A;OICI;GW;;;WD)"), "may write"),
            (format!("{made}(A;;WD;;;AU)"), "may write"),
            (format!("O:{user}D:PAI(A;;FA;;;SY)"), "owned by"),
            (format!("{made}(A;;QQ;;;BU)"), "not understood"),
            ("O:BAD:NO_ACCESS_CONTROL".to_string(), "no DACL"),
            ("D:PAI(A;;FA;;;SY)".to_string(), "owner"),
        ] {
            let got = sddl_admins_alone_write(&sddl);
            assert!(
                got.as_ref().is_err_and(|e| e.contains(why)),
                "{sddl}: {got:?}"
            );
        }
        // A denial takes nothing away from the check.
        assert_eq!(
            sddl_admins_alone_write(&format!("{made}(D;;FA;;;{user})")),
            Ok(())
        );
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
