use super::lemonade::{
    parse_backends, parse_downloads, parse_figures, parse_health, parse_models, read_lemonade,
};
use super::*;
use crate::link::wire::Policy;
use crate::link::wire::ProviderPolicy;
use crate::telemetry::App;
use serde_json::json;
use serde_json::Value;

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
    assert!(read_lemonade(&on_port(1), false).is_none());
    assert!(!lemonade_in(&[app("Docker Desktop")]));
}

#[test]
fn installed_but_silent_is_found_not_running() {
    assert!(lemonade_in(&[
        app("Docker Desktop"),
        app("Lemonade Server")
    ]));
    let r = read_lemonade(&on_port(1), true).expect("installed");
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
        parse_downloads(&json!([{"model_name": "a", "percent": 42.5, "status": "downloading"}])),
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
