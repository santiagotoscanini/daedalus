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
//! binary. The `.old` is deleted on the next clean start.
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
/// release and by their plain names beside this executable. The required
/// ones must be present and signed, or the release is skipped — on Windows
/// and macOS a service without its tray, or the reverse, is a
/// half-installed version. The optional ones (the Linux tray, x86_64 only)
/// are updated where installed and never hold an update back. The tables
/// are per OS (`os::ASSETS`, `os::OPTIONAL_ASSETS`).
pub use crate::os::{ASSETS, OPTIONAL_ASSETS};

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

/// One asset and its signature in a release, when both are there.
fn asset_of(r: &ApiRelease, remote: &str, local: &'static str) -> Option<Asset> {
    let url = r.assets.iter().find(|a| a.name == remote)?;
    let sig = r
        .assets
        .iter()
        .find(|a| a.name == format!("{remote}.sig"))?;
    Some(Asset {
        local_name: local,
        url: url.browser_download_url.clone(),
        sig_url: sig.browser_download_url.clone(),
    })
}

/// The assets this target needs from one API release, or None when a
/// required one is missing or unsigned; plus each optional one this
/// machine has (`installed` says, by local name) and the release carries
/// signed — the Linux tray, which a desktop-less or aarch64 machine never
/// has and never gets.
fn assets_of(r: &ApiRelease, installed: impl Fn(&str) -> bool) -> Option<Vec<Asset>> {
    let mut out: Vec<Asset> = ASSETS
        .iter()
        .map(|(remote, local)| asset_of(r, remote, local))
        .collect::<Option<_>>()?;
    out.extend(
        OPTIONAL_ASSETS
            .iter()
            .filter(|(_, local)| installed(local))
            .filter_map(|(remote, local)| asset_of(r, remote, local)),
    );
    Some(out)
}

/// Ask the feed. `Ok(None)` is "nothing newer"; an error is the feed not
/// answering, which the caller reports and retries later.
pub fn check() -> Result<Option<Release>> {
    let url = format!(
        "https://api.github.com/repos/{}/releases?per_page=20",
        crate::config::DEFAULT_REPO
    );
    let releases: Vec<ApiRelease> = crate::http::agent()
        .get(&url)
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
        let dir = install_dir().ok();
        let installed = |local: &str| dir.as_ref().is_some_and(|d| d.join(local).exists());
        let Some(assets) = assets_of(&r, installed) else {
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
    let resp = crate::http::agent()
        .get(url)
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
        // A downloaded file is not executable until it is said to be (on
        // Windows the name says it, and this does nothing).
        crate::os::mark_executable(&new)
            .with_context(|| format!("marking {} executable", new.display()))?;
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
fn free_aside(old: &Path, exists: impl Fn(&Path) -> bool) -> PathBuf {
    (1u32..)
        .map(|n| suffixed(old, &n.to_string()))
        .find(|p| !exists(p))
        .expect("an unused name")
}

/// Whether `name` is one of `local`'s retired copies: `<local>.old` or
/// `<local>.old.<n>`.
fn is_retired(local: &str, name: &str) -> bool {
    match name
        .strip_prefix(local)
        .and_then(|r| r.strip_prefix(".old"))
    {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('.')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
}

fn undo(moved: &[(PathBuf, PathBuf)]) {
    for (old, target) in moved.iter().rev() {
        let _ = std::fs::remove_file(target);
        let _ = std::fs::rename(old, target);
    }
}

/// Delete the `.old` (and `.old.<n>`) files earlier updates left, once this
/// binary has started well enough to reach here. One still in use stays for
/// a later start.
pub fn retire_old_binaries() {
    let Ok(dir) = install_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    for (_, local) in ASSETS.iter().chain(OPTIONAL_ASSETS) {
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
        match check() {
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
                if let Some(why) = cfg.self_update_off() {
                    shared.with_state(|s| {
                        s.last_update_check = Some(now.clone());
                        s.last_update_result = Some(format!("{label} available; {why}"));
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

/// The updater's wait: like `util::sleep_until`, and a "check now" — from the
/// status page or from the box — cuts it short. Returns true when stopped.
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
    fn an_old_binary_in_use_is_moved_aside_and_retired_later() {
        let old = Path::new("C:/x/daedalus-agent.exe.old");
        let taken = [
            "C:/x/daedalus-agent.exe.old.1",
            "C:/x/daedalus-agent.exe.old.2",
        ];
        let aside = free_aside(old, |p| taken.iter().any(|t| Path::new(t) == p));
        assert!(aside.ends_with("daedalus-agent.exe.old.3"));
        for yes in [
            "daedalus-agent.exe.old",
            "daedalus-agent.exe.old.1",
            "daedalus-agent.exe.old.12",
        ] {
            assert!(is_retired("daedalus-agent.exe", yes), "{yes}");
        }
        for no in [
            "daedalus-agent.exe",
            "daedalus-agent.exe.new",
            "daedalus-agent.exe.old.",
            "daedalus-agent.exe.old.x",
            "daedalus-agent.exe.older",
            "daedalus-agent-tray.exe.old",
        ] {
            assert!(!is_retired("daedalus-agent.exe", no), "{no}");
        }
    }

    #[test]
    fn suffixed_names() {
        let p = suffixed(Path::new("C:/x/daedalus-agent.exe"), "old");
        assert!(p.ends_with("daedalus-agent.exe.old"));
    }

    #[test]
    fn every_asset_has_a_local_name() {
        for (remote, local) in ASSETS.iter().chain(OPTIONAL_ASSETS) {
            assert!(!remote.is_empty() && !local.is_empty());
            assert!(!local.contains('/') && !local.contains('\\'));
        }
    }

    /// A release as the API lists it, carrying `names` (each signed when
    /// `signed` says so).
    fn release(names: &[&str], signed: bool) -> ApiRelease {
        let mut assets = Vec::new();
        for n in names {
            assets.push(ApiAsset {
                name: n.to_string(),
                browser_download_url: format!("https://x/{n}"),
            });
            if signed {
                assets.push(ApiAsset {
                    name: format!("{n}.sig"),
                    browser_download_url: format!("https://x/{n}.sig"),
                });
            }
        }
        ApiRelease {
            tag_name: "agent-v9.9.9".into(),
            draft: false,
            prerelease: false,
            assets,
        }
    }

    #[test]
    fn required_assets_decide_and_optional_ones_follow_what_is_installed() {
        let required: Vec<&str> = ASSETS.iter().map(|(r, _)| *r).collect();
        let optional: Vec<&str> = OPTIONAL_ASSETS.iter().map(|(r, _)| *r).collect();
        let all: Vec<&str> = required.iter().chain(&optional).copied().collect();
        // Everything there and signed, the optional ones installed: all of them.
        let got = assets_of(&release(&all, true), |_| true).unwrap();
        assert_eq!(got.len(), ASSETS.len() + OPTIONAL_ASSETS.len());
        // Not installed here: only the required ones.
        let got = assets_of(&release(&all, true), |_| false).unwrap();
        assert_eq!(got.len(), ASSETS.len());
        // A release without the optional ones still installs.
        let got = assets_of(&release(&required, true), |_| true).unwrap();
        assert_eq!(got.len(), ASSETS.len());
        // Unsigned: skipped.
        assert!(assets_of(&release(&all, false), |_| true).is_none());
        // A required one missing: skipped.
        assert!(assets_of(&release(&optional, true), |_| true).is_none());
    }
}
