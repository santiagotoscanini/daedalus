//! The tunnel against a box in the same process: boringtun as the box's
//! responder and smoltcp with an echo server on the link's port behind it —
//! a second, independent WireGuard end, so the machine's side cannot be
//! wrong the same way at both ends. (The box's kernel WireGuard is the
//! end-to-end's, agent/e2e-tunnel.sh.)

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::socket::tcp;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr};

use super::core::Queue;
use super::*;
use crate::net::Dialer;

/// The box's LAN address, the client's one AllowedIPs; the machine in
/// wg-easy's network.
const BOX: Ipv4Addr = Ipv4Addr::new(192, 168, 0, 2);
const MACHINE: &str = "10.8.0.2/32";
const ECHO: u16 = 7788;

/// A box: a UDP socket, boringtun answering the machine's key with a
/// preshared key as wg-easy does, smoltcp at the box's LAN address echoing
/// every connection to `ECHO`, dropping `loss` percent of the datagrams
/// each way.
struct TestBox {
    addr: SocketAddr,
    public: [u8; 32],
    psk: [u8; 32],
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for TestBox {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn listener() -> tcp::Socket<'static> {
    let mut s = tcp::Socket::new(
        tcp::SocketBuffer::new(vec![0; 64 * 1024]),
        tcp::SocketBuffer::new(vec![0; 64 * 1024]),
    );
    s.listen(ECHO).unwrap();
    s
}

fn spawn_box(machine: &StaticSecret, loss: u32) -> TestBox {
    let secret = StaticSecret::random_from_rng(rand_core::OsRng);
    let public = *PublicKey::from(&secret).as_bytes();
    let mut psk = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut psk);
    let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
    let addr = udp.local_addr().unwrap();
    let mut tunn = Tunn::new(secret, PublicKey::from(machine), Some(psk), None, 7, None);
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            udp.set_read_timeout(Some(Duration::from_millis(2)))
                .unwrap();
            let epoch = Instant::now();
            let now = || smoltcp::time::Instant::from_micros(epoch.elapsed().as_micros() as i64);
            let mut q = Queue::default();
            let mut iface = Interface::new(Config::new(HardwareAddress::Ip), &mut q, now());
            iface.update_ip_addrs(|a| {
                a.push(IpCidr::new(IpAddress::Ipv4(BOX), 32)).unwrap();
            });
            iface.routes_mut().add_default_ipv4_route(BOX).unwrap();
            let mut sockets = SocketSet::new(Vec::new());
            let mut handles: Vec<SocketHandle> = vec![sockets.add(listener())];
            let mut peer: Option<SocketAddr> = None;
            let (mut buf, mut out) = (vec![0u8; 2048], vec![0u8; 2048]);
            let mut chunk = vec![0u8; 16 * 1024];
            let mut seed: u32 = 12345;
            let mut lost = move || {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                (seed >> 16) % 100 < loss
            };
            while !stop.load(Ordering::SeqCst) {
                if let Ok((n, from)) = udp.recv_from(&mut buf) {
                    if !lost() {
                        peer = Some(from);
                        let mut input = &buf[..n];
                        loop {
                            match tunn.decapsulate(Some(from.ip()), input, &mut out) {
                                TunnResult::WriteToNetwork(d) => {
                                    let _ = udp.send_to(d, from);
                                    input = &[];
                                    continue;
                                }
                                TunnResult::WriteToTunnelV4(p, _) => q.rx.push_back(p.to_vec()),
                                _ => {}
                            }
                            break;
                        }
                    }
                }
                if let (TunnResult::WriteToNetwork(d), Some(p)) =
                    (tunn.update_timers(&mut out), peer)
                {
                    let _ = udp.send_to(d, p);
                }
                iface.poll(now(), &mut q, &mut sockets);
                for h in &handles {
                    let s = sockets.get_mut::<tcp::Socket>(*h);
                    while s.can_recv() && s.can_send() {
                        let room = (s.send_capacity() - s.send_queue()).min(chunk.len());
                        let n = s.recv_slice(&mut chunk[..room]).unwrap();
                        s.send_slice(&chunk[..n]).unwrap();
                    }
                    if s.state() == tcp::State::CloseWait {
                        s.close();
                    }
                }
                // Always one socket listening for the next connection.
                if handles
                    .iter()
                    .all(|h| sockets.get::<tcp::Socket>(*h).state() != tcp::State::Listen)
                {
                    handles.push(sockets.add(listener()));
                }
                iface.poll(now(), &mut q, &mut sockets);
                while let Some(packet) = q.tx.pop_front() {
                    if let (TunnResult::WriteToNetwork(d), Some(p)) =
                        (tunn.encapsulate(&packet, &mut out), peer)
                    {
                        if !lost() {
                            let _ = udp.send_to(d, p);
                        }
                    }
                }
            }
        })
    };
    TestBox {
        addr,
        public,
        psk,
        stop,
        thread: Some(thread),
    }
}

