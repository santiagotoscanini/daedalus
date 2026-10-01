//! What a machine offers the network beyond itself: a model server today.
//!
//! The agent reads its own provider over loopback — presence, the catalog,
//! the health, what it is downloading, which runtimes it has, and what each
//! model has served — and pushes the result up the link as the `providers`
//! document (link/wire.rs `name::PROVIDERS`). The box reads it from the
//! controller (`nodes.providers`) and never dials the provider for it; only
//! the gateway's data plane (LiteLLM's routes) still goes to the machine
//! directly, since a model request has no business passing through the
//! controller.
//!
//! **When.** `run_loop` reads every `READ_EVERY`, every `READ_DOWNLOADING`
//! while a download runs (a percentage a minute old is worthless), and at
//! once when the box's policy for the providers changes (a new port). The
//! link pushes the document when it changes, its clock aside, and every
//! `PUSH_EVERY` (link/node.rs).
//!
//! **Bounds.** Each endpoint's body is read to at most `MAX_BODY` bytes;
//! lists and strings are cut to the bounds below at read time, and the
//! controller refuses a document past them (`check`), so what it keeps in
//! memory and what the app renders is bounded whatever the machine sends.
//!
//! Lemonade is the one kind the agent detects. Ollama is deliberately not
//! one: Lemonade's installer brings it along, so detecting it would list
//! every Lemonade machine twice (app/src/lib/providers/kinds.ts says more).

use crate::util::Shutdown;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::link::wire::{Policy, ProvidersPolicy};
use crate::shared::Shared;
use crate::telemetry::App;

/// One provider as the `providers` document carries it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProviderReport {
    /// "lemonade", the one kind the agent detects.
    pub kind: String,
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
    pub kind: String,
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
        if self.kind != "lemonade" {
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

pub const LEMONADE_DEFAULT_PORT: u16 = 13305;

/// How long one local request may take. A refused port answers at once; a
/// hung server must not hold the reader for long.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(2500);
/// The most of one endpoint's body read.
const MAX_BODY: u64 = 512 * 1024;

const READ_EVERY: Duration = Duration::from_secs(60);
const READ_DOWNLOADING: Duration = Duration::from_secs(10);
/// How often the reader looks at the policy between reads.
const POLICY_POLL: Duration = Duration::from_secs(1);

pub const MAX_PROVIDERS: usize = 4;
pub const MAX_MODELS: usize = 256;
pub const MAX_LABELS: usize = 16;
pub const MAX_LOADED: usize = 32;
pub const MAX_DOWNLOADS: usize = 32;
pub const MAX_BACKENDS: usize = 64;
/// An id, a URL, a sentence.
pub const MAX_TEXT: usize = 256;
/// A label, a status word, a recipe.
pub const MAX_WORD: usize = 64;
/// The residency outcomes a document carries.
pub const MAX_ACTIONS: usize = 8;

/// How long a residency verb may take: a cold 12B model is read off a disk
/// and pushed across PCIe.
const ACTION_TIMEOUT: Duration = Duration::from_secs(120);

/// Text as the document keeps it: control characters out, cut at a char
/// boundary to `max` bytes.
pub fn clip(s: &str, max: usize) -> String {
    let mut out = String::new();
    for c in s.chars().filter(|c| !c.is_control()) {
        if out.len() + c.len_utf8() > max {
            break;
        }
        out.push(c);
    }
    out.trim().to_string()
}

fn s_of(v: &Value, k: &str, max: usize) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(|s| clip(s, max))
        .filter(|s| !s.is_empty())
}

