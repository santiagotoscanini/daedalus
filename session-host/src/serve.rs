//! `serve`: the TLS listeners and the hook socket, the tasks beside them
//! (status file, revocation, reaper), and a clean stop.
//!
//! **Before a connection is admitted** it holds a pre-auth slot and has
//! [`HANDSHAKE_TIMEOUT`] to finish the TLS handshake; the handshake admits a
//! key only if the allow-list does (santree-remote-tls `server_config`). The
//! slots come from two pools that cannot starve each other:
//!
//! - **the network**: [`MAX_PREAUTH`] in all, [`PREAUTH_PER_IP`] per address
//!   (an IPv6 /64 is one address), as the controller's link counts them. One
//!   LAN host that claims a dozen addresses can fill it; on a home LAN that
//!   is an accepted risk.
//! - **loopback**: [`LOOPBACK_PREAUTH`], its own and generous. A tunnel's
//!   peers and every container on this host (wg-easy's DNAT, pasta) arrive
//!   from 127.0.0.1, and all agents will once the tunnel moves into them, so
//!   a per-address limit there would be one bucket for everybody: three
//!   silent connections from one container would lock every VPN user out.
//!   With [`LOOPBACK_PREAUTH`] slots, each freed after at most
//!   [`HANDSHAKE_TIMEOUT`], a buggy local client (a health checker, a port
//!   scan, a reconnect loop) leaves plenty for the real handshakes, which
//!   take one round trip. What remains: a process on this box that
//!   deliberately holds that many silent connections open, re-opened every
//!   five seconds, still locks out loopback clients (the LAN keeps its own
//!   pool). It has to be running on the box or in a container already, and
//!   from there it has easier ways to deny service (filling the disk,
//!   exhausting the pi-hole's shared rate limit, CPU); nothing it does here
//!   gets it past the TLS key check. The audit log shows loopback peers as
//!   `127.0.0.1`.
//!
//! A refused handshake is logged at most [`REFUSALS_PER_MINUTE`] times a
//! minute, with a count of the rest, so a scanner cannot flood the journal.
//!
//! **Accepted sockets** get TCP keepalive and `TCP_USER_TIMEOUT` =
//! [`USER_TIMEOUT`]: a peer that vanished (a laptop lid closed mid-session)
//! is noticed within about that, its sessions parked, instead of after the
//! kernel's ~15-minute retransmit window.

use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use santree_remote_proto::{HOOK_QUEUE_CAP, PING_INTERVAL};
use santree_remote_tls::{rustls::ServerConfig, Identity};
use tokio::net::{TcpListener, TcpStream, UnixListener};

use crate::allow::AllowList;
use crate::config::Config;
use crate::daemon::{self, Daemon, Options, Peer};
use crate::status::StatusWriter;
use crate::{hostkey, sys};

/// Connections from the network not yet admitted, in all…
pub const MAX_PREAUTH: usize = 32;
/// …and from one address.
pub const PREAUTH_PER_IP: usize = 3;
/// Connections from loopback (VPN peers, containers) not yet admitted: a
/// pool of their own (module doc).
pub const LOOPBACK_PREAUTH: usize = 64;
/// Refused handshakes logged a minute; the rest are counted.
pub const REFUSALS_PER_MINUTE: u32 = 10;
/// From accept to a finished TLS handshake.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Unacknowledged data older than this ends the connection.
pub const USER_TIMEOUT: Duration = Duration::from_secs(30);

/// A bound host, not yet serving.
pub struct Server {
    config: Config,
    identity: Identity,
    allow: Arc<AllowList>,
    tls: Arc<ServerConfig>,
    listeners: Vec<TcpListener>,
    hooks: UnixListener,
    daemon: Arc<Daemon>,
}

