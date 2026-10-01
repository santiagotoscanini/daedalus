//! The tunnel's one thread and the state it shares with the streams: the
//! WireGuard session (`Tunn`), smoltcp's interface and sockets over a queue
//! of IP packets, the UDP socket, and the endpoint (the module doc of
//! `tunnel` says why each is as it is).

use std::collections::VecDeque;
use std::net::{Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::tcp;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr};

use super::{Settings, KEEPALIVE_SECS, MTU, REKEY_TIMEOUT, RESOLVE_DEADLINE, TIMER_TICK};
use crate::link::TunnelStatus;
use crate::util::LockExt;

/// The largest datagram either way: an inner packet plus WireGuard's 32
/// bytes, and never less than a handshake initiation (148).
const DATAGRAM: usize = MTU + 64;
/// The first ephemeral port a stream takes.
const FIRST_PORT: u16 = 49152;
/// A closed stream's socket still finishing its goodbye is dropped after
/// this, whatever state it is in.
const LINGER: Duration = Duration::from_secs(60);
/// How often a UDP socket that failed is made again, at most.
const REBIND_EVERY: Duration = Duration::from_secs(1);

/// What the thread and the streams share.
pub(super) struct Inner {
    pub(super) settings: Settings,
    pub(super) core: Mutex<Core>,
    /// Raised whenever something a stream may be waiting for moved: bytes
    /// in, room out, a state, the tunnel stopping.
    pub(super) moved: Condvar,
    pub(super) stopped: AtomicBool,
}

impl Inner {
    pub(super) fn new(settings: Settings) -> std::io::Result<Self> {
        let core = Core::new(&settings)?;
        Ok(Self {
            settings,
            core: Mutex::new(core),
            moved: Condvar::new(),
            stopped: AtomicBool::new(false),
        })
    }

    pub(super) fn status(&self) -> TunnelStatus {
        let core = self.core.lock_ok();
        let (handshake, tx, rx, _, _) = core.tunn.stats();
        TunnelStatus {
            endpoint: self.settings.endpoint.clone(),
            resolved: core.wire.endpoint.map(|e| e.to_string()),
            address: self.settings.address.to_string(),
            last_handshake_secs: handshake.map(|d| d.as_secs()),
            rx_bytes: rx as u64,
            tx_bytes: tx as u64,
            error: core.wire.error.clone(),
        }
    }
}

/// The packets between smoltcp and the tunnel: what came out of the tunnel
/// for smoltcp to read, what smoltcp wrote for the tunnel to seal.
#[derive(Default)]
pub(super) struct Queue {
    pub(super) rx: VecDeque<Vec<u8>>,
    pub(super) tx: VecDeque<Vec<u8>>,
}

pub(super) struct Rx(Vec<u8>);

impl RxToken for Rx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

pub(super) struct Tx<'a>(&'a mut VecDeque<Vec<u8>>);

impl TxToken for Tx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut packet = vec![0; len];
        let r = f(&mut packet);
        self.0.push_back(packet);
        r
    }
}

impl Device for Queue {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;

    fn receive(
        &mut self,
        _: smoltcp::time::Instant,
    ) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        let packet = self.rx.pop_front()?;
        Some((Rx(packet), Tx(&mut self.tx)))
    }

    fn transmit(&mut self, _: smoltcp::time::Instant) -> Option<Self::TxToken<'_>> {
        Some(Tx(&mut self.tx))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = MTU;
        caps
    }
}

/// The UDP side: the socket, where it sends, and what went wrong.
struct Wire {
    udp: Arc<UdpSocket>,
    /// The endpoint as last resolved; None until it has been.
    endpoint: Option<SocketAddr>,
    /// A handshake initiation went out and nothing has come back since.
    initiated: Option<Instant>,
    /// The last trouble, for the status (`TunnelStatus::error`).
    error: Option<String>,
    /// The OS refused to send: make the socket again (`Core::tick`).
    broken: bool,
}

impl Wire {
    fn send(&mut self, datagram: &[u8]) {
        let Some(to) = self.endpoint else {
            return;
        };
        // A handshake initiation (type 1, 148 bytes), until anything answers.
        if datagram.len() == 148 && datagram[0] == 1 {
            self.initiated.get_or_insert_with(Instant::now);
        }
        match self.udp.send_to(datagram, to) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => {
                self.error = Some(format!("sending to {to}: {e}"));
                self.broken = true;
            }
        }
    }
}