fn f_of(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// `/api/v1/health`: (healthy, version, loaded).
fn parse_health(v: &Value) -> (bool, Option<String>, Vec<LoadedModel>) {
    let healthy = v.get("status").and_then(Value::as_str) == Some("ok");
    let version = s_of(v, "version", MAX_WORD);
    let loaded = v
        .get("all_models_loaded")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|m| m.get("loaded").and_then(Value::as_bool) != Some(false))
                .filter_map(|m| {
                    Some(LoadedModel {
                        id: s_of(m, "model_name", MAX_TEXT)?,
                        device: s_of(m, "device", MAX_WORD),
                        max_context: m.get("max_context_window").and_then(Value::as_u64),
                        pinned: m.get("pinned").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .take(MAX_LOADED)
                .collect()
        })
        .unwrap_or_default();
    (healthy, version, loaded)
}

/// `/api/v1/models`: `{"data":[{id, labels, downloaded, size, recipe}]}`.
fn parse_models(v: &Value) -> Vec<ProviderModel> {
    v.get("data")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    Some(ProviderModel {
                        id: s_of(m, "id", MAX_TEXT)?,
                        labels: m
                            .get("labels")
                            .and_then(Value::as_array)
                            .map(|l| {
                                l.iter()
                                    .filter_map(Value::as_str)
                                    .map(|s| clip(s, MAX_WORD))
                                    .filter(|s| !s.is_empty())
                                    .take(MAX_LABELS)
                                    .collect()
                            })
                            .unwrap_or_default(),
                        downloaded: m
                            .get("downloaded")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        size_gb: f_of(m, "size"),
                        recipe: s_of(m, "recipe", MAX_WORD),
                    })
                })
                .take(MAX_MODELS)
                .collect()
        })
        .unwrap_or_default()
}

/// `/api/v1/downloads`: `[{model_name, percent, status}]`.
fn parse_downloads(v: &Value) -> Vec<ProviderDownload> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|d| ProviderDownload {
                    model: s_of(d, "model_name", MAX_TEXT).unwrap_or_else(|| "?".into()),
                    percent: f_of(d, "percent"),
                    status: s_of(d, "status", MAX_WORD).unwrap_or_else(|| "?".into()),
                })
                .take(MAX_DOWNLOADS)
                .collect()
        })
        .unwrap_or_default()
}

/// `/api/v1/system-info`: the installed backends of every recipe.
fn parse_backends(v: &Value) -> Vec<ProviderBackend> {
    let Some(recipes) = v.get("recipes").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (recipe, r) in recipes {
        let Some(backends) = r.get("backends").and_then(Value::as_object) else {
            continue;
        };
        for (backend, b) in backends {
            if b.get("state").and_then(Value::as_str) != Some("installed") {
                continue;
            }
            out.push(ProviderBackend {
                recipe: clip(recipe, MAX_WORD),
                backend: clip(backend, MAX_WORD),
                version: s_of(b, "version", MAX_WORD),
                url: s_of(b, "release_url", MAX_TEXT),
            });
        }
    }
    out.truncate(MAX_BACKENDS);
    out
}

/// A parsed exposition line: the series name, its labels, its value.
type PromSample<'a> = (&'a str, Vec<(String, String)>, f64);

/// One exposition line, `name{label="value",…} value [timestamp]`, as the
/// name, its labels and the value; None for a comment, a blank or a line
/// that does not parse. The three escapes the format defines inside a
/// label value (`\\`, `\"`, `\n`) are undone.
fn prom_line(line: &str) -> Option<PromSample<'_>> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let name_end = line
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':'))
        .unwrap_or(line.len());
    let name = &line[..name_end];
    if name.is_empty() {
        return None;
    }
    let mut rest = &line[name_end..];
    let mut labels = Vec::new();
    if let Some(inner) = rest.strip_prefix('{') {
        let mut chars = inner.char_indices();
        let mut key = String::new();
        let mut end = None;
        while let Some((i, c)) = chars.next() {
            match c {
                '}' => {
                    end = Some(i);
                    break;
                }
                ',' | ' ' => {}
                '=' => {
                    if chars.next().map(|(_, c)| c) != Some('"') {
                        return None;
                    }
                    let mut val = String::new();
                    loop {
                        match chars.next()?.1 {
                            '\\' => match chars.next()?.1 {
                                'n' => val.push('\n'),
                                c => val.push(c),
                            },
                            '"' => break,
                            c => val.push(c),
                        }
                    }
                    labels.push((std::mem::take(&mut key), val));
                }
                c => key.push(c),
            }
        }
        rest = &inner[end? + 1..];
    }
    let value: f64 = rest.split_whitespace().next()?.parse().ok()?;
    value.is_finite().then_some((name, labels, value))
}

