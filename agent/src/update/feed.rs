//! The release feed: GitHub's releases of the engine repository, and the
//! signed manifest that says what each one is.
//!
//! GitHub's answer is trusted for nothing but where to look: which tags
//! exist and where their files are. What a release IS — its product, its
//! version and tag, and for each target and role the asset's name, size
//! and SHA-256 — is `release.json`, signed once with the release key under
//! a context of its own (signature.rs), and every decision is taken from
//! it: the version must be its tag's and newer than this one, and the
//! assets are chosen by this binary's own target table (`os::ASSETS`).
//! So a re-uploaded old asset, another target's binary under this one's
//! name, or a tag moved onto an older build is refused (audit D3).

use std::io::Read;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use super::*;

/// The manifest's file name in a release, and its signature's.
pub const MANIFEST: &str = "release.json";
pub const MANIFEST_SIG: &str = "release.json.sig";
/// What the manifest says it is for.
pub const PRODUCT: &str = "daedalus-agent";
/// The longest manifest or signature read.
const MAX_MANIFEST: u64 = 64 * 1024;

/// A release as its signed manifest states it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub product: String,
    pub version: String,
    pub tag: String,
    pub assets: Vec<ManifestAsset>,
}

/// One asset of a release: the Rust target and role it is for, its file
/// name in the release, and what it must hash to and weigh. The role is
/// free text: `service` and `tray` are what this version installs,
/// `bundle` ([`ROLE_BUNDLE`]) what it recognises and cannot apply, and
/// any other (`installer`, a DMG) is read and ignored.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestAsset {
    pub target: String,
    pub role: String,
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

/// One asset to install: where it is, what it is called here, and what the
/// manifest says of it.
#[derive(Debug, Clone, PartialEq)]
pub struct Asset {
    pub local_name: &'static str,
    pub url: String,
    pub sha256: [u8; 32],
    pub size: u64,
}

/// The role of a macOS app bundle: one `.app.zip` for its target, in place
/// of the bare service and tray (agent 0.24 on). This version cannot apply
/// one; a release that carries only that for this machine is a re-install.
pub const ROLE_BUNDLE: &str = "bundle";

#[derive(Debug, Clone)]
pub struct Release {
    pub tag: String,
    pub version: semver::Version,
    pub assets: Vec<Asset>,
}

/// What the newest signed release newer than this agent is to this machine.
#[derive(Debug, Clone)]
pub enum Offer {
    /// Its assets for this target, to install.
    Install(Release),
    /// Packaged in a form this version cannot apply — the macOS app bundle
    /// ([`ROLE_BUNDLE`]) with no bare binaries beside it: reported, never
    /// applied; the machine is re-installed from the website or install.sh.
    Reinstall {
        tag: String,
        version: semver::Version,
    },
}

/// [`offer_of`]'s answer for one release.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Offered {
    Assets(semver::Version, Vec<Asset>),
    Reinstall(semver::Version),
}

#[derive(Deserialize)]
pub(super) struct ApiRelease {
    pub(super) tag_name: String,
    pub(super) draft: bool,
    pub(super) prerelease: bool,
    pub(super) assets: Vec<ApiAsset>,
}

#[derive(Deserialize)]
pub(super) struct ApiAsset {
    pub(super) name: String,
    pub(super) browser_download_url: String,
}

/// A version without its build metadata (`0.21.0+g1a2b3c4` is `0.21.0`):
/// what releases are compared as.
pub(super) fn release_version(v: &semver::Version) -> semver::Version {
    semver::Version {
        build: semver::BuildMetadata::EMPTY,
        ..v.clone()
    }
}

pub(super) fn running_version() -> semver::Version {
    release_version(&semver::Version::parse(crate::VERSION).expect("the version is semver"))
}

/// The role an asset plays, from the file it becomes here.
pub(super) fn role_of(local: &str) -> &'static str {
    if local.starts_with("daedalus-agent-tray") {
        "tray"
    } else {
        "service"
    }
}

