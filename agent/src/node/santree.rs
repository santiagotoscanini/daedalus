//! santree's door: how santree on this machine reaches its projects on the
//! box. santree connects to a unix socket here; the agent opens a TLS 1.3
//! connection of its own to the box's session host, proving this machine's
//! NODE key and pinning the host's, and pipes bytes both ways. It never
//! reads santree's protocol, and the control link carries none of it.
//!
//! ```text
//! santree ─unix─▶ run/santree.sock ─ agent ─ TLS 1.3, node key, host key pinned ─▶ session host
//! ```
//!
//! **Where and who.** `paths::santree_socket()`: `run/santree.sock` beside
//! the local socket, 0666 in the service's 0711 `run/`, served on macOS and
//! Linux only (a named pipe on Windows is later work). The file modes let
//! anyone reach it and the kernel's peer check is the gate
//! (`os::operator_allowed`): root, the service's own uid, and the user who
//! installed the agent — `install` records who ran it under `sudo` — and
//! nobody else. Not the console user, as the local socket serves on macOS:
//! a connection here is a shell as the operator on the box (NOPASSWD sudo:
//! root), so it must not follow whoever sits at the Mac. Every process of
//! that user may use it, as it may use the user's own ssh keys. A refused
//! peer gets the door's `forbidden` line; past `MAX_CONNECTIONS` at once,
//! `busy`. santree checks the other end too, as every client of the local
//! socket does (door.rs `server_trusted`: root owning the socket file).
//!
//! **The first line.** santree writes nothing until the agent has spoken
//! one line in its envelope, and the agent reads nothing of santree's before
//! it:
//!
//! ```text
//! {"id":null,"ok":{"host":"<host:port>","node":"<16 hex>","agent":"<version>"}}   then raw bytes both ways
//! {"id":null,"err":{"code":"santree_off","msg":"…"}}                              then closed
//! ```
//!
//! The codes: `santree_off` (this machine's policy keeps it off: Settings ›
//! Machines), `host_key_changed` (the host proved another key than the one
//! the box named — the security signal, never retried quietly), and
//! `unavailable` with the reason for everything else (not paired, not
//! approved, no session host named, the host not reachable, TLS failed).
//! The checks read the KEPT policy (`policy.json`), so santree keeps working
//! while the controller restarts; the host's allow-list is the enforcement,
//! and these give santree a precise message. The one refusal the agent
//! cannot know first is the host turning this key away: TLS 1.3 sends that
//! alert after the client's flight, so it arrives after `ok`, as the end of
//! the stream before any byte, and the agent logs it.
//!
//! **The dial**: every address the name resolves to, then the handshake,
//! all within one `DIAL` deadline; the config (link/tls.rs `pinned_client`)
//! is built once per host key and shared by every connection, on the
//! agent's own pure-Rust TLS provider.
//!
//! **The pipe** (`pipe`): this connection's thread carries santree → host,
//! a second carries host → santree, over one `rustls::Connection` behind a
//! lock and a second lock on the socket's writes (taken first, always), so
//! records reach the wire in the order they were sealed and no lock is held
//! across a read. Backpressure is the sockets': a santree that stops reading
//! stalls the host's side, and the host drops its end (it parks the
//! sessions; santree re-attaches losslessly); a write that blocks past
//! `WRITE_TIMEOUT`, either way, ends the pipe. A host silent past
//! `HOST_SILENCE` is gone (it pings every 15 s). Either side's end is passed
//! on as an end: santree's EOF becomes close_notify and a half-close toward
//! the host, whose own close_notify becomes EOF for santree; anything else
//! (an error, a stream cut short) tears both down.
//!
//! **Logged**: one line as a connection opens or is refused — the peer's
//! uid and pid, the host, the code — and one as it ends: how long, the bytes
//! each way, who ended it. Never a byte of what it carried.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use rustls::ClientConfig;
use serde::Serialize;

use crate::core::shared::Shared;
use crate::identity::Identity;
use crate::ipc::deadline::Deadline;
use crate::ipc::door::{Conn, Peer};
use crate::ipc::rpc::{error_line, line_of, ApiError, Body, ErrorCode, Response};
use crate::link::tls::{self, Tls};
use crate::link::wire::Policy;
use crate::link::LinkState;
use crate::net::{Dialer, Sock};
use crate::util::{LockExt, Rebinding};

