use std::sync::atomic::AtomicBool;
use std::time::Instant;

use santree_remote_tls::Identity;
use tokio::sync::{mpsc, oneshot};

use super::conn::Out;
use super::*;

fn options(root: &std::path::Path) -> Options {
    Options {
        hostname: "h".into(),
        user: "u".into(),
        home: "/h".into(),
        projects_root: root.to_path_buf(),
        hook_bin: "/bin/true".into(),
        workspaces: root.join("none.json"),
        workspace_icons: root.join("icons"),
        hook_queue_cap: 10,
    }
}

/// An allow-list file naming `nodes`, as the controller writes it.
fn write_allow(path: &std::path::Path, nodes: &[&Identity]) {
    use std::os::unix::fs::PermissionsExt;
    let entries: Vec<String> = nodes
        .iter()
        .map(|n| {
            let key = n.public_key();
            format!(
                r#"{{"id":"{}","publicKey":"{}"}}"#,
                crate::allow::node_id_of(&key),
                santree_remote_tls::key_hex(&key)
            )
        })
        .collect();
    let temp = path.with_extension("tmp");
    std::fs::write(
        &temp,
        format!(r#"{{"schemaVersion":1,"nodes":[{}]}}"#, entries.join(",")),
    )
    .unwrap();
    std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::rename(&temp, path).unwrap();
}

fn node(id: &Identity) -> String {
    crate::allow::node_id_of(&id.public_key())
}

fn open(daemon: &Daemon, root: &std::path::Path, node: &str, argv: &[&str]) -> Outcome {
    daemon.pty_open(
        PtyOpenParams {
            cwd: Some(root.to_string_lossy().into_owned()),
            command: argv[0].into(),
            args: argv[1..].iter().map(|a| a.to_string()).collect(),
            cols: 80,
            rows: 24,
            owner: "o".into(),
            label: "t".into(),
            ..Default::default()
        },
        node.into(),
    )
}

fn id_of(outcome: Outcome) -> SessionId {
    serde_json::from_str::<SessionInfo>(outcome.unwrap().get())
        .unwrap()
        .id
}

fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn exited_unattached_sessions_are_reaped_and_live_ones_are_not() {
    let dir = tempfile::tempdir().unwrap();
    let a = Identity::generate().unwrap();
    let list = dir.path().join("allow.json");
    write_allow(&list, &[&a]);
    let daemon = Daemon::new(options(dir.path()), "b".into(), AllowList::open(list));
    let done = id_of(open(&daemon, dir.path(), &node(&a), &["true"]));
    let running = id_of(open(&daemon, dir.path(), &node(&a), &["sleep", "30"]));
    wait_for("true exits", || {
        daemon
            .mgr
            .sessions()
            .iter()
            .any(|s| s.id == done && !s.alive)
    });
    // Not yet an hour: both stay.
    daemon.reap(REAP_AFTER);
    assert_eq!(daemon.mgr.sessions().len(), 2);
    // Aged out: the exited one goes, the running one stays.
    daemon.reap(Duration::ZERO);
    let left: Vec<SessionId> = daemon.mgr.sessions().iter().map(|s| s.id).collect();
    assert_eq!(left, vec![running]);
    daemon.close_all();
}

#[test]
fn a_node_leaving_loses_only_its_sessions_and_opens_no_more() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (Identity::generate().unwrap(), Identity::generate().unwrap());
    let path = dir.path().join("allow.json");
    write_allow(&path, &[&a, &b]);
    let list = AllowList::open(path.clone());
    let daemon = Daemon::new(options(dir.path()), "b".into(), list.clone());
    let theirs = id_of(open(&daemon, dir.path(), &node(&a), &["sleep", "30"]));
    let mine = id_of(open(&daemon, dir.path(), &node(&b), &["sleep", "30"]));

    write_allow(&path, &[&b]);
    list.reload();
    daemon.close_revoked();
    let left: Vec<SessionId> = daemon.mgr.sessions().iter().map(|s| s.id).collect();
    assert_eq!(left, vec![mine]);
    assert!(daemon.session(theirs).is_none());
    let refused = open(&daemon, dir.path(), &node(&a), &["sleep", "30"]).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Other("access_denied".into()));
    daemon.close_all();
}

/// The hook queue is bounded by bytes as well as count; the
/// oldest go first and are counted as dropped.
#[test]
fn the_hook_queue_is_bounded_by_bytes() {
    let mut q = HookQueue {
        cap: 100,
        max_bytes: 3 * (64 + 1 + 1000),
        bytes: 0,
        last_seq: 0,
        items: VecDeque::new(),
        dropped: 0,
        subscriber: None,
    };
    for _ in 0..5 {
        q.push("e".into(), Vec::new(), vec![0u8; 1000]);
    }
    let seqs: Vec<u64> = q.items.iter().map(|h| h.seq).collect();
    assert_eq!(seqs, vec![3, 4, 5]);
    assert_eq!(q.dropped, 2);
    assert!(q.bytes <= q.max_bytes);
    // One larger than the whole budget is kept, alone.
    q.push("e".into(), Vec::new(), vec![0u8; 10_000]);
    assert_eq!(q.items.len(), 1);
    assert_eq!(q.dropped, 5);
    q.ack(6);
    assert_eq!((q.items.len(), q.bytes), (0, 0));
}

