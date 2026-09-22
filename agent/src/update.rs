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

/// What a release carries for this target, and what each asset becomes on
/// disk: the service binary and the tray, named by Rust target in the
/// release and by their plain names beside this executable. Both must be
/// present and signed, or the release is skipped — a service without its
/// tray, or the reverse, is a half-installed version.
#[cfg(all(windows, target_arch = "x86_64"))]
pub const ASSETS: &[(&str, &str)] = &[
    (
        "daedalus-agent-x86_64-pc-windows-msvc.exe",
        "daedalus-agent.exe",
    ),
    (
        "daedalus-agent-tray-x86_64-pc-windows-msvc.exe",
        "daedalus-agent-tray.exe",
    ),
];
#[cfg(not(all(windows, target_arch = "x86_64")))]
pub const ASSETS: &[(&str, &str)] = &[("daedalus-agent-unsupported", "daedalus-agent")];

const TAG_PREFIX: &str = "agent-v";
const USER_AGENT: &str = concat!("daedalus-agent/", env!("CARGO_PKG_VERSION"));

/// One asset of a release: where it is and what it is called here.
#[derive(Debug, Clone)]
pub struct Asset {
    pub local_name: &'static str,
    pub url: String,
    pub sig_url: String,
}

#[derive(Debug, Clone)]
pub struct Release {
    pub tag: String,
    pub version: semver::Version,
    pub assets: Vec<Asset>,
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

/// The assets this target needs from one API release, or None when any is
/// missing or unsigned.
fn assets_of(r: &ApiRelease) -> Option<Vec<Asset>> {
    ASSETS
        .iter()
        .map(|(remote, local)| {
            let url = r.assets.iter().find(|a| a.name == *remote)?;
            let sig = r
                .assets
                .iter()
                .find(|a| a.name == format!("{remote}.sig"))?;
            Some(Asset {
                local_name: local,
                url: url.browser_download_url.clone(),
                sig_url: sig.browser_download_url.clone(),
            })
        })
        .collect()
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
        let Some(assets) = assets_of(&r) else {
            tracing::warn!(
                tag = r.tag_name,
                "release lacks an asset or a signature for this target; skipped"
            );
            continue;
        };
        if best.as_ref().is_none_or(|b| version > b.version) {
            best = Some(Release {
                tag: r.tag_name.clone(),
                version,
                assets,
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

/// The directory both executables live in: this one's.
fn install_dir() -> Result<PathBuf> {
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

/// Download every asset and its signature; verify each; leave them beside
/// the binaries as `<name>.new`.
pub fn download_and_verify(rel: &Release) -> Result<Staged> {
    let dir = install_dir()?;
    let mut files = Vec::new();
    for a in &rel.assets {
        tracing::info!(tag = rel.tag, asset = a.local_name, "downloading");
        let bytes = fetch(&a.url)?;
        let sig = fetch(&a.sig_url)?;
        verify(&bytes, &sig).with_context(|| format!("{}: {}", rel.tag, a.local_name))?;
        let target = dir.join(a.local_name);
        let new = suffixed(&target, "new");
        std::fs::write(&new, &bytes).with_context(|| format!("writing {}", new.display()))?;
        tracing::info!(
            asset = a.local_name,
            bytes = bytes.len(),
            "verified against the release key"
        );
        files.push((target, new));
    }
    Ok(Staged { files })
}

/// Put the verified binaries in place of the current ones. Windows lets a
/// running executable be renamed but not overwritten, hence the two moves
/// per file; a failure part-way puts back what was moved.
pub fn swap_in(staged: &Staged) -> Result<()> {
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (target, new) in &staged.files {
        let old = suffixed(target, "old");
        if old.exists() {
            std::fs::remove_file(&old).with_context(|| format!("removing {}", old.display()))?;
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

fn undo(moved: &[(PathBuf, PathBuf)]) {
    for (old, target) in moved.iter().rev() {
        let _ = std::fs::remove_file(target);
        let _ = std::fs::rename(old, target);
    }
}

/// Delete the `.old` files an earlier update left, once this binary has
/// started well enough to reach here.
pub fn retire_old_binaries() {
    let Ok(dir) = install_dir() else { return };
    for (_, local) in ASSETS {
        let old = suffixed(&dir.join(local), "old");
        if old.exists() {
            match std::fs::remove_file(&old) {
                Ok(()) => tracing::info!(file = local, "retired the previous binary"),
                Err(e) => tracing::warn!(file = local, error = %e, "previous binary not removed"),
            }
        }
    }
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("binary");
    path.with_file_name(format!("{name}.{suffix}"))
}

pub fn run_loop(cfg: Config, shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    let interval = cfg.update_interval();
    let mut wait = Duration::from_secs(30);
    loop {
        if sleep_until_stop(&stop, &shared, wait) {
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
                match download_and_verify(&rel).and_then(|s| swap_in(&s)) {
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

/// Sleep in short steps so a stop request is honoured within half a second,
/// and a "check now" from the status page cuts the wait short. Returns true
/// when stopped.
fn sleep_until_stop(stop: &AtomicBool, shared: &Shared, total: Duration) -> bool {
    let step = Duration::from_millis(500);
    let mut left = total;
    while !left.is_zero() {
        if stop.load(Ordering::Relaxed) {
            return true;
        }
        if shared.take_check_request() {
            tracing::info!("update check requested from the status page");
            return false;
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
    fn suffixed_names() {
        let p = suffixed(Path::new("C:/x/daedalus-agent.exe"), "old");
        assert!(p.ends_with("daedalus-agent.exe.old"));
    }

    #[test]
    fn every_asset_has_a_local_name() {
        for (remote, local) in ASSETS {
            assert!(!remote.is_empty() && !local.is_empty());
            assert!(!local.contains('/') && !local.contains('\\'));
        }
    }
}
