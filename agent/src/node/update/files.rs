//! Windows and Linux: download, swap in, retire and roll back the binaries
//! beside this one.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use super::*;

/// The directory both executables live in: this one's.
pub(super) fn install_dir() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("locating this binary")?;
    exe.parent()
        .map(Path::to_path_buf)
        .context("binary has no directory")
}

/// A release downloaded and verified, waiting beside the binaries as `.new`
/// files. Nothing running has been touched yet.
pub struct Staged {
    files: Vec<(PathBuf, PathBuf)>,
}

/// Download every asset the manifest named, each streamed to
/// `<name>.new` beside the binaries through a cap at its stated size,
/// hashed on the way, flushed to disk, and kept only when size and SHA-256
/// are the manifest's.
pub fn download_and_verify(rel: &Release) -> Result<Staged> {
    let dir = install_dir()?;
    let mut files = Vec::new();
    for a in &rel.assets {
        let target = dir.join(a.local_name);
        let new = suffixed(&target, "new");
        fetch_verified(rel, a, &new)?;
        // A downloaded file is not executable until it is said to be (on
        // Windows the name says it, and this does nothing).
        crate::os::mark_executable(&new)
            .with_context(|| format!("marking {} executable", new.display()))?;
        files.push((target, new));
    }
    if let Ok(d) = std::fs::File::open(&dir) {
        let _ = d.sync_all();
    }
    Ok(Staged { files })
}

/// What the service binary now in place says it is (`version_of`): the
/// check after a swap.
pub fn installed_version() -> Result<semver::Version> {
    let (_, _, service) = ASSETS.first().context("no assets")?;
    version_of(&install_dir()?.join(service))
}

/// Put the verified binaries in place of the current ones. Windows lets a
/// running executable be renamed but not overwritten, hence the two moves
/// per file; a failure part-way puts back what was moved.
///
/// An `.old` from the previous update that cannot be removed — on Windows a
/// binary something still runs, such as a resumed session's terminal holder
/// from before the holder ran from its own copy — is moved aside to
/// `.old.<n>` instead, which a later start retires (`retire_old_binaries`).
pub fn swap_in(staged: &Staged) -> Result<()> {
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (target, new) in &staged.files {
        let old = suffixed(target, "old");
        if old.exists() {
            if let Err(e) = std::fs::remove_file(&old) {
                let aside = free_aside(&old, |p| p.exists());
                tracing::warn!(file = %old.display(), error = %e, to = %aside.display(),
                    "the previous binary is in use; moving it aside");
                std::fs::rename(&old, &aside).with_context(|| {
                    format!(
                        "{} could not be removed ({e}) nor moved to {}",
                        old.display(),
                        aside.display()
                    )
                })?;
            }
        }
        if target.exists() {
            if let Err(e) = std::fs::rename(target, &old) {
                undo(&moved);
                return Err(e).with_context(|| format!("moving {} aside", target.display()));
            }
            moved.push((old.clone(), target.clone()));
        }
        if let Err(e) = std::fs::rename(new, target) {
            undo(&moved);
            return Err(e)
                .with_context(|| format!("moving the new {} into place", target.display()));
        }
    }
    Ok(())
}

/// The first `<old>.<n>` that does not exist: where an `.old` still in use
/// goes.
pub(super) fn free_aside(old: &Path, exists: impl Fn(&Path) -> bool) -> PathBuf {
    (1u32..)
        .map(|n| suffixed(old, &n.to_string()))
        .find(|p| !exists(p))
        .expect("an unused name")
}

/// Whether `name` is one of `local`'s retired copies: `<local>.old` or
/// `<local>.old.<n>` (a previous version), `<local>.bad` or `<local>.bad.<n>`
/// (a version rolled back from).
pub(super) fn is_retired(local: &str, name: &str) -> bool {
    let Some(rest) = name.strip_prefix(local) else {
        return false;
    };
    match rest
        .strip_prefix(".old")
        .or_else(|| rest.strip_prefix(".bad"))
    {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('.')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
}

pub(super) fn undo(moved: &[(PathBuf, PathBuf)]) {
    for (old, target) in moved.iter().rev() {
        let _ = std::fs::remove_file(target);
        let _ = std::fs::rename(old, target);
    }
}

/// Delete the `.old` and `.bad` files (and their `.<n>`s) earlier updates
/// left: at a start with no update on probation, and when one has proved
/// itself (`prove`). One still in use stays for a later start.
pub fn retire_old_binaries() {
    if let Ok(dir) = install_dir() {
        retire_in(&dir);
    }
}

pub(super) fn retire_in(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    for (_, _, local) in ASSETS.iter().chain(OPTIONAL_ASSETS) {
        for name in names.iter().filter(|n| is_retired(local, n)) {
            match std::fs::remove_file(dir.join(name)) {
                Ok(()) => tracing::info!(file = name, "retired a previous binary"),
                Err(e) => {
                    tracing::warn!(file = name, error = %e, "previous binary not removed yet")
                }
            }
        }
    }
}

/// Put the previous binaries back beside this one (`roll_back_in`).
pub fn roll_back() -> Result<()> {
    roll_back_in(&install_dir()?)
}

/// Put the `.old` binaries in `dir` back in place: each current one moved
/// aside to `.bad` (or `.bad.<n>` where one is in use) first. The service's
/// own `.old` must be there; an optional asset without one stays as it is.
pub(super) fn roll_back_in(dir: &Path) -> Result<()> {
    let mut assets = ASSETS.iter().chain(OPTIONAL_ASSETS);
    let service = ASSETS.first().map(|(_, _, l)| *l).context("no assets")?;
    if !dir.join(format!("{service}.old")).exists() {
        anyhow::bail!("there is no {service}.old to go back to");
    }
    assets.try_for_each(|(_, _, local)| {
        let target = dir.join(local);
        let old = suffixed(&target, "old");
        if !old.exists() {
            return Ok(());
        }
        if target.exists() {
            let mut bad = suffixed(&target, "bad");
            if bad.exists() && std::fs::remove_file(&bad).is_err() {
                bad = free_aside(&bad, |p| p.exists());
            }
            std::fs::rename(&target, &bad)
                .with_context(|| format!("moving {} aside", target.display()))?;
        }
        std::fs::rename(&old, &target).with_context(|| format!("putting {} back", old.display()))
    })
}

pub(super) fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("binary");
    path.with_file_name(format!("{name}.{suffix}"))
}
