//! The link: the handshake and the hello gate, the allow-list applied live,
//! the caps on connections, pre-auth and an unread queue, and how the host
//! closes a link. Driven over TLS against the built binary (common/).

mod common;

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use santree_remote_client::proto::ErrorCode;
use santree_remote_client::{RemoteClient, RemoteError};
use santree_remote_tls::{Identity, Refusal};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};
use tokio::net::TcpStream;

use common::*;

// ── handshake ─────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_version_refusal_and_the_hello_gate() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.raw().await;

    // Garbage and blank lines get no answer; the next request still works.
    raw.send_line("not json").await;
    raw.send_line("").await;

    let early = raw.call("pty.sessions", json!({})).await;
    assert_eq!(early["err"]["code"], "bad_request");
    assert_eq!(early["err"]["msg"], "send hello first");
    // hooks.push is not served on the link, before hello or after.
    let push = json!({"event": "Stop", "env": [], "stdin": ""});
    assert_eq!(
        raw.call("hooks.push", push.clone()).await["err"]["code"],
        "bad_request"
    );

    let refused = raw.hello(99).await;
    assert_eq!(refused["err"]["code"], "version");
    assert_eq!(refused["err"]["protocol"], 1);

    let hello = raw.hello(1).await["ok"].clone();
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["version"], "0.1.0");
    assert_eq!(hello["home"], dir.path().to_str().unwrap());
    assert_eq!(hello["projectsRoot"], host.root_str());
    assert_eq!(hello["hookBin"], BIN);
    assert_eq!(
        hello["features"],
        json!(["workspaces.list", "workspaces.icon"])
    );
    let boot = hello["bootId"].as_str().unwrap();
    assert_eq!(boot.len(), 16);
    assert!(boot.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(!hello["hostname"].as_str().unwrap().is_empty());
    assert!(raw
        .ok("pty.sessions", json!({}))
        .await
        .as_array()
        .unwrap()
        .is_empty());
    let push = raw.call("hooks.push", push).await;
    assert_eq!(push["err"]["code"], "bad_request");
    assert!(push["err"]["msg"].as_str().unwrap().contains("hook socket"));
    // hello is repeatable, and the boot is the same.
    assert_eq!(raw.hello(1).await["ok"]["bootId"], boot);
    let unknown = raw.call("pty.teleport", json!({})).await;
    assert_eq!(unknown["err"]["code"], "bad_request");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_client_handshakes_and_is_refused_cleanly() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let (r, w) = tokio::io::split(host.tls().await);
    let client = RemoteClient::new(r, w);
    let early = client.pty_sessions().await.unwrap_err();
    assert_eq!(early.code(), Some(&ErrorCode::BadRequest));
    let refused = client
        .call::<santree_remote_client::proto::m::Hello>(
            &santree_remote_client::proto::HelloParams {
                protocol: 2,
                client: "santree/test".into(),
                owner: "o".into(),
            },
        )
        .await
        .unwrap_err();
    match refused {
        RemoteError::Remote(e) => {
            assert_eq!(e.code, ErrorCode::Version);
            assert_eq!(e.protocol, Some(1));
        }
        other => panic!("{other:?}"),
    }
    assert!(!client.is_closed());
    let hello = client.hello("santree/test", "o").await.unwrap();
    assert_eq!(hello.version, "0.1.0");
    assert!(hello.supports::<santree_remote_client::proto::m::WorkspacesList>());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unlisted_key_gets_access_denied_on_its_first_read() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let stranger = Identity::generate().unwrap();
    // TLS 1.3: the client's side of the handshake completes…
    let tls = host.tls_as(&stranger).await;
    let mut raw = Raw::over(tls);
    // …and the refusal is the first read. Nothing is written first: the host
    // may have closed by then, and the write would fail instead.
    let mut line = String::new();
    let e = tokio::time::timeout(WAIT, raw.reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(Refusal::of(&e), Some(Refusal::NotEnrolled), "{e}");

    // A client pinning another host key refuses the host itself.
    let tcp = TcpStream::connect(host.addr).await.unwrap();
    let e =
        santree_remote_tls::connect(santree_remote_tls::client_config(&host.node, [7; 32]), tcp)
            .await
            .unwrap_err();
    assert_eq!(Refusal::of(&e), Some(Refusal::HostKeyMismatch), "{e}");
}

// ── the allow-list, live ──────────────────────────────────────────────────

/// A node taken off the allow-list mid-connection loses its links and the
/// PTYs it opened within 2 s; another node keeps both.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_node_removed_from_the_allow_list_loses_its_links_and_ptys() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let other = Identity::generate().unwrap();
    write_allow(&host.allow_list(), &[&host.node, &other]);
    // The watch polls once a second: retried until it admits their key.
    let deadline = Instant::now() + WAIT;
    let mut theirs = loop {
        let mut raw = Raw::over(host.tls_as(&other).await);
        // A refused link may break before the refusal is read: the write
        // then fails, and the next attempt follows.
        let hello = r#"{"id":1,"m":"hello","p":{"protocol":1,"client":"x","owner":"o"}}"#;
        if raw.try_send_line(hello).await {
            let mut line = String::new();
            let read = tokio::time::timeout(WAIT, raw.reader.read_line(&mut line))
                .await
                .unwrap();
            if matches!(read, Ok(n) if n > 0) {
                break raw;
            }
        }
        assert!(Instant::now() < deadline, "their key was never admitted");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let their_pty = theirs.ok("pty.open", open(&host, "sleep", &["30"])).await["id"].clone();
    let mut mine = host.greeted().await;
    let my_pty = mine.ok("pty.open", open(&host, "sleep", &["30"])).await["id"].clone();

    let removed = Instant::now();
    write_allow(&host.allow_list(), &[&host.node]);
    theirs.closed(Duration::from_secs(2)).await;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let ids: Vec<Value> = mine
            .ok("pty.sessions", json!({}))
            .await
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].clone())
            .collect();
        if ids == vec![my_pty.clone()] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "their PTY {their_pty} still open after {:?}: {ids:?}",
            removed.elapsed()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Their key is now refused outright; mine still works.
    let mut again = Raw::over(host.tls_as(&other).await);
    let mut line = String::new();
    let e = again.reader.read_line(&mut line).await.unwrap_err();
    assert_eq!(Refusal::of(&e), Some(Refusal::NotEnrolled));
    mine.ok("pty.close", json!({"id": my_pty})).await;

    // The file gone: fail closed, even for the node that was allowed.
    std::fs::remove_file(host.allow_list()).unwrap();
    mine.closed(Duration::from_secs(3)).await;
}

