//! The `providers` document's types: one provider, its models, what it
//! has loaded and downloads, its install and power state, and the verbs'
//! requests and outcomes.

use serde::{Deserialize, Serialize};

use super::MAX_TEXT;

/// A model server the agent finds and drives: lemonade, for now. `unknown`:
/// a newer machine's kind, read on the controller.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    #[default]
    Lemonade,
    #[serde(other)]
    Unknown,
}

impl std::fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        crate::util::wire_name(self, f)
    }
}

/// One provider as the `providers` document carries it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderReport {
    pub kind: ProviderKind,
    /// The port it answers on, or would.
    pub port: u16,
    /// What its health endpoint says it is; None when it is not answering.
    pub version: Option<String>,
    /// The health endpoint answered. False with a report present means
    /// "installed, not running", which the page names.
    pub running: bool,
    /// Its health document said `ok`. False while running means the server
    /// answers but reports itself unhealthy (a backend that died).
    pub healthy: bool,
    /// What is resident right now.
    pub loaded: Vec<LoadedModel>,
    /// Its catalog, as it lists it; None when it could not be read — an
    /// unknown catalog, never an empty one (the gateway keeps its routes).
    pub models: Option<Vec<ProviderModel>>,
    /// What it is fetching; empty at rest.
    pub downloads: Vec<ProviderDownload>,
    /// The inference runtimes installed, with the build serving each.
    pub backends: Vec<ProviderBackend>,
    /// What each model has served since the provider started, from its
    /// `/metrics`; a model it has not served is absent.
    pub figures: Vec<ModelFigures>,
    /// When the agent read it, RFC 3339 UTC.
    pub read_at: String,
    /// What went wrong reading it, in a sentence; None when every read
    /// answered.
    pub error: Option<String>,
    /// The last verbs the box asked for here (`provider_model`,
    /// `provider_install`, `provider_power`) and how each went, newest
    /// last, at most `MAX_ACTIONS`.
    pub actions: Vec<ProviderAction>,
    /// The install the agent found, read off the install itself (the
    /// registry, the package, the pkg receipt); None when there is none —
    /// a server answering without one is an install the agent cannot
    /// manage.
    pub install: Option<ProviderInstall>,
    /// The server's process, when one runs.
    pub pid: Option<u32>,
    /// Windows: the session it runs in, and the account that runs it.
    pub session: Option<u32>,
    pub owner: Option<String>,
    /// Windows: nobody is logged on, so the server cannot run — it lives in
    /// the user's tray. Always false elsewhere.
    pub no_user_session: bool,
    /// Whether it starts on its own: at logon (Windows) or at boot.
    pub startup: Option<ProviderStartup>,
    /// What the box wants of it: the operator's last power verb while the
    /// policy has not moved since, else the policy's `wanted`.
    pub wanted: Option<PowerWanted>,
    /// It stopped while wanted, and not by the box (the tray's Quit): left
    /// off until the next logon or the operator's start.
    pub manual_off: bool,
    /// The last install or update, as its journal holds it — under way, or
    /// how it ended, with the installer's log tail.
    pub lifecycle: Option<ProviderLifecycle>,
}

/// How the provider was installed.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderInstallMethod {
    /// Windows: the MSI.
    #[default]
    Msi,
    /// macOS: the `.pkg`.
    Pkg,
    /// Linux: the `.deb` or the `.rpm`.
    Deb,
    Rpm,
}

/// Whose install it is: one user's profile, or the machine's.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderInstallScope {
    #[default]
    User,
    Machine,
}

/// The install itself.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderInstall {
    pub method: ProviderInstallMethod,
    pub scope: ProviderInstallScope,
    /// Where it is installed.
    pub location: Option<String>,
    /// The installer's own version — the MSI's ProductVersion, the
    /// package's — which is not the server's (`version`, from its health).
    pub installer_version: Option<String>,
    /// Windows, a per-user install: the account whose profile holds it.
    pub user: Option<String>,
}