/// santree connections served at once: the session host's per-machine cap
/// (`session-host/src/daemon/mod.rs` `MAX_CONNS_PER_NODE`), so the refusal is
/// local and says why. Change both.
pub const MAX_CONNECTIONS: usize = 4;
/// From accept to the pipe: the whole dial fits inside it.
pub const FIRST_LINE: Duration = Duration::from_secs(15);
/// The dial: name, connect and handshake, all of it.
pub const DIAL: Duration = Duration::from_secs(10);
/// A write either way that cannot complete in this long ends the pipe.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// A host heard from for this long is gone (it pings every 15 s).
pub const HOST_SILENCE: Duration = Duration::from_secs(60);
/// The name the agent asks for; nothing checks it, the key is the identity.
const SERVER_NAME: &str = "daedalus-session-host";
/// One read's worth, either way.
const CHUNK: usize = 16 * 1024;

fn unavailable(msg: impl Into<String>) -> ApiError {
    ApiError::new(ErrorCode::Unavailable, msg)
}

/// Where a santree connection may go — the session host's address and key —
/// from this machine's standing and its kept policy; the refusal otherwise.
pub fn admit(
    paired: bool,
    link_state: Option<LinkState>,
    policy: &Policy,
) -> Result<(String, [u8; 32]), ApiError> {
    if !paired {
        return Err(unavailable(
            "this machine is not paired with a box (daedalus-agent pair)",
        ));
    }
    match link_state {
        Some(LinkState::Pending) => {
            return Err(unavailable(
                "the box has not approved this machine yet (Settings › Machines)",
            ))
        }
        Some(LinkState::Revoked) => return Err(unavailable("the box revoked this machine")),
        _ => {}
    }
    if !policy.santree {
        return Err(ApiError::new(
            ErrorCode::SantreeOff,
            "santree is off for this machine (Settings › Machines)",
        ));
    }
    let host = policy.session_host.as_ref().ok_or_else(|| {
        unavailable("the box has named no session host (it runs none, or has not read it yet)")
    })?;
    let (address, key) = host.checked().map_err(unavailable)?;
    Ok((address.to_string(), key))
}

/// Connect to the session host at `address` the way this machine reaches
/// the box (`dialer`: TCP, or its tunnel alone) and prove both keys, the
/// whole of it within `within` (module doc).
pub fn dial(
    dialer: &Dialer,
    address: &str,
    config: Arc<ClientConfig>,
    within: Duration,
) -> Result<Tls, ApiError> {
    let deadline = Deadline::after(within);
    let sock = dialer
        .connect(address, within)
        .map_err(|e| unavailable(format!("the session host: {e}")))?;
    if deadline.passed() {
        return Err(unavailable(format!(
            "the session host at {address} did not answer in time"
        )));
    }
    Tls::client(sock, config, SERVER_NAME, deadline.timeout(within)).map_err(|e| {
        if tls::pin_refused(&e) {
            ApiError::new(
                ErrorCode::HostKeyChanged,
                format!(
                    "the session host at {address} proved another key than the one the box named; \
                     refusing it"
                ),
            )
        } else {
            unavailable(format!(
                "TLS with the session host at {address} failed: {e}"
            ))
        }
    })
}

/// What a connection needs: the service's state, the machine's key, and the
/// client config for the host's key, built once per key.
struct Ctx {
    shared: Arc<Shared>,
    identity: Identity,
    config: Mutex<Option<([u8; 32], Arc<ClientConfig>)>>,
}

impl Ctx {
    fn config_for(&self, key: &[u8; 32]) -> Result<Arc<ClientConfig>, ApiError> {
        let mut held = self.config.lock_ok();
        if let Some((k, c)) = held.as_ref() {
            if k == key {
                return Ok(Arc::clone(c));
            }
        }
        let c = tls::pinned_client(&self.identity, key)
            .map_err(|e| ApiError::new(ErrorCode::Internal, format!("no TLS client: {e:#}")))?;
        *held = Some((*key, Arc::clone(&c)));
        Ok(c)
    }

    /// The checks, then the dial (module doc).
    fn open(&self) -> Result<(String, Tls), ApiError> {
        let (keys, _) = self.shared.link.keys();
        let state = self.shared.link.status().and_then(|l| l.state);
        let (address, key) = admit(keys.paired(), state, &self.shared.settings.policy())?;
        let tls = dial(
            &self.shared.link.dialer(),
            &address,
            self.config_for(&key)?,
            DIAL,
        )?;
        Ok((address, tls))
    }
}

