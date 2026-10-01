//! Lemonade Server, read and driven over loopback: its health, catalog,
//! downloads, backends and per-model figures, and the two residency
//! verbs.

use std::io::Read;
use std::time::Duration;

use serde_json::Value;

use super::*;
use crate::link::wire::{Policy, ProvidersPolicy};
use crate::telemetry::App;

pub const LEMONADE_DEFAULT_PORT: u16 = 13305;

/// How long one local request may take. A refused port answers at once; a
/// hung server must not hold the reader for long.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(2500);
/// The most of one endpoint's body read.
const MAX_BODY: u64 = 512 * 1024;

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
pub(super) fn parse_health(v: &Value) -> (bool, Option<String>, Vec<LoadedModel>) {
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
pub(super) fn parse_models(v: &Value) -> Vec<ProviderModel> {
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
pub(super) fn parse_downloads(v: &Value) -> Vec<ProviderDownload> {
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
pub(super) fn parse_backends(v: &Value) -> Vec<ProviderBackend> {
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
pub(super) fn parse_figures(text: &str) -> Vec<ModelFigures> {
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
/// not (`installed`, `lemonade_in` the inventory); None when there is no
/// sign of it.
pub(super) fn read_lemonade(policy: &ProvidersPolicy, installed: bool) -> Option<ProviderReport> {
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
            // Not answering: worth a report only if it is installed.
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

/// Whether the application inventory the slow facts read lists Lemonade:
/// kept with each sample (`Shared::lemonade_installed`), so the reader asks
/// a flag rather than copying the telemetry.
pub fn lemonade_in(apps: &[App]) -> bool {
    apps.iter()
        .any(|a| a.name.to_ascii_lowercase().contains("lemonade"))
}

/// Every provider on this machine, read now; `lemonade` says whether the
/// inventory lists Lemonade.
pub fn read(policy: &Policy, lemonade: bool) -> Vec<ProviderReport> {
    read_lemonade(&policy.providers, lemonade)
        .into_iter()
        .collect()
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
