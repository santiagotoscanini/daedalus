//! santree through a node's agent to the session host, end to end and in
//! process: the real host, the real controller registry (allow-list writer,
//! status reader, the link), a node connected to it over the real link, the
//! node's santree socket, and santree's own `RemoteClient` on it.
//!
//! 1. The app approves the node with santree on: the controller writes the
//!    allow-list, and the node's policy carries the host's address and key
//!    (read from the host's status file) — kept in its policy.json.
//! 2. santree connects to the node's socket, reads `ok`, and speaks protocol
//!    v1 through it: hello, a PTY opened, a command's output back.
//! 3. The controller reports the host: running, the node's connection by
//!    name, its live PTY.
//! 4. The app turns santree off: out of the allow-list, the host cuts the
//!    link within seconds, and the node's socket answers `santree_off`.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use daedalus_agent::api::wire::{DesiredState, SessionHostState};
use daedalus_agent::config::{Config as AgentConfig, Mode, SessionHostConfig};
use daedalus_agent::identity::{digest, format_fingerprint, Identity};
use daedalus_agent::link::controller::{listen, DesiredEntry, Limits, Registry};
use daedalus_agent::link::node::{connect_once, hello_of, Cadence, Target};
use daedalus_agent::link::tls::Client;
use daedalus_agent::link::wire::Policy;
use daedalus_agent::link::LinkKeys;
use daedalus_agent::role::Role;
use daedalus_agent::rpc::Events;
use daedalus_agent::session_host::SessionHost;
use daedalus_agent::shared::Shared;
use daedalus_agent::util::Shutdown;
use daedalus_session_host::{Config, Server};
use santree_remote_client::proto::{Anchor, PtyOpenParams};
use santree_remote_client::{PtyEvent, RemoteClient};
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;

const WAIT: Duration = Duration::from_secs(10);