impl Server {
    /// Load (or make) the host key, read the allow-list and start watching
    /// it, bind every listener and the hook socket.
    pub async fn bind(config: Config) -> Result<Self, String> {
        // Made 0700 when missing (tmpfiles makes it so too, under systemd).
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&config.state_dir)
            .map_err(|e| format!("creating {}: {e}", config.state_dir.display()))?;
        let identity = hostkey::load_or_create(&config.host_key())?;
        let allow = AllowList::open(config.allow_list.clone());
        allow
            .watch()
            .map_err(|e| format!("starting the allow-list watch: {e}"))?;
        let tls = santree_remote_tls::server_config(&identity, {
            let allow = allow.clone();
            Arc::new(move |key: &[u8; 32]| allow.node_of(key).is_some())
        });
        let mut listeners = Vec::new();
        for addr in &config.listen {
            listeners.push(
                TcpListener::bind(addr)
                    .await
                    .map_err(|e| format!("listening on {addr}: {e}"))?,
            );
        }
        let hooks = bind_hook_socket(&config.hook_socket)?;
        let (user, home) = sys::user_and_home();
        let daemon = Daemon::new(
            Options {
                version: env!("CARGO_PKG_VERSION").to_string(),
                hostname: sys::hostname(),
                user,
                home,
                projects_root: config.projects_root.clone(),
                hook_bin: config.hook_bin.clone(),
                workspaces: config.workspaces.clone(),
                workspace_icons: config.workspace_icons.clone(),
                ping_interval: PING_INTERVAL,
                hook_queue_cap: HOOK_QUEUE_CAP,
            },
            sys::new_boot_id()?,
            allow.clone(),
        );
        revocations(daemon.clone(), allow.clone())?;
        Ok(Self {
            config,
            identity,
            allow,
            tls,
            listeners,
            hooks,
            daemon,
        })
    }

    /// The addresses the TLS listeners are bound to.
    pub fn local_addrs(&self) -> Vec<SocketAddr> {
        self.listeners
            .iter()
            .filter_map(|l| l.local_addr().ok())
            .collect()
    }

    /// This host's public key: what every node pins.
    pub fn host_key(&self) -> [u8; 32] {
        self.identity.public_key()
    }

    /// Serve until `shutdown` resolves, then stop: no new connections, the
    /// hook socket removed, every PTY closed, a last status file saying
    /// `stopped`.
    pub async fn run(self, shutdown: impl Future<Output = ()>) {
        let listen = self.local_addrs();
        let daemon = self.daemon.clone();
        let status = Arc::new(StatusWriter {
            path: self.config.status_file(),
            started_at: SystemTime::now(),
            exe: std::fs::read_link("/proc/self/exe")
                .ok()
                .map(|p| p.to_string_lossy().into_owned()),
            config: self
                .config
                .file
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            host_key: santree_remote_tls::key_hex(&self.identity.public_key()),
            listen: listen.clone(),
            allow: self.allow.clone(),
            daemon: daemon.clone(),
            written: Default::default(),
        });
        let mut tasks = vec![
            tokio::spawn(status.clone().run()),
            tokio::spawn(reaper(daemon.clone())),
            tokio::spawn(accept_hooks(daemon.clone(), self.hooks)),
        ];
        let preauth = Arc::new(Preauth::default());
        for listener in self.listeners {
            tasks.push(tokio::spawn(accept_tls(
                listener,
                self.tls.clone(),
                self.allow.clone(),
                daemon.clone(),
                preauth.clone(),
            )));
        }
        log::info!(
            "serving protocol 1 on {} (version {}, boot {}, host key {})",
            listen
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", "),
            daemon.options().version,
            daemon.boot_id(),
            santree_remote_tls::fingerprint(&self.identity.public_key())
        );

        shutdown.await;

        for task in tasks {
            task.abort();
        }
        if let Err(e) = std::fs::remove_file(&self.config.hook_socket) {
            log::warn!("removing {}: {e}", self.config.hook_socket.display());
        }
        let closing = daemon.clone();
        let _ = tokio::task::spawn_blocking(move || closing.close_all()).await;
        if let Err(e) = status.write(false) {
            log::warn!("final status file {}: {e}", status.path.display());
        }
        log::info!("stopped");
    }
}

// ── pre-auth ──────────────────────────────────────────────────────────────

/// The address a limit counts: an IPv4 address as it is (an IPv4-mapped IPv6
/// one as its IPv4), an IPv6 address by its /64 — one host has a whole /64 to
/// pick from. The controller's link counts the same way.
fn ip_bucket(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => IpAddr::V4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

/// The pre-auth pools (module doc).
#[derive(Default)]
struct Preauth {
    /// The network's, by address; its total is the sum.
    per_ip: Mutex<HashMap<IpAddr, usize>>,
    total: AtomicUsize,
    loopback: AtomicUsize,
}

/// One pre-auth slot, given back on drop.
struct Slot {
    preauth: Arc<Preauth>,
    /// None: a loopback slot.
    bucket: Option<IpAddr>,
}

impl Preauth {
    fn slot(self: &Arc<Self>, ip: IpAddr) -> Option<Slot> {
        let bucket = ip_bucket(ip);
        // `::1`'s /64 is `::`: loopback is asked of the address itself (and of
        // its IPv4, for an IPv4-mapped one).
        if ip.is_loopback() || bucket.is_loopback() {
            self.loopback
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    (n < LOOPBACK_PREAUTH).then_some(n + 1)
                })
                .ok()?;
            return Some(Slot {
                preauth: self.clone(),
                bucket: None,
            });
        }
        let mut per = self.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        let mine = per.get(&bucket).copied().unwrap_or(0);
        if mine >= PREAUTH_PER_IP || self.total.load(Ordering::Acquire) >= MAX_PREAUTH {
            return None;
        }
        per.insert(bucket, mine + 1);
        self.total.fetch_add(1, Ordering::AcqRel);
        Some(Slot {
            preauth: self.clone(),
            bucket: Some(bucket),
        })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let Some(bucket) = self.bucket else {
            self.preauth.loopback.fetch_sub(1, Ordering::AcqRel);
            return;
        };
        let mut per = self
            .preauth
            .per_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(n) = per.get_mut(&bucket) {
            *n -= 1;
            if *n == 0 {
                per.remove(&bucket);
            }
        }
        self.preauth.total.fetch_sub(1, Ordering::AcqRel);
    }
}