/// Whether the provider starts on its own.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderStartup {
    Enabled,
    Disabled,
    /// Windows: no Startup-folder shortcut to approve.
    Missing,
}

/// Whether the provider should run.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PowerWanted {
    Start,
    Stop,
}

impl std::fmt::Display for PowerWanted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        crate::util::wire_name(self, f)
    }
}

/// Where an install stands. The last three are how it ended.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecyclePhase {
    #[default]
    Downloading,
    Stopping,
    Installing,
    Verifying,
    Wiring,
    Powering,
    RollingBack,
    Done,
    Failed,
    RolledBack,
}

impl LifecyclePhase {
    pub fn ended(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::RolledBack)
    }
}

/// The last install, as the report carries it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderLifecycle {
    pub request: String,
    /// The release asked for, and the one running before.
    pub version: String,
    pub from_version: Option<String>,
    pub phase: LifecyclePhase,
    /// What happened last, in a sentence.
    pub message: String,
    /// Catalog ids offered before the install and gone after it: the
    /// aliases derived from them have nothing behind them now.
    pub vanished: Vec<String>,
    /// The end of the installer's log, at most `MAX_LOG_LINES` lines.
    pub log_tail: Vec<String>,
    pub started_at: String,
    pub at: String,
}

/// A residency verb: put a model into the accelerator, or take it out.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelAction {
    Load,
    Unload,
}

/// `provider_model`'s parameters, as the controller sends them: one verb
/// on one model of one provider on this machine, under the request id the
/// controller minted. Exact: never an address, a path or a flag — the
/// provider is found by its kind and the policy's port.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderModelParams {
    pub kind: ProviderKind,
    pub action: ModelAction,
    pub model: String,
    /// Load only: keep it through the provider's eviction.
    #[serde(default)]
    pub pinned: bool,
    /// Load only: the model to put down first, freeing its slot.
    #[serde(default)]
    pub replacing: Option<String>,
    pub request: String,
}

impl ProviderModelParams {
    pub fn check(&self) -> Result<(), String> {
        check_kind(self.kind)?;
        let name = |what: &str, s: &str| {
            if s.trim().is_empty() || s.len() > MAX_TEXT || s.chars().any(char::is_control) {
                Err(format!("{what} is not a model name"))
            } else {
                Ok(())
            }
        };
        name("model", &self.model)?;
        if let Some(r) = &self.replacing {
            if self.action == ModelAction::Unload {
                return Err("an unload replaces nothing".into());
            }
            name("replacing", r)?;
        }
        check_request(&self.request)
    }
}

fn check_request(request: &str) -> Result<(), String> {
    if request.len() != 16 || !request.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("the request id is sixteen hex characters".into());
    }
    Ok(())
}

fn check_kind(kind: ProviderKind) -> Result<(), String> {
    if kind != ProviderKind::Lemonade {
        return Err(format!("{kind} is not a provider kind this agent drives"));
    }
    Ok(())
}

/// The one place a provider's installer may come from: Lemonade's own
/// GitHub releases. The box resolves the asset; the agent downloads only
/// from here, and keeps it only at the size and SHA-256 the box named.
pub const LEMONADE_RELEASES: &str = "https://github.com/lemonade-sdk/lemonade/releases/download/";
/// The largest installer the agent downloads.
pub const MAX_INSTALLER: u64 = 2 << 30;

/// A release's version as both sides spell it: a tag (`v2026.40.0`) or
/// what the server's health says (`2026.40.0`), compared without the `v`.
pub fn same_version(a: &str, b: &str) -> bool {
    let bare = |s: &str| s.trim().trim_start_matches(['v', 'V']).to_string();
    !a.trim().is_empty() && bare(a) == bare(b)
}

