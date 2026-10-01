//! santree's door and pipe in process: a stand-in session host on loopback
//! (the agent's own TLS server, any node key admitted, each connection
//! handed to a closure), the pipe driven over a unix socket pair, and the
//! door served on a scratch socket. The real session host is the interop
//! crate's (session-host/interop).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rustls::{ServerConnection, StreamOwned};

use super::*;
use crate::config::Mode;
use crate::door::{peer_allowed, unix_allowed};
use crate::identity::format_fingerprint;
use crate::link::wire::SessionHost;
use crate::role::Role;
use crate::state::State;

type HostStream = StreamOwned<ServerConnection, TcpStream>;

fn host_id() -> Identity {
    Identity::from_seed([9; 32])
}

fn node_id() -> Identity {
    Identity::from_seed([8; 32])
}

/// A session host stand-in: TLS 1.3 under `host_id`'s key, every node key
/// admitted, each connection handed to `serve` on a thread of its own.
fn host(serve: impl Fn(HostStream) + Send + Sync + 'static) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let cfg = tls::server_config(&host_id()).unwrap();
    let serve = Arc::new(serve);
    std::thread::spawn(move || {
        for sock in listener.incoming() {
            let Ok(sock) = sock else { return };
            let (cfg, serve) = (Arc::clone(&cfg), Arc::clone(&serve));
            std::thread::spawn(move || {
                serve(StreamOwned::new(ServerConnection::new(cfg).unwrap(), sock));
            });
        }
    });
    addr
}

/// The host finishes its side of the handshake and nothing else.
fn handshake(s: &mut HostStream) {
    while s.conn.is_handshaking() {
        if s.conn.complete_io(&mut s.sock).is_err() {
            return;
        }
    }
}

/// Send close_notify, as a host that is done sending does.
fn say_goodbye(s: &mut HostStream) {
    s.conn.send_close_notify();
    while s.conn.wants_write() {
        if s.conn.write_tls(&mut s.sock).is_err() {
            return;
        }
    }
}

/// An echoing host that reports how each connection ended: `close_notify`,
/// or the error.
fn echo_host() -> (SocketAddr, mpsc::Receiver<String>) {
    let (tx, rx) = mpsc::channel();
    let addr = host(move |mut s| {
        let mut buf = vec![0u8; 8192];
        let how = loop {
            match s.read(&mut buf) {
                Ok(0) => {
                    say_goodbye(&mut s);
                    break "close_notify".to_string();
                }
                Ok(n) => {
                    if let Err(e) = s.write_all(&buf[..n]) {
                        break e.to_string();
                    }
                }
                Err(e) => break e.to_string(),
            }
        };
        let _ = tx.send(how);
    });
    (addr, rx)
}

fn host_key() -> String {
    host_id().public_key_hex()
}

fn config() -> Arc<ClientConfig> {
    tls::pinned_client(&node_id(), host_id().public_key().as_bytes()).unwrap()
}

/// santree's end of a unix socket pair as the door hands it over, the
/// write timeout the door would set.
fn conn_of(s: &UnixStream, write_timeout: Duration) -> Conn {
    s.set_write_timeout(Some(write_timeout)).unwrap();
    let (r, w, c, h) = (
        s.try_clone().unwrap(),
        s.try_clone().unwrap(),
        s.try_clone().unwrap(),
        s.try_clone().unwrap(),
    );
    Conn {
        reader: Box::new(r),
        writer: Box::new(w),
        close: Arc::new(move || {
            let _ = c.shutdown(Shutdown::Both);
        }),
        end_writes: Arc::new(move || {
            let _ = h.shutdown(Shutdown::Write);
        }),
        ..Conn::plain(std::io::empty(), std::io::sink())
    }
}

/// A pipe to the host at `addr`: santree's end, and the pipe's thread.
fn piped(addr: SocketAddr, limits: Limits) -> (UnixStream, std::thread::JoinHandle<End>) {
    let tls = dial(&Dialer::Direct, &addr.to_string(), config(), DIAL).unwrap();
    let (santree, agent) = UnixStream::pair().unwrap();
    let conn = conn_of(&agent, limits.write_timeout);
    drop(agent);
    let pipe = std::thread::spawn(move || pipe(conn, tls, &limits));
    (santree, pipe)
}