/// At most [`REFUSALS_PER_MINUTE`] refusal lines a minute; the rest counted
/// and summed up in the first line of the next minute.
#[derive(Default)]
struct RefusalLog {
    window: Mutex<(Option<std::time::Instant>, u32, u64)>,
}

impl RefusalLog {
    /// Whether to log this one, and how many were held back before it.
    fn admit(&self) -> Option<u64> {
        let now = std::time::Instant::now();
        let mut w = self.window.lock().unwrap_or_else(|e| e.into_inner());
        let (start, logged, held) = &mut *w;
        if start.is_none_or(|s| now.duration_since(s) >= Duration::from_secs(60)) {
            *start = Some(now);
            *logged = 0;
        }
        if *logged < REFUSALS_PER_MINUTE {
            *logged += 1;
            Some(std::mem::take(held))
        } else {
            *held += 1;
            None
        }
    }
}

// ── the TLS side ──────────────────────────────────────────────────────────

fn tune(stream: &TcpStream) -> std::io::Result<()> {
    stream.set_nodelay(true)?;
    let sock = socket2::SockRef::from(stream);
    sock.set_tcp_keepalive(
        &socket2::TcpKeepalive::new()
            .with_time(Duration::from_secs(15))
            .with_interval(Duration::from_secs(5))
            .with_retries(3),
    )?;
    sock.set_tcp_user_timeout(Some(USER_TIMEOUT))
}

async fn accept_tls(
    listener: TcpListener,
    tls: Arc<ServerConfig>,
    allow: Arc<AllowList>,
    daemon: Arc<Daemon>,
    preauth: Arc<Preauth>,
) {
    let refusals = Arc::new(RefusalLog::default());
    loop {
        let (stream, addr) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                // EMFILE and friends: back off rather than spin.
                log::warn!("accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let Some(slot) = preauth.slot(addr.ip()) else {
            log::debug!("{addr}: too many connections not yet admitted; closed");
            continue;
        };
        if let Err(e) = tune(&stream) {
            log::warn!("{addr}: setting keepalive: {e}");
            continue;
        }
        let (tls, allow, daemon) = (tls.clone(), allow.clone(), daemon.clone());
        let refusals = refusals.clone();
        tokio::spawn(async move {
            let accepted =
                tokio::time::timeout(HANDSHAKE_TIMEOUT, santree_remote_tls::accept(tls, stream))
                    .await;
            drop(slot);
            let refused = |why: String| {
                if let Some(held) = refusals.admit() {
                    let more = if held > 0 {
                        format!(" ({held} more refusals not logged in the last minute)")
                    } else {
                        String::new()
                    };
                    log::info!("{addr}: {why}{more}");
                }
            };
            let stream = match accepted {
                Ok(Ok(stream)) => stream,
                Ok(Err(e)) => {
                    refused(format!("handshake refused: {e}"));
                    return;
                }
                Err(_) => {
                    refused(format!(
                        "no handshake within {}s; closed",
                        HANDSHAKE_TIMEOUT.as_secs()
                    ));
                    return;
                }
            };
            let Some(key) = santree_remote_tls::peer_key(stream.get_ref().1) else {
                log::warn!("{addr}: handshake finished without a client key; closed");
                return;
            };
            let node = crate::allow::node_id_of(&key);
            daemon::serve_conn(daemon, allow, stream, Peer { key, node, addr }).await;
        });
    }
}

