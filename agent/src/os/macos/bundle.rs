//! Daedalus Agent.app: the one form the Mac's agent ships in, and where it
//! runs from.
//!
//! ```text
//! /Library/Application Support/daedalus-agent/Daedalus Agent.app   what launchd runs, root's
//! /Library/Application Support/daedalus-agent/.update/             the slot's work (update/slot.rs), root 0700
//! /Applications/Daedalus Agent.app                                 what the user dragged: an opener
//! ```
//!
//! The canonical bundle sits in a folder chain only root can write
//! (review B1): a root daemon that ran from `/Applications`, which every
//! admin can rename entries in, could be swapped for another bundle without
//! a password. The copy in `/Applications` is the user's own; opening it
//! starts the menu bar app, or installs (tray.rs, "the first open").
//!
//! Installing and updating are one path (review S2): the bundle is copied
//! (`install`) or unpacked (the updater) into the slot's stage, where only
//! root can reach it; sealed there — root's, closed to writers, no
//! quarantine — and checked; and only then exchanged with the live one.
//! Nothing is ever chowned where a user could still change it. The check
//! (`check`) is what the bundle says it is and that its service answers
//! with that version before anything is swapped (review S4e); the updater
//! alone also asks for Apple's signature with this team's ID and the fixed
//! identifiers (S1): `install`'s trust is the administrator password that
//! ran it.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::node::update::Slot;

pub const APP_NAME: &str = "Daedalus Agent.app";
/// The bundle's identifier: the menu bar app's, its main executable.
pub const BUNDLE_ID: &str = super::launchd::TRAY_LABEL;
/// The service executable's signing identifier, fixed forever: launchd's
/// and Background Task Management's records key on it.
pub const SERVICE_ID: &str = super::launchd::DAEMON_LABEL;
/// The Developer ID team that signs every release.
pub const TEAM_ID: &str = "H8M3SN9RDZ";
/// Where a user drags the app from the disk image.
pub const APPLICATIONS_COPY: &str = "/Applications/Daedalus Agent.app";

/// The folder the canonical bundle lives in: the data directory's default
/// place, fixed — `data_dir` and `DAEDALUS_AGENT_DATA_DIR` move state, never
/// what launchd runs.
pub fn home() -> PathBuf {
    super::default_data_dir()
}

pub fn canonical() -> PathBuf {
    home().join(APP_NAME)
}

pub fn slot() -> Slot {
    Slot {
        live: canonical(),
        work: home().join(".update"),
    }
}

pub fn service_exe(app: &Path) -> PathBuf {
    app.join("Contents/MacOS").join(crate::SERVICE_NAME)
}

pub fn tray_exe(app: &Path) -> PathBuf {
    app.join("Contents/MacOS").join(crate::TRAY_EXE)
}

/// The bundle this executable runs from, links resolved; None outside one
/// (a development build).
pub fn running_app() -> Option<PathBuf> {
    let exe = std::fs::canonicalize(std::env::current_exe().ok()?).ok()?;
    app_of(&exe)
}

/// `<X>.app` of `<X>.app/Contents/MacOS/<exe>`.
fn app_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe
        .parent()
        .filter(|p| p.file_name() == Some(OsStr::new("MacOS")))?;
    let contents = macos
        .parent()
        .filter(|p| p.file_name() == Some(OsStr::new("Contents")))?;
    let app = contents
        .parent()
        .filter(|p| p.extension() == Some(OsStr::new("app")))?;
    Some(app.to_path_buf())
}

/// What a bundle's Info.plist says it is.
#[derive(Debug, PartialEq)]
pub struct Info {
    pub id: String,
    pub version: semver::Version,
}

pub fn info(app: &Path) -> Result<Info> {
    let path = app.join("Contents/Info.plist");
    let value =
        plist::Value::from_file(&path).with_context(|| format!("reading {}", path.display()))?;
    let dict = value
        .as_dictionary()
        .with_context(|| format!("{} is not a dictionary", path.display()))?;
    let text = |key: &str| {
        dict.get(key)
            .and_then(plist::Value::as_string)
            .with_context(|| format!("{} has no {key}", path.display()))
    };
    let version = text("CFBundleShortVersionString")?;
    Ok(Info {
        id: text("CFBundleIdentifier")?.to_string(),
        version: semver::Version::parse(version)
            .with_context(|| format!("{} version {version:?}", path.display()))?,
    })
}

