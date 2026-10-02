use super::host::{
    dpkg_owner, launchctl_disabled, log_text, msi_exit, msiexec_args, pkgutil_info, show_value,
    startup_approved, startup_value, tail_lines, Msi, MsiExit,
};
use super::install::{refusal, resume_phase, vanished, Journal};
use super::lemonade::{
    parse_backends, parse_downloads, parse_figures, parse_health, parse_models, read_lemonade,
    unwired, wiring, MAX_ORIGINS,
};
use super::power::{effective, Converge, Input, ManualOff, Operator, Step};
use super::*;
use crate::link::wire::Policy;
use crate::link::wire::{ProviderPin, ProviderPolicy};
use serde_json::json;
use serde_json::Value;
use std::path::Path;
use std::time::{Duration, Instant};

fn on_port(port: u16) -> ProvidersPolicy {
    ProvidersPolicy {
        lemonade: Some(ProviderPolicy {
            port: Some(port),
            ..Default::default()
        }),
    }
}

fn installed() -> Found {
    Found {
        install: Some(ProviderInstall {
            location: Some(r"C:\Users\op\AppData\Local\lemonade_server".into()),
            installer_version: Some("26.40.0".into()),
            ..Default::default()
        }),
        console: Some(Console::default()),
        ..Default::default()
    }
}

#[test]
fn nothing_installed_and_nothing_answering_is_no_report() {
    // A port nothing listens on: the probe refuses at once.
    assert!(read_lemonade(&on_port(1), &Found::default()).is_none());
}

