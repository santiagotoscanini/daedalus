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
//! and the Service Control Manager's recovery action starts it again on the
//! new binary. The `.old` is deleted on the next clean start.
//!
//! Trust is the key, not the transport: GitHub over TLS says where the file
//! came from, the signature says who built it. A release without a valid
//! `.sig` is reported on the status page and never installed. Losing the
//! private key strands every agent on its version — the recovery copy is
//! the operator's, outside this repository.
//!
//! Until the box learns to pin an agent version (PLAN.md, feature 6), the
//! newest release is the pin.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;

use crate::config::Config;
use crate::state::now_rfc3339;
use crate::status::Shared;

/// The ed25519 public key every release asset is signed with (32 bytes,
/// hex). Its private half is the engine repository's `AGENT_SIGNING_KEY`
/// Actions secret. Changing this key means every installed agent stops
/// accepting releases — it is rotated by shipping a release signed with the
/// OLD key that carries the new one here, never by editing it alone.
pub const RELEASE_PUBLIC_KEY_HEX: &str =
    "27dc531d10284f3de682907886cbef2f1c380b7cd8fecd91f93691ce6f1aa62f";

/// The asset this build installs. The workflow names them by Rust target.
#[cfg(all(windows, target_arch = "x86_64"))]
pub const ASSET_NAME: &str = "daedalus-agent-x86_64-pc-windows-msvc.exe";
#[cfg(not(all(windows, target_arch = "x86_64")))]
pub const ASSET_NAME: &str = "daedalus-agent-unsupported";

const TAG_PREFIX: &str = "agent-v";
const USER_AGENT: &str = concat!("daedalus-agent/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone)]
pub struct Release {
    pub tag: String,
    pub version: semver::Version,
    pub asset_url: String,
    pub sig_url: String,
}

#[derive(Deserialize)]
struct ApiRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<ApiAsset>,
}

#[derive(Deserialize)]
struct ApiAsset {
    name: String,
    browser_download_url: String,
}

fn running_version() -> semver::Version {
    semver::Version::parse(crate::VERSION).expect("Cargo.toml version is semver")
}

/// Ask the feed. `Ok(None)` is "nothing newer"; an error is the feed not
/// answering, which the caller reports and retries later.
pub fn check(cfg: &Config) -> Result<Option<Release>> {
    let url = format!(
        "https://api.github.com/repos/{}/releases?per_page=20",
        cfg.release_repo
    );
    let releases: Vec<ApiRelease> = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .call()
        .context("asking GitHub for releases")?
        .into_json()
        .context("reading the release list")?;

    let running = running_version();
    let mut best: Option<Release> = None;
    for r in releases {
        if r.draft || r.prerelease {
            continue;
        }
        let Some(v) = r.tag_name.strip_prefix(TAG_PREFIX) else {
            continue;
        };
        let Ok(version) = semver::Version::parse(v) else {
            continue;
        };
        if version <= running {
            continue;
        }
        let asset = r.assets.iter().find(|a| a.name == ASSET_NAME);
        let sig = r
            .assets
            .iter()
            .find(|a| a.name == format!("{ASSET_NAME}.sig"));
        let (Some(asset), Some(sig)) = (asset, sig) else {
            tracing::warn!(
                tag = r.tag_name,
                "release lacks this target's asset or its signature; skipped"
            );
            continue;
        };
        if best.as_ref().is_none_or(|b| version > b.version) {
            best = Some(Release {
                tag: r.tag_name.clone(),
                version,
                asset_url: asset.browser_download_url.clone(),
                sig_url: sig.browser_download_url.clone(),
            });
        }
    }
    Ok(best)
}

fn fetch(url: &str) -> Result<Vec<u8>> {
    let resp = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(300))
        .call()
        .with_context(|| format!("downloading {url}"))?;
    let mut bytes = Vec::new();
    resp.into_reader()
        .read_to_end(&mut bytes)
        .with_context(|| format!("reading {url}"))?;
    Ok(bytes)
}

fn verifying_key() -> Result<VerifyingKey> {
    let raw = hex::decode(RELEASE_PUBLIC_KEY_HEX).context("public key hex")?;
    let arr: [u8; 32] = raw.as_slice().try_into().context("public key length")?;
    VerifyingKey::from_bytes(&arr).context("public key bytes")
}

/// Check a raw ed25519 signature (64 bytes, as `openssl pkeyutl -sign
/// -rawin` writes it) over the asset's bytes.
pub fn verify(asset: &[u8], sig: &[u8]) -> Result<()> {
    let sig = Signature::from_slice(sig).context("signature is not 64 bytes")?;
    verifying_key()?
        .verify(asset, &sig)
        .map_err(|_| anyhow::anyhow!("signature does not match the release key"))
}

fn exe_path() -> Result<PathBuf> {
    std::env::current_exe().context("locating this binary")
}