/// A node leaving the allow-list loses the PTYs it opened (its connections
/// close themselves, daemon.rs). On a thread of its own, never the blocking
/// pool: whatever a node has running there, its revocation does not wait
/// behind it. The thread lives as long as the process.
fn revocations(daemon: Arc<Daemon>, allow: Arc<AllowList>) -> Result<(), String> {
    let runtime = tokio::runtime::Handle::current();
    let mut set = allow.subscribe();
    std::thread::Builder::new()
        .name("revocations".into())
        .spawn(move || {
            while runtime.block_on(set.changed()).is_ok() {
                set.borrow_and_update();
                daemon.close_revoked();
            }
        })
        .map(|_| ())
        .map_err(|e| format!("starting the revocation thread: {e}"))
}

async fn reaper(daemon: Arc<Daemon>) {
    let mut ticks = tokio::time::interval(daemon::REAP_EVERY);
    loop {
        ticks.tick().await;
        let daemon = daemon.clone();
        let _ = tokio::task::spawn_blocking(move || daemon.reap(daemon::REAP_AFTER)).await;
    }
}

// ── the hook socket ───────────────────────────────────────────────────────

/// The socket's directory is made 0700 when missing (under systemd it is the
/// unit's RuntimeDirectory, already 0700); a leftover socket nothing answers
/// on is replaced; the socket is 0600.
fn bind_hook_socket(path: &Path) -> Result<UnixListener, String> {
    let shown = path.display();
    let Some(dir) = path.parent() else {
        return Err(format!("{shown} has no parent directory"));
    };
    if !dir.exists() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    match std::fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_socket() => {
            return Err(format!(
                "{shown} exists and is not a socket; not replacing it"
            ));
        }
        Ok(_) => {
            if std::os::unix::net::UnixStream::connect(path).is_ok() {
                return Err(format!("another session host is answering on {shown}"));
            }
            std::fs::remove_file(path)
                .map_err(|e| format!("removing the stale socket {shown}: {e}"))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{shown}: {e}")),
    }
    let listener = UnixListener::bind(path).map_err(|e| format!("binding {shown}: {e}"))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod 0600 {shown}: {e}"))?;
    Ok(listener)
}

async fn accept_hooks(daemon: Arc<Daemon>, listener: UnixListener) {
    // SAFETY: geteuid(2) cannot fail.
    let me = unsafe { libc::geteuid() };
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                log::warn!("hook socket accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        match stream.peer_cred() {
            Ok(cred) if cred.uid() == me => {
                tokio::spawn(daemon::serve_hook_conn(daemon.clone(), stream));
            }
            Ok(cred) => log::warn!("hook socket: refused uid {}", cred.uid()),
            Err(e) => log::warn!("hook socket: no peer credentials: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Review S8: loopback has a pool of its own, the network its per-address
    /// and total limits, and neither can starve the other.
    #[test]
    fn loopback_and_the_network_have_separate_pre_auth_pools() {
        let pre = Arc::new(Preauth::default());
        let lan = |n: u8| IpAddr::from([192, 0, 2, n]);
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        let lo6: IpAddr = "::1".parse().unwrap();

        let mut held: Vec<Slot> = (0..LOOPBACK_PREAUTH)
            .map(|i| pre.slot(if i % 2 == 0 { lo } else { lo6 }).unwrap())
            .collect();
        assert!(pre.slot(lo).is_none(), "loopback's pool is full");
        // The network is untouched by it: three per address…
        for _ in 0..PREAUTH_PER_IP {
            held.push(pre.slot(lan(1)).unwrap());
        }
        assert!(pre.slot(lan(1)).is_none());
        // …and MAX_PREAUTH in all.
        let mut n = 2;
        while held.len() < LOOPBACK_PREAUTH + MAX_PREAUTH {
            if let Some(slot) = pre.slot(lan(n)) {
                held.push(slot);
            } else {
                n += 1;
            }
        }
        assert!(pre.slot(lan(200)).is_none(), "the network's pool is full");
        drop(held);
        assert!(pre.slot(lo).is_some() && pre.slot(lan(1)).is_some());
        assert_eq!(pre.loopback.load(Ordering::Acquire), 0);
        assert_eq!(pre.total.load(Ordering::Acquire), 0);
    }

    #[test]
    fn refusals_are_logged_a_few_a_minute() {
        let log = RefusalLog::default();
        for _ in 0..REFUSALS_PER_MINUTE {
            assert_eq!(log.admit(), Some(0));
        }
        assert_eq!(log.admit(), None);
        assert_eq!(log.admit(), None);
        // A new minute: the first line says how many were held back.
        log.window.lock().unwrap().0 = Some(std::time::Instant::now() - Duration::from_secs(61));
        assert_eq!(log.admit(), Some(2));
    }
}
