//! A bundle's slot: one fixed path whose directory is replaced whole, and a
//! work directory beside it (same volume, root's alone) where the next one
//! is staged and the previous one waits until the new one has proved itself.
//!
//! ```text
//! <live>                    what runs: always a whole bundle
//! <work>/stage/<name>       the next one, copied or extracted, then checked
//! <work>/old/<name>         the one it replaced, until it proves itself
//! <work>/bad/<name>         one rolled back from, until the next start
//! <work>/download           the downloaded archive, while it is unpacked
//! ```
//!
//! Replacing is one exchange of two directory entries (`RENAME_SWAP` on
//! macOS, `RENAME_EXCHANGE` on Linux, where only the tests run it), so the
//! live path never names a half-copied bundle and a running process keeps
//! the files it started from. Every path is the slot's own, never the
//! running executable's: after an exchange that names the new bundle
//! (review S5).

use std::ffi::{CString, OsStr};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

pub struct Slot {
    pub live: PathBuf,
    pub work: PathBuf,
}

impl Slot {
    fn name(&self) -> &OsStr {
        self.live.file_name().unwrap_or(OsStr::new("bundle"))
    }

    pub fn staged(&self) -> PathBuf {
        self.work.join("stage").join(self.name())
    }

    pub fn old(&self) -> PathBuf {
        self.work.join("old").join(self.name())
    }

    pub fn bad(&self) -> PathBuf {
        self.work.join("bad").join(self.name())
    }

    pub fn download(&self) -> PathBuf {
        self.work.join("download")
    }

    /// The work directory, this user's alone (0700): made when absent;
    /// refused when it is a link, or another user's.
    pub fn open_work(&self) -> Result<()> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        match std::fs::symlink_metadata(&self.work) {
            Ok(m) => {
                if !m.is_dir() {
                    bail!("{} is not a directory", self.work.display());
                }
                if m.uid() != euid() {
                    bail!("{} is another user's", self.work.display());
                }
            }
            Err(_) => std::fs::create_dir(&self.work)
                .with_context(|| format!("creating {}", self.work.display()))?,
        }
        std::fs::set_permissions(&self.work, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("closing {}", self.work.display()))
    }

    /// An empty stage: whatever an earlier attempt left there removed.
    /// Returns where the next bundle goes.
    pub fn fresh_stage(&self) -> Result<PathBuf> {
        let stage = self.work.join("stage");
        remove(&stage)?;
        std::fs::create_dir(&stage).with_context(|| format!("creating {}", stage.display()))?;
        Ok(self.staged())
    }

    /// The staged bundle into the live path: exchanged with the one there,
    /// which is kept as `old` (an earlier `old` goes first); moved there
    /// when the slot is empty.
    pub fn swap_in(&self) -> Result<()> {
        let staged = self.staged();
        if !staged.is_dir() {
            bail!("nothing is staged at {}", staged.display());
        }
        if std::fs::symlink_metadata(&self.live).is_err() {
            return std::fs::rename(&staged, &self.live)
                .with_context(|| format!("moving the new bundle to {}", self.live.display()));
        }
        let old = self.old();
        remove(old.parent().expect("old has a directory"))?;
        std::fs::create_dir(old.parent().expect("old has a directory"))?;
        exchange(&staged, &self.live)
            .with_context(|| format!("exchanging the new bundle with {}", self.live.display()))?;
        // The stage now holds the previous bundle.
        std::fs::rename(&staged, &old).context("keeping the previous bundle")
    }

    /// Put `old` back: exchanged with the live bundle, which is kept as
    /// `bad`. Refused without an `old`.
    pub fn roll_back(&self) -> Result<()> {
        let old = self.old();
        if !old.is_dir() {
            bail!("there is no previous bundle to go back to");
        }
        let bad = self.bad();
        remove(bad.parent().expect("bad has a directory"))?;
        std::fs::create_dir(bad.parent().expect("bad has a directory"))?;
        if std::fs::symlink_metadata(&self.live).is_err() {
            return std::fs::rename(&old, &self.live).context("putting the previous bundle back");
        }
        exchange(&old, &self.live).context("putting the previous bundle back")?;
        // `old` now holds the bundle rolled back from.
        std::fs::rename(&old, &bad).context("keeping the bundle rolled back from")
    }

    /// Everything but the live bundle: the stage, the download, `old` and
    /// `bad`. Once an update has proved itself, at a start with none on
    /// probation, and after an install.
    pub fn retire(&self) {
        for p in [
            self.work.join("stage"),
            self.work.join("old"),
            self.work.join("bad"),
            self.download(),
        ] {
            if let Err(e) = remove(&p) {
                tracing::warn!(path = %p.display(), error = %format!("{e:#}"), "not removed yet");
            }
        }
    }
}