/// `/metrics`: every `lemonade_model_*` series, by the model it names.
fn parse_figures(text: &str) -> Vec<ModelFigures> {
    let mut out: Vec<ModelFigures> = Vec::new();
    for line in text.lines() {
        let Some((name, labels, value)) = prom_line(line) else {
            continue;
        };
        if !name.starts_with("lemonade_model") {
            continue;
        }
        let label = |k: &str| labels.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        let Some(model) = label("model_name").map(|m| clip(m, MAX_TEXT)) else {
            continue;
        };
        let at = match out.iter().position(|f| f.model == model) {
            Some(i) => i,
            None if out.len() < MAX_MODELS => {
                out.push(ModelFigures {
                    model,
                    ..Default::default()
                });
                out.len() - 1
            }
            None => continue,
        };
        let f = &mut out[at];
        if f.device.is_none() {
            f.device = label("device").map(|s| clip(s, MAX_WORD));
        }
        if f.checkpoint.is_none() {
            f.checkpoint = label("checkpoint").map(|s| clip(s, MAX_TEXT));
        }
        match name {
            "lemonade_model_requests_total" => f.requests = Some(value),
            "lemonade_model_input_tokens_total" => f.input_tokens = Some(value),
            "lemonade_model_output_tokens_total" => f.output_tokens = Some(value),
            "lemonade_model_tokens_per_second" => f.tps = Some(value),
            "lemonade_model_time_to_first_token_seconds" => f.ttft_ms = Some(value * 1000.0),
            _ => {}
        }
    }
    out
}

/// A GET on loopback: the body, at most `MAX_BODY` bytes, on a 200; an
/// error in words otherwise.
fn get(port: u16, path: &str) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}{path}");
    let res = ureq::AgentBuilder::new()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .get(&url)
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("{path} answered HTTP {code}"),
            ureq::Error::Transport(_) => format!("did not answer {path}"),
        })?;
    let mut body = String::new();
    res.into_reader()
        .take(MAX_BODY)
        .read_to_string(&mut body)
        .map_err(|_| format!("{path} sent an unreadable body"))?;
    Ok(body)
}

fn get_json(port: u16, path: &str) -> Result<Value, String> {
    serde_json::from_str(&get(port, path)?).map_err(|_| format!("{path} is not JSON"))
}

/// Lemonade Server (lemonade-server.ai): an OpenAI-compatible model server
/// under `/api/v1`. A report when it answers, or is installed and does
/// not; None when there is no sign of it.
fn read_lemonade(policy: &ProvidersPolicy, apps: &[App]) -> Option<ProviderReport> {
    let port = policy
        .lemonade
        .as_ref()
        .and_then(|p| p.port)
        .unwrap_or(LEMONADE_DEFAULT_PORT);
    let mut r = ProviderReport {
        kind: "lemonade".into(),
        port,
        read_at: crate::state::now_rfc3339(),
        ..Default::default()
    };
    let health = match get_json(port, "/api/v1/health") {
        Ok(h) => h,
        Err(e) => {
            // Not answering: worth a report only if it is installed, and
            // the inventory the slow facts read says so.
            let installed = apps
                .iter()
                .any(|a| a.name.to_ascii_lowercase().contains("lemonade"));
            r.error = Some(e);
            return installed.then_some(r);
        }
    };
    r.running = true;
    (r.healthy, r.version, r.loaded) = parse_health(&health);
    let mut errors = Vec::new();
    match get_json(port, "/api/v1/models") {
        Ok(v) => r.models = parse_models(&v),
        Err(e) => errors.push(e),
    }
    // The page's detail: best-effort, and a failure costs its own panel.
    match get_json(port, "/api/v1/downloads") {
        Ok(v) => r.downloads = parse_downloads(&v),
        Err(e) => errors.push(e),
    }
    match get_json(port, "/api/v1/system-info") {
        Ok(v) => r.backends = parse_backends(&v),
        Err(e) => errors.push(e),
    }
    match get(port, "/metrics") {
        Ok(t) => r.figures = parse_figures(&t),
        Err(e) => errors.push(e),
    }
    if !errors.is_empty() {
        r.error = Some(clip(&errors.join("; "), MAX_TEXT));
    }
    Some(r)
}

/// Every provider on this machine, read now.
pub fn read(policy: &Policy, apps: &[App]) -> Vec<ProviderReport> {
    read_lemonade(&policy.providers, apps).into_iter().collect()
}

/// The document without its clocks: what the link compares to push only
/// what moved.
pub fn digest(list: &[ProviderReport]) -> String {
    let mut v = serde_json::to_value(list).unwrap_or(Value::Null);
    if let Some(a) = v.as_array_mut() {
        for p in a.iter_mut().filter_map(Value::as_object_mut) {
            p.remove("read_at");
        }
    }
    v.to_string()
}

