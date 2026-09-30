//! The machine's own WireGuard tunnel to the box: optional, per machine.
//! A machine with a tunnel config (`tunnel.toml`, from its log-in: a Mac
//! logged in from its menu bar, enroll.rs) reaches the controller's link and
//! the session host through it and through nothing else (net.rs `Dialer`);
//! a machine without one dials as it always has.
//!
//! ```text
//! link / santree ─ Stream ─ smoltcp TCP ─ boringtun Tunn ─ UDP <endpoint> ─▶ the box's wg-easy
//!                     10.8.0.x ⇄ the box's LAN address (AllowedIPs, one /32): :7788, :7789
//! ```
//!
//! **The peer.** The box's existing WireGuard server, wg-easy: the log-in
//! made this machine an ordinary wg-easy client, whose config — the private
//! key wg-easy generated, the address, the server's key, the preshared key,
//! the endpoint, and an AllowedIPs of the box's LAN address alone — came
//! back once, redeemed by the service (enroll.rs), and lives here. wg-easy
//! DNATs the LAN address's host ports to the host (the engine's
//! `tunnelHostPorts`), so the controller and the session host answer there
//! as they do at home.
//!
//! **Where it ends.** In this process: boringtun's sans-IO `noise::Tunn`
//! does the protocol (handshake, cookies, rekeying, the replay window,
//! keepalives), smoltcp the TCP on top — no utun, no route, no listener,
//! so nothing that comes through reaches the machine's own network stack,
//! and the agent dials nothing through it but the box (`Settings::target`,
//! the one inner source it accepts, too).
//!
//! **One thread** (`core.rs`) owns the UDP socket's reads and wakes at
//! least every `TIMER_TICK` for the protocol's timers (`update_timers`, as
//! boringtun's own device does) and smoltcp's; a stream's read or write
//! (`stream.rs`) takes the same lock, moves its bytes and pushes whatever
//! they produced out at once, so a keystroke never waits for the thread.
//!
//! **Roaming.** The UDP socket is bound to `0.0.0.0:0` and never connected,
//! so each datagram takes the route of the moment (a new Wi-Fi, a hotspot).
//! The endpoint's name is split-horizon on the reference box — the LAN
//! address at home, the WAN address away — so a handshake left unanswered
//! for `REKEY_TIMEOUT` resolves it again, on a thread of its own with a
//! deadline (`RESOLVE_DEADLINE`): the timers keep running meanwhile. A
//! socket the OS stops sending on (the network went away) is made again.
//! Datagrams from anywhere but the endpoint are dropped unread.
//!
//! **Sizes.** Inner MTU `MTU` (1280): with WireGuard's 60 bytes of IPv4
//! and UDP overhead that is 1340 on the wire, which fits inside the system
//! VPN's 1420 when the tunnel rides it. TCP buffers of `TCP_BUFFER` each
//! way, cubic, Nagle off, and `TCP_TIMEOUT` without an acknowledgement ends
//! a connection. A persistent keepalive every `KEEPALIVE_SECS` holds NAT
//! mappings open, whatever the client config says.
//!
//! **The file**: `tunnel.toml` in the data directory, the service's alone
//! (0600, root's on a Mac) — it holds the private key.

mod core;
mod stream;
#[cfg(test)]
mod tests;

use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use zeroize::Zeroizing;

pub use crate::api::wire::WireguardConfig;

use crate::deadline::Deadline;
use crate::link::TunnelStatus;
use crate::util::LockExt;

pub use stream::Stream;

/// The inner MTU (module doc).
pub const MTU: usize = 1280;
/// The persistent keepalive, in seconds.
pub const KEEPALIVE_SECS: u16 = 25;
/// The longest the thread sleeps between looks at the timers.
pub const TIMER_TICK: Duration = Duration::from_millis(250);
/// An initiation unanswered this long has the endpoint resolved again.
pub const REKEY_TIMEOUT: Duration = Duration::from_secs(5);
/// A resolution of the endpoint's name that takes longer is given up on.
pub const RESOLVE_DEADLINE: Duration = Duration::from_secs(10);
/// Data unacknowledged this long ends a TCP connection.
pub const TCP_TIMEOUT: Duration = Duration::from_secs(45);
/// Each TCP connection's buffer, each way.
pub const TCP_BUFFER: usize = 256 * 1024;

/// A WireGuard key as `wg` writes it: standard base64 of its 32 bytes
/// (the tests make configs with it).
#[cfg(test)]
pub fn wg_key(key: &[u8; 32]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(key)
}

/// The inverse of `wg_key`, strict: 44 characters that decode to 32 bytes.
pub fn parse_wg_key(s: &str) -> Result<[u8; 32], String> {
    use base64::Engine as _;
    let bad = || "not a WireGuard key (44 characters of base64)".to_string();
    if s.len() != 44 {
        return Err(bad());
    }
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
        .ok_or_else(bad)
}

/// A private key held in memory: wiped when dropped, never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(Zeroizing<[u8; 32]>);

impl Secret {
    pub fn parse(s: &str) -> Result<Self, String> {
        parse_wg_key(s).map(|k| Self(Zeroizing::new(k)))
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(…)")
    }
}

