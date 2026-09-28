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
/// answering, which the caller reports and retries later. `refused` is a
/// version this machine rolled back from (`State::rolled_back`), which is
/// never offered again; a newer one is.
pub fn check(refused: Option<&str>) -> Result<Option<Release>> {
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
    let dir = install_dir().ok();
    let installed = |local: &str| dir.as_ref().is_some_and(|d| d.join(local).exists());
    Ok(pick(releases, &running_version(), refused, installed))
}

/// The pure half of `check`: the highest release above `running` that is
/// not a draft, a prerelease or `refused`, and carries this target's
/// signed assets.
fn pick(
    releases: Vec<ApiRelease>,
    running: &semver::Version,
    refused: Option<&str>,
    installed: impl Fn(&str) -> bool,
) -> Option<Release> {
    let refused = refused.and_then(|v| semver::Version::parse(v).ok());
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
        if version <= *running {
            continue;
        }
        if refused.as_ref() == Some(&version) {
            tracing::info!(
                tag = r.tag_name,
                "this machine rolled back from that release; waiting for a newer one"
            );
            continue;
        }
        let Some(assets) = assets_of(&r, &installed) else {
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
    best
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
/// `<local>.old.<n>` (a previous version), `<local>.bad` or `<local>.bad.<n>`
/// (a version rolled back from).
fn is_retired(local: &str, name: &str) -> bool {
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

fn undo(moved: &[(PathBuf, PathBuf)]) {
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

fn retire_in(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
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

// ── probation ─────────────────────────────────────────────────────────────
//
// A new binary is not trusted for being signed alone: it has to run. The
// update that installs it records it on PROBATION (`State::probation`),
// its `.old` binaries kept; each start of that version under the service
// manager (`run`, never a `serve`) counts itself, as the first thing
// `agent_main` does (`on_start`), before the config is even read. It has
// proved itself (`judge_proof`, `prove`) once its local socket has been served
// for `PROBATION` and — when someone is logged on who runs a tray or a
// session — that tray or session has reported to it: then the record is
// cleared and the `.old` files retired. A run that cannot show that within
// `REPORT_WINDOW` exits, which counts as a failed start. A version that
// starts more than `MAX_STARTS` times without proving itself — the
// service manager restarting it after each crash or exit — is ROLLED BACK
// at its next start: the `.old` binaries go back in place, the failed ones
// become `.bad`, `State::rolled_back` remembers the version, and the
// process exits for the service manager to start the old one. That
// version is never installed again (`check`'s `refused`); a newer release
// is. The first start after an update also restarts the tray or the
// session on the new binary (os `restart_desktop_side`), so the report it
// waits for comes from the matching version. A binary that dies before
// `main` — never one signed for this target — is past what it can count.

/// How long a new version must keep its local socket up to have proved
/// itself.
pub const PROBATION: Duration = Duration::from_secs(120);
/// Starts a version on probation gets; the next one rolls it back.
pub const MAX_STARTS: u32 = 3;

/// What this start of the agent is (`judge_start`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Start {
    /// No update on probation.
    Normal,
    /// The version on probation, starting for the `n`th time.
    Probation(u32),
    /// The version on probation started too often: put the old one back.
    RollBack(crate::state::RolledBack),
}

/// The pure half of `on_start`: count this start against the probation in
/// `state`, running `version`, at `now`.
pub fn judge_start(state: &mut crate::state::State, version: &str, now: &str) -> Start {
    let Some(mut p) = state.probation.take() else {
        return Start::Normal;
    };
    if p.version != version {
        // Not the version on probation: put back by hand, or never
        // started. Nothing to count.
        return Start::Normal;
    }
    p.starts += 1;
    if p.starts > MAX_STARTS {
        let r = crate::state::RolledBack {
            version: p.version,
            to: p.from,
            starts: p.starts - 1,
            at: now.to_string(),
        };
        state.rolled_back = Some(r.clone());
        return Start::RollBack(r);
    }
    let n = p.starts;
    state.probation = Some(p);
    Start::Probation(n)
}

/// Record the update just swapped in as on probation (and forget a
/// version rolled back from: this one is newer).
pub fn begin_probation(state: &mut crate::state::State, version: &str, now: &str) {
    state.probation = Some(crate::state::Probation {
        version: version.to_string(),
        from: crate::VERSION.to_string(),
        starts: 0,
        installed_at: now.to_string(),
    });
    state.rolled_back = None;
}

/// The first thing a start does (module section above): count it, and
/// roll back when the count is past `MAX_STARTS` — which exits the process
/// for the service manager to start the version put back. Logging is not
/// up yet: a rollback says so on stderr and in `last_update_result`, and
/// the caller logs what this returns.
pub fn on_start() -> Start {
    let mut state = crate::state::State::load();
    let had_probation = state.probation.is_some();
    let start = judge_start(&mut state, crate::VERSION, &now_rfc3339());
    match &start {
        // A record for another version was dropped: keep that.
        Start::Normal if had_probation => state.save(),
        Start::Normal => {}
        Start::Probation(_) => state.save(),
        Start::RollBack(r) => {
            let done = install_dir().and_then(|d| roll_back_in(&d));
            state.last_update_result = Some(match &done {
                Ok(()) => format!(
                    "{} rolled back to {}: it started {} times without proving itself",
                    r.version, r.to, r.starts,
                ),
                Err(e) => format!(
                    "{} did not last, and could not be rolled back: {e:#}",
                    r.version
                ),
            });
            state.save();
            eprintln!(
                "daedalus-agent: {}",
                state.last_update_result.as_deref().unwrap_or_default()
            );
            if done.is_ok() {
                std::process::exit(3);
            }
        }
    }
    start
}

/// Whether the version on probation has proved itself yet (`judge_proof`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proof {
    Wait,
    /// Proved, by the rule named.
    Proven(&'static str),
    /// This run failed: no status page, or no report from the tray or the
    /// session with someone logged on, within `REPORT_WINDOW`.
    Failed(&'static str),
}

/// How long a run on probation has to prove itself before it counts as a
/// failed start.
pub const REPORT_WINDOW: Duration = Duration::from_secs(300);

/// The pure half of the proof (module section above): the local socket served
/// for `PROBATION`, and — when someone is logged on who runs a tray or a
/// session (`user_present`, asked only then) — a report from it lately
/// (`reporting`). Past `REPORT_WINDOW` without that, the run failed.
pub fn judge_proof(
    page_up_for: Option<Duration>,
    running_for: Duration,
    user_present: impl FnOnce() -> bool,
    reporting: bool,
) -> Proof {
    if page_up_for.is_some_and(|u| u >= PROBATION) {
        if reporting {
            return Proof::Proven("the local socket served 120 s and the tray/session reported");
        }
        if !user_present() {
            return Proof::Proven(
                "the local socket served 120 s, and nobody is logged on to report",
            );
        }
    }
    if running_for < REPORT_WINDOW {
        return Proof::Wait;
    }
    Proof::Failed(match page_up_for {
        None => "the local socket was never served",
        Some(_) => "someone is logged on and no tray or session reported",
    })
}

/// The version on probation has proved itself (`rule` says how): clear it,
/// and retire the previous binaries.
pub fn prove(shared: &Shared, rule: &'static str) {
    let mut version = None;
    shared.with_state(|s| {
        version = s.probation.take().map(|p| p.version);
    });
    if let Some(v) = version {
        tracing::info!(
            version = v,
            rule,
            "the update proved itself; retiring the previous binaries"
        );
        retire_old_binaries();
    }
}

/// Put the `.old` binaries in `dir` back in place: each current one moved
/// aside to `.bad` (or `.bad.<n>` where one is in use) first. The service's
/// own `.old` must be there; an optional asset without one stays as it is.
fn roll_back_in(dir: &Path) -> Result<()> {
    let mut assets = ASSETS.iter().chain(OPTIONAL_ASSETS);
    let service = ASSETS.first().map(|(_, l)| *l).context("no assets")?;
    if !dir.join(format!("{service}.old")).exists() {
        anyhow::bail!("there is no {service}.old to go back to");
    }
    assets.try_for_each(|(_, local)| {
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

    #[test]
    fn a_bad_copy_is_retired_like_an_old_one() {
        for yes in ["daedalus-agent.exe.bad", "daedalus-agent.exe.bad.2"] {
            assert!(is_retired("daedalus-agent.exe", yes), "{yes}");
        }
        for no in ["daedalus-agent.exe.badx", "daedalus-agent.exe.bad."] {
            assert!(!is_retired("daedalus-agent.exe", no), "{no}");
        }
    }

    fn on_probation(version: &str, starts: u32) -> crate::state::State {
        crate::state::State {
            probation: Some(crate::state::Probation {
                version: version.into(),
                from: "0.18.0".into(),
                starts,
                installed_at: "t0".into(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn a_new_version_counts_its_starts_and_is_rolled_back_past_the_limit() {
        // Nothing on probation: an ordinary start.
        let mut s = crate::state::State::default();
        assert_eq!(judge_start(&mut s, "0.19.0", "t"), Start::Normal);
        // Installed: each start counts, up to MAX_STARTS.
        let mut s = crate::state::State::default();
        begin_probation(&mut s, "0.19.0", "t0");
        assert_eq!(s.probation.as_ref().unwrap().from, crate::VERSION);
        for n in 1..=MAX_STARTS {
            assert_eq!(judge_start(&mut s, "0.19.0", "t"), Start::Probation(n));
            assert_eq!(s.probation.as_ref().unwrap().starts, n);
        }
        // One more: rolled back, remembered, the probation gone.
        let mut s = on_probation("0.19.0", MAX_STARTS);
        s.probation.as_mut().unwrap().from = "0.18.0".into();
        let r = crate::state::RolledBack {
            version: "0.19.0".into(),
            to: "0.18.0".into(),
            starts: MAX_STARTS,
            at: "t9".into(),
        };
        assert_eq!(
            judge_start(&mut s, "0.19.0", "t9"),
            Start::RollBack(r.clone())
        );
        assert_eq!(s.probation, None);
        assert_eq!(s.rolled_back, Some(r));
        // Another version runs than the one on probation (put back by
        // hand): nothing is counted, and the probation is over.
        let mut s = on_probation("0.19.0", 1);
        assert_eq!(judge_start(&mut s, "0.18.0", "t"), Start::Normal);
        assert_eq!(s.probation, None);
        // A newer install forgets the version rolled back from.
        let mut s = crate::state::State {
            rolled_back: Some(crate::state::RolledBack {
                version: "0.19.0".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        begin_probation(&mut s, "0.20.0", "t");
        assert_eq!(s.rolled_back, None);
        assert_eq!(s.probation.unwrap().version, "0.20.0");
    }

    #[test]
    fn a_version_rolled_back_from_is_never_picked_again_but_a_newer_one_is() {
        let names: Vec<&str> = ASSETS.iter().map(|(r, _)| *r).collect();
        let tagged = |tag: &str| ApiRelease {
            tag_name: tag.into(),
            ..release(&names, true)
        };
        let running = semver::Version::parse("0.18.0").unwrap();
        let got = pick(vec![tagged("agent-v0.19.0")], &running, None, |_| false).unwrap();
        assert_eq!(got.version.to_string(), "0.19.0");
        assert!(pick(
            vec![tagged("agent-v0.19.0")],
            &running,
            Some("0.19.0"),
            |_| false
        )
        .is_none());
        let got = pick(
            vec![tagged("agent-v0.19.0"), tagged("agent-v0.19.1")],
            &running,
            Some("0.19.0"),
            |_| false,
        )
        .unwrap();
        assert_eq!(got.version.to_string(), "0.19.1");
        // Not newer than the running one, a draft or not ours: never.
        let draft = ApiRelease {
            draft: true,
            ..tagged("agent-v0.20.0")
        };
        assert!(pick(
            vec![tagged("agent-v0.18.0"), draft, tagged("v0.30.0")],
            &running,
            None,
            |_| false
        )
        .is_none());
    }

    #[test]
    fn a_roll_back_puts_the_old_binaries_back_and_keeps_the_bad_ones_aside() {
        let dir = std::env::temp_dir().join(format!("daedalus-rollback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let service = ASSETS[0].1;
        // Nothing to go back to: refused, nothing moved.
        std::fs::write(dir.join(service), "new").unwrap();
        assert!(roll_back_in(&dir).is_err());
        assert_eq!(std::fs::read_to_string(dir.join(service)).unwrap(), "new");
        for (_, local) in ASSETS {
            std::fs::write(dir.join(local), "new").unwrap();
            std::fs::write(dir.join(format!("{local}.old")), "old").unwrap();
        }
        // A `.bad` from an earlier rollback is replaced.
        std::fs::write(dir.join(format!("{service}.bad")), "older bad").unwrap();
        roll_back_in(&dir).unwrap();
        for (_, local) in ASSETS {
            assert_eq!(std::fs::read_to_string(dir.join(local)).unwrap(), "old");
            assert_eq!(
                std::fs::read_to_string(dir.join(format!("{local}.bad"))).unwrap(),
                "new"
            );
            assert!(!dir.join(format!("{local}.old")).exists());
        }
        retire_in(&dir);
        for (_, local) in ASSETS {
            assert!(dir.join(local).exists());
            assert!(!dir.join(format!("{local}.bad")).exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_probation_run_proves_itself_by_its_page_and_a_report_when_someone_is_there() {
        let s = Duration::from_secs;
        let asked = std::cell::Cell::new(false);
        let present = || {
            asked.set(true);
            true
        };
        // Not yet up long enough: wait, and nobody is asked.
        assert_eq!(judge_proof(Some(s(60)), s(60), present, true), Proof::Wait);
        assert!(!asked.get());
        // Up, and the tray reported.
        assert!(matches!(
            judge_proof(Some(s(120)), s(125), || true, true),
            Proof::Proven(r) if r.contains("reported")
        ));
        // Up, nobody logged on: uptime alone.
        assert!(matches!(
            judge_proof(Some(s(120)), s(125), || false, false),
            Proof::Proven(r) if r.contains("nobody")
        ));
        // Up, someone there, no report: wait, then the run failed.
        assert_eq!(
            judge_proof(Some(s(200)), s(200), || true, false),
            Proof::Wait
        );
        assert!(matches!(
            judge_proof(Some(s(300)), REPORT_WINDOW, || true, false),
            Proof::Failed(w) if w.contains("no tray")
        ));
        // A page that never came up fails at the window too.
        assert!(matches!(
            judge_proof(None, REPORT_WINDOW, || false, false),
            Proof::Failed(w) if w.contains("never")
        ));
    }
}