/// A resolution of the endpoint's name under way on a thread of its own.
struct Resolving {
    since: Instant,
    answer: Receiver<Result<SocketAddr, String>>,
}

pub(super) struct Core {
    tunn: Tunn,
    iface: Interface,
    pub(super) sockets: SocketSet<'static>,
    queue: Queue,
    wire: Wire,
    /// The box: the one inner source accepted.
    target: Ipv4Addr,
    endpoint_name: String,
    resolving: Option<Resolving>,
    /// When the last resolution started.
    resolved_at: Option<Instant>,
    rebound_at: Option<Instant>,
    /// smoltcp's clock: monotonic, from here.
    epoch: Instant,
    next_port: u16,
    /// Sockets whose streams are all gone, finishing their goodbye.
    orphans: Vec<(SocketHandle, Instant)>,
    scratch: Vec<u8>,
}

fn bind_udp() -> std::io::Result<UdpSocket> {
    UdpSocket::bind("0.0.0.0:0")
}

impl Core {
    fn new(settings: &Settings) -> std::io::Result<Self> {
        let tunn = Tunn::new(
            StaticSecret::from(*settings.private_key.bytes()),
            PublicKey::from(settings.server_public_key),
            settings.preshared_key.as_ref().map(|k| *k.bytes()),
            Some(KEEPALIVE_SECS),
            rand_core::RngCore::next_u32(&mut rand_core::OsRng),
            None,
        );
        let mut queue = Queue::default();
        let epoch = Instant::now();
        let mut config = Config::new(HardwareAddress::Ip);
        config.random_seed = rand_core::RngCore::next_u64(&mut rand_core::OsRng);
        let mut iface = Interface::new(config, &mut queue, smoltcp::time::Instant::ZERO);
        iface.update_ip_addrs(|addrs| {
            addrs
                .push(IpCidr::new(IpAddress::Ipv4(settings.address), 32))
                .expect("one address fits");
        });
        // Everything this interface sends goes into the tunnel (a device of
        // IP packets has no next hop to find), so the route only has to
        // exist: the box is outside the /32.
        iface
            .routes_mut()
            .add_default_ipv4_route(settings.address)
            .expect("one route fits");
        let span = u16::MAX - FIRST_PORT;
        let next_port = FIRST_PORT
            + (rand_core::RngCore::next_u32(&mut rand_core::OsRng) % u32::from(span)) as u16;
        Ok(Self {
            tunn,
            iface,
            sockets: SocketSet::new(Vec::new()),
            queue,
            wire: Wire {
                udp: Arc::new(bind_udp()?),
                endpoint: None,
                initiated: None,
                error: None,
                broken: false,
            },
            target: settings.target,
            endpoint_name: settings.endpoint.clone(),
            resolving: None,
            resolved_at: None,
            rebound_at: None,
            epoch,
            next_port,
            orphans: Vec::new(),
            scratch: vec![0; DATAGRAM],
        })
    }

    fn now(&self) -> smoltcp::time::Instant {
        smoltcp::time::Instant::from_micros(self.epoch.elapsed().as_micros() as i64)
    }

    /// Let smoltcp read what came in and write what it has to say, and
    /// seal and send every packet it wrote.
    pub(super) fn poll(&mut self) {
        let now = self.now();
        self.iface.poll(now, &mut self.queue, &mut self.sockets);
        while let Some(packet) = self.queue.tx.pop_front() {
            match self.tunn.encapsulate(&packet, &mut self.scratch) {
                TunnResult::WriteToNetwork(datagram) => self.wire.send(datagram),
                TunnResult::Err(e) => tracing::debug!(error = ?e, "tunnel: a packet not sealed"),
                _ => {}
            }
        }
    }

    /// One datagram from the network (module doc: only the endpoint's).
    fn ingress(&mut self, datagram: &[u8], from: SocketAddr) {
        if self.wire.endpoint != Some(from) {
            return;
        }
        let mut input = datagram;
        loop {
            let answer = self
                .tunn
                .decapsulate(Some(from.ip()), input, &mut self.scratch);
            // The box answered: whatever went wrong before is over.
            if !matches!(answer, TunnResult::Err(_)) {
                self.wire.initiated = None;
                self.wire.error = None;
            }
            match answer {
                // A handshake answer, a cookie, a keepalive — and then the
                // packets that waited for the session, one call each.
                TunnResult::WriteToNetwork(out) => {
                    self.wire.send(out);
                    input = &[];
                    continue;
                }
                TunnResult::WriteToTunnelV4(packet, source) => {
                    if source == self.target {
                        self.queue.rx.push_back(packet.to_vec());
                    }
                }
                TunnResult::Done | TunnResult::WriteToTunnelV6(..) => {}
                TunnResult::Err(e) => tracing::debug!(error = ?e, "tunnel: a datagram refused"),
            }
            break;
        }
        self.poll();
    }