/// `path` gone, file or directory; nothing there is not an error. A link
/// is removed, never followed.
pub fn remove(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(_) => Ok(()),
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
    }
    .with_context(|| format!("removing {}", path.display()))
}

fn euid() -> u32 {
    // SAFETY: no arguments.
    unsafe { libc::geteuid() }
}

fn c_path(p: &Path) -> std::io::Result<CString> {
    CString::new(p.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "a NUL in the path"))
}

/// Exchange two directory entries in one step.
fn exchange(a: &Path, b: &Path) -> std::io::Result<()> {
    let (a, b) = (c_path(a)?, c_path(b)?);
    // SAFETY: two NUL-terminated paths that outlive the call.
    #[cfg(target_os = "macos")]
    let rc = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) };
    // SAFETY: as above, relative to nothing (both paths are absolute or the
    // caller's own).
    #[cfg(target_os = "linux")]
    let rc = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            a.as_ptr(),
            libc::AT_FDCWD,
            b.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(at: &Path, version: &str) {
        std::fs::create_dir_all(at.join("Contents")).unwrap();
        std::fs::write(at.join("Contents/version"), version).unwrap();
    }

    fn version(at: &Path) -> String {
        std::fs::read_to_string(at.join("Contents/version")).unwrap()
    }

    fn slot(name: &str) -> (PathBuf, Slot) {
        let root =
            std::env::temp_dir().join(format!("daedalus-slot-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let s = Slot {
            live: root.join("Daedalus Agent.app"),
            work: root.join(".update"),
        };
        (root, s)
    }

    #[test]
    fn a_first_install_moves_the_stage_in_and_keeps_no_old() {
        let (root, s) = slot("first");
        s.open_work().unwrap();
        bundle(&s.fresh_stage().unwrap(), "1");
        s.swap_in().unwrap();
        assert_eq!(version(&s.live), "1");
        assert!(!s.old().exists());
        assert!(s.roll_back().is_err(), "nothing to go back to");
        assert_eq!(version(&s.live), "1");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_update_exchanges_the_bundles_and_a_roll_back_undoes_it() {
        let (root, s) = slot("update");
        bundle(&s.live, "1");
        s.open_work().unwrap();
        // What an earlier attempt left is cleared.
        std::fs::create_dir_all(s.staged()).unwrap();
        std::fs::write(s.staged().join("junk"), "x").unwrap();
        bundle(&s.fresh_stage().unwrap(), "2");
        assert!(!s.staged().join("junk").exists());
        // A process that opened the live bundle before the exchange keeps
        // what it opened.
        let held = std::fs::File::open(s.live.join("Contents/version")).unwrap();
        s.swap_in().unwrap();
        assert_eq!(version(&s.live), "2");
        assert_eq!(version(&s.old()), "1");
        assert!(!s.staged().exists());
        let mut text = String::new();
        std::io::Read::read_to_string(&mut &held, &mut text).unwrap();
        assert_eq!(text, "1");
        // Rolled back: the old one live again, the new one kept as bad.
        s.roll_back().unwrap();
        assert_eq!(version(&s.live), "1");
        assert_eq!(version(&s.bad()), "2");
        assert!(!s.old().exists());
        // Retired: only the live bundle is left.
        s.retire();
        assert!(!s.bad().exists() && !s.work.join("stage").exists());
        assert_eq!(version(&s.live), "1");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_second_update_replaces_the_kept_old_one() {
        let (root, s) = slot("again");
        bundle(&s.live, "1");
        s.open_work().unwrap();
        bundle(&s.fresh_stage().unwrap(), "2");
        s.swap_in().unwrap();
        bundle(&s.fresh_stage().unwrap(), "3");
        s.swap_in().unwrap();
        assert_eq!(version(&s.live), "3");
        assert_eq!(version(&s.old()), "2");
        assert!(s.swap_in().is_err(), "nothing staged");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_work_directory_is_closed_and_never_a_link() {
        use std::os::unix::fs::PermissionsExt;
        let (root, s) = slot("work");
        s.open_work().unwrap();
        let mode = std::fs::metadata(&s.work).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        std::fs::remove_dir(&s.work).unwrap();
        std::os::unix::fs::symlink(&root, &s.work).unwrap();
        assert!(s.open_work().is_err());
        // A link is removed, never followed.
        remove(&s.work).unwrap();
        assert!(root.exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