/// Blocking work is counted per node and held until it
/// returns, not reset by a reconnect.
#[test]
fn blocking_work_is_capped_per_node() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(
        options(dir.path()),
        "b".into(),
        AllowList::open(dir.path().join("allow.json")),
    );
    let held: Vec<_> = (0..MAX_BLOCKING_PER_NODE)
        .map(|_| daemon.permit("a").unwrap())
        .collect();
    assert_eq!(
        daemon.permit("a").unwrap_err().code,
        ErrorCode::Other("busy".into())
    );
    assert!(daemon.permit("b").is_ok(), "another node is not affected");
    drop(held);
    assert!(daemon.permit("a").is_ok());
}

/// A `pty.write` into a terminal that does not read its
/// input waits on the session's own input thread, never the blocking
/// pool; a full queue is `busy`; and a revocation closes the session at
/// once regardless, which ends the stuck write.
#[test]
fn a_terminal_that_does_not_read_cannot_pin_writes_or_the_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let a = Identity::generate().unwrap();
    let path = dir.path().join("allow.json");
    write_allow(&path, &[&a]);
    let list = AllowList::open(path.clone());
    let daemon = Daemon::new(options(dir.path()), "b".into(), list.clone());
    // Raw mode, so the line discipline stops taking input once full.
    let id = id_of(open(
        &daemon,
        dir.path(),
        &node(&a),
        &["sh", "-c", "stty raw -echo; exec sleep 60"],
    ));
    std::thread::sleep(Duration::from_millis(500));

    let mut stuck = daemon.pty_input(id, vec![b'x'; 512 * 1024]).unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        matches!(stuck.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
        "the write went in: the terminal was reading"
    );
    let full = daemon
        .pty_input(id, vec![b'y'; PTY_INPUT_QUEUE])
        .unwrap_err();
    assert_eq!(full.code, ErrorCode::Other("busy".into()));

    write_allow(&path, &[]);
    list.reload();
    let started = Instant::now();
    daemon.close_revoked();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the revocation waited {:?}",
        started.elapsed()
    );
    assert!(daemon.session(id).is_none());
    let gone = daemon.pty_input(id, b"z".to_vec()).unwrap_err();
    assert_eq!(gone.code, ErrorCode::NotFound);
    // The kernel may keep that write parked after the close (`Input`):
    // it is counted against MAX_INPUT_THREADS, never the pool.
    assert!(daemon.inputs.load(Ordering::Acquire) <= 1);
    let _ = stuck.try_recv();
    daemon.close_all();
}
/// An attach that fails on a session this host still holds is `io`, not
/// `not_found`: the client would forget a session that is still there.
#[test]
fn a_failed_attach_to_a_known_session_is_io() {
    let dir = tempfile::tempdir().unwrap();
    let a = Identity::generate().unwrap();
    let list = dir.path().join("allow.json");
    write_allow(&list, &[&a]);
    let daemon = Daemon::new(options(dir.path()), "b".into(), AllowList::open(list));
    let id = id_of(open(&daemon, dir.path(), &node(&a), &["sleep", "30"]));
    let (tx, _rx) = mpsc::unbounded_channel();
    let conn = Conn {
        id: 1,
        node: node(&a),
        out: Out {
            tx,
            conn: 1,
            queued: Default::default(),
            full: Default::default(),
            close: Default::default(),
        },
        closed: AtomicBool::new(false),
    };
    // Gone from the manager, still in the daemon's map.
    daemon.mgr.close(id).unwrap();
    let attach = |id| {
        let params = PtyAttachParams {
            id,
            anchor: Anchor::Fresh,
        };
        match daemon.pty_attach(&conn, 7, params) {
            Reply::Answer(Err(e)) => e.code,
            _ => panic!("the attach did not fail"),
        }
    };
    assert_eq!(attach(id), ErrorCode::Io);
    lock(&daemon.sessions).remove(&id);
    assert_eq!(attach(id), ErrorCode::NotFound);
    daemon.close_all();
}

/// The first ping comes after one [`PING_INTERVAL`], not at once (on paused
/// time: nothing else on the connection is timed).
#[tokio::test(start_paused = true)]
async fn the_first_ping_comes_after_one_interval() {
    use tokio::io::AsyncBufReadExt;
    let dir = tempfile::tempdir().unwrap();
    let a = Identity::generate().unwrap();
    let list = dir.path().join("allow.json");
    write_allow(&list, &[&a]);
    let daemon = Daemon::new(options(dir.path()), "b".into(), AllowList::open(list));
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    let peer = Peer {
        key: a.public_key(),
        node: node(&a),
        addr: "127.0.0.1:1".parse().unwrap(),
    };
    let started = tokio::time::Instant::now();
    tokio::spawn(serve_conn(daemon, theirs, peer));
    let mut lines = tokio::io::BufReader::new(ours).lines();
    let first = lines.next_line().await.unwrap().unwrap();
    assert_eq!(first, r#"{"e":"ping"}"#);
    assert_eq!(started.elapsed(), PING_INTERVAL);
}