/// The candidates GitHub lists, newest first: `agent-v<semver>` tags,
/// neither drafts nor prereleases, newer than `running` and not `refused`.
/// Nothing here is trusted yet; the manifest decides.
pub(super) fn candidates(
    releases: Vec<ApiRelease>,
    running: &semver::Version,
    refused: Option<&semver::Version>,
) -> Vec<(semver::Version, ApiRelease)> {
    let mut out: Vec<(semver::Version, ApiRelease)> = releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let v = semver::Version::parse(r.tag_name.strip_prefix(TAG_PREFIX)?).ok()?;
            (v > *running && refused != Some(&v)).then_some((v, r))
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

/// The product, the tag GitHub listed the manifest under, its version that
/// tag's and newer than `running`, not `refused`.
fn checked_version(
    m: &Manifest,
    r: &ApiRelease,
    running: &semver::Version,
    refused: Option<&semver::Version>,
) -> Result<semver::Version> {
    if m.product != PRODUCT {
        bail!("the manifest is for {:?}, not {PRODUCT}", m.product);
    }
    if m.tag != r.tag_name {
        bail!("the manifest is {}'s, not {}'s", m.tag, r.tag_name);
    }
    let version = semver::Version::parse(&m.version).context("the manifest's version")?;
    if format!("{TAG_PREFIX}{}", m.version) != m.tag || !version.build.is_empty() {
        bail!("version {} is not its tag {}'s", m.version, m.tag);
    }
    if version <= *running {
        bail!("{version} is not newer than this agent ({running})");
    }
    if refused == Some(&version) {
        bail!("this machine rolled back from {version}");
    }
    Ok(version)
}

/// A manifest whose signature held, checked against the release it came
/// in and this machine: the product, the tag GitHub listed it under, its
/// version that tag's and newer than `running`, not `refused` — then this
/// target's assets (required, and the optional ones `installed` has),
/// each with the URL GitHub gives for its name.
pub(super) fn assets_of(
    m: &Manifest,
    r: &ApiRelease,
    running: &semver::Version,
    refused: Option<&semver::Version>,
    installed: impl Fn(&str) -> bool,
) -> Result<(semver::Version, Vec<Asset>)> {
    let version = checked_version(m, r, running, refused)?;
    let url_of = |name: &str| {
        r.assets
            .iter()
            .find(|a| a.name == name)
            .map(|a| a.browser_download_url.clone())
    };
    let pick = |(target, name, local): &(&str, &str, &'static str)| -> Result<Option<Asset>> {
        let Some(entry) = m
            .assets
            .iter()
            .find(|a| a.target == *target && a.role == role_of(local) && a.name == *name)
        else {
            return Ok(None);
        };
        let sha: [u8; 32] = hex::decode(&entry.sha256)
            .ok()
            .and_then(|b| b.try_into().ok())
            .with_context(|| format!("{name}: the manifest's sha256 is not 64 hex characters"))?;
        let url =
            url_of(name).with_context(|| format!("{name} is in the manifest, not the release"))?;
        Ok(Some(Asset {
            local_name: local,
            url,
            sha256: sha,
            size: entry.size,
        }))
    };
    let mut out = Vec::new();
    for a in ASSETS {
        out.push(pick(a)?.with_context(|| format!("no {} for {} in the manifest", a.1, a.0))?);
    }
    for a in OPTIONAL_ASSETS.iter().filter(|a| installed(a.2)) {
        if let Some(asset) = pick(a)? {
            out.push(asset);
        }
    }
    Ok((version, out))
}

/// What a signed manifest offers this machine: its assets for this target
/// ([`assets_of`]); else, when it carries an app bundle for one of
/// `bundle_targets` (`os::BUNDLE_TARGETS`: macOS's, none elsewhere) that
/// GitHub lists too, a re-install of its version; else `assets_of`'s
/// refusal. Any bare binary for this target rules the bundle out. The same checks
/// of product, tag and version hold either way: an old or refused release
/// is nothing, bundle or not.
pub(super) fn offer_of(
    m: &Manifest,
    r: &ApiRelease,
    running: &semver::Version,
    refused: Option<&semver::Version>,
    installed: impl Fn(&str) -> bool,
    bundle_targets: &[&str],
) -> Result<Offered> {
    let refusal = match assets_of(m, r, running, refused, installed) {
        Ok((version, assets)) => return Ok(Offered::Assets(version, assets)),
        Err(e) => e,
    };
    let version = checked_version(m, r, running, refused)?;
    // Any bare binary for this target makes it a release of the old form,
    // whole or broken — `assets_of` has said which — and a bundle beside it
    // changes nothing.
    let bare = m.assets.iter().any(|a| {
        ASSETS
            .iter()
            .any(|(target, _, local)| a.target == *target && a.role == role_of(local))
    });
    let bundled = !bare
        && m.assets.iter().any(|a| {
            a.role == ROLE_BUNDLE
                && bundle_targets.contains(&a.target.as_str())
                && r.assets.iter().any(|l| l.name == a.name)
        });
    if bundled {
        Ok(Offered::Reinstall(version))
    } else {
        Err(refusal)
    }
}

/// Ask the feed. `Ok(None)` is "nothing newer"; an error is the feed not
/// answering, which the caller reports and retries later. The newest
/// release this machine can install is offered; one newer still that it
/// can only be re-installed with ([`Offer::Reinstall`]) is offered when
/// there is nothing to install.
/// `refused` is a version this machine rolled back from
/// (`State::rolled_back`), which is never offered again; a newer one is.
/// A release whose manifest is missing, unsigned or wrong is skipped, and
/// the next older one is looked at.
pub fn check(refused: Option<&str>) -> Result<Option<Offer>> {
    let url = format!(
        "https://api.github.com/repos/{}/releases?per_page=20",
        crate::config::DEFAULT_REPO
    );
    let releases: Vec<ApiRelease> =
        serde_json::from_slice(&fetch_capped(&url, 4 << 20).context("asking GitHub for releases")?)
            .context("reading the release list")?;
    let keys = verifying_keys()?;
    let running = running_version();
    let refused = refused.and_then(|v| semver::Version::parse(v).ok());
    let dir = install_dir().ok();
    let installed = |local: &str| dir.as_ref().is_some_and(|d| d.join(local).exists());
    let mut reinstall = None;
    for (_, r) in candidates(releases, &running, refused.as_ref()) {
        let checked = (|| -> Result<Offered> {
            let url_of = |name: &str| {
                r.assets
                    .iter()
                    .find(|a| a.name == name)
                    .map(|a| a.browser_download_url.clone())
                    .with_context(|| format!("no {name}"))
            };
            let manifest = fetch_capped(&url_of(MANIFEST)?, MAX_MANIFEST)?;
            let sig = fetch_capped(&url_of(MANIFEST_SIG)?, MAX_MANIFEST)?;
            verify_manifest(&manifest, &sig, &keys)?;
            let m: Manifest = serde_json::from_slice(&manifest).context("the manifest")?;
            offer_of(
                &m,
                &r,
                &running,
                refused.as_ref(),
                installed,
                BUNDLE_TARGETS,
            )
        })();
        match checked {
            Ok(Offered::Assets(version, assets)) => {
                return Ok(Some(Offer::Install(Release {
                    tag: r.tag_name.clone(),
                    version,
                    assets,
                })))
            }
            Ok(Offered::Reinstall(version)) => {
                tracing::info!(
                    tag = r.tag_name,
                    "release is a macOS app bundle: this agent is re-installed, not updated"
                );
                reinstall.get_or_insert(Offer::Reinstall {
                    tag: r.tag_name.clone(),
                    version,
                });
            }
            Err(e) => tracing::warn!(
                tag = r.tag_name,
                error = format!("{e:#}"),
                "release skipped"
            ),
        }
    }
    Ok(reinstall)
}

/// A small download, whole, refused past `cap` bytes.
pub(super) fn fetch_capped(url: &str, cap: u64) -> Result<Vec<u8>> {
    let mut req = crate::http::agent()
        .get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(30));
    if url.starts_with("https://api.github.com/") {
        req = req.set("Accept", "application/vnd.github+json");
    }
    let resp = req.call().with_context(|| format!("downloading {url}"))?;
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("reading {url}"))?;
    if bytes.len() as u64 > cap {
        bail!("{url} is larger than {cap} bytes");
    }
    Ok(bytes)
}