/// `provider_install`'s parameters: install or update a provider to one
/// release, downloaded from `url` and kept only at `size` bytes of
/// `sha256` — the box resolved them from the release, the agent checks
/// where they point (`check`) and what arrived (`store_verified`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderInstallParams {
    pub request: String,
    pub kind: ProviderKind,
    /// The release's tag, `v2026.40.0`.
    pub version: String,
    pub url: String,
    pub size: u64,
    /// 64 hex characters.
    pub sha256: String,
}

impl ProviderInstallParams {
    pub fn check(&self) -> Result<(), String> {
        check_kind(self.kind)?;
        check_request(&self.request)?;
        let v = &self.version;
        if v.is_empty()
            || v.len() > 64
            || !v
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
        {
            return Err("the version is not a release tag".into());
        }
        // releases/download/<tag>/<file>: this release, one plain file.
        let rest = self
            .url
            .strip_prefix(LEMONADE_RELEASES)
            .ok_or_else(|| format!("an installer comes from {LEMONADE_RELEASES} alone"))?;
        let (tag, file) = rest
            .split_once('/')
            .ok_or("the URL names no release asset")?;
        if tag != v {
            return Err(format!("the URL is release {tag}'s, not {v}'s"));
        }
        if self.url.len() > MAX_TEXT
            || file.is_empty()
            || file.starts_with('.')
            || !file
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'+'))
        {
            return Err("the URL's file name is not a plain asset name".into());
        }
        if self.size == 0 || self.size > MAX_INSTALLER {
            return Err(format!("{} bytes is no installer", self.size));
        }
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("sha256 is not 64 hex characters".into());
        }
        Ok(())
    }

    /// The asset's file name, the URL's last segment (`check` held it plain).
    pub fn file_name(&self) -> &str {
        self.url.rsplit('/').next().unwrap_or_default()
    }

    /// The SHA-256 as bytes.
    pub fn digest(&self) -> Option<[u8; 32]> {
        hex::decode(&self.sha256).ok()?.try_into().ok()
    }
}

/// `provider_power`'s parameters: run the provider, or not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderPowerParams {
    pub request: String,
    pub kind: ProviderKind,
    pub wanted: PowerWanted,
}

impl ProviderPowerParams {
    pub fn check(&self) -> Result<(), String> {
        check_kind(self.kind)?;
        check_request(&self.request)
    }
}

/// Which verb an action was.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderVerb {
    /// `provider_model`.
    #[default]
    Model,
    /// `provider_install`.
    Install,
    /// `provider_power`.
    Power,
}

/// How one verb went, under the controller's request id.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderAction {
    pub request: String,
    pub verb: ProviderVerb,
    /// What it acted on: the model, the release installed, or the power
    /// state asked for (`start`, `stop`).
    pub model: String,
    pub ok: bool,
    /// The provider's word on it, or why it failed.
    pub message: String,
    pub at: String,
}

/// A model resident at the provider.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct LoadedModel {
    pub id: String,
    pub device: Option<String>,
    pub max_context: Option<u64>,
    pub pinned: bool,
}

/// One catalog entry: the provider's own words. The app derives the
/// gateway's mode and flags from the labels (lib/providers/kinds.ts).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderModel {
    pub id: String,
    pub labels: Vec<String>,
    /// On disk at the provider; an entry that is not is not offerable.
    pub downloaded: bool,
    pub size_gb: Option<f64>,
    pub recipe: Option<String>,
}

/// A download in progress.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderDownload {
    pub model: String,
    pub percent: Option<f64>,
    pub status: String,
}

/// An installed inference runtime.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderBackend {
    pub recipe: String,
    pub backend: String,
    pub version: Option<String>,
    pub url: Option<String>,
}

/// What one model has done at its provider. `tps` and `ttft_ms` are the
/// LAST generation's, as the provider reports them.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ModelFigures {
    pub model: String,
    pub requests: Option<f64>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub tps: Option<f64>,
    pub ttft_ms: Option<f64>,
    pub device: Option<String>,
    pub checkpoint: Option<String>,
}