fn quick() -> Limits {
    Limits {
        write_timeout: Duration::from_millis(300),
        host_silence: Duration::from_millis(500),
    }
}

/// Deterministic bytes that are not a pattern a bug could echo by accident.
fn noise(n: usize) -> Vec<u8> {
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

#[test]
fn the_checks_say_why_in_order() {
    let host = SessionHost {
        address: "box.example.org:7789".into(),
        public_key: "ab".repeat(32),
    };
    let on = Policy {
        santree: true,
        session_host: Some(host.clone()),
        ..Policy::default()
    };
    let code_of =
        |paired, state: Option<LinkState>, p: &Policy| admit(paired, state, p).unwrap_err();
    let e = code_of(false, None, &on);
    assert_eq!(e.code, ErrorCode::Unavailable);
    assert!(e.msg.contains("not paired"), "{}", e.msg);
    for state in [LinkState::Pending, LinkState::Revoked] {
        let what = format!("{state:?}");
        let e = code_of(true, Some(state), &on);
        assert_eq!(e.code, ErrorCode::Unavailable, "{what}");
    }
    assert_eq!(
        code_of(true, Some(LinkState::Approved), &Policy::default()).code,
        ErrorCode::SantreeOff
    );
    let unnamed = Policy {
        session_host: None,
        ..on.clone()
    };
    let e = code_of(true, Some(LinkState::Approved), &unnamed);
    assert!(e.msg.contains("no session host"), "{}", e.msg);
    let bad = Policy {
        session_host: Some(SessionHost {
            public_key: "zz".into(),
            ..host
        }),
        ..on.clone()
    };
    assert_eq!(
        code_of(true, Some(LinkState::Approved), &bad).code,
        ErrorCode::Unavailable
    );
    // A controller that restarts, or one not reached yet: the kept policy
    // stands, and the host's allow-list decides.
    for state in [Some(LinkState::Approved), Some(LinkState::Connecting), None] {
        assert_eq!(
            admit(true, state, &on).unwrap(),
            ("box.example.org:7789".to_string(), [0xab; 32])
        );
    }
}

#[test]
fn the_installer_is_served_and_the_console_user_is_not() {
    // Root, and the user `install` recorded (501); another account at the
    // console (502) is refused, whoever is logged in.
    let allowed = unix_allowed(0, &[501]);
    assert!(peer_allowed(Some(&Peer::Uid(0)), &allowed));
    assert!(peer_allowed(Some(&Peer::Uid(501)), &allowed));
    assert!(!peer_allowed(Some(&Peer::Uid(502)), &allowed));
    assert!(!peer_allowed(None, &allowed));
    assert_eq!(
        refusal(Some(&Peer::Uid(502))),
        "{\"id\":null,\"err\":{\"code\":\"forbidden\",\"msg\":\"uid 502 may not use santree's socket \
         (root and the user who installed the agent may)\"}}\n"
    );
}

#[test]
fn the_first_line_is_the_agents_envelope() {
    assert_eq!(
        ok_line("box.example.org:7789", "0123456789abcdef"),
        format!(
            "{{\"id\":null,\"ok\":{{\"host\":\"box.example.org:7789\",\"node\":\"0123456789abcdef\",\"agent\":\"{}\"}}}}\n",
            crate::VERSION
        )
    );
    assert_eq!(
        error_line(ErrorCode::SantreeOff, "off"),
        "{\"id\":null,\"err\":{\"code\":\"santree_off\",\"msg\":\"off\"}}\n"
    );
}

#[test]
fn a_host_with_another_key_is_host_key_changed_and_a_closed_port_unavailable() {
    let (addr, _) = echo_host();
    let other = tls::pinned_client(&node_id(), &[7; 32]).unwrap();
    let e = dial(&Dialer::Direct, &addr.to_string(), other, DIAL)
        .map(|_| ())
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::HostKeyChanged, "{}", e.msg);

    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let t = Instant::now();
    let e = dial(&Dialer::Direct, &closed.to_string(), config(), DIAL)
        .map(|_| ())
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Unavailable);
    assert!(e.msg.contains("did not answer"), "{}", e.msg);
    assert!(t.elapsed() < Duration::from_secs(6), "{:?}", t.elapsed());
}