/// The `ok` line: where the pipe goes, this machine, this agent.
fn ok_line(host: &str, node: &str) -> String {
    #[derive(Serialize)]
    struct Verdict<'a> {
        host: &'a str,
        node: &'a str,
        agent: &'a str,
    }
    let raw = serde_json::value::to_raw_value(&Verdict {
        host,
        node,
        agent: crate::VERSION,
    })
    .expect("the verdict serialises");
    line_of(&Response {
        id: None,
        body: Body::Ok(raw),
    })
}

/// One connection, on the door's thread (module doc).
fn serve_one(ctx: &Ctx, mut conn: Conn) {
    let uid = match conn.peer {
        Some(Peer::Uid(u)) => Some(u),
        _ => None,
    };
    let pid = conn.pid;
    let (address, tls) = match ctx.open() {
        Ok(opened) => opened,
        Err(e) => {
            tracing::info!(uid, pid, code = %e.code, why = %e.msg, "santree: refused");
            ctx.shared.santree.refused(e.code);
            let _ = conn.writer.write_all(error_line(e.code, e.msg).as_bytes());
            let _ = conn.writer.flush();
            (conn.close)();
            return;
        }
    };
    if conn
        .writer
        .write_all(ok_line(&address, &ctx.identity.node_id()).as_bytes())
        .and_then(|()| conn.writer.flush())
        .is_err()
    {
        (conn.close)();
        return;
    }
    // Piping now: the first line's deadline no longer applies.
    (std::mem::replace(&mut conn.on_hello, Box::new(|| {})))();
    tracing::info!(uid, pid, host = %address, "santree: piping to the session host");
    // Counted on the status page while it pipes.
    let _open = ctx.shared.santree.opened();
    let started = Instant::now();
    let end = pipe(conn, tls, &Limits::default());
    if end.refused_key {
        tracing::warn!(host = %address, "santree: the session host refused this machine's key (its allow-list does not hold it yet, or no longer)");
    }
    tracing::info!(
        uid,
        pid,
        host = %address,
        secs = started.elapsed().as_secs(),
        up = end.up,
        down = end.down,
        ended = %end.by,
        "santree: closed"
    );
}

/// The door's policy: `allow` asked per connection (module doc).
fn door_policy(allow: crate::ipc::door::Allow) -> crate::ipc::door::Policy {
    crate::ipc::door::Policy {
        what: "santree",
        allow,
        refusal: Arc::new(refusal),
        busy: crate::ipc::door::busy(MAX_CONNECTIONS),
        max_connections: MAX_CONNECTIONS,
        first_line: FIRST_LINE,
        write_timeout: WRITE_TIMEOUT,
        whole: None,
        open_to_others: true,
    }
}

/// The line a refused peer gets before its connection is closed.
pub fn refusal(peer: Option<&Peer>) -> String {
    crate::ipc::door::refusal(
        "santree's socket",
        peer,
        "root and the user who installed the agent",
    )
}

/// Serve santree's door at `path`, `allow` deciding each peer, until the
/// returned handle is dropped.
pub fn serve_at(
    path: &Path,
    shared: Arc<Shared>,
    identity: Identity,
    allow: crate::ipc::door::Allow,
) -> anyhow::Result<crate::os::LocalSocket> {
    let ctx = Arc::new(Ctx {
        shared,
        identity,
        config: Mutex::new(None),
    });
    crate::os::serve_local(path, &door_policy(allow), move |c| serve_one(&ctx, c))
}

/// santree's socket, served now or later: one that cannot be made does not
/// stop the service, and is tried again every `local::BIND_RETRY`.
pub struct Door {
    /// Held for its drop, which stops serving and removes the socket.
    _socket: Rebinding<crate::os::LocalSocket>,
}

impl Door {
    pub fn start(shared: Arc<Shared>, identity: Identity) -> Self {
        let path = crate::core::paths::santree_socket();
        let mut last: Option<String> = None;
        let _socket = Rebinding::start("santree-bind", crate::ipc::local::BIND_RETRY, move || {
            let allow: crate::ipc::door::Allow = Arc::new(|peer| {
                crate::ipc::door::peer_allowed(peer, &crate::os::operator_allowed())
            });
            match serve_at(&path, Arc::clone(&shared), identity.clone(), allow) {
                Ok(s) => {
                    tracing::info!(socket = %path.display(), "santree socket answering");
                    Some(s)
                }
                Err(e) => {
                    let why = format!("{e:#}");
                    if last.as_deref() != Some(why.as_str()) {
                        tracing::error!(error = %why, "santree's socket could not be made; the service runs on and tries again");
                        last = Some(why);
                    }
                    None
                }
            }
        });
        Self { _socket }
    }
}

// ── the pipe ──────────────────────────────────────────────────────────────