/// The bounds the controller holds a pushed document to.
pub fn check(list: &[ProviderReport]) -> Result<(), String> {
    fn text(what: &str, s: &str, max: usize) -> Result<(), String> {
        if s.len() > max || s.chars().any(char::is_control) {
            return Err(format!(
                "{what} is longer than {max} bytes or has control characters"
            ));
        }
        Ok(())
    }
    fn opt(what: &str, s: &Option<String>, max: usize) -> Result<(), String> {
        s.as_deref().map_or(Ok(()), |s| text(what, s, max))
    }
    if list.len() > MAX_PROVIDERS {
        return Err(format!("more than {MAX_PROVIDERS} providers"));
    }
    for p in list {
        text("kind", &p.kind, MAX_WORD)?;
        opt("version", &p.version, MAX_WORD)?;
        // Every read is stamped: an entry without the stamp is not a read, and
        // keeping it would be a provider answering with an empty catalog.
        if p.read_at.is_empty() {
            return Err(format!("{}: not a read (no read_at)", p.kind));
        }
        text("read_at", &p.read_at, MAX_WORD)?;
        opt("error", &p.error, MAX_TEXT)?;
        if p.loaded.len() > MAX_LOADED
            || p.models.len() > MAX_MODELS
            || p.downloads.len() > MAX_DOWNLOADS
            || p.backends.len() > MAX_BACKENDS
            || p.figures.len() > MAX_MODELS
        {
            return Err(format!("{}: a list past its bound", p.kind));
        }
        for m in &p.loaded {
            text("loaded.id", &m.id, MAX_TEXT)?;
            opt("loaded.device", &m.device, MAX_WORD)?;
        }
        for m in &p.models {
            text("models.id", &m.id, MAX_TEXT)?;
            opt("models.recipe", &m.recipe, MAX_WORD)?;
            if m.labels.len() > MAX_LABELS {
                return Err(format!("{}: more than {MAX_LABELS} labels", m.id));
            }
            for l in &m.labels {
                text("a label", l, MAX_WORD)?;
            }
        }
        for d in &p.downloads {
            text("downloads.model", &d.model, MAX_TEXT)?;
            text("downloads.status", &d.status, MAX_WORD)?;
        }
        for b in &p.backends {
            text("backends.recipe", &b.recipe, MAX_WORD)?;
            text("backends.backend", &b.backend, MAX_WORD)?;
            opt("backends.version", &b.version, MAX_WORD)?;
            opt("backends.url", &b.url, MAX_TEXT)?;
        }
        for f in &p.figures {
            text("figures.model", &f.model, MAX_TEXT)?;
            opt("figures.device", &f.device, MAX_WORD)?;
            opt("figures.checkpoint", &f.checkpoint, MAX_TEXT)?;
        }
        if p.actions.len() > MAX_ACTIONS {
            return Err(format!("{}: more than {MAX_ACTIONS} actions", p.kind));
        }
        for a in &p.actions {
            text("actions.request", &a.request, MAX_WORD)?;
            text("actions.model", &a.model, MAX_TEXT)?;
            text("actions.message", &a.message, MAX_TEXT)?;
            text("actions.at", &a.at, MAX_WORD)?;
        }
    }
    Ok(())
}

/// The reader's thread: a read now, then on the cadence above — and at
/// once after a residency verb (`Shared::request_providers_read`) — each
/// published to `shared` with the verbs' outcomes, for the link to push.
pub fn run_loop(shared: Arc<Shared>, stop: Shutdown) {
    let mut last_policy: Option<ProvidersPolicy> = None;
    let mut read_at: Option<Instant> = None;
    let mut every = READ_EVERY;
    loop {
        let policy = shared.policy();
        let asked = shared.take_providers_read();
        let due = asked
            || read_at.is_none_or(|at| at.elapsed() >= every)
            || last_policy.as_ref() != Some(&policy.providers);
        if due {
            let apps = shared.telemetry().map(|t| t.apps).unwrap_or_default();
            let mut list = read(&policy, &apps);
            let actions = shared.provider_actions();
            for p in &mut list {
                p.actions = actions.clone();
            }
            every = if list.iter().any(|p| !p.downloads.is_empty()) {
                READ_DOWNLOADING
            } else {
                READ_EVERY
            };
            shared.set_providers(list);
            last_policy = Some(policy.providers);
            read_at = Some(Instant::now());
        }
        if stop.wait(POLICY_POLL) {
            return;
        }
    }
}

