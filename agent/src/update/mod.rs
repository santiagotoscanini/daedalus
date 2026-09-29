//! Self-update from the engine repository's `agent-v*` releases.
//!
//! The loop asks GitHub for the repository's releases, keeps the ones whose
//! tag is `agent-v<semver>` (the engine's own releases are `v*` and are not
//! ours), takes the highest that is neither a draft nor a prerelease, and
//! compares it with the running version. A newer one is downloaded next to
//! the binary as `.new` together with its `.sig`, and the signature — a raw
//! ed25519 signature over the asset's bytes — is checked against the public
//! key compiled in below. Only then is the running binary renamed to `.old`
//! and the new one moved into its place; then the process exits non-zero,
//! and the Service Control Manager's recovery action (launchd's KeepAlive on
//! macOS, systemd's `Restart=always` on Linux) starts it again on the new
//! binary — on probation until it has run long enough to prove itself, its
//! `.old` kept for going back to (the probation section below).
//!
//! Trust is the key, not the transport: GitHub over TLS says where the file
//! came from, the signature says who built it. A release missing a `.sig` is
//! skipped; one whose signature fails is reported on the status page and
//! never installed. Losing the private key strands every agent on its
//! version — the recovery copy is the operator's, outside this repository.
//!
//! Whether a newer release is installed or only reported is config.toml's
//! `updates`, or the older `auto_update` (`Config::self_update_off`).
//!
//! The box cannot pin an agent version; the newest release is the pin.

mod feed;
mod probation;
mod signature;
mod swap;

pub use feed::*;
pub use probation::*;
pub use signature::*;
pub use swap::*;

use crate::util::Shutdown;
use std::sync::Arc;
use std::time::Duration;

use crate::config::Config;
use crate::shared::Shared;
use crate::state::now_rfc3339;

/// The ed25519 public key every release asset is signed with (32 bytes,
/// hex). Its private half is the engine repository's `AGENT_SIGNING_KEY`
/// Actions secret. Changing this key means every installed agent stops
/// accepting releases — it is rotated by shipping a release signed with the
/// OLD key that carries the new one here, never by editing it alone.
pub const RELEASE_PUBLIC_KEY_HEX: &str =
    "27dc531d10284f3de682907886cbef2f1c380b7cd8fecd91f93691ce6f1aa62f";

/// What a release carries for this target, and what each asset becomes on
/// disk: the service binary and the tray, named by Rust target in the
/// release and by their plain names beside this executable. The required
/// ones must be present and signed, or the release is skipped — on Windows
/// and macOS a service without its tray, or the reverse, is a
/// half-installed version. The optional ones (the Linux tray, x86_64 only)
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
        let refused = shared.state().rolled_back.map(|r| r.version);
        match check(refused.as_deref()) {
            Err(e) => {
                tracing::warn!(error = format!("{e:#}"), "update check failed");
                shared.with_state(|s| {
                    s.last_update_check = Some(now.clone());
                    s.last_update_result = Some(format!("check failed: {e:#}"));
                });
            }
            Ok(None) => {
                shared.set_update_available(None);
                shared.with_state(|s| {
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
                shared.set_update_available(Some(label.clone()));
                if let Some(why) = cfg.self_update_off() {
                    shared.with_state(|s| {
                        s.last_update_check = Some(now.clone());
                        s.last_update_result = Some(format!("{label} available; {why}"));
                    });
                    continue;
                }
                // The `.old` binaries are the version to go back to until
                // this one has proved itself: nothing replaces them before.
                if let Some(p) = shared.state().probation {
                    shared.with_state(|s| {
                        s.last_update_check = Some(now.clone());
                        s.last_update_result = Some(format!(
                            "{label} available; waiting for {} to prove itself first",
                            p.version
                        ));
                    });
                    continue;
                }
                match download_and_verify(&rel).and_then(|s| swap_in(&s)) {
                    Ok(()) => {
                        shared.with_state(|s| {
                            s.last_update_check = Some(now.clone());
                            s.last_update_result = Some(format!("installed {label}; restarting"));
                            s.updated_from = Some(crate::VERSION.into());
                            s.updated_at = Some(now.clone());
                            begin_probation(s, &label, &now);
                        });
                        shared.set_restart_pending();
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
                        shared.with_state(|s| {
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

/// The updater's wait: `total`, cut short by a "check now" — from the
/// status page or from the box, which nudges the stop (`Shared::
/// request_check`). Returns true when stopped.
pub(super) fn sleep_until_stop(stop: &Shutdown, shared: &Shared, total: Duration) -> bool {
    let until = std::time::Instant::now() + total;
    loop {
        // Taken before the flag is read, so a request between the two
        // still wakes the wait below.
        let seen = stop.nudges();
        if shared.take_check_request() {
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