#[test]
fn bytes_go_both_ways_whole_and_santrees_end_reaches_the_host_as_close_notify() {
    let (addr, ended) = echo_host();
    let (santree, pipe) = piped(addr, Limits::default());
    let data = noise(4 << 20);
    let writer = {
        let (mut w, data) = (santree.try_clone().unwrap(), data.clone());
        std::thread::spawn(move || {
            let sizes = [1usize, 7, 4093, 65_537, 3000, 16_384];
            let mut at = 0;
            for size in sizes.iter().cycle() {
                if at == data.len() {
                    break;
                }
                let end = (at + size).min(data.len());
                w.write_all(&data[at..end]).unwrap();
                at = end;
            }
            w.shutdown(Shutdown::Write).unwrap();
        })
    };
    let mut back = Vec::new();
    (&santree).read_to_end(&mut back).unwrap();
    writer.join().unwrap();
    assert_eq!(back.len(), data.len());
    assert!(back == data, "the bytes came back changed");
    assert_eq!(
        ended.recv_timeout(Duration::from_secs(5)).unwrap(),
        "close_notify"
    );
    let end = pipe.join().unwrap();
    assert_eq!((end.up, end.down), (4 << 20, 4 << 20));
    assert_eq!(end.by, "santree");
    assert!(!end.refused_key);
}

#[test]
fn the_hosts_close_notify_is_santrees_end_of_stream() {
    let addr = host(|mut s| {
        let _ = s.write_all(b"bye");
        say_goodbye(&mut s);
        // It may still read: santree's end comes after.
        let mut rest = Vec::new();
        let _ = s.read_to_end(&mut rest);
    });
    let (santree, pipe) = piped(addr, Limits::default());
    let mut got = Vec::new();
    (&santree).read_to_end(&mut got).unwrap();
    assert_eq!(got, b"bye");
    // Half-closed: santree may still write, then ends its side.
    (&santree).write_all(b"late").unwrap();
    santree.shutdown(Shutdown::Write).unwrap();
    let end = pipe.join().unwrap();
    assert_eq!(end.by, "the session host");
    assert_eq!((end.up, end.down), (4, 3));
}

#[test]
fn a_santree_that_stops_reading_is_torn_down_at_the_write_timeout() {
    let addr = host(|mut s| {
        let chunk = vec![b'x'; 64 * 1024];
        while s.write_all(&chunk).is_ok() {}
    });
    let (santree, pipe) = piped(addr, quick());
    let t = Instant::now();
    let end = pipe.join().unwrap();
    assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
    assert!(end.by.contains("writing to santree"), "{}", end.by);
    // The pipe stopped reading the host while santree was full: what it
    // holds is bounded by the sockets, not the host's appetite.
    assert!(end.down < 64 << 20, "{}", end.down);
    drop(santree);
}

#[test]
fn a_host_that_stops_reading_is_torn_down_at_the_write_timeout() {
    let addr = host(|mut s| {
        handshake(&mut s);
        std::thread::sleep(Duration::from_secs(20));
    });
    let limits = Limits {
        host_silence: Duration::from_secs(30),
        ..quick()
    };
    let (santree, pipe) = piped(addr, limits);
    let writer = {
        let mut w = santree.try_clone().unwrap();
        std::thread::spawn(move || {
            let chunk = vec![b'y'; 64 * 1024];
            while w.write_all(&chunk).is_ok() {}
        })
    };
    let t = Instant::now();
    let end = pipe.join().unwrap();
    assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
    assert!(end.by.contains("writing to the session host"), "{}", end.by);
    writer.join().unwrap();
}

#[test]
fn a_silent_host_is_taken_for_gone() {
    let addr = host(|mut s| {
        handshake(&mut s);
        std::thread::sleep(Duration::from_secs(20));
    });
    let (santree, pipe) = piped(addr, quick());
    let end = pipe.join().unwrap();
    assert!(end.by.contains("silent"), "{}", end.by);
    let mut rest = Vec::new();
    (&santree).read_to_end(&mut rest).unwrap();
    assert!(rest.is_empty());
}

// ── the door ──────────────────────────────────────────────────────────────