/// The installed bundle's version, when both jobs point at it; None when
/// the agent is not installed as an app.
pub fn installed() -> Option<semver::Version> {
    if !super::launchd::daemon_plist().exists() {
        return None;
    }
    info(&canonical()).ok().map(|i| i.version)
}

/// Apple's designated requirement for one of our executables: a Developer
/// ID certificate of our team, and the identifier it was signed with.
pub fn requirement(identifier: &str) -> String {
    format!(
        "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists \
         and certificate leaf[field.1.2.840.113635.100.6.1.13] exists \
         and certificate leaf[subject.OU] = \"{TEAM_ID}\" and identifier \"{identifier}\""
    )
}

/// One of Apple's tools, by its absolute path, with a deadline (exec.rs): a
/// copy, an unpack or a signature check of the bundle, which take seconds.
fn run(program: &str, args: &[&OsStr]) -> Result<()> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    crate::exec::stdout_or(
        cmd,
        std::time::Duration::from_secs(300),
        crate::exec::Text::Lossy,
    )
    .map(drop)
    .map_err(|e| {
        anyhow::anyhow!(
            "{program} {}: {e}",
            args.iter()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ")
        )
    })
}

/// A copy of the bundle at `src` in the slot's stage (`ditto` keeps the
/// signature, its extended attributes and the modes). Returns where.
pub fn stage_copy(src: &Path, slot: &Slot) -> Result<PathBuf> {
    slot.open_work()?;
    let dst = slot.fresh_stage()?;
    run("/usr/bin/ditto", &[src.as_os_str(), dst.as_os_str()])
        .with_context(|| format!("copying {}", src.display()))?;
    Ok(dst)
}

/// The downloaded archive unpacked into the slot's stage: it must hold
/// `APP_NAME` and nothing else. Returns where.
pub fn stage_archive(zip: &Path, slot: &Slot) -> Result<PathBuf> {
    let dst = slot.fresh_stage()?;
    let stage = dst.parent().context("the stage has a directory")?;
    run(
        "/usr/bin/ditto",
        &[
            OsStr::new("-x"),
            OsStr::new("-k"),
            zip.as_os_str(),
            stage.as_os_str(),
        ],
    )
    .context("unpacking the bundle")?;
    let names: Vec<_> = std::fs::read_dir(stage)?
        .flatten()
        .map(|e| e.file_name())
        .collect();
    if names != [OsStr::new(APP_NAME)] {
        bail!("the archive holds {names:?}, not {APP_NAME} alone");
    }
    Ok(dst)
}

/// No link anywhere in the bundle: root runs it, and a link could name a
/// file its user can still write.
fn no_links(dir: &Path) -> Result<()> {
    for e in std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let e = e?;
        let kind = e.file_type()?;
        if kind.is_symlink() {
            bail!("{} is a link", e.path().display());
        }
        if kind.is_dir() {
            no_links(&e.path())?;
        }
    }
    Ok(())
}

/// The staged bundle made root's: no links, owned by root:wheel, nothing
/// writable by group or others, no quarantine. Only ever on a bundle in
/// the slot's stage, which no one else can reach.
pub fn seal(app: &Path) -> Result<()> {
    no_links(app)?;
    // Absent is not an error: a copy that never had it, or the updater's.
    let _ = run(
        "/usr/bin/xattr",
        &[
            OsStr::new("-r"),
            OsStr::new("-d"),
            OsStr::new("com.apple.quarantine"),
            app.as_os_str(),
        ],
    );
    run(
        "/usr/sbin/chown",
        &[OsStr::new("-R"), OsStr::new("root:wheel"), app.as_os_str()],
    )?;
    run(
        "/bin/chmod",
        &[OsStr::new("-R"), OsStr::new("go-w"), app.as_os_str()],
    )
}