    /// The timers, the endpoint, the socket, the orphans: what the thread
    /// looks at every tick.
    fn tick(&mut self) {
        match self.tunn.update_timers(&mut self.scratch) {
            TunnResult::WriteToNetwork(datagram) => self.wire.send(datagram),
            TunnResult::Err(boringtun::noise::errors::WireGuardError::ConnectionExpired)
                if self.wire.initiated.is_some() && self.wire.error.is_none() =>
            {
                self.wire.error = Some(format!(
                    "no WireGuard handshake with {} for 90 s",
                    self.endpoint_name
                ));
            }
            _ => {}
        }
        self.resolve();
        if self.wire.broken && self.rebound_at.is_none_or(|t| t.elapsed() >= REBIND_EVERY) {
            self.rebound_at = Some(Instant::now());
            match bind_udp() {
                Ok(s) => {
                    self.wire.udp = Arc::new(s);
                    self.wire.broken = false;
                    tracing::info!("tunnel: made its UDP socket again");
                }
                Err(e) => self.wire.error = Some(format!("making a UDP socket: {e}")),
            }
        }
        self.reap();
        self.poll();
    }

    /// Resolve the endpoint's name when there is no address yet, or when a
    /// handshake has gone unanswered for `REKEY_TIMEOUT` — off this thread,
    /// within `RESOLVE_DEADLINE` (module doc).
    fn resolve(&mut self) {
        if let Some(r) = &self.resolving {
            match r.answer.try_recv() {
                Ok(Ok(addr)) => {
                    if self.wire.endpoint != Some(addr) {
                        tracing::info!(endpoint = %self.endpoint_name, address = %addr, "tunnel: the endpoint resolves");
                    }
                    self.wire.endpoint = Some(addr);
                    self.wire.error = None;
                    self.resolving = None;
                }
                Ok(Err(e)) => {
                    self.wire.error = Some(e);
                    self.resolving = None;
                }
                Err(TryRecvError::Empty) if r.since.elapsed() >= RESOLVE_DEADLINE => {
                    self.wire.error = Some(format!(
                        "{} did not resolve within {} s",
                        self.endpoint_name,
                        RESOLVE_DEADLINE.as_secs()
                    ));
                    self.resolving = None;
                }
                Err(TryRecvError::Empty) => return,
                Err(TryRecvError::Disconnected) => self.resolving = None,
            }
        }
        if self.resolving.is_some() {
            return;
        }
        let since_last = self.resolved_at.map(|t| t.elapsed());
        let wanted = match (self.wire.endpoint, self.wire.initiated) {
            (None, _) => since_last.is_none_or(|d| d >= Duration::from_secs(2)),
            (Some(_), Some(at)) => {
                at.elapsed() >= REKEY_TIMEOUT && since_last.is_none_or(|d| d >= REKEY_TIMEOUT)
            }
            (Some(_), None) => false,
        };
        if !wanted {
            return;
        }
        self.resolved_at = Some(Instant::now());
        let (tx, rx) = mpsc::channel();
        let name = self.endpoint_name.clone();
        let spawned = std::thread::Builder::new()
            .name("tunnel-resolve".into())
            .spawn(move || {
                let answer = match name.to_socket_addrs() {
                    Ok(mut addrs) => addrs
                        .find(SocketAddr::is_ipv4)
                        .ok_or_else(|| format!("{name} has no IPv4 address")),
                    Err(e) => Err(format!("{name} does not resolve: {e}")),
                };
                let _ = tx.send(answer);
            });
        match spawned {
            Ok(_) => {
                self.resolving = Some(Resolving {
                    since: Instant::now(),
                    answer: rx,
                })
            }
            Err(e) => {
                self.wire.error = Some(format!(
                    "no thread to resolve {name}: {e}",
                    name = self.endpoint_name
                ))
            }
        }
    }