async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let until = Instant::now() + WAIT;
    while !f() {
        assert!(Instant::now() < until, "waited for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The node's first line on its santree socket, a byte at a time so
/// nothing of the protocol after it is taken.
async fn verdict(s: &mut UnixStream) -> Value {
    let mut line = Vec::new();
    loop {
        let b = s.read_u8().await.unwrap();
        if b == b'\n' {
            return serde_json::from_slice(&line).unwrap();
        }
        line.push(b);
    }
}

fn entry(node: &Identity, santree: bool) -> DesiredEntry {
    DesiredEntry {
        id: node.node_id(),
        public_key: *node.public_key().as_bytes(),
        state: DesiredState::Approved,
        policy: Policy {
            santree,
            ..Policy::default()
        },
        name: Some("MacBook".into()),
        offer_lemonade: false,
    }
}

fn listed(allow: &Path) -> Vec<String> {
    let doc: Value = serde_json::from_slice(&std::fs::read(allow).unwrap()).unwrap();
    doc["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn santree_reaches_the_session_host_through_the_nodes_agent() {
    let dir = tempfile::Builder::new()
        .prefix("dsht")
        .tempdir_in("/tmp")
        .unwrap();
    let d = dir.path().to_path_buf();
    // The node's kept policy lands in this data directory, not a real one.
    std::env::set_var("DAEDALUS_AGENT_DATA_DIR", d.join("node"));
    std::fs::create_dir_all(d.join("node")).unwrap();
    std::fs::create_dir_all(d.join("projects")).unwrap();
    let allow = d.join("allow.json");

    // The session host.
    let server = Server::bind(Config {
        listen: vec!["127.0.0.1:0".parse().unwrap()],
        state_dir: d.join("state"),
        allow_list: allow.clone(),
        hook_socket: d.join("hook.sock"),
        projects_root: d.join("projects"),
        workspaces: d.join("workspaces.json"),
        workspace_icons: d.join("icons"),
        hook_bin: "/bin/true".into(),
        file: None,
    })
    .await
    .unwrap();
    let host_addr = server.local_addrs()[0];
    let host_key = server.host_key();
    let (stop_host, host_stopped) = tokio::sync::oneshot::channel::<()>();
    let serving = tokio::spawn(server.run(async {
        let _ = host_stopped.await;
    }));

    // The controller: its registry keeps the allow-list, its listener takes
    // the node's link, and it follows the host's status file.
    let ctl = Identity::from_seed([200; 32]);
    let registry = Arc::new(
        Registry::new(Arc::new(Events::default()), Limits::default())
            .with_allow_list(allow.clone()),
    );
    let listener = listen("127.0.0.1:0".parse().unwrap(), &ctl, Arc::clone(&registry)).unwrap();
    let host = SessionHost::new(
        SessionHostConfig {
            address: host_addr.to_string(),
            allow_list: allow.clone(),
            status_file: d.join("state").join("status.json"),
            bin: "/nix/store/x-daedalus-session-host/bin/daedalus-session-host".into(),
            config: "/nix/store/y-daedalus-session-host.json".into(),
        },
        Arc::clone(&registry),
    );
    wait_for("the host's status file", || {
        host.poll();
        registry.session_host().is_some()
    })
    .await;
    assert_eq!(registry.session_host().unwrap().public_key, hex(&host_key));

    // The node, linked to the controller as a paired machine.
    let node = Identity::from_seed([1; 32]);
    let shared = Arc::new(Shared::new(
        Role::of(Mode::Node),
        daedalus_agent::facts::Facts::default(),
        daedalus_agent::state::State::default(),
        Policy::default(),
        Shutdown::new(),
    ));
    let pin = digest(ctl.public_key().as_bytes());
    shared.link.set_keys(LinkKeys {
        pin: Some(format_fingerprint(&pin)),
        address: None,
    });
    let stop_link = Shutdown::new();
    let link = {
        let (shared, stop, node) = (Arc::clone(&shared), stop_link.clone(), node.clone());
        let target = Target {
            address: listener.local_addr.to_string(),
            found_via: daedalus_agent::link::FoundVia::Config,
            pin,
        };
        let config = d.join("node").join("config.toml");
        std::thread::spawn(move || {
            let hello = hello_of(
                &AgentConfig::default(),
                &node,
                &daedalus_agent::facts::read(),
            );
            let client = Client::new(&node).unwrap();
            connect_once(
                &target,
                &client,
                hello,
                &shared,
                &stop,
                &config,
                &Cadence::default(),
            )
        })
    };

    // 1. The app approves it with santree on.
    registry.set_desired(vec![entry(&node, true)]);
    assert_eq!(listed(&allow), vec![node.node_id()]);
    wait_for("the node's policy", || {
        shared.settings.policy().session_host.is_some()
    })
    .await;
    let told = shared.settings.policy().session_host.unwrap();
    assert_eq!(told.address, host_addr.to_string());
    assert_eq!(told.public_key, hex(&host_key));
    let kept: Value =
        serde_json::from_slice(&std::fs::read(d.join("node").join("policy.json")).unwrap())
            .unwrap();
    assert_eq!(kept["santree"], true);
    assert_eq!(kept["session_host"]["public_key"], hex(&host_key));

    // 2. santree on the node's socket.
    let socket = d.join("node").join("run").join("santree.sock");
    let own = daedalus_agent::os::own_uid().unwrap();
    let _door = daedalus_agent::santree::serve_at(
        &socket,
        Arc::clone(&shared),
        node.clone(),
        Arc::new(move |peer| {
            daedalus_agent::door::peer_allowed(peer, &daedalus_agent::door::unix_allowed(own, &[]))
        }),
    )
    .unwrap();
    // The host reads its allow-list every second: until it has, it turns
    // the key away after `ok` (the stream ends), and santree tries again.
    let until = Instant::now() + WAIT;
    let client = loop {
        let mut stream = UnixStream::connect(&socket).await.unwrap();
        let ok = verdict(&mut stream).await;
        assert_eq!(ok["ok"]["host"], host_addr.to_string(), "{ok}");
        assert_eq!(ok["ok"]["node"], node.node_id());
        let (r, w) = stream.into_split();
        let client = RemoteClient::new(r, w);
        match client.hello("santree/e2e", "owner-a").await {
            Ok(hello) => {
                assert_eq!(hello.protocol, 1);
                break client;
            }
            Err(e) => {
                assert!(e.is_disconnected(), "{e:?}");
                assert!(Instant::now() < until, "the host never admitted the node");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    };
    let info = client
        .pty_open(&PtyOpenParams {
            cwd: Some(d.join("projects").to_string_lossy().into_owned()),
            command: "sh".into(),
            cols: 80,
            rows: 24,
            owner: "owner-a".into(),
            label: "tree:e2e".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let (attach, mut rx) = client.pty_attach(info.id, Anchor::Fresh).await.unwrap();
    let mut seen = attach.data;
    client
        .pty_write(info.id, b"echo round-$((20+22))\n".to_vec())
        .await
        .unwrap();
    let until = tokio::time::Instant::now() + WAIT;
    while !String::from_utf8_lossy(&seen).contains("round-42") {
        match tokio::time::timeout_at(until, rx.recv()).await {
            Ok(Some(PtyEvent::Data(bytes))) => seen.extend(bytes),
            other => panic!("{other:?}"),
        }
    }

    // 3. The controller's view of the host.
    wait_for("the node's connection in the status", || {
        host.poll();
        let s = host.status();
        s.state == SessionHostState::Running
            && s.live_ptys == 1
            && s.connections.len() == 1
            && s.connections[0].node == node.node_id()
            && s.connections[0].name.as_deref() == Some("MacBook")
    })
    .await;
    assert!(host.status().restart_pending, "another build is installed");

    // 4. santree off: the host cuts the link, the socket says why.
    registry.set_desired(vec![entry(&node, false)]);
    assert!(listed(&allow).is_empty());
    tokio::time::timeout(WAIT, client.closed())
        .await
        .expect("the host cut the link");
    wait_for("santree off on the node", || !shared.settings.policy().santree).await;
    let mut again = UnixStream::connect(&socket).await.unwrap();
    assert_eq!(verdict(&mut again).await["err"]["code"], "santree_off");

    stop_link.stop();
    link.join().unwrap();
    let _ = stop_host.send(());
    serving.await.unwrap();
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