/// The pipe's clocks; `Default` is the module's, the tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// A write to the host that blocks this long ends the pipe.
    pub write_timeout: Duration,
    /// A host silent this long is gone.
    pub host_silence: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            write_timeout: WRITE_TIMEOUT,
            host_silence: HOST_SILENCE,
        }
    }
}

/// How a pipe ended.
#[derive(Debug)]
pub struct End {
    /// Bytes santree sent, and bytes it was sent.
    pub up: u64,
    pub down: u64,
    /// Who ended it: "santree", "the session host", or what failed.
    pub by: String,
    /// The host's `access_denied` (or `certificate_required`) came before
    /// any byte: it does not admit this machine's key.
    pub refused_key: bool,
}

/// One pipe's shared half: the TLS state, the socket, santree's end.
struct Link {
    tls: Mutex<rustls::Connection>,
    /// The socket's writes: held while records are sealed and sent, and
    /// always taken before `tls`.
    wire: Mutex<Sock>,
    tcp: Sock,
    santree_close: Arc<dyn Fn() + Send + Sync>,
    closed: Once,
    /// Who ended it, first come.
    ended: Mutex<Option<String>>,
    /// The host refused this machine's key before any byte (`End`).
    refused_key: AtomicBool,
    up: AtomicU64,
    down: AtomicU64,
}

impl Link {
    /// Let `f` put plaintext or an alert into the connection, then seal
    /// and send what it queued, in order (the lock order is `wire`, `tls`).
    fn send(&self, f: impl FnOnce(&mut rustls::Connection) -> io::Result<()>) -> io::Result<()> {
        let mut wire = self.wire.lock_ok();
        let mut out = Vec::new();
        {
            let mut tls = self.tls.lock_ok();
            f(&mut tls)?;
            while tls.wants_write() {
                tls.write_tls(&mut out)?;
            }
        }
        wire.write_all(&out)
    }

    fn end(&self, by: impl Into<String>) {
        self.ended.lock_ok().get_or_insert_with(|| by.into());
    }

    /// Tear both sides down, once: close_notify to the host if the wire is
    /// free (never waiting on it), then the socket, then santree's end.
    fn close(&self) {
        self.closed.call_once(|| {
            if let Ok(mut wire) = self.wire.try_lock() {
                let mut out = Vec::new();
                if let Ok(mut tls) = self.tls.try_lock() {
                    tls.send_close_notify();
                    while tls.wants_write() && tls.write_tls(&mut out).is_ok() {}
                }
                let _ = wire.set_write_timeout(Some(Duration::from_secs(1)));
                let _ = wire.write_all(&out);
            }
            let _ = self.tcp.shutdown(Shutdown::Both);
            (self.santree_close)();
        });
    }
}

/// santree → host, on the calling thread: Ok when santree ended its side,
/// else what failed.
fn upstream(link: &Link, mut from: Box<dyn Read + Send>) -> Result<(), String> {
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("reading santree: {e}")),
        };
        link.send(|t| t.writer().write_all(&buf[..n]))
            .map_err(|e| format!("writing to the session host: {e}"))?;
        link.up.fetch_add(n as u64, Ordering::Relaxed);
    }
}

/// How the host's side ended.
enum Down {
    /// close_notify: the host is done sending.
    Closed,
    /// Anything else, said for the log; `refused` when it was the host's
    /// refusal of this key before any byte.
    Failed { why: String, refused: bool },
}