fn scratch(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("dst-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn node_shared(paired: bool, policy: Policy) -> Arc<Shared> {
    let s = Arc::new(Shared::new(
        Role::of(Mode::Node),
        crate::facts::Facts::default(),
        State::default(),
        policy,
        crate::util::Shutdown::new(),
    ));
    s.link.set_keys(crate::link::LinkKeys {
        pin: paired.then(|| format_fingerprint(&[1; 32])),
        address: None,
    });
    s.link.set_status(|l| {
        l.state = Some(if paired {
            LinkState::Approved
        } else {
            LinkState::Unpaired
        })
    });
    s
}

fn santree_on(addr: SocketAddr) -> Policy {
    Policy {
        santree: true,
        session_host: Some(SessionHost {
            address: addr.to_string(),
            public_key: host_key(),
        }),
        ..Policy::default()
    }
}

fn me() -> crate::door::Allow {
    Arc::new(|peer| peer_allowed(peer, &unix_allowed(crate::os::own_uid().unwrap(), &[])))
}

/// The agent's first line, a byte at a time so nothing after it is taken.
fn first_line(s: &UnixStream) -> serde_json::Value {
    let mut line = Vec::new();
    let mut byte = [0u8];
    while (&*s).read(&mut byte).unwrap() == 1 && byte[0] != b'\n' {
        line.push(byte[0]);
    }
    serde_json::from_slice(&line).unwrap()
}

#[test]
fn the_door_says_why_or_pipes() {
    use std::os::unix::fs::PermissionsExt;
    let (addr, _) = echo_host();
    let dir = scratch("door");
    let path = dir.join("run").join("santree.sock");
    let shared = node_shared(false, Policy::default());
    let served = serve_at(&path, Arc::clone(&shared), node_id(), me()).unwrap();
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&path), 0o666, "the peer check is the gate");
    assert_eq!(mode(path.parent().unwrap()), 0o711);

    let ask = || first_line(&UnixStream::connect(&path).unwrap());
    let e = ask();
    assert_eq!(e["id"], serde_json::Value::Null);
    assert_eq!(e["err"]["code"], "unavailable");
    shared.link.set_keys(crate::link::LinkKeys {
        pin: Some(format_fingerprint(&[1; 32])),
        address: None,
    });
    shared
        .link
        .set_status(|l| l.state = Some(LinkState::Approved));
    assert_eq!(ask()["err"]["code"], "santree_off");
    shared.settings.set_policy(santree_on(addr));
    let s = UnixStream::connect(&path).unwrap();
    let ok = first_line(&s);
    assert_eq!(ok["ok"]["host"], addr.to_string());
    assert_eq!(ok["ok"]["node"], node_id().node_id());
    assert_eq!(ok["ok"]["agent"], crate::VERSION);
    (&s).write_all(b"{\"id\":1}\n").unwrap();
    let mut back = [0u8; 9];
    (&s).read_exact(&mut back).unwrap();
    assert_eq!(&back, b"{\"id\":1}\n");
    drop(s);

    // Another key where the box named this one.
    shared.settings.set_policy(Policy {
        session_host: Some(SessionHost {
            address: addr.to_string(),
            public_key: "07".repeat(32),
        }),
        ..santree_on(addr)
    });
    assert_eq!(ask()["err"]["code"], "host_key_changed");
    drop(served);

    // A gate that says no: the door's `forbidden`, nothing dialled.
    let refusing = serve_at(&path, shared, node_id(), Arc::new(|_| false)).unwrap();
    assert_eq!(ask()["err"]["code"], "forbidden");
    drop(refusing);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_fifth_connection_is_busy() {
    let (addr, _) = echo_host();
    let dir = scratch("busy");
    let path = dir.join("run").join("santree.sock");
    let served = serve_at(&path, node_shared(true, santree_on(addr)), node_id(), me()).unwrap();
    let open: Vec<UnixStream> = (0..MAX_CONNECTIONS)
        .map(|_| {
            let s = UnixStream::connect(&path).unwrap();
            assert!(first_line(&s)["ok"].is_object());
            s
        })
        .collect();
    let fifth = UnixStream::connect(&path).unwrap();
    let busy = first_line(&fifth);
    assert_eq!(busy["err"]["code"], "busy", "{busy}");
    // A slot comes back when one leaves.
    drop(open);
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let again = UnixStream::connect(&path).unwrap();
        if first_line(&again)["ok"].is_object() {
            break;
        }
        assert!(Instant::now() < until, "no slot came back");
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(served);
    let _ = std::fs::remove_dir_all(dir);
}
