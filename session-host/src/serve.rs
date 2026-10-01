//! `serve`: the TLS listeners and the hook socket, the tasks beside them
//! (status file, revocation, reaper), and a clean stop.
//!
//! A connection not yet admitted holds a pre-auth slot (preauth.rs) and has
//! [`HANDSHAKE_TIMEOUT`] to finish the TLS handshake, which admits a key only
//! if the allow-list does; accepted sockets get TCP keepalive and
//! `TCP_USER_TIMEOUT` = [`USER_TIMEOUT`]. Why: README.md, "The link".

use std::future::Future;
use std::net::SocketAddr;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use santree_remote_proto::{HOOK_QUEUE_CAP, PING_INTERVAL};
use santree_remote_tls::{rustls::ServerConfig, Identity};
use tokio::net::{TcpListener, TcpStream, UnixListener};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::allow::AllowList;
use crate::config::Config;
use crate::daemon::{self, Daemon, Options, Peer};
use crate::preauth::{Preauth, RefusalLog};
use crate::status::StatusWriter;
use crate::{hostkey, sys};

/// From accept to a finished TLS handshake.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Unacknowledged data older than this ends the connection.
pub const USER_TIMEOUT: Duration = Duration::from_secs(30);
/// Hook socket connections served at once; another is closed unanswered (the
/// hook command logs it and gives up, as it does after its ~200 ms).
pub const MAX_HOOK_CONNS: usize = 16;
/// How long one hook socket connection may stay open.
pub const HOOK_CONN_DEADLINE: Duration = Duration::from_secs(1);

/// Every connection's task (TLS and hook socket), aborted at shutdown before
/// the PTYs are closed and the last status written.
type ConnTasks = Arc<Mutex<JoinSet<()>>>;

/// Run `task` in `tasks`, forgetting the ones that finished.
fn track(tasks: &ConnTasks, task: impl Future<Output = ()> + Send + 'static) {
    let mut tasks = tasks.lock().unwrap_or_else(|e| e.into_inner());
    while tasks.try_join_next().is_some() {}
    tasks.spawn(task);
}

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
        let conns = ConnTasks::default();
        let mut tasks = vec![
            tokio::spawn(status.clone().run()),
            tokio::spawn(reaper(daemon.clone())),
            tokio::spawn(accept_hooks(daemon.clone(), self.hooks, conns.clone())),
        ];
        let preauth = Arc::new(Preauth::default());
        for listener in self.listeners {
            tasks.push(tokio::spawn(accept_tls(
                listener,
                self.tls.clone(),
                self.allow.clone(),
                daemon.clone(),
                preauth.clone(),
                conns.clone(),
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

        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
        // The accept loops are gone, so nothing adds to it any more.
        let mut open = std::mem::take(&mut *conns.lock().unwrap_or_else(|e| e.into_inner()));
        open.shutdown().await;
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
    conns: ConnTasks,
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
        track(&conns, async move {
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

async fn accept_hooks(daemon: Arc<Daemon>, listener: UnixListener, conns: ConnTasks) {
    // SAFETY: geteuid(2) cannot fail.
    let me = unsafe { libc::geteuid() };
    let slots = Arc::new(Semaphore::new(MAX_HOOK_CONNS));
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
                let Ok(slot) = slots.clone().try_acquire_owned() else {
                    log::warn!("hook socket: {MAX_HOOK_CONNS} connections open; closed one");
                    continue;
                };
                let daemon = daemon.clone();
                track(&conns, async move {
                    let _slot = slot;
                    let served = daemon::serve_hook_conn(daemon, stream);
                    if tokio::time::timeout(HOOK_CONN_DEADLINE, served)
                        .await
                        .is_err()
                    {
                        log::warn!(
                            "hook socket: a connection open over {}s; closed",
                            HOOK_CONN_DEADLINE.as_secs()
                        );
                    }
                });
            }
            Ok(cred) => log::warn!("hook socket: refused uid {}", cred.uid()),
            Err(e) => log::warn!("hook socket: no peer credentials: {e}"),
        }
    }
}