/// The client config wg-easy would hand the machine for this box.
fn config(machine: &StaticSecret, b: &TestBox) -> WireguardConfig {
    WireguardConfig {
        private_key: wg_key(machine.as_bytes()),
        address: MACHINE.into(),
        server_public_key: wg_key(&b.public),
        preshared_key: Some(wg_key(&b.psk)),
        endpoint: b.addr.to_string(),
        allowed_ips: vec![format!("{BOX}/32")],
    }
}

fn tunnel(machine: &StaticSecret, b: &TestBox) -> Arc<Tunnel> {
    Tunnel::start(config(machine, b).checked().unwrap()).unwrap()
}

fn noise(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut v);
    v
}

/// Echo `data` through `s` in odd-sized writes, reading it all back.
fn echo(s: &Stream, data: &[u8]) -> Vec<u8> {
    let writer = {
        let (mut w, data) = (s.clone(), data.to_vec());
        std::thread::spawn(move || {
            for c in data.chunks(7919) {
                w.write_all(c).unwrap();
            }
        })
    };
    let mut r = s.clone();
    r.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    let mut got = vec![0u8; data.len()];
    r.read_exact(&mut got).unwrap();
    writer.join().unwrap();
    got
}

#[test]
fn four_mib_go_through_the_tunnel_and_back_whole() {
    let machine = StaticSecret::random_from_rng(rand_core::OsRng);
    let b = spawn_box(&machine, 0);
    let t = tunnel(&machine, &b);
    let s = t.connect(ECHO, Duration::from_secs(10)).unwrap();
    assert_eq!(s.peer_addr(), SocketAddr::from((BOX, ECHO)));
    let data = noise(4 << 20);
    assert!(echo(&s, &data) == data, "the bytes came back changed");
    let st = t.status();
    assert!(st.last_handshake_secs.is_some(), "{st:?}");
    assert!(st.tx_bytes >= 4 << 20 && st.rx_bytes >= 4 << 20, "{st:?}");
    assert_eq!(st.resolved.as_deref(), Some(b.addr.to_string().as_str()));
    assert_eq!(st.error, None);

    // A keystroke waits for nobody: the round trip is the loopback's, not
    // the thread's tick.
    let mut w = s.clone();
    let mut r = s.clone();
    let started = Instant::now();
    for _ in 0..20 {
        w.write_all(b"k").unwrap();
        let mut one = [0u8; 1];
        r.read_exact(&mut one).unwrap();
    }
    let each = started.elapsed() / 20;
    assert!(each < Duration::from_millis(20), "{each:?} a round trip");

    // The machine's end: its half-close reaches the box, whose close comes
    // back as the end of the stream.
    s.shutdown(std::net::Shutdown::Write).unwrap();
    let mut rest = Vec::new();
    r.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    r.read_to_end(&mut rest).unwrap();
    assert!(rest.is_empty());
}

#[test]
fn the_tunnel_carries_on_through_loss() {
    let machine = StaticSecret::random_from_rng(rand_core::OsRng);
    let b = spawn_box(&machine, 3);
    let t = tunnel(&machine, &b);
    let s = t.connect(ECHO, Duration::from_secs(20)).unwrap();
    let data = noise(256 << 10);
    assert!(echo(&s, &data) == data, "the bytes came back changed");
}

#[test]
fn the_dialer_reaches_the_box_alone_and_a_silent_box_fails_in_time() {
    let machine = StaticSecret::random_from_rng(rand_core::OsRng);
    let b = spawn_box(&machine, 0);
    let t = tunnel(&machine, &b);
    assert_eq!(t.target(), BOX);
    // A port nothing listens on at the box: refused, at once.
    let e = t.connect(9, Duration::from_secs(10)).err().unwrap();
    assert!(e.contains("refused"), "{e}");
    // The dialer goes to the box at the port asked for, whatever the host
    // part names — the controller's address from the log-in, the session
    // host's name from the policy; it resolves nothing and reaches nothing
    // else.
    let d = Dialer::Tunnel(Arc::clone(&t));
    assert!(d.tunnelled());
    for through in ["192.168.0.2:7788", "box.example.org:7788", "192.0.2.1:7788"] {
        let s = d.connect(through, Duration::from_secs(10)).unwrap();
        assert_eq!(s.peer_addr().unwrap(), SocketAddr::from((BOX, ECHO)));
    }
    assert!(d
        .connect("box.example.org", Duration::from_secs(1))
        .is_err());
    // Stopped: every stream fails, and nothing more is dialled.
    let mut s = t.connect(ECHO, Duration::from_secs(10)).unwrap();
    t.stop();
    assert!(s.write_all(b"x").is_err());
    assert!(t.connect(ECHO, Duration::from_secs(1)).is_err());

    // A box that never answers: an error within the deadline that says the
    // handshake never happened.
    let silent = UdpSocket::bind("127.0.0.1:0").unwrap();
    let mut quiet = config(&machine, &b);
    quiet.endpoint = silent.local_addr().unwrap().to_string();
    let t = Tunnel::start(quiet.checked().unwrap()).unwrap();
    let started = Instant::now();
    let e = t.connect(ECHO, Duration::from_secs(2)).err().unwrap();
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(e.contains("no WireGuard handshake"), "{e}");
}

