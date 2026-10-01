//! Self-update from the engine repository's `agent-v*` releases.
//!
//! The loop asks GitHub for the repository's releases, keeps the ones whose
//! tag is `agent-v<semver>` (the engine's own releases are `v*` and are not
//! ours), newest first, neither drafts nor prereleases, newer than this
//! agent, and reads each one's `release.json` until one holds: signed with a
//! release key compiled in (`RELEASE_PUBLIC_KEYS`), its version its tag's,
//! and for this binary's own target the size and SHA-256 of every asset
//! (feed.rs, signature.rs). Each asset is downloaded, capped at its size and
//! flushed to disk, and kept only when it hashes to the manifest — on
//! Windows and Linux beside the binary as `.new` (files.rs); on macOS the
//! one app bundle, unpacked into its slot's stage and fenced there — Apple's
//! signature with our team, the manifest's version from the staged service
//! itself (bundle.rs, slot.rs); the probation is recorded; only then is the
//! running binary renamed to `.old` and the new one moved into its place —
//! on macOS the two bundles exchanged, the previous one kept as `old` —
//! the new service binary asked its version — the manifest's, or it all
//! goes back — and the process exits non-zero: the Service Control
//! Manager's recovery action (launchd's KeepAlive on macOS, systemd's
//! `Restart=always` on Linux) starts it again on the new binary, on
//! probation until it has run long enough to prove itself, the previous
//! one kept for going back to (probation.rs).
//!
//! Trust is the key, not the transport: GitHub over TLS says where the files
//! are, the signed manifest says what they are. Losing every listed private
//! key strands every agent on its version — the recovery copies are the
//! operator's, outside this repository.
//!
//! Whether a newer release is installed or only reported is config.toml's
//! `updates` (`Config::self_update_off`).
//!
//! The box cannot pin an agent version; the newest release is the pin.

// How a release is put in place: the binaries beside this one on Windows and
// Linux (files.rs); on macOS the app bundle, whole, in its fixed slot
// (bundle.rs, slot.rs). Both answer to the same names.
#[cfg(target_os = "macos")]
mod bundle;
mod feed;
#[cfg(not(target_os = "macos"))]
mod files;
mod probation;
mod signature;
#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
mod slot;
mod swap;

#[cfg(target_os = "macos")]
pub use bundle::*;
pub use feed::*;
#[cfg(not(target_os = "macos"))]
pub use files::*;
pub use probation::*;
pub use signature::*;
#[cfg(target_os = "macos")]
pub use slot::{remove, Slot};
#[cfg(target_os = "macos")]
pub(crate) use swap::version_of;
use swap::*;

use crate::util::Shutdown;
use std::sync::Arc;
use std::time::Duration;

use crate::config::Config;
use crate::shared::Shared;
use crate::state::{now_rfc3339, StateStore};

/// The ed25519 public keys a release manifest may be signed with (32 bytes
/// each, hex). The first is the current key, whose private half signs every
/// release (`AGENT_SIGNING_KEY` in the engine repository's `release`
/// environment); a second, kept offline, is the one to move to when the
/// first is lost or leaks: a release signed with it that drops the first.
/// Every installed agent trusts only what is listed here, so a key is
/// added in a release signed with one it already trusts. PLAN.md holds the
/// spare key still owed.
pub const RELEASE_PUBLIC_KEYS: &[&str] =
    &["27dc531d10284f3de682907886cbef2f1c380b7cd8fecd91f93691ce6f1aa62f"];

/// What a release carries for this target, and what each asset becomes on
/// disk: the service binary and the tray, named by Rust target in the
/// release and by their plain names beside this executable — on macOS the
/// one app bundle that holds both. The required ones must be present and
/// signed, or the release is skipped — on Windows a service without its
/// tray, or the reverse, is a half-installed version. The optional ones (the Linux tray, x86_64 only)
/// are updated where installed and never hold an update back. The tables
/// are per OS (`os::ASSETS`, `os::OPTIONAL_ASSETS`).
pub use crate::os::{ASSETS, OPTIONAL_ASSETS};

pub(super) const TAG_PREFIX: &str = "agent-v";
pub(super) const USER_AGENT: &str = concat!("daedalus-agent/", env!("CARGO_PKG_VERSION"));

