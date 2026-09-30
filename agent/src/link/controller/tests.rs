//! The link end to end, in process: a controller listening on loopback and
//! machines connecting to it over real TLS, each with its own key, its own
//! `Shared` and a scratch store.

use crate::util::Shutdown;
use std::net::{IpAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::*;
use crate::api::wire::{CommandOk, DesiredState, NodeSummary, SetDesiredOk};
use crate::claude::Report;
use crate::config::{Config, Mode};
use crate::identity::{digest, Identity};
use crate::link::node::{connect_once, hello_of, Cadence, Ended, Target};
use crate::link::rotation::Keys;
use crate::link::tls as ltls;
use crate::link::wire::{self, name, Command, ControllerId, Hello, NodeState, Welcome, PROTO};
use crate::link::{PREAUTH_PER_IP, UNKNOWN_ADDRESSES};
use crate::role::Role;
use crate::rpc::Events;
use crate::rpc::{code, Response};
use crate::shared::Shared;
use crate::state::State;
use crate::telemetry::Telemetry;

fn id(n: u8) -> Identity {
    Identity::from_seed([n; 32])
}

fn events() -> Arc<Events> {
    Arc::new(Events::default())
}

struct Ctl {
    id: Identity,
    registry: Arc<Registry>,
    listener: Listener,
    events: Arc<Events>,
}

fn controller(limits: Limits) -> Ctl {
    let cid = id(200);
    let events = events();
    let registry = Arc::new(Registry::new(&cid, Arc::clone(&events), limits));
    let listener = listen("127.0.0.1:0".parse().unwrap(), &cid, Arc::clone(&registry)).unwrap();
    Ctl {
        id: cid,
        registry,
        listener,
        events,
    }
}

fn fast() -> Limits {
    Limits {
        ack_timeout: Duration::from_secs(3),
        ..Limits::default()
    }
}

fn node_shared() -> Arc<Shared> {
    Arc::new(Shared::new(
        State::default(),
        crate::facts::Facts::default(),
        Instant::now(),
        crate::link::wire::Policy::default(),
        Role::of(Mode::Node),
    ))
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("daedalus-link-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn cadence() -> Cadence {
    Cadence {
        heartbeat: Duration::from_millis(500),
        dead_after: Duration::from_secs(3),
        push_every: Duration::from_secs(60),
        push_check: Duration::from_millis(100),
    }
}

struct Node {
    shared: Arc<Shared>,
    stop: Shutdown,
    thread: std::thread::JoinHandle<Ended>,
    config: PathBuf,
}

impl Node {
    fn stop(self) -> Ended {
        self.stop.stop();
        let e = self.thread.join().unwrap();
        let _ = std::fs::remove_dir_all(self.config.parent().unwrap());
        e
    }
}

fn target(ctl: &Ctl, pin: [u8; 32]) -> Target {
    Target {
        address: ctl.listener.local_addr.to_string(),
        found_via: "config".into(),
        pin,
    }
}

fn pin_of(i: &Identity) -> [u8; 32] {
    digest(i.public_key().as_bytes())
}

fn spawn_node(t: Target, nid: Identity, shared: Arc<Shared>, name: &str) -> Node {
    let stop = Shutdown::new();
    let config = scratch(name).join("config.toml");
    let thread = {
        let (stop, shared, config) = (stop.clone(), Arc::clone(&shared), config.clone());
        std::thread::spawn(move || {
            let hello = hello_of(&Config::default(), &nid, &facts());
            let client = ltls::Client::new(&nid).unwrap();
            connect_once(&t, &client, hello, &shared, &stop, &config, &cadence())
        })
    };
    Node {
        shared,
        stop,
        thread,
        config,
    }
}

fn wait_for(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(Instant::now() < until, "waited {secs} s for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn entry(nid: &Identity, state: DesiredState, policy: crate::link::wire::Policy) -> DesiredEntry {
    DesiredEntry {
        id: nid.node_id(),
        public_key: *nid.public_key().as_bytes(),
        state,
        policy,
        name: None,
        offered: vec![],
    }
}

fn approve(registry: &Registry, nid: &Identity, policy: crate::link::wire::Policy) -> SetDesiredOk {
    registry.set_desired(vec![entry(nid, DesiredState::Approved, policy)])
}

fn summary(ctl: &Ctl, nid: &Identity) -> Option<NodeSummary> {
    ctl.registry
        .list()
        .into_iter()
        .find(|n| n.id == nid.node_id())
}

fn claude_policy() -> crate::link::wire::Policy {
    crate::link::wire::Policy {
        awake_hold: false,
        claude_remote_control: true,
        claude_workdir: Some("/work".into()),
        ..Default::default()
    }
}

#[test]
fn an_approved_machine_connects_and_pushes() {
    let ctl = controller(fast());
    let nid = id(1);
    approve(&ctl.registry, &nid, claude_policy());
    let shared = node_shared();
    shared.set_telemetry(
        Telemetry {
            sampled_at: "t1".into(),
            process_count: Some(300),
            ..Default::default()
        },
        true,
    );
    shared.set_claude(Report {
        state: "running".into(),
        pid: Some(7),
        ..Default::default()
    });
    let node = spawn_node(
        target(&ctl, pin_of(&ctl.id)),
        nid.clone(),
        shared,
        "approved",
    );

    wait_for("the pushes", 5, || {
        ctl.registry
            .telemetry(&nid.node_id())
            .is_ok_and(|t| t.telemetry.is_some())
            && ctl
                .registry
                .claude(&nid.node_id())
                .is_ok_and(|c| c.report.is_some())
            && ctl
                .registry
                .get(&nid.node_id())
                .is_ok_and(|d| d.status.is_some())
    });
    let s = summary(&ctl, &nid).unwrap();
    assert_eq!((s.state, s.connected), (NodeState::Approved, true));
    assert_eq!(s.claude.unwrap().state, "running");
    let d = ctl.registry.get(&nid.node_id()).unwrap();
    assert_eq!(d.public_key, nid.public_key_hex());
    assert_eq!(d.hello.unwrap().node_id, nid.node_id());
    // The status document is the machine's page, without its telemetry,
    // with its view of the link.
    let status = d.status.unwrap();
    assert!(status.get("awake_hold").is_some() && status.get("telemetry").is_none());
    assert_eq!(status["controller"]["state"], "approved", "{status}");
    assert_eq!(status["controller"]["fingerprint"], nid.fingerprint());
    assert_eq!(
        status["controller"]["controller_fingerprint"],
        ctl.id.fingerprint()
    );
    // The policy from the answer applied.
    assert_eq!(node.shared.policy(), claude_policy());
    assert_eq!(
        ctl.registry
            .telemetry(&nid.node_id())
            .unwrap()
            .telemetry
            .unwrap()
            .process_count,
        Some(300)
    );
    // /nodes/metrics: the machine's series, with the four labels; no
    // name from the app, so `machine` is the hostname.
    let m = ctl.registry.metrics();
    let os = ctl.registry.get(&nid.node_id()).unwrap().hello.unwrap().os;
    let host = crate::telemetry::escape_label(&crate::facts::hostname());
    let labels = format!(
        "host=\"{host}\",machine=\"{host}\",node=\"{}\",os=\"{os}\"",
        nid.node_id()
    );
    assert!(
        m.contains(&format!("daedalus_agent_link_up{{{labels}}} 1\n")),
        "{m}"
    );
    assert!(
        m.contains(&format!("daedalus_agent_processes{{{labels}}} 300\n")),
        "{m}"
    );

    assert_eq!(node.stop(), Ended::Stopped);
    wait_for("the disconnect", 5, || {
        summary(&ctl, &nid).is_some_and(|s| !s.connected)
    });
    // Gone: its telemetry leaves the metrics, its link_up is 0.
    let m = ctl.registry.metrics();
    assert!(
        m.contains(&format!("daedalus_agent_link_up{{{labels}}} 0\n")),
        "{m}"
    );
    assert!(!m.contains("daedalus_agent_processes"), "{m}");
}

#[test]
fn a_machine_pushes_its_providers_and_the_controller_keeps_them() {
    let ctl = controller(fast());
    let nid = id(40);
    let mut e = entry(&nid, DesiredState::Approved, claude_policy());
    e.offered = vec!["lemonade".into()];
    ctl.registry.set_desired(vec![e]);
    // Before any document: known, and null.
    let none = ctl.registry.providers(&nid.node_id()).unwrap();
    assert_eq!((none.connected, none.providers.is_none()), (false, true));

    let shared = node_shared();
    shared.set_providers(vec![crate::providers::ProviderReport {
        kind: "lemonade".into(),
        port: 13305,
        running: true,
        healthy: true,
        models: vec![crate::providers::ProviderModel {
            id: "Gemma-4".into(),
            downloaded: true,
            ..Default::default()
        }],
        read_at: "2026-09-28T10:00:00Z".into(),
        ..Default::default()
    }]);
    let node = spawn_node(
        target(&ctl, pin_of(&ctl.id)),
        nid.clone(),
        shared,
        "approved",
    );
    wait_for("the providers", 5, || {
        ctl.registry
            .providers(&nid.node_id())
            .is_ok_and(|p| p.providers.is_some())
    });
    let p = ctl.registry.providers(&nid.node_id()).unwrap();
    assert!(p.connected && p.received_at.is_some());
    assert_eq!(p.providers.as_ref().unwrap()[0].models[0].id, "Gemma-4");
    let d = ctl.registry.get(&nid.node_id()).unwrap();
    assert_eq!(d.providers, p.providers);
    let m = ctl.registry.metrics();
    assert!(
        m.contains("kind=\"lemonade\",port=\"13305\",version=\"\",offered=\"1\"} 1\n"),
        "{m}"
    );
    assert!(m.contains("daedalus_agent_provider_models{"), "{m}");

    // A document past its bounds is dropped; the last good one stands.
    node.shared.set_providers(vec![
        crate::providers::ProviderReport {
            kind: "lemonade".into(),
            ..Default::default()
        };
        crate::providers::MAX_PROVIDERS + 1
    ]);
    std::thread::sleep(std::time::Duration::from_millis(600));
    assert_eq!(
        ctl.registry.providers(&nid.node_id()).unwrap().providers,
        p.providers
    );

    assert_eq!(node.stop(), Ended::Stopped);
    wait_for("the disconnect", 5, || {
        summary(&ctl, &nid).is_some_and(|s| !s.connected)
    });
    // Gone: the document is kept for the pages, its series are not served.
    let left = ctl.registry.providers(&nid.node_id()).unwrap();
    assert!(!left.connected && left.providers.is_some());
    assert!(!ctl.registry.metrics().contains("provider_up"));
}
#[test]
fn an_unknown_key_waits_and_is_approved_without_reconnecting() {
    let ctl = controller(fast());
    let rx = ctl.events.subscribe();
    let nid = id(2);
    let node = spawn_node(
        target(&ctl, pin_of(&ctl.id)),
        nid.clone(),
        node_shared(),
        "pending",
    );
    wait_for("pending", 5, || {
        summary(&ctl, &nid).is_some_and(|s| s.state == NodeState::Pending && s.connected)
    });
    wait_for("the machine sees pending", 5, || {
        node.shared
            .link()
            .is_some_and(|l| l.state.as_deref() == Some("pending"))
    });
    let link = node.shared.link().unwrap();
    assert!(link.connected);
    assert_eq!(link.controller_fingerprint, Some(ctl.id.fingerprint()));
    // A pending machine pushes nothing, and nothing it sends is kept.
    std::thread::sleep(Duration::from_millis(300));
    assert!(ctl.registry.get(&nid.node_id()).unwrap().status.is_none());
    let since = summary(&ctl, &nid).unwrap().since;

    let ok = approve(&ctl.registry, &nid, claude_policy());
    assert_eq!(ok.approved, vec![nid.node_id()]);
    wait_for("the policy", 5, || node.shared.policy() == claude_policy());
    wait_for("the pushes after approval", 5, || {
        ctl.registry
            .get(&nid.node_id())
            .is_ok_and(|d| d.status.is_some())
    });
    // The same connection, upgraded in place.
    assert_eq!(summary(&ctl, &nid).unwrap().since, since);
    assert_eq!(
        node.shared.link().unwrap().state.as_deref(),
        Some("approved")
    );

    // A changed policy is pushed; the same set again changes nothing.
    let mut p2 = claude_policy();
    p2.awake_hold = true;
    let ok = approve(&ctl.registry, &nid, p2.clone());
    assert_eq!(ok.policy, vec![nid.node_id()]);
    wait_for("the new policy", 5, || node.shared.policy() == p2);
    assert_eq!(
        approve(&ctl.registry, &nid, p2),
        SetDesiredOk {
            nodes: 1,
            ..Default::default()
        }
    );

    // Dropped from the set: pending again, still connected.
    let ok = ctl.registry.set_desired(vec![]);
    assert_eq!(ok.pending, vec![nid.node_id()]);
    wait_for("pending again", 5, || {
        node.shared
            .link()
            .is_some_and(|l| l.state.as_deref() == Some("pending"))
    });
    node.stop();

    let lines: Vec<String> = rx.try_iter().map(|l| l.to_string()).collect();
    let n = nid.node_id();
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with(r#"{"e":"nodes.pending""#) && l.contains(&n)),
        "{lines:?}"
    );
    assert!(
        lines.contains(&format!(
            r#"{{"e":"nodes.changed","p":{{"id":"{n}","state":"approved","connected":true}}}}"#
        )),
        "{lines:?}"
    );
}

#[test]
fn a_revoked_machine_is_disconnected_and_refused() {
    let ctl = controller(fast());
    let nid = id(3);
    approve(&ctl.registry, &nid, claude_policy());
    let t = target(&ctl, pin_of(&ctl.id));
    let node = spawn_node(t.clone(), nid.clone(), node_shared(), "revoked");
    wait_for("connected", 5, || {
        summary(&ctl, &nid).is_some_and(|s| s.connected)
    });
    let ok = ctl
        .registry
        .set_desired(vec![entry(&nid, DesiredState::Revoked, Default::default())]);
    assert_eq!(ok.revoked, vec![nid.node_id()]);
    assert_eq!(node.thread.join().unwrap(), Ended::Revoked);
    wait_for("disconnected", 5, || {
        summary(&ctl, &nid).is_some_and(|s| !s.connected && s.state == NodeState::Revoked)
    });
    // It comes back: refused at hello.
    let again = spawn_node(t, nid.clone(), node_shared(), "revoked-again");
    assert_eq!(again.thread.join().unwrap(), Ended::Revoked);
    assert!(!summary(&ctl, &nid).unwrap().connected);
}

#[test]
fn a_controller_with_another_key_is_refused() {
    let ctl = controller(fast());
    let nid = id(4);
    // Pinned to another key: refused, and the key that came is named.
    let wrong = pin_of(&id(99));
    let node = spawn_node(target(&ctl, wrong), nid.clone(), node_shared(), "wrong-pin");
    match node.thread.join().unwrap() {
        Ended::KeyChanged {
            presented_unproven,
            pinned,
        } => {
            assert_eq!(presented_unproven, *ctl.id.public_key().as_bytes());
            assert_eq!(pinned, wrong);
        }
        other => panic!("{other:?}"),
    }
    assert!(
        summary(&ctl, &nid).is_none(),
        "the machine never reached hello"
    );
}

#[test]
fn commands_are_delivered_with_an_ack_or_queued() {
    let ctl = controller(fast());
    let nid = id(5);
    // A machine never heard of takes no command.
    assert_eq!(
        ctl.registry
            .command(&nid.node_id(), Command::CheckUpdate)
            .unwrap_err()
            .code,
        code::NOT_FOUND
    );
    approve(&ctl.registry, &nid, claude_policy());
    // Approved but away: queued, once per kind.
    for _ in 0..2 {
        assert_eq!(
            ctl.registry
                .command(&nid.node_id(), Command::CheckUpdate)
                .unwrap(),
            CommandOk {
                delivered: false,
                queued: true
            }
        );
    }
    let shared = node_shared();
    let node = spawn_node(
        target(&ctl, pin_of(&ctl.id)),
        nid.clone(),
        Arc::clone(&shared),
        "commands",
    );
    wait_for("the queued check", 5, || shared.take_check_request());
    // Connected: delivered and acknowledged at once.
    let t = Instant::now();
    assert_eq!(
        ctl.registry
            .command(&nid.node_id(), Command::ClaudeRestart)
            .unwrap(),
        CommandOk {
            delivered: true,
            queued: false
        }
    );
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    assert!(shared.claude_instruction_waiting());
    let answer = shared.set_claude(Report::default());
    assert!(answer.restart && !answer.update);
    assert!(ctl
        .registry
        .command(&nid.node_id(), Command::ClaudeUpdate)
        .is_ok());
    assert!(shared.set_claude(Report::default()).update);
    node.stop();

    // A pending machine is not approved: nothing to deliver to.
    let other = id(6);
    let pending = spawn_node(
        target(&ctl, pin_of(&ctl.id)),
        other.clone(),
        node_shared(),
        "commands-pending",
    );
    wait_for("pending", 5, || {
        summary(&ctl, &other).is_some_and(|s| s.connected)
    });
    assert_eq!(
        ctl.registry
            .command(&other.node_id(), Command::CheckUpdate)
            .unwrap_err()
            .code,
        code::UNAVAILABLE
    );
    pending.stop();
}

/// A model server on loopback that answers every POST with `body` and
/// records what it was asked: the request line and the body.
fn fake_provider(body: &'static str) -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut line = String::new();
            let _ = r.read_line(&mut line);
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut b = vec![0; len];
            let _ = r.read_exact(&mut b);
            log.lock().unwrap().push(format!(
                "{} {}",
                line.split_whitespace().nth(1).unwrap_or(""),
                String::from_utf8_lossy(&b)
            ));
            let mut s = s;
            let _ = write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (port, seen)
}

#[test]
fn residency_verbs_travel_the_link_and_run_on_the_machine() {
    use crate::providers::{ModelAction, ProviderModelParams};
    let (port, seen) = fake_provider(r#"{"status":"success","message":"Loaded Gemma-4"}"#);
    let ctl = controller(fast());
    let nid = id(41);
    let params = |request: &str| ProviderModelParams {
        kind: "lemonade".into(),
        action: ModelAction::Load,
        model: "Gemma-4".into(),
        pinned: true,
        replacing: Some("Qwen3".into()),
        request: request.into(),
    };
    let mut policy = claude_policy();
    policy.providers.lemonade = Some(crate::link::wire::ProviderPolicy { port: Some(port) });
    approve(&ctl.registry, &nid, policy.clone());
    // Approved and away: never kept for later.
    let away = ctl
        .registry
        .provider_model(&nid.node_id(), params("00112233445566aa"))
        .unwrap_err();
    assert_eq!(away.code, code::UNAVAILABLE);
    assert!(away.msg.contains("not connected"), "{}", away.msg);

    let shared = node_shared();
    let node = spawn_node(
        target(&ctl, pin_of(&ctl.id)),
        nid.clone(),
        Arc::clone(&shared),
        "residency",
    );
    wait_for("the policy", 5, || shared.policy() == policy);
    let sent = ctl
        .registry
        .provider_model(&nid.node_id(), params("00112233445566bb"))
        .unwrap();
    assert!(sent.delivered);
    wait_for("the outcome", 10, || !shared.provider_actions().is_empty());
    let a = &shared.provider_actions()[0];
    assert_eq!(
        (a.request.as_str(), a.ok, a.message.as_str()),
        ("00112233445566bb", true, "Loaded Gemma-4")
    );
    // The incumbent went down first, then the load, on the policy's port.
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            r#"/api/v1/unload {"model_name":"Qwen3"}"#.to_string(),
            r#"/api/v1/load {"model_name":"Gemma-4","pinned":true}"#.to_string(),
        ]
    );
    assert!(
        shared.take_providers_read(),
        "the reader is asked to read again"
    );
    node.stop();
}
#[test]
fn claude_sessions_travel_the_link() {
    use crate::claude::{Roster, SessionAction};
    const ID: &str = "abdda3a9-0cb2-43f1-b13e-37f25a755fce";
    let ctl = controller(fast());
    let nid = id(7);
    assert_eq!(
        ctl.registry
            .claude_session(&nid.node_id(), SessionAction::Resume, ID)
            .unwrap_err()
            .code,
        code::NOT_FOUND
    );
    approve(&ctl.registry, &nid, claude_policy());
    // Approved and away: a session verb is never kept for later.
    let away = ctl
        .registry
        .claude_session(&nid.node_id(), SessionAction::Resume, ID)
        .unwrap_err();
    assert_eq!(away.code, code::UNAVAILABLE);
    assert!(away.msg.contains("not connected"), "{}", away.msg);

    let shared = node_shared();
    shared.set_claude(Report {
        state: "running".into(),
        restarts: 2,
        ..Default::default()
    });
    let roster = Roster {
        reported_at: "t".into(),
        transcript_total: 3,
        ..Default::default()
    };
    shared.set_claude_roster(roster.clone());
    let node = spawn_node(
        target(&ctl, pin_of(&ctl.id)),
        nid.clone(),
        Arc::clone(&shared),
        "sessions",
    );
    wait_for("the roster", 5, || {
        ctl.registry
            .claude_roster(&nid.node_id())
            .is_ok_and(|r| r.roster.is_some() && r.received_at.is_some())
    });
    assert_eq!(
        ctl.registry.claude_roster(&nid.node_id()).unwrap().roster,
        Some(roster)
    );

    // Delivered, acknowledged, and handed to the session with its next
    // report, under the controller's request id.
    let sent = ctl
        .registry
        .claude_session(&nid.node_id(), SessionAction::Stop, "0a1b2c3d")
        .unwrap();
    assert!(sent.delivered && sent.request.len() == 16);
    let answer = shared.set_claude(Report {
        state: "running".into(),
        ..Default::default()
    });
    assert_eq!(answer.sessions.len(), 1);
    assert_eq!(answer.sessions[0].request, sent.request);
    assert_eq!(
        (answer.sessions[0].action, answer.sessions[0].id.as_str()),
        (SessionAction::Stop, "0a1b2c3d")
    );
    assert!(
        shared.set_claude(Report::default()).sessions.is_empty(),
        "once"
    );

    // The machine's own check: its policy turns Claude off, and it refuses.
    let off = crate::link::wire::Policy {
        claude_remote_control: false,
        ..claude_policy()
    };
    approve(&ctl.registry, &nid, off.clone());
    wait_for("the policy", 5, || shared.policy() == off);
    let refused = ctl
        .registry
        .claude_session(&nid.node_id(), SessionAction::Resume, ID)
        .unwrap_err();
    assert_eq!(refused.code, code::UNAVAILABLE);
    assert!(refused.msg.contains("off"), "{}", refused.msg);

    // The machine's Claude in /nodes/metrics, with the four labels.
    let m = ctl.registry.metrics();
    let os = ctl.registry.get(&nid.node_id()).unwrap().hello.unwrap().os;
    let host = crate::telemetry::escape_label(&crate::facts::hostname());
    let labels = format!(
        "host=\"{host}\",machine=\"{host}\",node=\"{}\",os=\"{os}\"",
        nid.node_id()
    );
    wait_for("the report", 5, || {
        ctl.registry.metrics().contains("daedalus_agent_claude_up")
    });
    let m = format!("{m}{}", ctl.registry.metrics());
    assert!(
        m.contains(&format!("daedalus_agent_claude_up{{{labels},state=")),
        "{m}"
    );
    node.stop();
    wait_for("the disconnect", 5, || {
        summary(&ctl, &nid).is_some_and(|s| !s.connected)
    });
    assert!(!ctl.registry.metrics().contains("daedalus_agent_claude_up"));
}

/// A raw machine: TLS with its key, `hello`, and the first line back.
fn raw(ctl: &Ctl, nid: &Identity) -> std::io::Result<(ltls::Tls, String)> {
    raw_hello(ctl, nid, |_| {})
}

fn raw_hello(
    ctl: &Ctl,
    nid: &Identity,
    edit: impl FnOnce(&mut Hello),
) -> std::io::Result<(ltls::Tls, String)> {
    let client = ltls::Client::new(nid).unwrap();
    let sock = TcpStream::connect(ctl.listener.local_addr)?;
    let mut t = client
        .connect(sock, pin_of(&ctl.id), Duration::from_secs(5))
        .map_err(|e| std::io::Error::other(format!("{e:?}")))?;
    let mut hello = hello_of(&Config::default(), nid, &facts());
    edit(&mut hello);
    t.send(&wire::request(1, name::HELLO, &hello))?;
    for _ in 0..100 {
        match t.recv()? {
            ltls::Recv::Line(l) => return Ok((t, String::from_utf8_lossy(&l).into_owned())),
            ltls::Recv::Idle => {}
            ltls::Recv::Closed => return Err(std::io::ErrorKind::ConnectionReset.into()),
        }
    }
    Err(std::io::ErrorKind::TimedOut.into())
}

#[test]
fn a_silent_machine_is_dropped_and_a_silent_controller_too() {
    let ctl = controller(Limits {
        dead_after: Duration::from_secs(1),
        heartbeat: Duration::from_secs(60),
        ..fast()
    });
    let nid = id(7);
    let (_t, first) = raw(&ctl, &nid).unwrap();
    assert!(first.contains(r#""state":"pending""#), "{first}");
    wait_for("connected", 5, || {
        summary(&ctl, &nid).is_some_and(|s| s.connected)
    });
    // It says nothing more: gone past the dead line.
    wait_for("dropped", 5, || {
        summary(&ctl, &nid).is_some_and(|s| !s.connected)
    });

    // The machine's side: a controller that goes quiet is dropped too.
    let quiet = controller(Limits {
        heartbeat: Duration::from_secs(60),
        ..fast()
    });
    let node = spawn_node(
        target(&quiet, pin_of(&quiet.id)),
        id(8),
        node_shared(),
        "quiet",
    );
    let ended = node.thread.join().unwrap();
    assert!(
        matches!(&ended, Ended::Dropped(why) if why.contains("no word")),
        "{ended:?}"
    );
}

#[test]
fn a_machine_reconnects_after_the_controller_comes_back() {
    let ctl = controller(fast());
    let nid = id(9);
    approve(&ctl.registry, &nid, claude_policy());
    let addr = ctl.listener.local_addr;
    let cfg = Config {
        controller_address: Some(addr.to_string()),
        controller_pin: Some(ctl.id.fingerprint()),
        ..Config::default()
    };
    let shared = node_shared();
    let stop = Shutdown::new();
    let thread = {
        let (shared, stop, nid) = (Arc::clone(&shared), stop.clone(), nid.clone());
        std::thread::spawn(move || crate::link::node::run_loop(cfg, nid, facts(), shared, stop))
    };
    wait_for("connected", 5, || {
        summary(&ctl, &nid).is_some_and(|s| s.connected)
    });

    // The controller goes away and comes back on the same address.
    let Ctl {
        id: cid,
        registry,
        listener,
        ..
    } = ctl;
    drop(listener);
    wait_for("the machine sees it go", 5, || {
        shared.link().is_some_and(|l| !l.connected)
    });
    let registry2 = Arc::new(Registry::new(&cid, events(), fast()));
    approve(&registry2, &nid, claude_policy());
    let _listener2 = listen(addr, &cid, Arc::clone(&registry2)).unwrap();
    wait_for("reconnected", 10, || {
        registry2
            .list()
            .iter()
            .any(|n| n.id == nid.node_id() && n.connected)
    });
    wait_for("the machine sees it back", 5, || {
        shared.link().is_some_and(|l| l.connected)
    });
    drop(registry);
    stop.stop();
    thread.join().unwrap();
}

#[test]
fn connections_and_pending_keys_are_capped() {
    let ctl = controller(Limits {
        max_connections: 2,
        max_pending: 1,
        ..fast()
    });
    // One unknown key waits; the next is told the list is full.
    let (_a, first) = raw(&ctl, &id(10)).unwrap();
    assert!(first.contains(r#""state":"pending""#), "{first}");
    let (_b, second) = raw(&ctl, &id(11)).unwrap();
    assert!(second.contains(r#""code":"busy""#), "{second}");
    assert_eq!(ctl.registry.open_connections(), 1);
    // An approved key gets in, up to the limit…
    approve(&ctl.registry, &id(12), claude_policy());
    let (_c, third) = raw(&ctl, &id(12)).unwrap();
    assert!(third.contains(r#""state":"approved""#), "{third}");
    assert_eq!(ctl.registry.open_connections(), 2);
    // …past which an unknown one is refused after its handshake…
    let (_d, fourth) = raw(&ctl, &id(13)).unwrap();
    assert!(fourth.contains(r#""code":"busy""#), "{fourth}");
    // …and an approved one takes the pending one's place.
    ctl.registry.set_desired(vec![
        entry(&id(12), DesiredState::Approved, claude_policy()),
        entry(&id(14), DesiredState::Approved, claude_policy()),
    ]);
    let (_e, fifth) = raw(&ctl, &id(14)).unwrap();
    assert!(fifth.contains(r#""state":"approved""#), "{fifth}");
    wait_for("the pending one to go", 5, || {
        summary(&ctl, &id(10)).is_some_and(|s| !s.connected)
    });
    assert_eq!(ctl.registry.open_connections(), 2);
    // Gone, an unknown key keeps its id, fingerprint and hostname only.
    let d = ctl.registry.get(&id(10).node_id()).unwrap();
    assert!(d.hello.is_none() && d.status.is_none());
    assert_eq!(d.node.hostname, Some(crate::facts::hostname()));
    assert_eq!(d.node.fingerprint, id(10).fingerprint());
    assert_eq!(ctl.registry.preauth_connections(), 0);
}

#[test]
fn pending_keys_are_capped_per_address_and_expire() {
    let ctl = controller(Limits {
        pending_ttl: Duration::from_secs(1),
        ..fast()
    });
    let (_a, a) = raw(&ctl, &id(15)).unwrap();
    let (_b, b) = raw(&ctl, &id(16)).unwrap();
    assert!(a.contains("pending") && b.contains("pending"), "{a} {b}");
    let (_c, c) = raw(&ctl, &id(17)).unwrap();
    assert!(
        c.contains(r#""code":"busy""#) && c.contains("this address"),
        "{c}"
    );
    // Past the TTL a pending connection is closed.
    wait_for("the pending ones to expire", 5, || {
        ctl.registry.open_connections() == 0
    });
}

#[test]
fn unknown_keys_are_rate_limited_after_the_handshake_and_approved_ones_never() {
    let ctl = controller(Limits {
        unknown_per_minute: 2,
        ..fast()
    });
    for n in [20, 21] {
        let (t, first) = raw(&ctl, &id(n)).unwrap();
        assert!(first.contains("pending"), "{first}");
        drop(t);
    }
    // Past the limit, a third unknown key from this address is refused…
    let (_t, third) = raw(&ctl, &id(22)).unwrap();
    assert!(third.contains("too many unknown keys"), "{third}");
    // …but an approved key from the same address gets in.
    approve(&ctl.registry, &id(23), claude_policy());
    let (_t, ok) = raw(&ctl, &id(23)).unwrap();
    assert!(ok.contains(r#""state":"approved""#), "{ok}");
    // Another address has its own count.
    assert!(ctl.registry.allow_unknown("127.0.0.2".parse().unwrap()));
}

#[test]
fn the_unknown_address_table_is_bounded_and_ipv6_counts_by_64() {
    let ctl = controller(fast());
    for i in 0..(UNKNOWN_ADDRESSES as u32 + 100) {
        let ip = std::net::Ipv4Addr::from(0x0a00_0000 + i);
        assert!(ctl.registry.allow_unknown(IpAddr::V4(ip)));
    }
    assert!(ctl.registry.lock().unknown_by_ip.len() <= UNKNOWN_ADDRESSES);
    let a: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
    let b: IpAddr = "2001:db8:1:2:bbbb::9".parse().unwrap();
    let c: IpAddr = "2001:db8:1:3::1".parse().unwrap();
    assert_eq!(ip_bucket(a), ip_bucket(b));
    assert_ne!(ip_bucket(a), ip_bucket(c));
    assert_eq!(
        ip_bucket("::ffff:192.168.0.9".parse().unwrap()),
        "192.168.0.9".parse::<IpAddr>().unwrap()
    );
}

#[test]
fn pre_auth_connections_are_capped_per_address_and_timed() {
    let ctl = controller(Limits {
        preauth_budget: Duration::from_secs(1),
        ..fast()
    });
    // Three silent TCP connections hold this address's pre-auth share…
    let held: Vec<TcpStream> = (0..PREAUTH_PER_IP)
        .map(|_| TcpStream::connect(ctl.listener.local_addr).unwrap())
        .collect();
    wait_for("the slots to be taken", 5, || {
        ctl.registry.preauth_connections() == PREAUTH_PER_IP
    });
    // …so a fourth is closed before any handshake…
    assert!(raw(&ctl, &id(24)).is_err());
    // …until the budget ends theirs.
    wait_for("the budget to pass", 5, || {
        ctl.registry.preauth_connections() == 0
    });
    drop(held);
    assert!(raw(&ctl, &id(24)).is_ok());
}

/// A peer that trickles its handshake a byte at a time — each byte inside
/// any per-read timeout — still loses its pre-auth slot when the budget
/// ends (audit D4).
#[test]
fn a_trickled_handshake_is_cut_off_at_the_budget() {
    use std::io::Write as _;
    let ctl = controller(Limits {
        preauth_budget: Duration::from_secs(1),
        ..fast()
    });
    let mut sock = TcpStream::connect(ctl.listener.local_addr).unwrap();
    // A handshake record's header announcing 16 KiB, then its body a byte
    // at a time.
    sock.write_all(&[0x16, 0x03, 0x01, 0x40, 0x00]).unwrap();
    let t = Instant::now();
    let trickler = std::thread::spawn(move || {
        while t.elapsed() < Duration::from_secs(6) {
            if sock.write_all(&[0]).is_err() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    });
    wait_for("the slot to be taken", 5, || {
        ctl.registry.preauth_connections() == 1
    });
    wait_for("the budget to end the trickle", 4, || {
        ctl.registry.preauth_connections() == 0
    });
    assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
    assert!(trickler.join().unwrap(), "the connection was closed");
}

/// The same past the handshake: a `hello` that never ends, a byte per
/// record, is cut off at the budget too.
#[test]
fn a_trickled_hello_is_cut_off_at_the_budget() {
    let ctl = controller(Limits {
        preauth_budget: Duration::from_secs(1),
        ..fast()
    });
    let nid = id(29);
    let client = ltls::Client::new(&nid).unwrap();
    let sock = TcpStream::connect(ctl.listener.local_addr).unwrap();
    let mut t = client
        .connect(sock, pin_of(&ctl.id), Duration::from_secs(5))
        .unwrap();
    let start = Instant::now();
    let mut cut = false;
    while start.elapsed() < Duration::from_secs(6) {
        if t.send_bytes(b"{").is_err() {
            cut = true;
            break;
        }
        if ctl.registry.preauth_connections() == 0 {
            cut = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(cut, "still held after {:?}", start.elapsed());
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn an_oversized_or_out_of_bounds_hello_is_refused() {
    let ctl = controller(fast());
    // A hostname that is text, but too long for the bounds.
    let (_t, line) = raw_hello(&ctl, &id(25), |h| h.hostname = "h".repeat(300)).unwrap();
    assert!(
        line.contains("bad_request") && line.contains("hostname"),
        "{line}"
    );
    // A hello past the pre-admission line limit: closed without an answer.
    let big = raw_hello(&ctl, &id(26), |h| {
        h.capabilities = vec!["c".repeat(60); 400];
    });
    assert!(big.is_err(), "{:?}", big.map(|(_, l)| l));
    assert!(ctl.registry.list().is_empty());
}

#[test]
fn a_decision_is_for_a_key_not_an_id() {
    let ctl = controller(fast());
    // The app decided this id for another key (a forged or colliding id).
    let nid = id(27);
    ctl.registry.set_desired(vec![DesiredEntry {
        id: nid.node_id(),
        public_key: *id(28).public_key().as_bytes(),
        state: DesiredState::Approved,
        policy: claude_policy(),
        name: None,
        offered: vec![],
    }]);
    let (_t, line) = raw(&ctl, &nid).unwrap();
    assert!(
        line.contains("forbidden") && line.contains("another key"),
        "{line}"
    );
}

#[test]
fn another_protocol_or_another_keys_id_is_refused() {
    let ctl = controller(fast());
    let nid = id(30);
    let (_t, line) = raw_hello(&ctl, &nid, |h| h.proto = 2).unwrap();
    assert!(
        line.contains(r#""code":"version""#) && line.contains(r#""supported":1"#),
        "{line}"
    );
    let (_t, line) = raw_hello(&ctl, &nid, |h| h.node_id = id(31).node_id()).unwrap();
    assert!(
        line.contains("bad_request") && line.contains("proved"),
        "{line}"
    );
    assert!(ctl.registry.list().is_empty());
}

/// The API's `nodes.*`, through the unix socket, against a live registry.
#[cfg(unix)]
#[test]
fn the_api_steers_the_machines_through_the_socket() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let dir = scratch("api");
    let sock_path = dir.join("run").join("api.sock");
    let cfg: Config = toml::from_str(&format!(
        "mode = \"controller\"\n[controller]\napi_socket = \"{}\"\nlisten = \"127.0.0.1:0\"\n",
        sock_path.display()
    ))
    .unwrap();
    let cshared = Arc::new(Shared::new(
        State::default(),
        crate::facts::Facts::default(),
        Instant::now(),
        cfg.initial_policy(),
        cfg.role(),
    ));
    let cid = id(210);
    let registry = Arc::new(Registry::new(&cid, cshared.events_handle(), fast()));
    cshared.set_nodes(Arc::clone(&registry));
    cshared.set_controller(crate::shared::Controller {
        keys: Arc::new(Keys::fixed(&cid).unwrap()),
        listen: Some("127.0.0.1:0".into()),
        advertise: vec![],
    });
    let listener = listen("127.0.0.1:0".parse().unwrap(), &cid, Arc::clone(&registry)).unwrap();
    let api = crate::api::serve(&cfg, Arc::clone(&cshared)).unwrap();

    let conn = UnixStream::connect(&sock_path).unwrap();
    let mut reader = BufReader::new(conn.try_clone().unwrap());
    let mut w = conn;
    let mut call = |line: String| -> serde_json::Value {
        w.write_all(format!("{line}\n").as_bytes()).unwrap();
        loop {
            let mut l = String::new();
            reader.read_line(&mut l).unwrap();
            let v: serde_json::Value = serde_json::from_str(&l).unwrap();
            if v.get("e").is_none() {
                return v;
            }
        }
    };
    let hello = call(r#"{"id":1,"m":"hello","p":{"api":1,"client":"test/1"}}"#.into());
    assert_eq!(
        hello["ok"]["capabilities"],
        serde_json::json!(["telemetry.full", "nodes"])
    );
    let info = call(r#"{"id":2,"m":"system.info"}"#.into());
    assert_eq!(info["ok"]["controller"]["fingerprint"], cid.fingerprint());
    assert_eq!(info["ok"]["role"]["node_listener"], true);
    assert_eq!(
        info["ok"]["controller"]["rotation"],
        serde_json::Value::Null
    );
    // A grace period out of bounds, and a key handed in fixed: refused.
    let rot = call(r#"{"id":90,"m":"controller.rotate","p":{"grace_secs":5}}"#.into());
    assert_eq!(rot["err"]["code"], "bad_request", "{rot}");
    let rot = call(r#"{"id":91,"m":"controller.rotate","p":{"grace":60}}"#.into());
    assert_eq!(rot["err"]["code"], "bad_request", "{rot}");
    let rot = call(r#"{"id":92,"m":"controller.rotate"}"#.into());
    assert_eq!(rot["err"]["code"], "unavailable", "{rot}");

    // A machine connects and waits.
    let nid = id(40);
    let shared = node_shared();
    let node = spawn_node(
        Target {
            address: listener.local_addr.to_string(),
            found_via: "config".into(),
            pin: pin_of(&cid),
        },
        nid.clone(),
        Arc::clone(&shared),
        "api-node",
    );
    let n = nid.node_id();
    wait_for("pending", 5, || registry.list().iter().any(|s| s.id == n));
    let list = call(r#"{"id":3,"m":"nodes.list"}"#.into());
    assert_eq!(list["ok"]["nodes"][0]["state"], "pending");
    assert_eq!(list["ok"]["nodes"][0]["fingerprint"], nid.fingerprint());

    // Bad selectors never reach the registry.
    let bad = call(r#"{"id":4,"m":"nodes.get","p":{"id":"../etc"}}"#.into());
    assert_eq!(bad["err"]["code"], "bad_request");
    let bad = call(r#"{"id":5,"m":"nodes.get","p":{"id":"0123456789abcdef"}}"#.into());
    assert_eq!(bad["err"]["code"], "not_found");
    let forged = serde_json::json!({"id":6,"m":"nodes.set_desired","p":{"nodes":[
        {"id": id(41).node_id(), "public_key": nid.public_key_hex(), "state":"approved"}]}});
    assert_eq!(call(forged.to_string())["err"]["code"], "bad_request");
    let bad = call(r#"{"id":13,"m":"nodes.reboot","p":{}}"#.into());
    assert_eq!(bad["err"]["code"], "unknown_method");

    // A name that would not make a clean label is refused, whole set and all.
    for name in [" ".to_string(), "a".repeat(65), "PC\n".to_string()] {
        let set = serde_json::json!({"id":14,"m":"nodes.set_desired","p":{"nodes":[
            {"id": n, "public_key": nid.public_key_hex(), "state":"approved", "name": name}]}});
        assert_eq!(
            call(set.to_string())["err"]["code"],
            "bad_request",
            "{name:?}"
        );
    }
    assert_eq!(registry.list()[0].state, NodeState::Pending);

    // Approved: the policy reaches the machine without a reconnect.
    let set = serde_json::json!({"id":7,"m":"nodes.set_desired","p":{"nodes":[
        {"id": n, "public_key": nid.public_key_hex(), "state":"approved", "name":"Gaming PC",
         "policy":{"awake_hold":false,"claude_remote_control":true,"claude_workdir":"/work"}}]}});
    let ok = call(set.to_string());
    assert_eq!(ok["ok"]["approved"], serde_json::json!([n]));
    wait_for("the policy", 5, || shared.policy() == claude_policy());

    shared.set_telemetry(
        Telemetry {
            sampled_at: "t9".into(),
            ..Default::default()
        },
        true,
    );
    wait_for("telemetry", 5, || {
        registry
            .telemetry(&n)
            .is_ok_and(|t| t.telemetry.is_some_and(|t| t.sampled_at == "t9"))
    });
    let t = call(format!(
        r#"{{"id":8,"m":"nodes.telemetry","p":{{"id":"{n}"}}}}"#
    ));
    assert_eq!(t["ok"]["telemetry"]["sampled_at"], "t9");
    // /nodes/metrics names the machine as the app does.
    let m = registry.metrics();
    assert!(
        m.contains(&format!(
            "daedalus_agent_link_up{{host=\"{}\",machine=\"Gaming PC\",node=\"{n}\",os=\"{}\"}} 1\n",
            crate::telemetry::escape_label(&crate::facts::hostname()),
            registry.get(&n).unwrap().hello.unwrap().os
        )),
        "{m}"
    );
    let d = call(format!(r#"{{"id":9,"m":"nodes.get","p":{{"id":"{n}"}}}}"#));
    assert_eq!(d["ok"]["state"], "approved");
    assert_eq!(d["ok"]["connected"], true);
    let c = call(format!(
        r#"{{"id":10,"m":"nodes.command","p":{{"id":"{n}","command":"claude_restart"}}}}"#
    ));
    assert_eq!(
        c["ok"],
        serde_json::json!({"delivered":true,"queued":false})
    );
    assert!(shared.claude_instruction_waiting());
    let c = call(format!(
        r#"{{"id":11,"m":"nodes.command","p":{{"id":"{n}","command":"reboot"}}}}"#
    ));
    assert_eq!(c["err"]["code"], "bad_request");
    let cl = call(format!(
        r#"{{"id":12,"m":"nodes.claude","p":{{"id":"{n}"}}}}"#
    ));
    assert!(cl["ok"].get("report").is_some(), "{cl}");

    // The machine's Claude sessions: its roster, and one verb delivered.
    shared.set_claude(Report {
        state: "running".into(),
        ..Default::default()
    });
    shared.set_claude_roster(crate::claude::Roster {
        reported_at: "r".into(),
        empty_count: 5,
        ..Default::default()
    });
    wait_for("the roster", 5, || {
        registry.claude_roster(&n).is_ok_and(|r| r.roster.is_some())
    });
    let r = call(format!(
        r#"{{"id":15,"m":"nodes.claude_roster","p":{{"id":"{n}"}}}}"#
    ));
    assert_eq!(r["ok"]["roster"]["empty_count"], 5, "{r}");
    let s = call(format!(
        r#"{{"id":16,"m":"nodes.claude_session","p":{{"id":"{n}","action":"remove","session":"0a1b2c3d"}}}}"#
    ));
    assert_eq!(s["ok"]["delivered"], true, "{s}");
    let answer = shared.set_claude(Report::default());
    assert_eq!(answer.sessions.len(), 1);
    assert_eq!(
        answer.sessions[0].request,
        s["ok"]["request"].as_str().unwrap()
    );
    for bad in [
        format!(r#"{{"id":17,"m":"nodes.claude_session","p":{{"id":"{n}","action":"remove","session":"abdda3a9-0cb2-43f1-b13e-37f25a755fce"}}}}"#),
        format!(r#"{{"id":17,"m":"nodes.claude_session","p":{{"id":"{n}","action":"resume","session":"0a1b2c3d","flags":"x"}}}}"#),
        r#"{"id":17,"m":"nodes.claude_session","p":{"id":"../x","action":"stop","session":"0a1b2c3d"}}"#.to_string(),
    ] {
        assert_eq!(call(bad.clone())["err"]["code"], "bad_request", "{bad}");
    }
    // The controller's own Claude beside the machine's, labelled as a
    // machine of its own: the controller's node id and hostname.
    let own = cshared.own_claude_metrics();
    let chost = crate::telemetry::escape_label(&crate::facts::hostname());
    assert!(
        own.starts_with(&format!(
            "daedalus_agent_claude_up{{host=\"{chost}\",machine=\"{chost}\",node=\"{}\",os=\"\",state=\"none\"}} 0\n",
            cid.node_id()
        )),
        "{own}"
    );

    node.stop();
    drop(listener);
    drop(api);
    let _ = std::fs::remove_dir_all(dir);
}

/// What a machine says of itself, as `facts::read` would on Linux.
fn facts() -> crate::facts::Facts {
    crate::facts::Facts {
        os: "linux",
        arch: "x86_64",
        os_name: "Test OS".into(),
        ..Default::default()
    }
}

/// A machine's attempt with its trust in `dir` (its `config.toml`), on a
/// thread; the dir is left as it is.
fn attempt_in(
    t: Target,
    nid: &Identity,
    dir: &std::path::Path,
) -> (Arc<Shared>, Shutdown, std::thread::JoinHandle<Ended>) {
    let (shared, stop) = (node_shared(), Shutdown::new());
    let (s, st, nid, dir) = (
        Arc::clone(&shared),
        stop.clone(),
        nid.clone(),
        dir.to_path_buf(),
    );
    let thread = std::thread::spawn(move || {
        let hello = hello_of(&Config::default(), &nid, &facts());
        let client = ltls::Client::new(&nid).unwrap();
        let config = dir.join("config.toml");
        connect_once(&t, &client, hello, &s, &st, &config, &cadence())
    });
    (shared, stop, thread)
}

/// Where a machine with its trust in `dir` connects now: what its
/// config.toml says.
fn target_in(addr: &str, dir: &std::path::Path) -> Target {
    let cfg: Config = std::fs::read_to_string(dir.join("config.toml"))
        .ok()
        .map(|t| toml::from_str(&t).unwrap())
        .unwrap_or_default();
    crate::link::node::resolve_target(Some(addr), cfg.controller_pin.as_deref(), || None)
        .unwrap()
        .unwrap()
}

#[test]
fn a_signed_rotation_re_pins_every_machine_in_its_config() {
    let cdir = scratch("rot-ctl");
    let keys = Arc::new(Keys::load(&cdir).unwrap());
    let old = keys.forward();
    let registry = Arc::new(Registry::new(
        &old,
        events(),
        Limits {
            pending_per_ip: 8,
            ..fast()
        },
    ));
    let listener = listen_with(
        "127.0.0.1:0".parse().unwrap(),
        Arc::clone(&keys),
        Arc::clone(&registry),
    )
    .unwrap();
    let addr = listener.local_addr.to_string();

    // Two machines pinned in config.toml (comments and other keys kept, and
    // the other with nothing but the pin).
    let (pinned_dir, bare_dir) = (scratch("rot-pinned"), scratch("rot-bare"));
    std::fs::write(
        pinned_dir.join("config.toml"),
        format!(
            "# written by install\nport = 7787\ncontroller_pin = \"{}\"\n",
            old.fingerprint()
        ),
    )
    .unwrap();
    std::fs::write(
        bare_dir.join("config.toml"),
        format!("controller_pin = \"{}\"\n", old.fingerprint()),
    )
    .unwrap();
    let (pinned_id, bare_id) = (id(60), id(61));
    let t = target_in(&addr, &pinned_dir);
    let (_, _, pinned) = attempt_in(t, &pinned_id, &pinned_dir);
    let (_, _, bare) = attempt_in(target_in(&addr, &bare_dir), &bare_id, &bare_dir);
    wait_for("both connected", 5, || {
        [&pinned_id, &bare_id].iter().all(|n| {
            registry
                .list()
                .iter()
                .any(|s| s.id == n.node_id() && s.connected)
        })
    });
    assert_eq!(keys.info(), None);

    // The rotation: both are told, both re-pin where their pin was.
    let info = keys.start(Duration::from_secs(3600)).unwrap();
    assert_eq!(info.from_fingerprint, old.fingerprint());
    let new = keys.forward();
    let new_pin = pin_of(&new);
    assert_eq!(
        pinned.join().unwrap(),
        Ended::Rotated {
            from: pin_of(&old),
            new: new_pin
        }
    );
    assert_eq!(
        bare.join().unwrap(),
        Ended::Rotated {
            from: pin_of(&old),
            new: new_pin
        }
    );
    let config = std::fs::read_to_string(pinned_dir.join("config.toml")).unwrap();
    assert_eq!(
        config,
        format!(
            "# written by install\nport = 7787\ncontroller_pin = \"{}\"\n",
            new.fingerprint()
        )
    );
    let bare_config = std::fs::read_to_string(bare_dir.join("config.toml")).unwrap();
    assert_eq!(
        bare_config,
        format!("controller_pin = \"{}\"\n", new.fingerprint())
    );

    // They come back under the new key, asked for by name, and are not
    // told again.
    let t = target_in(&addr, &pinned_dir);
    assert_eq!(t.pin, new_pin);
    let (pshared, pstop, pinned) = attempt_in(t, &pinned_id, &pinned_dir);
    let (tshared, tstop, bare) = attempt_in(target_in(&addr, &bare_dir), &bare_id, &bare_dir);
    wait_for("both back under the new key", 5, || {
        [&pshared, &tshared].iter().all(|s| {
            s.link().is_some_and(|l| {
                l.connected && l.controller_fingerprint.as_deref() == Some(&new.fingerprint())
            })
        })
    });
    assert_eq!(keys.info().unwrap().old_key_connections, 0);
    // A machine that was away still pins the old key: it meets it, and is
    // told in turn.
    let late_dir = scratch("rot-late");
    let (_, _, late) = attempt_in(
        Target {
            address: addr.clone(),
            found_via: "dns lan".into(),
            pin: pin_of(&old),
        },
        &id(62),
        &late_dir,
    );
    assert_eq!(
        late.join().unwrap(),
        Ended::Rotated {
            from: pin_of(&old),
            new: new_pin
        }
    );

    // Retired: the old key is gone; a machine that still pins it is refused.
    assert!(keys.retire_now());
    let stale = attempt_in(
        Target {
            address: addr.clone(),
            found_via: "config".into(),
            pin: pin_of(&old),
        },
        &id(63),
        &scratch("rot-stale"),
    );
    assert!(
        matches!(stale.2.join().unwrap(), Ended::KeyChanged { presented_unproven, .. } if presented_unproven == *new.public_key().as_bytes())
    );
    for stop in [pstop, tstop] {
        stop.stop();
    }
    assert_eq!(pinned.join().unwrap(), Ended::Stopped);
    assert_eq!(bare.join().unwrap(), Ended::Stopped);
    drop(listener);
    for d in [cdir, pinned_dir, bare_dir, late_dir] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn a_rotation_the_trusted_key_did_not_sign_is_refused() {
    use std::net::TcpListener;
    let ctl = id(70);
    let (other, successor) = (id(71), id(72));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let config = ltls::server_config(&ctl).unwrap();
    // A controller that holds the pinned key, sending statements: one
    // signed by another key, one by the successor itself, one for a
    // key it vouches for over nothing it holds — and each answer read.
    let fake = std::thread::spawn(move || {
        let (sock, _) = listener.accept().unwrap();
        let mut t = ltls::Tls::server(sock, config, Duration::from_secs(5)).unwrap();
        let line = |t: &mut ltls::Tls| loop {
            if let ltls::Recv::Line(l) = t.recv().unwrap() {
                let l = String::from_utf8(l).unwrap();
                if !l.contains(r#""e":"hb""#) {
                    return l;
                }
            }
        };
        let _hello = line(&mut t);
        let welcome = Welcome {
            proto: PROTO,
            node_id: id(73).node_id(),
            state: NodeState::Pending,
            controller: ControllerId::default(),
            policy: None,
        };
        t.send(&serde_json::to_string(&Response::ok(1, &welcome)).unwrap())
            .unwrap();
        let new = *successor.public_key().as_bytes();
        let forged = [
            other.sign_rotation(&new),
            successor.sign_rotation(&new),
            [0u8; 64],
        ];
        let mut answers = Vec::new();
        for (i, sig) in forged.iter().enumerate() {
            let p = wire::RotateParams {
                new_public_key: hex::encode(new),
                signature: hex::encode(sig),
            };
            t.send(&wire::request(100 + i as u64, name::ROTATE, &p))
                .unwrap();
            answers.push(line(&mut t));
        }
        t.close();
        answers
    });
    let dir = scratch("rot-forged");
    let pin = pin_of(&ctl);
    let (_, _, node) = attempt_in(
        Target {
            address: addr,
            found_via: "config".into(),
            pin,
        },
        &id(73),
        &dir,
    );
    let answers = fake.join().unwrap();
    for a in &answers {
        assert!(a.contains(r#""code":"forbidden""#), "{a}");
    }
    assert!(matches!(node.join().unwrap(), Ended::Dropped(_)));
    // Nothing re-pinned.
    assert!(!dir.join("config.toml").exists());

    // An impostor that rotates its own key never gets as far as a
    // statement: the handshake with the pinned key fails first.
    let idir = scratch("rot-impostor-ctl");
    let ikeys = Arc::new(Keys::load(&idir).unwrap());
    ikeys.start(Duration::from_secs(3600)).unwrap();
    let impostor = listen_with(
        "127.0.0.1:0".parse().unwrap(),
        ikeys,
        Arc::new(Registry::new(&id(74), events(), fast())),
    )
    .unwrap();
    let (_, _, node) = attempt_in(
        Target {
            address: impostor.local_addr.to_string(),
            found_via: "config".into(),
            pin,
        },
        &id(73),
        &dir,
    );
    assert!(matches!(node.join().unwrap(), Ended::KeyChanged { .. }));
    assert!(!dir.join("config.toml").exists());
    drop(impostor);
    for d in [dir, idir] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn an_unpaired_machine_dials_nobody_until_it_is_paired() {
    // An address it could dial, in config.toml, but no pin.
    let bait = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    bait.set_nonblocking(true).unwrap();
    let dialled = |bait: &std::net::TcpListener| !matches!(bait.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock);
    let dir = scratch("unpaired");
    let path = dir.join("config.toml");
    let cfg = Config {
        controller_address: Some(bait.local_addr().unwrap().to_string()),
        ..Config::default()
    };
    std::fs::write(&path, toml::to_string(&cfg).unwrap()).unwrap();
    let (shared, stop, nid) = (node_shared(), Shutdown::new(), id(90));
    shared.set_shutdown(stop.clone());
    let thread = {
        let (shared, stop, nid, path) =
            (Arc::clone(&shared), stop.clone(), nid.clone(), path.clone());
        std::thread::spawn(move || {
            crate::link::node::run_loop_at(cfg, nid, facts(), shared, stop, &path)
        })
    };
    wait_for("unpaired", 5, || {
        shared
            .link()
            .is_some_and(|l| l.state.as_deref() == Some("unpaired"))
    });
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!dialled(&bait), "an unpaired machine dialled its address");
    let l = shared.link().unwrap();
    assert!(!l.connected && l.controller_fingerprint.is_none() && l.error.is_none());

    // Paired while it runs (`pair`: the file, then `link.reload`): it dials
    // the controller named at once, under that key, and waits for approval.
    let ctl = controller(fast());
    let p = crate::pair::Pairing::new(
        &crate::identity::format_fingerprint(&pin_of(&ctl.id)),
        Some(&ctl.listener.local_addr.to_string()),
    )
    .unwrap();
    p.write_at(&path).unwrap();
    crate::pair::reload(&shared, &path).unwrap();
    wait_for("seen by the controller", 5, || {
        summary(&ctl, &nid).is_some()
    });
    wait_for("pending", 5, || {
        shared
            .link()
            .is_some_and(|l| l.state.as_deref() == Some("pending"))
    });
    assert!(!dialled(&bait), "the old address was dialled");
    stop.stop();
    thread.join().unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

/// santree: the session host rides the policy of approved machines with
/// santree on, and only theirs; the allow-list is written from the app's
/// set — never before its first — ahead of the policy events, and follows
/// every change of it.
#[test]
fn santree_machines_are_told_the_session_host_and_the_allow_list_leads() {
    use crate::link::wire::{Policy, SessionHost};
    let dir = scratch("santree-allow");
    let allow = dir.join("session-host-allow.json");
    let cid = id(200);
    let events = events();
    let registry =
        Arc::new(Registry::new(&cid, Arc::clone(&events), fast()).with_allow_list(allow.clone()));
    let listener = listen("127.0.0.1:0".parse().unwrap(), &cid, Arc::clone(&registry)).unwrap();
    let ctl = Ctl {
        id: cid,
        registry,
        listener,
        events,
    };
    let (on, off) = (id(41), id(42));
    let (s_on, s_off) = (node_shared(), node_shared());
    let t = target(&ctl, pin_of(&ctl.id));
    let n_on = spawn_node(t.clone(), on.clone(), Arc::clone(&s_on), "santree-on");
    let n_off = spawn_node(t, off.clone(), Arc::clone(&s_off), "santree-off");
    wait_for("both pending", 5, || {
        [&on, &off]
            .iter()
            .all(|n| summary(&ctl, n).is_some_and(|s| s.connected && s.state == NodeState::Pending))
    });
    assert!(
        !allow.exists(),
        "nothing is written before the app's first set"
    );

    let host = SessionHost {
        address: "box.example.org:7789".into(),
        public_key: "ab".repeat(32),
    };
    ctl.registry.set_session_host(host.clone());
    let santree = Policy {
        santree: true,
        ..Policy::default()
    };
    let listed = |ids: &[&Identity]| {
        let doc: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&allow).unwrap()).unwrap();
        let have: Vec<String> = doc["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].as_str().unwrap().to_string())
            .collect();
        let mut want: Vec<String> = ids.iter().map(|i| i.node_id()).collect();
        want.sort();
        have == want
    };
    ctl.registry.set_desired(vec![
        entry(&on, DesiredState::Approved, santree.clone()),
        entry(&off, DesiredState::Approved, Policy::default()),
    ]);
    // The moment the machine holds santree on, the file already lists it.
    wait_for("santree on", 5, || s_on.policy().santree);
    assert!(listed(&[&on]));
    assert_eq!(s_on.policy().session_host, Some(host.clone()));
    wait_for("the other approved", 5, || {
        summary(&ctl, &off).is_some_and(|s| s.state == NodeState::Approved)
    });
    assert_eq!(s_off.policy().session_host, None, "only santree machines");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&allow).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    // A new host key reaches the santree machine at once.
    let moved = SessionHost {
        public_key: "cd".repeat(32),
        ..host
    };
    ctl.registry.set_session_host(moved.clone());
    wait_for("the new key", 5, || {
        s_on.policy().session_host.as_ref() == Some(&moved)
    });
    assert_eq!(s_off.policy().session_host, None);

    // santree off: out of the file, and the machine told.
    ctl.registry.set_desired(vec![
        entry(&on, DesiredState::Approved, Policy::default()),
        entry(&off, DesiredState::Approved, Policy::default()),
    ]);
    assert!(listed(&[]));
    wait_for("santree off", 5, || !s_on.policy().santree);
    assert_eq!(s_on.policy().session_host, None);
    n_on.stop();
    n_off.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_machine_that_logs_out_is_heard_and_a_revoked_one_hears_it_first() {
    let ctl = controller(fast());
    let subscribed = ctl.events.subscribe();
    let (leaver, revoked) = (id(51), id(52));
    let (s_leaver, s_revoked) = (node_shared(), node_shared());
    let t = target(&ctl, pin_of(&ctl.id));
    let n_leaver = spawn_node(t.clone(), leaver.clone(), Arc::clone(&s_leaver), "leaver");
    let n_revoked = spawn_node(t, revoked.clone(), Arc::clone(&s_revoked), "revoked-first");
    ctl.registry.set_desired(vec![
        entry(&leaver, DesiredState::Approved, Default::default()),
        entry(&revoked, DesiredState::Approved, Default::default()),
    ]);
    wait_for("both approved", 5, || {
        [&leaver, &revoked].iter().all(|n| {
            summary(&ctl, n).is_some_and(|s| s.connected && s.state == NodeState::Approved)
        })
    });

    // Logging out: the machine says so, the controller acknowledges, the
    // machine closes, and the app hears `nodes.left` — the controller
    // forgets nothing itself.
    let told = s_leaver.request_leave();
    told.recv_timeout(Duration::from_secs(5))
        .expect("the controller acknowledged the leave");
    wait_for("nodes.left", 5, || {
        subscribed
            .try_iter()
            .any(|l| l.contains("\"nodes.left\"") && l.contains(&leaver.node_id()))
    });
    assert!(matches!(n_leaver.thread.join().unwrap(), Ended::Dropped(_)));
    assert_eq!(summary(&ctl, &leaver).unwrap().state, NodeState::Approved);

    // Revoked: however busy the machine is pushing, it reads why before
    // its connection goes (the controller closes gracefully).
    for _ in 0..5 {
        s_revoked.set_link(|l| l.error = Some("x".repeat(64 * 1024)));
    }
    ctl.registry.set_desired(vec![entry(
        &revoked,
        DesiredState::Revoked,
        Default::default(),
    )]);
    assert_eq!(n_revoked.thread.join().unwrap(), Ended::Revoked);
}