    /// The next free ephemeral port.
    pub(super) fn port(&mut self) -> u16 {
        let used: Vec<u16> = self
            .sockets
            .iter()
            .filter_map(|(_, s)| match s {
                smoltcp::socket::Socket::Tcp(t) => t.local_endpoint().map(|e| e.port),
                #[allow(unreachable_patterns)]
                _ => None,
            })
            .collect();
        loop {
            let p = self.next_port;
            self.next_port = if p == u16::MAX { FIRST_PORT } else { p + 1 };
            if !used.contains(&p) {
                return p;
            }
        }
    }

    /// smoltcp's interface, to connect a socket on.
    pub(super) fn connect(
        &mut self,
        handle: SocketHandle,
        to: std::net::SocketAddrV4,
        port: u16,
    ) -> Result<(), String> {
        let cx = self.iface.context();
        self.sockets
            .get_mut::<tcp::Socket>(handle)
            .connect(cx, to, port)
            .map_err(|e| format!("connecting to {to}: {e}"))
    }

    /// A stream's last handle is gone: its socket says goodbye (FIN) and
    /// is dropped once done, or after `LINGER`.
    pub(super) fn orphan(&mut self, handle: SocketHandle) {
        self.sockets.get_mut::<tcp::Socket>(handle).close();
        self.orphans.push((handle, Instant::now()));
        self.poll();
    }

    fn reap(&mut self) {
        let sockets = &mut self.sockets;
        self.orphans.retain(|(h, since)| {
            let s = sockets.get_mut::<tcp::Socket>(*h);
            let done = matches!(s.state(), tcp::State::Closed | tcp::State::TimeWait);
            if done || since.elapsed() >= LINGER {
                s.abort();
                sockets.remove(*h);
                false
            } else {
                true
            }
        });
    }

    /// Why a connection is not coming up, for the error a caller sees.
    pub(super) fn trouble(&self) -> String {
        let session = self.tunn.stats().0.is_some();
        match (&self.wire.endpoint, &self.wire.error, session) {
            (_, _, true) => String::new(),
            (None, Some(e), _) => format!(" ({e})"),
            (None, None, _) => format!(" ({} has not resolved yet)", self.endpoint_name),
            (Some(at), e, false) => format!(
                " (no WireGuard handshake with {} at {at}{})",
                self.endpoint_name,
                e.as_ref().map(|e| format!("; {e}")).unwrap_or_default()
            ),
        }
    }

    /// How long the thread may sleep: until smoltcp's next timer, and never
    /// past `TIMER_TICK` (the protocol's timers).
    fn wait(&mut self) -> Duration {
        let now = self.now();
        let smol = self
            .iface
            .poll_delay(now, &self.sockets)
            .map(|d| Duration::from_micros(d.total_micros()))
            .unwrap_or(TIMER_TICK);
        smol.clamp(Duration::from_millis(1), TIMER_TICK)
    }
}

/// The thread (module doc): read the socket until the next timer, hand what
/// came in to the session, look at the timers, wake the streams.
pub(super) fn run(inner: &Inner) {
    let mut buf = vec![0u8; DATAGRAM];
    while !inner.stopped.load(Ordering::SeqCst) {
        let (udp, wait) = {
            let mut core = inner.core.lock_ok();
            core.tick();
            (Arc::clone(&core.wire.udp), core.wait())
        };
        inner.moved.notify_all();
        if udp.set_read_timeout(Some(wait)).is_err() {
            std::thread::sleep(wait);
            continue;
        }
        match udp.recv_from(&mut buf) {
            Ok((n, from)) => {
                inner.core.lock_ok().ingress(&buf[..n], from);
                inner.moved.notify_all();
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(e) => {
                let mut core = inner.core.lock_ok();
                core.wire.error = Some(format!("receiving: {e}"));
                core.wire.broken = true;
                drop(core);
                std::thread::sleep(REBIND_EVERY / 10);
            }
        }
    }
    // Stopped: every stream's socket goes at once, and whoever waits hears.
    let mut core = inner.core.lock_ok();
    let handles: Vec<SocketHandle> = core.sockets.iter().map(|(h, _)| h).collect();
    for h in handles {
        core.sockets.get_mut::<tcp::Socket>(h).abort();
    }
    core.poll();
    drop(core);
    inner.moved.notify_all();
}
