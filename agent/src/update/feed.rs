//! The release feed: GitHub's releases of the engine repository, the
//! newest `agent-v*` one this target can install.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

use super::*;

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

pub(super) fn running_version() -> semver::Version {
    semver::Version::parse(crate::VERSION).expect("Cargo.toml version is semver")
}

/// One asset and its signature in a release, when both are there.
pub(super) fn asset_of(r: &ApiRelease, remote: &str, local: &'static str) -> Option<Asset> {
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
pub(super) fn assets_of(r: &ApiRelease, installed: impl Fn(&str) -> bool) -> Option<Vec<Asset>> {
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
pub(super) fn pick(
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

pub(super) fn fetch(url: &str) -> Result<Vec<u8>> {
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