/// The client config wg-easy made for this machine, checked (module doc).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub private_key: Secret,
    /// This machine inside wg-easy's network.
    pub address: Ipv4Addr,
    pub server_public_key: [u8; 32],
    pub preshared_key: Option<Secret>,
    /// `host:port` of the box's WireGuard socket.
    pub endpoint: String,
    /// The box's LAN address: the client's AllowedIPs, its one /32 — the
    /// one address a stream may reach, and the one inner source accepted.
    pub target: Ipv4Addr,
}

/// The client config as the log-in's redeem answer carries it and
/// `tunnel.toml` keeps it (api/wire.rs).
impl WireguardConfig {
    /// Every field checked: the keys WireGuard keys, the address an IPv4
    /// address (a prefix, if any, is wg-easy's and ignored), AllowedIPs one
    /// IPv4 `/32` that is not this machine, the endpoint `host:port`.
    pub fn checked(&self) -> Result<Settings, String> {
        let private_key =
            Secret::parse(&self.private_key).map_err(|e| format!("the private key: {e}"))?;
        let server_public_key =
            parse_wg_key(&self.server_public_key).map_err(|e| format!("the server's key: {e}"))?;
        let preshared_key = match &self.preshared_key {
            Some(k) => Some(Secret::parse(k).map_err(|e| format!("the preshared key: {e}"))?),
            None => None,
        };
        let address: Ipv4Addr = self
            .address
            .split_once('/')
            .map_or(self.address.as_str(), |(ip, _)| ip)
            .parse()
            .map_err(|_| format!("the address {:?} is not an IPv4 address", self.address))?;
        let target = match self.allowed_ips.as_slice() {
            [one] => one
                .strip_suffix("/32")
                .and_then(|ip| ip.parse::<Ipv4Addr>().ok())
                .ok_or_else(|| format!("AllowedIPs {one:?} is not one IPv4 address, /32"))?,
            _ => {
                return Err(format!(
                    "AllowedIPs names {} addresses; the tunnel reaches the box alone, one /32",
                    self.allowed_ips.len()
                ))
            }
        };
        if target == address || target.is_unspecified() || target.is_broadcast() {
            return Err(format!("AllowedIPs {target} is not the box"));
        }
        if self.endpoint.len() > 255 || !crate::config::valid_host_port(&self.endpoint) {
            return Err(format!("the endpoint {:?} is not host:port", self.endpoint));
        }
        Ok(Settings {
            private_key,
            address,
            server_public_key,
            preshared_key,
            endpoint: self.endpoint.clone(),
            target,
        })
    }

    /// The file at `path`, checked; None when there is none. One that is
    /// there but not the service's alone, or does not check, is an error:
    /// the machine then dials nothing rather than around its tunnel (net.rs
    /// `Refused`).
    pub fn load_at(path: &Path) -> Result<Option<Settings>> {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => Zeroizing::new(t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        crate::private::check_owner(path)?;
        crate::os::ensure_private(path)?;
        let c: Self =
            toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        c.checked()
            .map(Some)
            .map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
    }

    /// Write it to `path`, the service's alone.
    pub fn write_at(&self, path: &Path) -> Result<()> {
        let text = Zeroizing::new(format!(
            "# daedalus-agent — this machine's WireGuard client of the box, from its log-in.\n\
             # Written by the service; Log out removes it.\n\n{}",
            toml::to_string_pretty(self)?
        ));
        crate::util::write_atomic(path, text.as_bytes(), crate::util::Access::Private)
            .with_context(|| format!("writing {}", path.display()))
    }
}

/// The running tunnel (module doc): a thread, and the streams through it.
/// Dropping it stops the thread; streams still open then fail.
pub struct Tunnel {
    inner: Arc<core::Inner>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Tunnel {
    /// Bring it up: the keys, a UDP socket and the thread. Nothing is sent
    /// until the first stream opens (then a handshake).
    pub fn start(settings: Settings) -> std::io::Result<Arc<Self>> {
        let inner = Arc::new(core::Inner::new(settings)?);
        let thread = {
            let inner = Arc::clone(&inner);
            std::thread::Builder::new()
                .name("tunnel".into())
                .spawn(move || core::run(&inner))?
        };
        tracing::info!(
            endpoint = %inner.settings.endpoint,
            address = %inner.settings.address,
            target = %inner.settings.target,
            "tunnel: up"
        );
        Ok(Arc::new(Self {
            inner,
            thread: Mutex::new(Some(thread)),
        }))
    }

    /// The box: the only address a stream reaches.
    pub fn target(&self) -> Ipv4Addr {
        self.inner.settings.target
    }

    /// A TCP connection to the box's `port` through the tunnel, established
    /// within `within` — the WireGuard handshake included, when there is no
    /// session yet.
    pub fn connect(&self, port: u16, within: Duration) -> Result<Stream, String> {
        stream::connect(
            &self.inner,
            SocketAddrV4::new(self.target(), port),
            Deadline::after(within),
        )
    }

    pub fn status(&self) -> TunnelStatus {
        self.inner.status()
    }

    /// Stop the thread; every stream fails from now on. Idempotent.
    pub fn stop(&self) {
        self.inner.stopped.store(true, Ordering::SeqCst);
        self.inner.moved.notify_all();
        if let Some(t) = self.thread.lock_ok().take() {
            let _ = t.join();
        }
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.stop();
    }
}