#[test]
fn installed_but_silent_is_found_not_running_with_an_unknown_catalog() {
    let r = read_lemonade(&on_port(1), &installed()).expect("installed");
    assert_eq!(r.kind, ProviderKind::Lemonade);
    assert_eq!(r.port, 1);
    assert!(!r.running && !r.healthy);
    assert_eq!(r.models, None);
    assert_eq!(r.install, installed().install);
    assert!(!r.no_user_session);
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
fn the_policy_carries_the_pin_power_and_startup() {
    let p: Policy = serde_json::from_value(json!({"providers":{"lemonade":{
        "port": 13305, "wanted": "stop", "always_on": true,
        "pin": {"version": "v2026.40.0", "url": "u", "size": 3, "sha256": "ab"}
    }}}))
    .unwrap();
    let l = p.providers.lemonade.unwrap();
    assert_eq!(l.wanted, Some(PowerWanted::Stop));
    assert_eq!(l.always_on, Some(true));
    assert_eq!(l.pin.unwrap().version, "v2026.40.0");
    // Unset, none of them is written.
    let bare = serde_json::to_value(ProviderPolicy {
        port: Some(1),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(bare, json!({"port": 1}));
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
        kind: ProviderKind::Lemonade,
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
        kind: ProviderKind::Lemonade,
        read_at: "2026-09-28T10:00:00Z".into(),
        models: Some(vec![ProviderModel {
            id: "m".into(),
            ..Default::default()
        }]),
        ..Default::default()
    }];
    assert!(check(&ok).is_ok());
    let mut long = ok.clone();
    long[0].models.as_mut().unwrap()[0].id = "x".repeat(MAX_TEXT + 1);
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

const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn install_params() -> ProviderInstallParams {
    ProviderInstallParams {
        request: "00112233445566ff".into(),
        kind: ProviderKind::Lemonade,
        version: "v2026.40.0".into(),
        url: format!(
            "{LEMONADE_RELEASES}v2026.40.0/lemonade-server.{}",
            crate::os::lemonade::INSTALLERS[0]
        ),
        size: 50_000_000,
        sha256: SHA.into(),
    }
}

#[test]
fn an_install_comes_from_lemonades_releases_alone() {
    let ok = install_params();
    assert!(ok.check().is_ok());
    assert!(ok.file_name().starts_with("lemonade-server."));
    assert!(ok.digest().is_some());
    let bad = |f: &dyn Fn(&mut ProviderInstallParams)| {
        let mut p = install_params();
        f(&mut p);
        p.check()
    };
    for (why, f) in [
        (
            "another host",
            &(|p: &mut ProviderInstallParams| {
                p.url =
                    "https://example.com/lemonade-sdk/lemonade/releases/download/v2026.40.0/x.msi"
                        .into()
            }) as &dyn Fn(&mut ProviderInstallParams),
        ),
        ("http", &|p| p.url = p.url.replace("https://", "http://")),
        ("another repository", &|p| {
            p.url = "https://github.com/evil/lemonade/releases/download/v2026.40.0/x.msi".into()
        }),
        ("another release's asset", &|p| {
            p.url = format!("{LEMONADE_RELEASES}v2026.39.0/x.msi")
        }),
        ("a path past the asset", &|p| {
            p.url = format!("{LEMONADE_RELEASES}v2026.40.0/../x.msi")
        }),
        ("a query", &|p| p.url.push_str("?x=1")),
        ("no asset", &|p| {
            p.url = format!("{LEMONADE_RELEASES}v2026.40.0/")
        }),
        ("a hidden file", &|p| {
            p.url = format!("{LEMONADE_RELEASES}v2026.40.0/.msi")
        }),
        ("a version with a slash", &|p| p.version = "v1/2".into()),
        ("no bytes", &|p| p.size = 0),
        ("too many bytes", &|p| p.size = MAX_INSTALLER + 1),
        ("a short digest", &|p| p.sha256 = "ab".into()),
        ("a bad request id", &|p| p.request = "x".into()),
        ("another kind", &|p| p.kind = ProviderKind::Unknown),
    ] {
        assert!(bad(f).is_err(), "{why}");
    }
    // Exact: nothing else rides it.
    let mut v = serde_json::to_value(install_params()).unwrap();
    v["args"] = json!(["/qn"]);
    assert!(serde_json::from_value::<ProviderInstallParams>(v).is_err());
}

#[test]
fn a_power_verb_is_start_or_stop() {
    let p: ProviderPowerParams = serde_json::from_value(
        json!({"request":"00112233445566ff","kind":"lemonade","wanted":"stop"}),
    )
    .unwrap();
    assert!(p.check().is_ok());
    assert_eq!(p.wanted, PowerWanted::Stop);
    for bad in [
        json!({"request":"00112233445566ff","kind":"lemonade","wanted":"restart"}),
        json!({"request":"00112233445566ff","kind":"lemonade","wanted":"start","exe":"x"}),
    ] {
        assert!(
            serde_json::from_value::<ProviderPowerParams>(bad.clone()).is_err(),
            "{bad}"
        );
    }
    let short: ProviderPowerParams =
        serde_json::from_value(json!({"request":"1","kind":"lemonade","wanted":"start"})).unwrap();
    assert!(short.check().is_err());
}

#[test]
fn versions_compare_without_the_tag_v() {
    assert!(same_version("v2026.40.0", "2026.40.0"));
    assert!(same_version("2026.40.0", "v2026.40.0"));
    assert!(!same_version("v2026.40.0", "26.40.0"));
    assert!(!same_version("v2026.40.0", "2026.40.1"));
    assert!(!same_version("", ""));
}

#[test]
fn an_install_is_refused_where_it_may_not_run() {
    let p = install_params();
    let mut found = installed();
    assert_eq!(refusal(&p, &found, true, None), None);
    let pin = ProviderPin {
        version: p.version.clone(),
        url: p.url.clone(),
        size: p.size,
        sha256: p.sha256.clone(),
    };
    assert_eq!(refusal(&p, &found, true, Some(&pin)), None);
    let other = ProviderPin {
        version: "v2026.39.0".into(),
        ..pin
    };
    assert!(refusal(&p, &found, true, Some(&other))
        .unwrap()
        .contains("pins"));
    found.foreign = Some(r"PC\other".into());
    assert!(refusal(&p, &found, true, None).unwrap().contains("other"));
    found.foreign = None;
    found.console = None;
    assert!(refusal(&p, &found, true, None)
        .unwrap()
        .contains("no user session"));
    let mut unmanaged = installed();
    unmanaged.install = None;
    assert!(refusal(&p, &unmanaged, true, None)
        .unwrap()
        .contains("by hand"));
    assert_eq!(
        refusal(&p, &unmanaged, false, None),
        None,
        "a fresh install"
    );
}

#[test]
fn a_journal_resumes_where_it_can() {
    let mut j = Journal::new(&install_params(), "t");
    assert!(j.file().starts_with("lemonade-server."));
    for (at, to) in [
        (LifecyclePhase::Downloading, LifecyclePhase::Downloading),
        (LifecyclePhase::Stopping, LifecyclePhase::Downloading),
        (LifecyclePhase::Installing, LifecyclePhase::Verifying),
        (LifecyclePhase::Verifying, LifecyclePhase::Verifying),
        (LifecyclePhase::Wiring, LifecyclePhase::Wiring),
        (LifecyclePhase::Powering, LifecyclePhase::Powering),
        (LifecyclePhase::RollingBack, LifecyclePhase::RollingBack),
    ] {
        j.phase = at;
        assert_eq!(resume_phase(&j), to, "{at:?}");
    }
    j.rollbacks = 2;
    assert_eq!(resume_phase(&j), LifecyclePhase::Failed);
    // On disk and back, whole.
    let back: Journal = serde_json::from_slice(&serde_json::to_vec(&j).unwrap()).unwrap();
    assert_eq!(back, j);
    let l = j.lifecycle();
    assert_eq!(
        (l.request.as_str(), l.version.as_str()),
        ("00112233445566ff", "v2026.40.0")
    );
    assert!(LifecyclePhase::RolledBack.ended() && !LifecyclePhase::Wiring.ended());
}

#[test]
fn vanished_ids_are_the_ones_offered_before_and_gone_after() {
    let ids = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert_eq!(
        vanished(&ids(&["a", "b", "c"]), &ids(&["c", "a", "d"])),
        ids(&["b"])
    );
    assert!(vanished(&ids(&[]), &ids(&["a"])).is_empty());
}

fn input(wanted: Option<PowerWanted>, running: bool, now: Instant) -> Input {
    Input {
        wanted,
        generation: 0,
        running,
        session: Some(1),
        installed: true,
        busy: false,
        always_on: None,
        startup: None,
        boot: 1_000_000,
        now,
    }
}

#[test]
fn a_wanted_server_is_started_and_a_users_quit_is_left_alone() {
    let t = Instant::now();
    let mut c = Converge::default();
    // Found stopped: started, then not again within the retry.
    assert_eq!(
        c.decide(&input(Some(PowerWanted::Start), false, t)),
        vec![Step::Start]
    );
    assert!(c
        .decide(&input(Some(PowerWanted::Start), false, t))
        .is_empty());
    // Running, then gone without the box asking: the user's word.
    assert!(c
        .decide(&input(Some(PowerWanted::Start), true, t))
        .is_empty());
    let later = t + Duration::from_secs(3600);
    assert!(c
        .decide(&input(Some(PowerWanted::Start), false, later))
        .is_empty());
    assert_eq!(
        c.manual_off(),
        Some(ManualOff {
            session: 1,
            boot: 1_000_000
        })
    );
    assert!(c
        .decide(&input(Some(PowerWanted::Start), false, later))
        .is_empty());
    // A new logon ends it.
    let mut next = input(Some(PowerWanted::Start), false, later);
    next.session = Some(2);
    assert_eq!(c.decide(&next), vec![Step::Start]);
    assert_eq!(c.manual_off(), None);
}

#[test]
fn an_operator_start_ends_a_manual_off_and_a_reboot_too() {
    let t = Instant::now();
    let off = ManualOff {
        session: 1,
        boot: 1_000_000,
    };
    let mut c = Converge::new(Some(off));
    assert!(c
        .decide(&input(Some(PowerWanted::Start), false, t))
        .is_empty());
    let mut verb = input(Some(PowerWanted::Start), true, t);
    verb.generation = 1;
    assert!(c.decide(&verb).is_empty(), "the verb started it itself");
    assert_eq!(c.manual_off(), None);
    // Kept across an agent restart, but not across a reboot.
    let mut c = Converge::new(Some(off));
    let mut rebooted = input(Some(PowerWanted::Start), false, t);
    rebooted.boot = 2_000_000;
    assert_eq!(c.decide(&rebooted), vec![Step::Start]);
}

#[test]
fn a_turn_to_stop_stops_once_and_never_at_first_sight() {
    let t = Instant::now();
    let mut c = Converge::default();
    // The agent just started and the box says stop: the user may have
    // started it; nothing.
    assert!(c
        .decide(&input(Some(PowerWanted::Stop), true, t))
        .is_empty());
    let mut c = Converge::default();
    assert!(c
        .decide(&input(Some(PowerWanted::Start), true, t))
        .is_empty());
    assert_eq!(
        c.decide(&input(Some(PowerWanted::Stop), true, t)),
        vec![Step::Stop]
    );
    assert!(c
        .decide(&input(Some(PowerWanted::Stop), true, t))
        .is_empty());
    // Busy (an install): nothing, and what it leaves is not a quit.
    let mut busy = input(Some(PowerWanted::Start), false, t);
    busy.busy = true;
    assert!(c.decide(&busy).is_empty());
    // No user session: nothing to start it in.
    let mut nobody = input(
        Some(PowerWanted::Start),
        false,
        t + Duration::from_secs(600),
    );
    nobody.session = None;
    assert!(c.decide(&nobody).is_empty());
}

#[test]
fn startup_follows_always_on() {
    let t = Instant::now();
    let mut c = Converge::default();
    let mut i = input(None, true, t);
    i.always_on = Some(true);
    i.startup = Some(ProviderStartup::Disabled);
    assert_eq!(c.decide(&i), vec![Step::Startup(true)]);
    assert!(c.decide(&i).is_empty(), "not retried at once");
    i.startup = Some(ProviderStartup::Enabled);
    assert!(c.decide(&i).is_empty());
    i.startup = Some(ProviderStartup::Missing);
    assert!(c.decide(&i).is_empty(), "no shortcut to approve");
}

#[test]
fn the_operators_word_stands_until_the_policy_moves() {
    let o = Operator {
        wanted: PowerWanted::Stop,
        policy: Some(PowerWanted::Start),
        generation: 1,
    };
    assert_eq!(
        effective(Some(PowerWanted::Start), Some(&o)),
        Some(PowerWanted::Stop)
    );
    assert_eq!(effective(None, Some(&o)), None);
    assert_eq!(
        effective(Some(PowerWanted::Start), None),
        Some(PowerWanted::Start)
    );
}

#[test]
fn the_os_tools_words() {
    assert_eq!(
        show_value("LoadState=loaded\nMainPID=42\n", "MainPID"),
        "42"
    );
    assert_eq!(show_value("LoadState=loaded\n", "MainPID"), "");
    assert_eq!(
        dpkg_owner("lemonade-server:amd64: /usr/lib/systemd/system/lemond.service\n").as_deref(),
        Some("lemonade-server:amd64")
    );
    assert_eq!(dpkg_owner("dpkg-query: no path found"), None);
    let (v, l) = pkgutil_info(
        "package-id: ai.lemonadeserver\nversion: 2026.40.0\nvolume: /\nlocation: usr/local\n",
    );
    assert_eq!(
        (v.as_deref(), l.as_deref()),
        (Some("2026.40.0"), Some("/usr/local"))
    );
    let disabled =
        "disabled services = {\n\t\"ai.lemonadeserver.server\" => disabled\n\t\"x\" => enabled\n}";
    assert_eq!(
        launchctl_disabled(disabled, "ai.lemonadeserver.server"),
        Some(true)
    );
    assert_eq!(launchctl_disabled(disabled, "x"), Some(false));
    assert_eq!(launchctl_disabled("\"y\" => true", "y"), Some(true));
    assert_eq!(launchctl_disabled(disabled, "z"), None);
}

#[test]
fn startup_approved_values() {
    assert_eq!(startup_approved(None), ProviderStartup::Enabled);
    assert_eq!(startup_approved(Some(&[2, 0, 0])), ProviderStartup::Enabled);
    assert_eq!(startup_approved(Some(&[6])), ProviderStartup::Enabled);
    assert_eq!(startup_approved(Some(&[3, 0])), ProviderStartup::Disabled);
    assert_eq!(startup_approved(Some(&[7])), ProviderStartup::Disabled);
    let on = startup_value(true, 99);
    assert_eq!(on, [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    let off = startup_value(false, 0x0102_0304_0506_0708);
    assert_eq!(off[0], 3);
    assert_eq!(&off[4..], &0x0102_0304_0506_0708u64.to_le_bytes());
    assert_eq!(startup_approved(Some(&off)), ProviderStartup::Disabled);
}

#[test]
fn msiexec_runs_quiet_logged_and_in_the_installs_scope() {
    let a = msiexec_args(Msi::Install, Path::new("a.msi"), Path::new("l.log"), false);
    assert_eq!(a, ["/i", "a.msi", "/qn", "/norestart", "/l*v", "l.log"]);
    let m = msiexec_args(Msi::Uninstall, Path::new("a.msi"), Path::new("l.log"), true);
    assert_eq!(m[0], "/x");
    assert_eq!(m.last().unwrap(), "ALLUSERS=1");
    assert_eq!(msi_exit(0), MsiExit::Done);
    assert_eq!(msi_exit(3010), MsiExit::Done);
    assert_eq!(msi_exit(1605), MsiExit::Done);
    assert_eq!(msi_exit(1618), MsiExit::Busy);
    assert!(matches!(msi_exit(1603), MsiExit::Failed(_)));
}

#[test]
fn an_installers_log_is_read_in_either_encoding() {
    let utf16: Vec<u8> = [0xff, 0xfe]
        .into_iter()
        .chain("one\r\ntwo\r\n".encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    assert_eq!(tail_lines(&log_text(&utf16)), ["one", "two"]);
    // A tail from the middle of the file has no mark.
    assert_eq!(tail_lines(&log_text(&utf16[2..])), ["one", "two"]);
    assert_eq!(tail_lines(&log_text(b"a\n\nb\tc\n")), ["a", "bc"]);
    let many: String = (0..100).map(|i| format!("line {i}\n")).collect();
    let t = tail_lines(&many);
    assert_eq!((t.len(), t[0].as_str()), (MAX_LOG_LINES, "line 60"));
}

#[test]
fn check_bounds_the_lifecycle() {
    let mut r = vec![ProviderReport {
        kind: ProviderKind::Lemonade,
        read_at: "t".into(),
        lifecycle: Some(ProviderLifecycle {
            request: "r".into(),
            version: "v".into(),
            log_tail: vec!["l".into(); MAX_LOG_LINES],
            ..Default::default()
        }),
        ..Default::default()
    }];
    assert!(check(&r).is_ok());
    r[0].lifecycle.as_mut().unwrap().log_tail.push("l".into());
    assert!(check(&r).is_err());
}

fn with_origins(origins: &[&str]) -> ProvidersPolicy {
    ProvidersPolicy {
        lemonade: Some(ProviderPolicy {
            port: Some(13305),
            allowed_origins: origins.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }),
    }
}

#[test]
fn the_policy_carries_the_origins_and_writes_none_when_empty() {
    let p: Policy = serde_json::from_value(json!({"providers":{"lemonade":{
        "port": 13305,
        "allowed_origins": ["http://gpu-box.lan:13305", "https://lemonade-gpu-box.example.org"]
    }}}))
    .unwrap();
    assert_eq!(
        p.providers.lemonade.unwrap().allowed_origins,
        vec![
            "http://gpu-box.lan:13305".to_string(),
            "https://lemonade-gpu-box.example.org".to_string()
        ]
    );
    assert_eq!(
        serde_json::to_value(with_origins(&[]).lemonade.unwrap()).unwrap(),
        json!({"port": 13305})
    );
}

#[test]
fn the_wiring_joins_the_box_s_origins_and_keeps_the_rest() {
    let want = wiring(&with_origins(&[
        "http://gpu-box.lan:13305",
        "http://192.0.2.10:13305",
        "https://lemonade-gpu-box.example.org",
    ]));
    assert_eq!(
        Value::Object(want),
        json!({
            "host": "0.0.0.0",
            "port": 13305,
            "broadcast": false,
            "allowed_origins": "http://gpu-box.lan:13305,http://192.0.2.10:13305,https://lemonade-gpu-box.example.org"
        })
    );
    // No origins: the server's own same-origin rule again.
    assert_eq!(
        wiring(&ProvidersPolicy::default())["allowed_origins"],
        json!("")
    );
    assert_eq!(wiring(&ProvidersPolicy::default())["port"], json!(13305));
}

#[test]
fn an_origin_the_server_could_not_hold_whole_is_left_out() {
    let long = format!("https://{}.example.org", "a".repeat(MAX_TEXT));
    let want = wiring(&with_origins(&[
        "http://a.lan:1,http://evil.example",
        "http://b.lan :1",
        "http://c.lan:1\n",
        "",
        &long,
        "http://d.lan:1",
        "http://d.lan:1",
    ]));
    assert_eq!(want["allowed_origins"], json!("http://d.lan:1"));
    let many: Vec<String> = (0..40).map(|i| format!("http://n{i}.lan:1")).collect();
    let refs: Vec<&str> = many.iter().map(String::as_str).collect();
    let joined = wiring(&with_origins(&refs))["allowed_origins"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(joined.split(',').count(), MAX_ORIGINS);
}

#[test]
fn only_what_the_server_does_not_hold_is_set() {
    let want = wiring(&with_origins(&["http://gpu-box.lan:13305"]));
    let wired = json!({
        "host": "0.0.0.0", "port": 13305, "broadcast": false,
        "allowed_origins": "http://gpu-box.lan:13305", "log_level": "info"
    });
    assert!(unwired(&wired, &want).is_empty());
    // A fresh install: localhost, broadcasting, no origins.
    let fresh =
        json!({"host": "localhost", "port": 13305, "broadcast": true, "allowed_origins": ""});
    let change = unwired(&fresh, &want);
    assert_eq!(
        Value::Object(change),
        json!({"host": "0.0.0.0", "broadcast": false, "allowed_origins": "http://gpu-box.lan:13305"})
    );
    // A key the server does not report is set too.
    let old = json!({"host": "0.0.0.0", "port": 13305, "broadcast": false});
    assert_eq!(
        unwired(&old, &want).keys().collect::<Vec<_>>(),
        vec!["allowed_origins"]
    );
}
