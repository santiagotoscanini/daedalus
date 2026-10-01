//! The `providers` document's types: one provider, its models, what it
//! has loaded and downloads, and the residency verbs' requests and
//! outcomes.

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
    /// Its catalog, as it lists it.
    pub models: Vec<ProviderModel>,
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
    /// The last residency verbs the box asked for here (`provider_model`)
    /// and how each went, newest last, at most `MAX_ACTIONS`.
    pub actions: Vec<ProviderAction>,
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
        if self.kind != ProviderKind::Lemonade {
            return Err(format!(
                "{} is not a provider kind this agent drives",
                self.kind
            ));
        }
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
        if self.request.len() != 16 || !self.request.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("the request id is sixteen hex characters".into());
        }
        Ok(())
    }
}

/// How one residency verb went, under the controller's request id.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderAction {
    pub request: String,
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