/// Download the release's asset and signature; verify; leave the verified
/// binary beside this one as `.new` and return its path.
pub fn download_and_verify(rel: &Release) -> Result<PathBuf> {
    tracing::info!(tag = rel.tag, "downloading");
    let asset = fetch(&rel.asset_url)?;
    let sig = fetch(&rel.sig_url)?;
    verify(&asset, &sig)?;
    let new_path = sibling(&exe_path()?, "new")?;
    std::fs::write(&new_path, &asset).with_context(|| format!("writing {}", new_path.display()))?;
    tracing::info!(
        tag = rel.tag,
        bytes = asset.len(),
        "verified against the release key"
    );
    Ok(new_path)
}

/// Put the verified binary in place of the running one. Windows lets a
/// running executable be renamed but not overwritten, hence the two moves.
pub fn swap_in(new_path: &Path) -> Result<()> {
    let exe = exe_path()?;
    let old = sibling(&exe, "old")?;
    if old.exists() {
        std::fs::remove_file(&old).with_context(|| format!("removing {}", old.display()))?;
    }
    std::fs::rename(&exe, &old)
        .with_context(|| format!("moving the running binary to {}", old.display()))?;
    if let Err(e) = std::fs::rename(new_path, &exe) {
        // Put the running one back so the service still has a binary to restart.
        let _ = std::fs::rename(&old, &exe);
        return Err(e).with_context(|| format!("moving the new binary to {}", exe.display()));
    }
    Ok(())
}

/// Delete the `.old` an earlier update left, once this binary has started
/// well enough to reach here.
pub fn retire_old_binary() {
    if let Ok(exe) = exe_path() {
        if let Ok(old) = sibling(&exe, "old") {
            if old.exists() {
                match std::fs::remove_file(&old) {
                    Ok(()) => tracing::info!("retired the previous binary"),
                    Err(e) => tracing::warn!(error = %e, "previous binary not removed"),
                }
            }
        }
    }
}

fn sibling(exe: &Path, suffix: &str) -> Result<PathBuf> {
    let name = exe
        .file_name()
        .and_then(|n| n.to_str())
        .context("binary has no name")?;
    Ok(exe.with_file_name(format!("{name}.{suffix}")))
}

/// The service's update thread: a check shortly after start, then on the
/// interval, until `stop`. Installs when allowed, then exits the process
/// so the Service Control Manager restarts it on the new binary.
pub fn run_loop(cfg: Config, shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    let interval = cfg.update_interval();
    let mut wait = Duration::from_secs(30);
    loop {
        if sleep_until_stop(&stop, wait) {
            return;
        }
        wait = interval;

        let now = now_rfc3339();
        match check(&cfg) {
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
                    s.last_update_result = Some("up to date".into());
                });
            }
            Ok(Some(rel)) => {
                let label = rel.version.to_string();
                shared.set_update_available(Some(label.clone()));
                if !cfg.auto_update {
                    shared.with_state(|s| {
                        s.last_update_check = Some(now.clone());
                        s.last_update_result =
                            Some(format!("{label} available; auto_update is off"));
                    });
                    continue;
                }
                match download_and_verify(&rel).and_then(|p| swap_in(&p)) {
                    Ok(()) => {
                        shared.with_state(|s| {
                            s.last_update_check = Some(now.clone());
                            s.last_update_result = Some(format!("installed {label}; restarting"));
                            s.updated_from = Some(crate::VERSION.into());
                            s.updated_at = Some(now.clone());
                        });
                        shared.set_restart_pending();
                        tracing::info!(
                            version = label,
                            "installed; exiting so the service restarts on it"
                        );
                        // A moment for the log to flush and the status page to
                        // say why, then a non-zero exit: the recovery action
                        // `install` configured restarts the service.
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

/// Sleep in short steps so a stop request is honoured within half a second.
/// Returns true when stopped.
fn sleep_until_stop(stop: &AtomicBool, total: Duration) -> bool {
    let step = Duration::from_millis(500);
    let mut left = total;
    while !left.is_zero() {
        if stop.load(Ordering::Relaxed) {
            return true;
        }
        let d = left.min(step);
        std::thread::sleep(d);
        left -= d;
    }
    stop.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_key_parses() {
        verifying_key().expect("compiled-in key is a valid ed25519 public key");
    }

    #[test]
    fn rejects_a_wrong_signature() {
        let err = verify(b"asset", &[0u8; 64]).unwrap_err();
        assert!(err.to_string().contains("does not match"));
    }

    #[test]
    fn rejects_a_short_signature() {
        assert!(verify(b"asset", &[0u8; 10]).is_err());
    }

    #[test]
    fn sibling_names() {
        let p = sibling(Path::new("C:/x/daedalus-agent.exe"), "old").unwrap();
        assert!(p.ends_with("daedalus-agent.exe.old"));
    }
}