/// host → santree, on a thread of its own (module doc).
fn downstream(
    link: &Link,
    mut tcp: Sock,
    mut to: Box<dyn Write + Send>,
    end_writes: &(dyn Fn() + Send + Sync),
    silence: Duration,
) -> Down {
    let failed = |why: String| Down::Failed {
        why,
        refused: false,
    };
    let mut buf = vec![0u8; CHUNK];
    let mut plain = Vec::with_capacity(CHUNK);
    let mut chunk = vec![0u8; CHUNK];
    loop {
        let n = match tcp.read(&mut buf) {
            Ok(0) => return failed("the session host cut the stream (no close_notify)".into()),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return failed(format!(
                    "the session host was silent for {} s",
                    silence.as_secs()
                ))
            }
            Err(e) => return failed(format!("reading the session host: {e}")),
        };
        // rustls may take less than it was given: feed it until it took
        // everything, handing santree the plaintext as it comes.
        let mut rest = &buf[..n];
        while !rest.is_empty() {
            let (closed, wants_write, broken) = {
                let mut tls = link.tls.lock_ok();
                let before = rest.len();
                if let Err(e) = tls.read_tls(&mut rest) {
                    return failed(format!("TLS: {e}"));
                }
                if rest.len() == before {
                    return failed("TLS: the session host's records were not taken".into());
                }
                match tls.process_new_packets() {
                    Ok(_) => {
                        let mut closed = false;
                        loop {
                            match tls.reader().read(&mut chunk) {
                                Ok(0) => {
                                    closed = true;
                                    break;
                                }
                                Ok(k) => plain.extend_from_slice(&chunk[..k]),
                                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                                Err(e) => return failed(format!("TLS: {e}")),
                            }
                        }
                        (closed, tls.wants_write(), None)
                    }
                    Err(e) => (false, tls.wants_write(), Some(e)),
                }
            };
            if !plain.is_empty() {
                if let Err(e) = to.write_all(&plain).and_then(|()| to.flush()) {
                    return failed(format!("writing to santree: {e}"));
                }
                link.down.fetch_add(plain.len() as u64, Ordering::Relaxed);
                plain.clear();
            }
            // Alerts and key updates the records asked for — the alert that
            // says why, too, when they were refused.
            if wants_write {
                if let Err(e) = link.send(|_| Ok(())) {
                    if broken.is_none() {
                        return failed(format!("writing to the session host: {e}"));
                    }
                }
            }
            if let Some(e) = broken {
                let refused = link.down.load(Ordering::Relaxed) == 0
                    && matches!(
                        e,
                        rustls::Error::AlertReceived(
                            rustls::AlertDescription::AccessDenied
                                | rustls::AlertDescription::CertificateRequired
                        )
                    );
                return Down::Failed {
                    why: format!("TLS: {e}"),
                    refused,
                };
            }
            if closed {
                end_writes();
                return Down::Closed;
            }
        }
    }
}

/// Pipe santree's `conn` and the host's `tls` into each other until both
/// sides ended or either failed (module doc).
pub fn pipe(conn: Conn, tls: Tls, limits: &Limits) -> End {
    let fail = |why: String, conn: &Conn| {
        (conn.close)();
        End {
            up: 0,
            down: 0,
            by: why,
            refused_key: false,
        }
    };
    let (rustls_conn, tcp) = match tls.into_parts() {
        Ok(p) => p,
        Err(e) => return fail(format!("the socket: {e}"), &conn),
    };
    let halves = tcp
        .set_read_timeout(Some(limits.host_silence))
        .and_then(|()| tcp.set_write_timeout(Some(limits.write_timeout)))
        .and_then(|()| Ok((tcp.try_clone()?, tcp.try_clone()?)));
    let (wire, reading) = match halves {
        Ok(h) => h,
        Err(e) => return fail(format!("the socket: {e}"), &conn),
    };
    let Conn {
        reader,
        writer,
        close,
        end_writes,
        ..
    } = conn;
    let link = Arc::new(Link {
        tls: Mutex::new(rustls_conn),
        wire: Mutex::new(wire),
        tcp,
        santree_close: close,
        closed: Once::new(),
        ended: Mutex::new(None),
        refused_key: AtomicBool::new(false),
        up: AtomicU64::new(0),
        down: AtomicU64::new(0),
    });
    let silence = limits.host_silence;
    let down = {
        let link = Arc::clone(&link);
        std::thread::Builder::new()
            .name("santree-down".into())
            .spawn(
                move || match downstream(&link, reading, writer, &*end_writes, silence) {
                    Down::Closed => link.end("the session host"),
                    Down::Failed { why, refused } => {
                        link.refused_key.store(refused, Ordering::Relaxed);
                        link.end(why);
                        link.close();
                    }
                },
            )
    };
    let down = match down {
        Ok(d) => d,
        Err(e) => {
            link.close();
            return End {
                up: 0,
                down: 0,
                by: format!("no thread for the pipe: {e}"),
                refused_key: false,
            };
        }
    };
    match upstream(&link, reader) {
        Ok(()) => {
            link.end("santree");
            // Passed on as an end: close_notify, and no more from this side.
            let said = link.send(|t| {
                t.send_close_notify();
                Ok(())
            });
            if said.is_err() || link.tcp.shutdown(Shutdown::Write).is_err() {
                link.close();
            }
        }
        Err(why) => {
            link.end(why);
            link.close();
        }
    }
    let _ = down.join();
    link.close();
    let by = link.ended.lock_ok().take().unwrap_or_default();
    End {
        up: link.up.load(Ordering::Relaxed),
        down: link.down.load(Ordering::Relaxed),
        by,
        refused_key: link.refused_key.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod tests;
