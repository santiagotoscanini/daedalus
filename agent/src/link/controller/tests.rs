//! The link end to end, in process: a controller listening on loopback and
//! machines connecting to it over real TLS, each with its own key, its own
//! `Shared` and a scratch store.

use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::*;
use crate::claude::Report;
use crate::config::{Config, Mode};
use crate::identity::{digest, Identity};
use crate::link::node::{connect_once, hello_of, Cadence, Ended, Target};
use crate::link::tls as ltls;
use crate::role::Role;
use crate::state::State;
use crate::status::Shared;

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
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<Ended>,
    store: PathBuf,
}

impl Node {
    fn stop(self) -> Ended {
        self.stop.store(true, Ordering::Relaxed);
        let e = self.thread.join().unwrap();
        let _ = std::fs::remove_dir_all(self.store.parent().unwrap());
        e
    }
}

fn target(ctl: &Ctl, pin: Option<[u8; 32]>) -> Target {
    Target {
        address: ctl.listener.local_addr.to_string(),
        found_via: "config".into(),
        pin,
        pinned_via: pin.map(|_| "config"),
    }
}

fn pin_of(i: &Identity) -> [u8; 32] {
    digest(i.public_key().as_bytes())
}

fn spawn_node(t: Target, nid: Identity, shared: Arc<Shared>, name: &str) -> Node {
    let stop = Arc::new(AtomicBool::new(false));
    let store = scratch(name).join(crate::link::node::STORE_FILE);
    let thread = {
        let (stop, shared, store) = (Arc::clone(&stop), Arc::clone(&shared), store.clone());
        std::thread::spawn(move || {
            let hello = hello_of(&Config::default(), &nid, &facts());
            let client = ltls::Client::new(&nid).unwrap();
            connect_once(&t, &client, hello, &shared, &stop, &store, &cadence())
        })
    };
    Node {
        shared,
        stop,
        thread,
        store,
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
        providers: Default::default(),
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
        target(&ctl, Some(pin_of(&ctl.id))),
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
    assert_eq!(
        status["controller"]["unconfirmed"], false,
        "pinned in config"
    );
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
    // /nodes/metrics: the machine's series, labelled by node.
    let m = ctl.registry.metrics();
    let labels = format!(
        "host=\"{}\",node=\"{}\"",
        crate::telemetry::escape_label(&crate::facts::hostname()),
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
fn an_unknown_key_waits_and_is_approved_without_reconnecting() {
    let ctl = controller(fast());
    let rx = ctl.events.subscribe();
    let nid = id(2);
    let node = spawn_node(
        target(&ctl, Some(pin_of(&ctl.id))),
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
    let t = target(&ctl, Some(pin_of(&ctl.id)));
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
fn a_controller_with_another_key_is_refused_pinned_or_first_used() {
    let ctl = controller(fast());
    let nid = id(4);
    // Pinned to another key: refused, and the key that came is named.
    let wrong = pin_of(&id(99));
    let node = spawn_node(
        target(&ctl, Some(wrong)),
        nid.clone(),
        node_shared(),
        "wrong-pin",
    );
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

    // Trust on first use: the key is kept, and a controller with another
    // key is refused afterwards.
    let node = spawn_node(target(&ctl, None), nid.clone(), node_shared(), "tofu");
    wait_for("connected", 5, || {
        summary(&ctl, &nid).is_some_and(|s| s.connected)
    });
    let stored = crate::link::node::load_store(&node.store).unwrap();
    assert_eq!(stored.fingerprint, ctl.id.fingerprint());
    assert_eq!(
        node.shared.link().unwrap().pinned_via.as_deref(),
        Some("tofu")
    );
    // Trusted on first use: approved, the link works, and the page says the
    // key is not pinned.
    assert!(node.shared.link().unwrap().unconfirmed);
    approve(&ctl.registry, &nid, claude_policy());
    wait_for("approved over a first-use key", 5, || {
        node.shared.policy() == claude_policy()
    });
    assert!(node.shared.link().unwrap().unconfirmed);
    let store = node.store.clone();
    node.stop.store(true, Ordering::Relaxed);
    node.thread.join().unwrap();

    let impostor = {
        let cid = id(201);
        let registry = Arc::new(Registry::new(&cid, events(), fast()));
        listen("127.0.0.1:0".parse().unwrap(), &cid, registry).unwrap()
    };
    let resolved = crate::link::node::resolve_target(
        Some(&impostor.local_addr.to_string()),
        None,
        crate::link::node::load_store(&store).as_ref(),
        || None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(resolved.pinned_via, Some("tofu"));
    let stop = AtomicBool::new(false);
    let hello = hello_of(&Config::default(), &nid, &facts());
    let ended = connect_once(
        &resolved,
        &ltls::Client::new(&nid).unwrap(),
        hello,
        &node_shared(),
        &stop,
        &store,
        &cadence(),
    );
    assert!(matches!(ended, Ended::KeyChanged { .. }), "{ended:?}");
    // Never re-pinned.
    assert_eq!(
        crate::link::node::load_store(&store).unwrap().fingerprint,
        ctl.id.fingerprint()
    );
    let _ = std::fs::remove_dir_all(store.parent().unwrap());
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
        target(&ctl, Some(pin_of(&ctl.id))),
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
        target(&ctl, Some(pin_of(&ctl.id))),
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
        .connect(sock, Some(pin_of(&ctl.id)), Duration::from_secs(5))
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
        target(&quiet, Some(pin_of(&quiet.id))),
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
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let (shared, stop, nid) = (Arc::clone(&shared), Arc::clone(&stop), nid.clone());
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
    stop.store(true, Ordering::Relaxed);
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
    cshared.set_controller_info(crate::api::wire::ControllerInfo {
        public_key: cid.public_key_hex(),
        fingerprint: cid.fingerprint(),
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

    // A machine connects and waits.
    let nid = id(40);
    let shared = node_shared();
    let node = spawn_node(
        Target {
            address: listener.local_addr.to_string(),
            found_via: "config".into(),
            pin: Some(pin_of(&cid)),
            pinned_via: Some("config"),
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

    // Approved: the policy reaches the machine without a reconnect.
    let set = serde_json::json!({"id":7,"m":"nodes.set_desired","p":{"nodes":[
        {"id": n, "public_key": nid.public_key_hex(), "state":"approved",
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