// ── caps ──────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caps_on_ptys_requests_and_connections() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;

    // 64 PTYs on the host; the 65th is `busy`.
    for _ in 0..64 {
        raw.ok("pty.open", open(&host, "sleep", &["30"])).await;
    }
    let refused = raw.call("pty.open", open(&host, "sleep", &["30"])).await;
    assert_eq!(refused["err"]["code"], "busy", "{refused}");

    // 32 requests running on one connection; the 33rd is `busy`.
    let cwd = host.root_str();
    for _ in 0..32 {
        raw.send("exec.run", json!({"cwd": cwd, "argv": ["sleep", "2"]}))
            .await;
    }
    let over = raw.call("fs.stat", json!({"path": "/"})).await;
    assert_eq!(over["err"]["code"], "busy", "{over}");

    // Four connections per node; a fifth is closed at once.
    let mut held = vec![];
    for _ in 0..3 {
        held.push(host.greeted().await);
    }
    let mut fifth = host.raw().await;
    fifth.closed(WAIT).await;
    drop(held);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pre_auth_slots_on_loopback_and_the_handshake_deadline() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    // The host accepts in order and takes a pre-auth slot at once, so every
    // connection made before another holds its slot by the time that one is
    // accepted.
    //
    // Loopback (every VPN peer, every container) is not one address's three
    // slots: a local client holding a few silent connections leaves the
    // others room to handshake.
    let mut silent: Vec<TcpStream> = connect_many(host.addr, 8).await;
    let mut raw = host.greeted().await;
    raw.ok("pty.sessions", json!({})).await;
    drop(raw);
    // Loopback's own pool is full at LOOPBACK_PREAUTH…
    let rest = daedalus_session_host::preauth::LOOPBACK_PREAUTH - silent.len();
    silent.extend(connect_many(host.addr, rest).await);
    // …so one more is closed without a handshake.
    let mut over = TcpStream::connect(host.addr).await.unwrap();
    let mut buf = [0u8; 1];
    let n = tokio::time::timeout(WAIT, over.read(&mut buf))
        .await
        .unwrap()
        .unwrap_or(0);
    assert_eq!(n, 0, "the connection past the pool was served");
    // The silent ones are cut at the handshake deadline (5 s).
    let started = Instant::now();
    for mut s in silent {
        let n = tokio::time::timeout(WAIT, s.read(&mut buf))
            .await
            .unwrap()
            .unwrap_or(0);
        assert_eq!(n, 0);
    }
    assert!(started.elapsed() < Duration::from_secs(6));
    // Then the slots are free again.
    let mut raw = host.greeted().await;
    raw.ok("pty.sessions", json!({})).await;
}

async fn connect_many(addr: SocketAddr, n: usize) -> Vec<TcpStream> {
    let mut out = Vec::new();
    for _ in 0..n {
        out.push(TcpStream::connect(addr).await.unwrap());
    }
    out
}

/// A client that stops reading fills its queue; the link is dropped and its
/// sessions parked, alive, for the next connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_stops_reading_is_dropped_and_its_session_parked() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    let id = raw
        .ok(
            "pty.open",
            open(
                &host,
                "sh",
                &["-c", "while :; do echo spam spam spam spam spam; done"],
            ),
        )
        .await["id"]
        .clone();
    raw.send("pty.attach", json!({"id": id, "anchor": "fresh"}))
        .await;
    // Read nothing until the host gives up on this link.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let conns = read_status(&host.status_file())["connections"]
            .as_array()
            .unwrap()
            .len();
        if conns == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "the link was never dropped");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    drop(raw);
    let mut next = host.greeted().await;
    let listed = next.ok("pty.sessions", json!({})).await;
    assert_eq!(listed[0]["id"], id);
    assert_eq!(listed[0]["alive"], true);
    assert_eq!(listed[0]["attached"], false, "parked");
    next.ok("pty.close", json!({"id": id})).await;
}

// ── how the host closes a link ────────────────────────────────────────────

/// The host ends a link with TLS `close_notify`, so the node reads a close
/// (here, a revocation) rather than a cut.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_link_the_host_closes_ends_with_close_notify() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    write_allow(&host.allow_list(), &[]);
    let mut rest = Vec::new();
    let read = tokio::time::timeout(WAIT, raw.reader.read_to_end(&mut rest))
        .await
        .expect("the host did not close the link");
    assert!(read.is_ok(), "the link was cut, not closed: {read:?}");
}
