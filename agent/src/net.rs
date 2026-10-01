//! This machine on its network: the adapter it talks through, its address,
//! its hardware address, and the DNS search suffixes DHCP handed it — the
//! last being how the agent finds the box (see discover.rs). And how it
//! reaches the box: the `Dialer`, which every connection to the controller
//! (node/link.rs) and to the session host (santree.rs) goes through, and
//! the `Sock` it hands back.
//!
//! The reading is per OS (`os::primary_adapter`): Windows reads
//! `GetAdaptersAddresses`, macOS asks `route`, `ifconfig` and `scutil`,
//! Linux reads `/proc/net/route`, sysfs, `getifaddrs` and resolv.conf.
//!
//! **The Dialer.** A machine without a tunnel config dials TCP as it always
//! has (`Direct`). A machine with one (tunnel/, `tunnel.toml`: a Mac signed
//! in from its menu bar) reaches the box ONLY through its own WireGuard
//! tunnel (`Tunnel`) — the box, the tunnel's one address, and nothing else,
//! and never around it: no fallback to the LAN, so a broken tunnel config fails
//! closed instead of quietly talking to whoever answers on the network. A
//! tunnel config that could not be brought up (`Refused`) refuses every
//! dial and says why.

use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::ipc::deadline::Deadline;

#[derive(Clone, Debug, Default)]
pub struct Adapter {
    pub mac: Option<String>,
    pub ipv4: Option<String>,
    /// Connection-specific DNS suffixes, one per adapter that has one.
    pub dns_suffixes: Vec<String>,
}

/// The first adapter that is up, not loopback, and has an IPv4 address —
/// which on a desktop is the one connected to the LAN — plus every DNS
/// suffix seen on any adapter, since the search domain may be on another.
pub fn primary() -> Adapter {
    crate::os::primary_adapter()
}

/// One connection to the box: a TCP socket, or a TCP stream inside the
/// machine's WireGuard tunnel (tunnel/). What the link (tls.rs) and the
/// santree pipe (santree.rs) use of a `TcpStream`, and nothing else.
pub enum Sock {
    Tcp(TcpStream),
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Tunnel(crate::node::tunnel::Stream),
}

impl From<TcpStream> for Sock {
    fn from(s: TcpStream) -> Self {
        Sock::Tcp(s)
    }
}

impl Sock {
    pub fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
        match self {
            Sock::Tcp(s) => s.set_read_timeout(d),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Sock::Tunnel(s) => s.set_read_timeout(d),
        }
    }

    pub fn set_write_timeout(&self, d: Option<Duration>) -> io::Result<()> {
        match self {
            Sock::Tcp(s) => s.set_write_timeout(d),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Sock::Tunnel(s) => s.set_write_timeout(d),
        }
    }

    /// Nagle off: the link's lines and santree's keystrokes go out at once
    /// (a tunnel stream has it off from the start: tunnel/).
    pub fn set_nodelay(&self) -> io::Result<()> {
        match self {
            Sock::Tcp(s) => s.set_nodelay(true),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Sock::Tunnel(_) => Ok(()),
        }
    }

    pub fn peer_addr(&self) -> io::Result<SocketAddr> {
        match self {
            Sock::Tcp(s) => s.peer_addr(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Sock::Tunnel(s) => Ok(s.peer_addr()),
        }
    }

    pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        match self {
            Sock::Tcp(s) => s.shutdown(how),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Sock::Tunnel(s) => s.shutdown(how),
        }
    }

    /// Another handle on the same connection, as `TcpStream::try_clone`:
    /// the timeouts are the connection's, shared by every handle.
    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(match self {
            Sock::Tcp(s) => Sock::Tcp(s.try_clone()?),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Sock::Tunnel(s) => Sock::Tunnel(s.clone()),
        })
    }
}

impl Read for Sock {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Sock::Tcp(s) => s.read(buf),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Sock::Tunnel(s) => s.read(buf),
        }
    }
}

impl Write for Sock {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Sock::Tcp(s) => s.write(buf),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Sock::Tunnel(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Sock::Tcp(s) => s.flush(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Sock::Tunnel(_) => Ok(()),
        }
    }
}

/// How this machine reaches the box (module doc). Cheap to clone: the
/// tunnel is shared.
#[derive(Clone)]
pub enum Dialer {
    /// TCP over whatever network the machine is on.
    Direct,
    /// Only the box's address inside the machine's own tunnel.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Tunnel(std::sync::Arc<crate::node::tunnel::Tunnel>),
    /// A tunnel config is there but the tunnel is not: every dial refused,
    /// with why.
    Refused(String),
}

impl Dialer {
    /// Whether a tunnel config governs this machine (up or refused): SRV
    /// discovery is skipped then, since the address is the tunnel's.
    pub fn tunnelled(&self) -> bool {
        !matches!(self, Dialer::Direct)
    }

    /// Connect to `address` (`host:port`), all of it — every address the
    /// name resolves to, one after another — within `within`. Through a
    /// tunnel every dial goes to the box, the tunnel's one address, at
    /// `address`'s port: the host part is however the box was named (the
    /// controller's address from the log-in, the session host's from the
    /// policy) and is never resolved — the pinned keys prove who answers.
    /// Nothing else is reachable through it.
    pub fn connect(&self, address: &str, within: Duration) -> Result<Sock, String> {
        match self {
            Dialer::Direct => connect_tcp(address, within).map(Sock::Tcp),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Dialer::Tunnel(t) => {
                let port = address
                    .rsplit_once(':')
                    .and_then(|(_, p)| p.parse::<u16>().ok())
                    .filter(|p| *p != 0)
                    .ok_or_else(|| format!("{address} is not host:port"))?;
                t.connect(port, within).map(Sock::Tunnel)
            }
            Dialer::Refused(why) => Err(why.clone()),
        }
    }
}

/// TCP to `address`: each address it resolves to in turn, all within one
/// deadline.
fn connect_tcp(address: &str, within: Duration) -> Result<TcpStream, String> {
    let deadline = Deadline::after(within);
    let addrs: Vec<_> = address
        .to_socket_addrs()
        .map_err(|e| format!("{address} does not resolve: {e}"))?
        .collect();
    let mut why = String::from("no address");
    for a in &addrs {
        if deadline.passed() {
            why = "no answer in time".into();
            break;
        }
        match TcpStream::connect_timeout(a, deadline.timeout(within)) {
            Ok(s) => return Ok(s),
            Err(e) => why = e.to_string(),
        }
    }
    Err(format!("{address} did not answer ({why})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_direct_dial_tries_every_address_within_one_deadline() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = l.local_addr().unwrap().to_string();
        let s = Dialer::Direct.connect(&at, Duration::from_secs(2)).unwrap();
        assert!(matches!(s, Sock::Tcp(_)));
        drop(l);
        let e = Dialer::Direct
            .connect(&at, Duration::from_secs(2))
            .err()
            .unwrap();
        assert!(e.contains("did not answer"), "{e}");
        assert!(Dialer::Direct
            .connect("nope", Duration::from_secs(1))
            .is_err());
        // A refused tunnel refuses everything, with its reason.
        let r = Dialer::Refused("tunnel.toml: broken".into());
        assert!(r.tunnelled());
        assert_eq!(
            r.connect(&at, Duration::from_secs(1)).err().unwrap(),
            "tunnel.toml: broken"
        );
        assert!(!Dialer::Direct.tunnelled());
    }
}