/// POST a residency call on loopback: the provider's word on a 200 whose
/// body does not say `status: error`, the failure in words otherwise.
fn post(port: u16, path: &str, body: &Value) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}{path}");
    let res = ureq::AgentBuilder::new()
        .timeout(ACTION_TIMEOUT)
        .build()
        .post(&url)
        .send_json(body.clone())
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("the provider answered HTTP {code}"),
            ureq::Error::Transport(_) => format!("the provider did not answer {path}"),
        })?;
    let mut text = String::new();
    res.into_reader()
        .take(MAX_BODY)
        .read_to_string(&mut text)
        .map_err(|_| "the provider sent an unreadable answer".to_string())?;
    let said: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let message = s_of(&said, "message", MAX_TEXT).unwrap_or_else(|| "done".into());
    // A refused load is a 200 whose body says so.
    if said.get("status").and_then(Value::as_str) == Some("error") {
        Err(message)
    } else {
        Ok(message)
    }
}

/// Run one residency verb against the provider on `port`. A load that
/// replaces a model puts that one down FIRST: the provider keeps a per-kind
/// pool one model deep and never evicts a pinned one, so a plain load into
/// a pinned slot fails with 409 — freeing it is what the operator asked for.
pub fn residency(port: u16, p: &ProviderModelParams) -> Result<String, String> {
    match p.action {
        ModelAction::Unload => post(
            port,
            "/api/v1/unload",
            &serde_json::json!({ "model_name": p.model }),
        ),
        ModelAction::Load => {
            if let Some(r) = &p.replacing {
                post(
                    port,
                    "/api/v1/unload",
                    &serde_json::json!({ "model_name": r }),
                )
                .map_err(|e| format!("could not put {r} down: {e}"))?;
            }
            post(
                port,
                "/api/v1/load",
                &serde_json::json!({ "model_name": p.model, "pinned": p.pinned }),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::wire::ProviderPolicy;
    use serde_json::json;

    fn app(name: &str) -> App {
        App {
            name: name.into(),
            kind: "app".into(),
            ..Default::default()
        }
    }

    fn on_port(port: u16) -> ProvidersPolicy {
        ProvidersPolicy {
            lemonade: Some(ProviderPolicy { port: Some(port) }),
        }
    }

    #[test]
    fn nothing_installed_and_nothing_answering_is_no_report() {
        // A port nothing listens on: the probe refuses at once.
        assert!(read_lemonade(&on_port(1), &[]).is_none());
    }

    #[test]
    fn installed_but_silent_is_found_not_running() {
        let r = read_lemonade(&on_port(1), &[app("Lemonade Server")]).expect("installed");
        assert_eq!(r.kind, "lemonade");
        assert_eq!(r.port, 1);
        assert!(!r.running && !r.healthy);
        assert!(r.models.is_empty());
        assert_eq!(r.error.as_deref(), Some("did not answer /api/v1/health"));
    }

    #[test]
    fn the_policy_port_is_optional_and_defaults() {
        let parsed: Policy =
            serde_json::from_str(r#"{"awake_hold":true,"providers":{"lemonade":{"port":8000}}}"#)
                .unwrap();
        assert_eq!(parsed.providers.lemonade.unwrap().port, Some(8000));
        let without: Policy = serde_json::from_str(r#"{"awake_hold":false}"#).unwrap();
        assert!(without.providers.lemonade.is_none());
    }

    #[test]
    fn health_reads_status_version_and_what_is_loaded() {
        let (ok, version, loaded) = parse_health(&json!({
            "status": "ok", "version": "9.1.2",
            "all_models_loaded": [
                {"model_name": "Gemma-4", "device": "gpu", "max_context_window": 65536, "pinned": true},
                {"model_name": "gone", "loaded": false},
                {"device": "cpu"}
            ]
        }));
        assert!(ok);
        assert_eq!(version.as_deref(), Some("9.1.2"));
        assert_eq!(
            loaded,
            vec![LoadedModel {
                id: "Gemma-4".into(),
                device: Some("gpu".into()),
                max_context: Some(65536),
                pinned: true
            }]
        );
        assert!(!parse_health(&json!({"status": "degraded"})).0);
    }

    #[test]
    fn the_catalog_keeps_the_providers_words_and_its_bounds() {
        let many: Vec<Value> = (0..300).map(|i| json!({"id": format!("m{i}")})).collect();
        assert_eq!(parse_models(&json!({ "data": many })).len(), MAX_MODELS);
        let m = parse_models(&json!({"data": [
            {"id": "Qwen3-Embed", "labels": ["embeddings", "x\u{7}y"], "downloaded": true, "size": 1.5, "recipe": "llamacpp"},
            {"labels": ["no id"]}
        ]}));
        assert_eq!(
            m,
            vec![ProviderModel {
                id: "Qwen3-Embed".into(),
                labels: vec!["embeddings".into(), "xy".into()],
                downloaded: true,
                size_gb: Some(1.5),
                recipe: Some("llamacpp".into()),
            }]
        );
    }

    #[test]
    fn downloads_and_backends() {
        assert_eq!(
            parse_downloads(
                &json!([{"model_name": "a", "percent": 42.5, "status": "downloading"}])
            ),
            vec![ProviderDownload {
                model: "a".into(),
                percent: Some(42.5),
                status: "downloading".into()
            }]
        );
        let b = parse_backends(&json!({"recipes": {
            "llamacpp": {"backends": {
                "vulkan": {"state": "installed", "version": "b6000", "release_url": "https://x/b6000"},
                "rocm": {"state": "available"}
            }}
        }}));
        assert_eq!(
            b,
            vec![ProviderBackend {
                recipe: "llamacpp".into(),
                backend: "vulkan".into(),
                version: Some("b6000".into()),
                url: Some("https://x/b6000".into())
            }]
        );
    }

    #[test]
    fn figures_from_the_exposition() {
        let text = "# HELP x\n\
            lemonade_model_requests_total{model_name=\"Gemma-4\",device=\"gpu\",checkpoint=\"u/g:Q4\"} 12\n\
            lemonade_model_tokens_per_second{model_name=\"Gemma-4\"} 41.5 1700000000\n\
            lemonade_model_time_to_first_token_seconds{model_name=\"Gemma-4\"} 0.25\n\
            lemonade_model_input_tokens_total{model_name=\"a\\\"b\"} 3\n\
            process_cpu_seconds_total 9\n\
            lemonade_model_output_tokens_total{device=\"cpu\"} 5\n";
        let f = parse_figures(text);
        assert_eq!(f.len(), 2);
        assert_eq!(
            f[0],
            ModelFigures {
                model: "Gemma-4".into(),
                requests: Some(12.0),
                tps: Some(41.5),
                ttft_ms: Some(250.0),
                device: Some("gpu".into()),
                checkpoint: Some("u/g:Q4".into()),
                ..Default::default()
            }
        );
        assert_eq!(f[1].model, "a\"b");
        assert_eq!(f[1].input_tokens, Some(3.0));
    }

    #[test]
    fn the_digest_ignores_the_clock() {
        let a = vec![ProviderReport {
            kind: "lemonade".into(),
            read_at: "2026-09-28T10:00:00Z".into(),
            ..Default::default()
        }];
        let mut b = a.clone();
        b[0].read_at = "2026-09-28T10:01:00Z".into();
        assert_eq!(digest(&a), digest(&b));
        b[0].running = true;
        assert_ne!(digest(&a), digest(&b));
    }

    #[test]
    fn check_holds_the_bounds() {
        let ok = vec![ProviderReport {
            kind: "lemonade".into(),
            read_at: "2026-09-28T10:00:00Z".into(),
            models: vec![ProviderModel {
                id: "m".into(),
                ..Default::default()
            }],
            ..Default::default()
        }];
        assert!(check(&ok).is_ok());
        let mut long = ok.clone();
        long[0].models[0].id = "x".repeat(MAX_TEXT + 1);
        assert!(check(&long).is_err());
        let mut ctl = ok.clone();
        ctl[0].error = Some("a\nb".into());
        assert!(check(&ctl).is_err());
        assert!(check(&vec![ok[0].clone(); MAX_PROVIDERS + 1]).is_err());
        // An entry without its stamp is not a read: the controller keeps none.
        let mut unstamped = ok.clone();
        unstamped[0].read_at = String::new();
        assert!(check(&unstamped).is_err());
    }
}