pub fn run_loop(cfg: Config, shared: Arc<Shared>, stop: Shutdown) {
    let interval = cfg.update_interval();
    let mut wait = Duration::from_secs(30);
    loop {
        if sleep_until_stop(&stop, &shared, wait) {
            return;
        }
        wait = interval;

        let now = now_rfc3339();
        let refused = shared.state.get().rolled_back.map(|r| r.version);
        match check(refused.as_deref()) {
            Err(e) => {
                tracing::warn!(error = format!("{e:#}"), "update check failed");
                shared.state.edit(|s| {
                    s.last_update_check = Some(now.clone());
                    s.last_update_result = Some(format!("check failed: {e:#}"));
                });
            }
            Ok(None) => {
                shared.update.set_available(None);
                shared.state.edit(|s| {
                    s.last_update_check = Some(now.clone());
                    s.last_update_result = Some(match &refused {
                        Some(v) => {
                            format!("up to date; {v} was rolled back, waiting for a newer release")
                        }
                        None => "up to date".into(),
                    });
                });
            }
            Ok(Some(rel)) => {
                let label = rel.version.to_string();
                shared.update.set_available(Some(label.clone()));
                if let Some(why) = cfg.self_update_off() {
                    shared.state.edit(|s| {
                        s.last_update_check = Some(now.clone());
                        s.last_update_result = Some(format!("{label} available; {why}"));
                    });
                    continue;
                }
                // The `.old` binaries are the version to go back to until
                // this one has proved itself: nothing replaces them before.
                if let Some(p) = shared.state.get().probation {
                    shared.state.edit(|s| {
                        s.last_update_check = Some(now.clone());
                        s.last_update_result = Some(format!(
                            "{label} available; waiting for {} to prove itself first",
                            p.version
                        ));
                    });
                    continue;
                }
                match install(&rel, &shared.state, &now) {
                    Ok(()) => {
                        shared.update.set_restart_pending();
                        tracing::info!(
                            version = label,
                            "installed; exiting so the service restarts on it"
                        );
                        // A moment for the log to flush and the status page to
                        // say why, then a non-zero exit: the recovery action
                        // `install` configured (KeepAlive on macOS) restarts
                        // the service.
                        std::thread::sleep(Duration::from_secs(2));
                        std::process::exit(3);
                    }
                    Err(e) => {
                        tracing::error!(error = format!("{e:#}"), "update not installed");
                        shared.state.edit(|s| {
                            s.last_update_check = Some(now.clone());
                            s.last_update_result =
                                Some(format!("{label} available but not installed: {e:#}"));
                        });
                    }
                }
            }
        }
    }
}

/// Install `rel` — the service's updater and `update --apply` alike: every
/// asset downloaded and verified beside the binaries, then `install_staged`
/// with the real swap.
pub fn install(rel: &Release, store: &StateStore, now: &str) -> anyhow::Result<()> {
    let staged = download_and_verify(rel)?;
    install_staged(
        &rel.version,
        store,
        now,
        Binaries {
            swap_in: || swap_in(&staged),
            installed_version,
            roll_back,
        },
    )
}

/// What `install_staged` does to the binaries: put the staged ones in
/// place, ask the one now in place its version, put the previous ones back.
pub struct Binaries<S, V, R> {
    pub swap_in: S,
    pub installed_version: V,
    pub roll_back: R,
}

/// The staged release `version` put in place: its probation recorded — and
/// kept on disk — BEFORE anything running is touched, so a crash from here
/// on still counts its starts (audit D11); the binaries swapped in; then
/// the service binary now in place asked its version, which must be the
/// manifest's (audit D3). A swap that does not hold is undone: the
/// probation cleared, and a binary that says another version rolled back
/// and refused from then on (`State::rolled_back`).
pub fn install_staged<S, V, R>(
    version: &semver::Version,
    store: &StateStore,
    now: &str,
    bin: Binaries<S, V, R>,
) -> anyhow::Result<()>
where
    S: FnOnce() -> anyhow::Result<()>,
    V: FnOnce() -> anyhow::Result<semver::Version>,
    R: FnOnce() -> anyhow::Result<()>,
{
    use anyhow::Context;
    let label = version.to_string();
    store
        .edit_saved(|s| {
            s.last_update_check = Some(now.to_string());
            s.last_update_result = Some(format!("installed {label}; restarting"));
            s.updated_from = Some(crate::VERSION.into());
            s.updated_at = Some(now.to_string());
            begin_probation(s, &label, now);
        })
        .context("the probation could not be recorded; nothing was replaced")?;
    if let Err(e) = (bin.swap_in)() {
        store.edit(|s| s.probation = None);
        return Err(e);
    }
    let why = match (bin.installed_version)() {
        Ok(v) if v == *version => return Ok(()),
        Ok(v) => format!("the installed binary says {v}, not {label}"),
        Err(e) => format!("the installed binary does not run: {e:#}"),
    };
    let back = (bin.roll_back)();
    store.edit(|s| {
        s.probation = None;
        s.rolled_back = Some(crate::state::RolledBack {
            version: label.clone(),
            to: crate::VERSION.into(),
            starts: 0,
            at: now.to_string(),
        });
    });
    match back {
        Ok(()) => anyhow::bail!("{why}; put the previous binaries back"),
        Err(e) => anyhow::bail!("{why}; and the previous binaries could not be put back: {e:#}"),
    }
}

/// The updater's wait: `total`, cut short by a "check now" — from the
/// status page or from the box, which nudges the stop (`UpdateState::
/// request_check`). Returns true when stopped.
pub(super) fn sleep_until_stop(stop: &Shutdown, shared: &Shared, total: Duration) -> bool {
    let until = std::time::Instant::now() + total;
    loop {
        // Taken before the flag is read, so a request between the two
        // still wakes the wait below.
        let seen = stop.nudges();
        if shared.update.take_check_request() {
            tracing::info!("update check requested from the status page");
            return false;
        }
        let left = until.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return stop.is_stopped();
        }
        if stop.wait_nudged(seen, left) {
            return true;
        }
    }
}

#[cfg(test)]
mod tests;
