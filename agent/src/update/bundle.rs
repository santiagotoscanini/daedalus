//! macOS: a release is one Daedalus Agent.app (os/macos/bundle.rs), and the
//! update replaces it whole in its fixed place (slot.rs): the archive
//! downloaded into the slot's work directory and checked against the signed
//! manifest; unpacked into the stage, sealed, and fenced — Apple's signature
//! with our team and identifiers, the manifest's version in Info.plist and
//! from the service binary itself — all before the probation is recorded
//! and the bundles are exchanged. Going back exchanges them again; nothing
//! here reads the running executable's path (review S5).

use std::path::PathBuf;

use anyhow::{bail, Result};

use super::*;
use crate::os::mac::bundle as app;

/// The directory the service binary runs from: the canonical bundle's.
pub(super) fn install_dir() -> Result<PathBuf> {
    Ok(app::canonical().join("Contents/MacOS"))
}

/// The new bundle, verified and fenced, waiting in the slot's stage.
pub struct Staged(());

/// Download the release's bundle, check it against the manifest, unpack it
/// into the stage and fence it (the module doc).
pub fn download_and_verify(rel: &Release) -> Result<Staged> {
    let [a] = rel.assets.as_slice() else {
        bail!(
            "a Mac's release is one app bundle, not {} files",
            rel.assets.len()
        );
    };
    let slot = app::slot();
    slot.open_work()?;
    let zip = slot.download();
    fetch_verified(rel, a, &zip)?;
    let staged = app::stage_archive(&zip, &slot);
    let _ = remove(&zip);
    let staged = staged?;
    app::seal(&staged)?;
    app::check(&staged, &rel.version, true)?;
    Ok(Staged(()))
}

/// The staged bundle exchanged with the live one, which is kept for going
/// back to until the new one proves itself.
pub fn swap_in(_staged: &Staged) -> Result<()> {
    app::slot().swap_in()
}

/// What the canonical bundle's service now says it is.
pub fn installed_version() -> Result<semver::Version> {
    version_of(&app::service_exe(&app::canonical()))
}

/// The previous bundle put back; the one rolled back from kept as `bad`.
pub fn roll_back() -> Result<()> {
    app::slot().roll_back()
}

/// The previous and the rolled-back bundles, and any leftover stage, gone.
pub fn retire_old_binaries() {
    app::slot().retire()
}