/// Whether a staged bundle is the one to put in place: our identifier and
/// `want` in its Info.plist, both executables there, the service answering
/// `version` with `want` — run before anything is swapped, so a bundle that
/// dies at launch never replaces one that runs — and, when `signed`, Apple's
/// signature whole and our team's, with the fixed identifiers.
pub fn check(app: &Path, want: &semver::Version, signed: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let i = info(app)?;
    if i.id != BUNDLE_ID {
        bail!("the bundle is {}, not {BUNDLE_ID}", i.id);
    }
    if i.version != *want {
        bail!("the bundle says {}, not {want}", i.version);
    }
    for exe in [service_exe(app), tray_exe(app)] {
        let m = std::fs::symlink_metadata(&exe)
            .with_context(|| format!("no {} in the bundle", exe.display()))?;
        if !m.is_file() || m.permissions().mode() & 0o111 == 0 {
            bail!("{} is not an executable file", exe.display());
        }
    }
    if signed {
        run(
            "/usr/bin/codesign",
            &[
                OsStr::new("--verify"),
                OsStr::new("--deep"),
                OsStr::new("--strict"),
                app.as_os_str(),
            ],
        )
        .context("the bundle's signature")?;
        for (path, id) in [
            (app.to_path_buf(), BUNDLE_ID),
            (service_exe(app), SERVICE_ID),
        ] {
            let req = format!("={}", requirement(id));
            run(
                "/usr/bin/codesign",
                &[
                    OsStr::new("--verify"),
                    OsStr::new("--strict"),
                    OsStr::new("-R"),
                    OsStr::new(&req),
                    path.as_os_str(),
                ],
            )
            .with_context(|| {
                format!("{} is not signed by team {TEAM_ID} as {id}", path.display())
            })?;
        }
    }
    let said = crate::node::update::version_of(&service_exe(app))?;
    if said != *want {
        bail!("the bundle's service says {said}, not {want}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_running_bundle_is_found_from_its_executable() {
        let exe = Path::new("/Applications/Daedalus Agent.app/Contents/MacOS/daedalus-agent-tray");
        assert_eq!(
            app_of(exe),
            Some(PathBuf::from("/Applications/Daedalus Agent.app"))
        );
        for no in [
            "/usr/local/bin/daedalus-agent",
            "/x/Daedalus Agent.app/Contents/Resources/daedalus-agent",
            "/x/Daedalus Agent/Contents/MacOS/daedalus-agent",
        ] {
            assert_eq!(app_of(Path::new(no)), None, "{no}");
        }
        assert_eq!(
            canonical(),
            Path::new("/Library/Application Support/daedalus-agent/Daedalus Agent.app")
        );
    }

    #[test]
    fn the_requirement_names_our_team_and_the_identifier() {
        let r = requirement(SERVICE_ID);
        assert!(r.starts_with("anchor apple generic"));
        assert!(r.contains("leaf[subject.OU] = \"H8M3SN9RDZ\""));
        assert!(r.ends_with("identifier \"me.toscanini.daedalus-agent\""));
        // Developer ID: its intermediate and its leaf.
        assert!(r.contains("1.2.840.113635.100.6.2.6") && r.contains("1.2.840.113635.100.6.1.13"));
    }

    fn fake_app(root: &Path, id: &str, version: &str, says: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let app = root.join(APP_NAME);
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
                 <key>CFBundleIdentifier</key><string>{id}</string>\
                 <key>CFBundleShortVersionString</key><string>{version}</string>\
                 </dict></plist>"
            ),
        )
        .unwrap();
        for exe in [service_exe(&app), tray_exe(&app)] {
            std::fs::write(&exe, format!("#!/bin/sh\necho daedalus-agent {says}\n")).unwrap();
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        app
    }

    #[test]
    fn a_bundle_is_checked_for_its_identifier_its_version_and_its_answer() {
        let root = std::env::temp_dir().join(format!("daedalus-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let v = semver::Version::parse("0.24.0").unwrap();
        let app = fake_app(&root, BUNDLE_ID, "0.24.0", "0.24.0");
        assert_eq!(
            info(&app).unwrap(),
            Info {
                id: BUNDLE_ID.into(),
                version: v.clone()
            }
        );
        check(&app, &v, false).unwrap();
        // Another version than asked for, in the plist or from the binary.
        assert!(check(&app, &semver::Version::parse("0.24.1").unwrap(), false).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let app = fake_app(&root, BUNDLE_ID, "0.24.0", "0.23.1");
        assert!(check(&app, &v, false).is_err());
        // Another bundle altogether.
        let _ = std::fs::remove_dir_all(&root);
        let app = fake_app(&root, "com.example.other", "0.24.0", "0.24.0");
        assert!(check(&app, &v, false).is_err());
        // An executable that is a link: never sealed.
        let _ = std::fs::remove_dir_all(&root);
        let app = fake_app(&root, BUNDLE_ID, "0.24.0", "0.24.0");
        std::fs::remove_file(tray_exe(&app)).unwrap();
        std::os::unix::fs::symlink("/tmp/anything", tray_exe(&app)).unwrap();
        assert!(no_links(&app).is_err());
        assert!(check(&app, &v, false).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