#[test]
fn the_client_config_is_checked_and_kept_private() {
    let key = wg_key(&[9; 32]);
    let good = WireguardConfig {
        private_key: key.clone(),
        address: "10.8.0.2/32".into(),
        server_public_key: key.clone(),
        preshared_key: Some(key.clone()),
        endpoint: "box.example.org:51820".into(),
        allowed_ips: vec!["192.168.0.2/32".into()],
    };
    let s = good.checked().unwrap();
    assert_eq!(s.address, Ipv4Addr::new(10, 8, 0, 2));
    assert_eq!(s.target, BOX);
    assert!(format!("{s:?}").contains("Secret(…)"), "keys never print");
    let bad = |f: &dyn Fn(&mut WireguardConfig)| {
        let mut c = good.clone();
        f(&mut c);
        c.checked().is_err()
    };
    assert!(bad(&|c| c.private_key = "short".into()));
    assert!(bad(&|c| c.server_public_key = "AAAA".into()));
    assert!(bad(&|c| c.preshared_key = Some("x".into())));
    assert!(bad(&|c| c.address = "not-an-address".into()));
    assert!(bad(&|c| c.endpoint = "box.example.org".into()));
    assert!(bad(&|c| c.endpoint = "$(x):1".into()));
    // AllowedIPs: the box alone, one /32 — never a route to the LAN or the
    // internet, and never this machine.
    assert!(bad(&|c| c.allowed_ips = vec!["0.0.0.0/0".into()]));
    assert!(bad(&|c| c.allowed_ips = vec!["192.168.0.0/24".into()]));
    assert!(bad(&|c| c.allowed_ips = vec![]));
    assert!(bad(
        &|c| c.allowed_ips = vec!["192.168.0.2/32".into(), "10.8.0.1/32".into()]
    ));
    assert!(bad(&|c| c.allowed_ips = vec!["10.8.0.2/32".into()]));
    assert!(bad(&|c| c.allowed_ips = vec!["::1/128".into()]));
    let mut no_psk = good.clone();
    no_psk.preshared_key = None;
    assert!(no_psk.checked().is_ok());

    let dir = std::env::temp_dir().join(format!("daedalus-tunnel-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tunnel.toml");
    assert_eq!(WireguardConfig::load_at(&path).unwrap(), None);
    good.write_at(&path).unwrap();
    assert_eq!(WireguardConfig::load_at(&path).unwrap(), Some(s));
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    // Readable by others: refused, as the identity key is.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(WireguardConfig::load_at(&path).is_err());
    // A file that does not parse is an error, never "no tunnel".
    std::fs::write(&path, "address = 1\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(WireguardConfig::load_at(&path).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

/// The end-to-end's half (agent/e2e-tunnel.sh): this tunnel against a real
/// wg-easy — the kernel's WireGuard — with the client config wg-easy made
/// for it through its API, the per-client firewall on. `E2E_TUNNEL` is that
/// config as `tunnel.toml`; `E2E_EXPECT` is `open` (the link's and the
/// session host's ports echo, any other port of the box is dropped) or
/// `gone` (the client was deleted: no handshake).
#[test]
#[ignore = "agent/e2e-tunnel.sh runs it, against a wg-easy container"]
fn e2e_against_wg_easy() {
    let path = std::env::var("E2E_TUNNEL").expect("E2E_TUNNEL names the client config");
    let settings = WireguardConfig::load_at(Path::new(&path))
        .unwrap()
        .expect("the client config is there");
    let t = Tunnel::start(settings).unwrap();
    match std::env::var("E2E_EXPECT").as_deref() {
        Ok("open") => {
            for port in [7788, 7789] {
                let s = t.connect(port, Duration::from_secs(15)).unwrap();
                let data = noise(1 << 20);
                assert!(
                    echo(&s, &data) == data,
                    "port {port}: the bytes came back changed"
                );
            }
            let e = t.connect(2222, Duration::from_secs(5)).err().unwrap();
            assert!(
                !e.contains("refused"),
                "the firewall let port 2222 through: {e}"
            );
            println!("E2E_TUNNEL_OPEN_OK {:?}", t.status());
        }
        Ok("gone") => {
            let e = t.connect(7788, Duration::from_secs(8)).err().unwrap();
            assert!(e.contains("no WireGuard handshake"), "{e}");
            println!("E2E_TUNNEL_GONE_OK");
        }
        other => panic!("E2E_EXPECT is open or gone, not {other:?}"),
    }
}
