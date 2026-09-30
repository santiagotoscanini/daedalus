//! A local door: a unix socket or a Windows named pipe that knows who is
//! calling. What is the same on every OS lives here — the transport a
//! connection is handed over as (`Conn`), the peer the kernel names
//! (`Peer`), the gate's policy (`Policy`), and the client's check on the
//! server (`server_trusted`); the OS supplies only the socket or pipe and
//! the peer's identity (os/). Two doors use it: the controller's API
//! (api/) and the agent's own local socket (local.rs).

use crate::util::LockExt;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

/// Windows' LocalSystem.
pub const SYSTEM_SID: &str = "S-1-5-18";
/// The longest line a door reads (either way on the local socket).
pub const MAX_LINE: usize = 1 << 20;

/// One connection's transport, as the os layer hands it over.
pub struct Conn {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    /// `hello` was answered: lift the deadline the first line had.
    pub on_hello: Box<dyn FnOnce() + Send>,
    /// Tear the transport down both ways: a blocked read returns, and the
    /// peer sees the connection end.
    pub close: Arc<dyn Fn() + Send + Sync>,
    /// Stop writing: the peer reads the end while it may still write (a
    /// unix socket's half-close); nothing where the transport has none.
    pub end_writes: Arc<dyn Fn() + Send + Sync>,
    /// Who is on the other end, as the door checked it (`serve` sets it
    /// before the handler runs).
    pub peer: Option<Peer>,
    /// The peer's process, where the OS names it (a unix socket's
    /// `SO_PEERCRED` or `LOCAL_PEERPID`): for the log.
    pub pid: Option<u32>,
}

impl Conn {
    /// Two halves with no deadline to lift and nothing to tear down beyond
    /// dropping them (the tests' in-memory transports).
    pub fn plain(reader: impl Read + Send + 'static, writer: impl Write + Send + 'static) -> Self {
        Self {
            reader: Box::new(reader),
            writer: Box::new(writer),
            on_hello: Box::new(|| {}),
            close: Arc::new(|| {}),
            end_writes: Arc::new(|| {}),
            peer: None,
            pid: None,
        }
    }
}

/// Who is on the other end, as the kernel says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Peer {
    /// A unix uid.
    Uid(u32),
    /// A Windows SID, in its string form (`S-1-5-…`).
    Sid(String),
}

impl std::fmt::Display for Peer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Peer::Uid(u) => write!(f, "uid {u}"),
            Peer::Sid(s) => write!(f, "{s}"),
        }
    }
}

/// Whom the socket serves right now (the OS's `local_allowed`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Allowed {
    pub peers: Vec<Peer>,
}

/// macOS and Linux: root, the agent's own uid, and the users the machine
/// runs Claude for.
pub fn unix_allowed(own_uid: u32, claude_users: &[u32]) -> Allowed {
    let mut peers = vec![Peer::Uid(0), Peer::Uid(own_uid)];
    peers.extend(claude_users.iter().map(|u| Peer::Uid(*u)));
    peers.dedup();
    Allowed { peers }
}

/// Windows: SYSTEM and the users logged on interactively.
pub fn windows_allowed(logged_on: Vec<String>) -> Allowed {
    let mut peers = vec![Peer::Sid(SYSTEM_SID.into())];
    peers.extend(logged_on.into_iter().map(Peer::Sid));
    Allowed { peers }
}

/// The gate: a peer whose credentials could not be read is refused.
pub fn peer_allowed(peer: Option<&Peer>, allowed: &Allowed) -> bool {
    peer.is_some_and(|p| allowed.peers.contains(p))
}

/// What a client can learn about the server end without opening the
/// service's process (a non-elevated user cannot open a SYSTEM process).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerSide {
    /// A unix socket: the server's uid as the kernel names it
    /// (`SO_PEERCRED` / `getpeereid` work from the client too), and the
    /// socket file's owner.
    Unix {
        uid: Option<u32>,
        file_owner: Option<u32>,
    },
    /// A named pipe: the pipe object's owner — SYSTEM or Administrators
    /// when a service made it (`owner_privileged`), else its SID — and the
    /// server's session (`GetNamedPipeServerSessionId`; 0 for a service).
    Pipe {
        owner: Option<String>,
        owner_privileged: bool,
        session: Option<u32>,
    },
}

/// The client's check on the service (module doc). On unix: the server is
/// root or this very user (the controller's operator, a development run),
/// and owns the socket file it answers on. On Windows: the pipe belongs to
/// SYSTEM or Administrators and its server runs in session 0 — or, for a
/// development run (`dev`) alone, the pipe is this user's own.
pub fn server_trusted(server: &ServerSide, own: Option<&Peer>, dev: bool) -> bool {
    match server {
        ServerSide::Unix {
            uid: Some(uid),
            file_owner: Some(owner),
        } => uid == owner && (*uid == 0 || own == Some(&Peer::Uid(*uid))),
        ServerSide::Unix { .. } => false,
        ServerSide::Pipe {
            owner_privileged: true,
            session: Some(0),
            ..
        } => true,
        ServerSide::Pipe { owner: Some(o), .. } => dev && own == Some(&Peer::Sid(o.clone())),
        ServerSide::Pipe { .. } => false,
    }
}

/// Whether this process is a development run (`DAEDALUS_AGENT_DATA_DIR`).
pub fn dev_run() -> bool {
    std::env::var_os(crate::paths::DATA_DIR_ENV).is_some_and(|v| !v.is_empty())
}

/// The check a connection passes, with the peer the kernel named.
pub type Allow = Arc<dyn Fn(Option<&Peer>) -> bool + Send + Sync>;
/// The line a refused peer gets, from the peer the kernel named.
pub type Refusal = Arc<dyn Fn(Option<&Peer>) -> String + Send + Sync>;

/// What a door applies to every connection before its handler sees it.
#[derive(Clone)]
pub struct Policy {
    /// For the log and the threads' names.
    pub what: &'static str,
    /// Asked for each connection, with the peer the kernel named.
    pub allow: Allow,
    /// The line a refused peer gets before its connection is closed.
    pub refusal: Refusal,
    /// The line a connection past `max_connections` gets.
    pub busy: String,
    pub max_connections: usize,
    /// The deadline a connection starts with: until `hello` (lifted by
    /// `Conn::on_hello`), or the whole exchange (`whole`).
    pub first_line: Duration,
    /// How long one write may block before the peer is taken for gone.
    pub write_timeout: Duration,
    /// The whole exchange's deadline, for a door that answers one request
    /// per connection; None for the API's long-lived ones.
    pub whole: Option<Duration>,
    /// Whether users other than the server's own may reach the socket file
    /// (unix modes 0711/0666 rather than 0700/0600); the peer check is then
    /// the gate. A pipe's DACL is fixed.
    pub open_to_others: bool,
}

/// When the OS can name a connection's peer.
pub enum PeerAt {
    /// At once, before a byte is read (`SO_PEERCRED`, `getpeereid`).
    Now(Option<Peer>),
    /// Once the client has written: a named pipe's client token is read
    /// while impersonating it, which needs its first write read.
    AfterRequest(Box<dyn FnOnce() -> Option<Peer> + Send>),
}

/// One connection as the OS hands it to `serve`.
pub struct Accepted {
    /// `close` ends it gracefully (what was written reaches the peer).
    pub conn: Conn,
    /// Tear it down at once, from any thread, whatever the connection's
    /// own thread is blocked in: the watchdog's.
    pub abort: Arc<dyn Fn() + Send + Sync>,
    pub peer: PeerAt,
}

/// The OS's half of a door: the next connection, and nothing else.
pub trait Listener: Send + 'static {
    /// The next connection; None once the door is stopped.
    fn accept(&self) -> Option<std::io::Result<Accepted>>;
}

/// Connections counted, for as long as each lives.
struct Slot(Arc<std::sync::atomic::AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

/// Serve a door (module doc), the same on every OS: each connection on a
/// thread of its own under a `Watchdog` — the first line's deadline, lifted
/// by `hello`, or the whole exchange's — so no peer holds a thread or a
/// slot past it by trickling, by not reading, or by leaving a flush
/// pending; the peer checked before its connection reaches `on_conn`,
/// before anything is read where the OS can say who it is; at most
/// `max_connections` served, one past that told `busy`, and past twice
/// that closed without a word.
pub fn serve<L, F>(listener: L, policy: Policy, on_conn: F) -> std::io::Result<()>
where
    L: Listener,
    F: Fn(Conn) + Send + Sync + 'static,
{
    use std::sync::atomic::{AtomicUsize, Ordering};
    let on_conn = Arc::new(on_conn);
    let served = Arc::new(AtomicUsize::new(0));
    let open = Arc::new(AtomicUsize::new(0));
    std::thread::Builder::new()
        .name(format!("{}-accept", policy.what))
        .spawn(move || {
            while let Some(next) = listener.accept() {
                let a = match next {
                    Ok(a) => a,
                    Err(e) => {
                        // Out of descriptors, say: not a reason to spin.
                        tracing::debug!(error = %e, door = policy.what, "accept failed");
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                };
                if open.fetch_add(1, Ordering::AcqRel) >= 2 * policy.max_connections {
                    open.fetch_sub(1, Ordering::AcqRel);
                    tracing::warn!(door = policy.what, "closed a connection far past the limit");
                    (a.abort)();
                    continue;
                }
                let opened = Slot(Arc::clone(&open));
                let busy = served.fetch_add(1, Ordering::AcqRel) >= policy.max_connections;
                let counted = Slot(Arc::clone(&served));
                let (policy, on_conn) = (policy.clone(), Arc::clone(&on_conn));
                let abort = Arc::clone(&a.abort);
                let spawned = std::thread::Builder::new()
                    .name(format!("{}-conn", policy.what))
                    .spawn(move || {
                        let _slots = (opened, counted);
                        one(a, busy, &policy, &*on_conn);
                    });
                if spawned.is_err() {
                    abort();
                }
            }
        })?;
    Ok(())
}

/// One connection, on its own thread (`serve`).
fn one(a: Accepted, busy: bool, policy: &Policy, on_conn: &(dyn Fn(Conn) + Send + Sync)) {
    use crate::deadline::{Deadline, Watchdog};
    let Accepted {
        mut conn,
        abort,
        peer,
    } = a;
    let first = policy.whole.unwrap_or(policy.first_line);
    let dog = {
        let abort = Arc::clone(&abort);
        Watchdog::arm(Deadline::after(first), move || abort())
    };
    let refuse = |mut conn: Conn, line: &str| {
        let _ = conn.writer.write_all(line.as_bytes());
        let _ = conn.writer.flush();
        (conn.close)();
    };
    if busy {
        tracing::warn!(
            max = policy.max_connections,
            door = policy.what,
            "refused a connection past the limit"
        );
        return refuse(conn, &policy.busy);
    }
    let peer = match peer {
        PeerAt::Now(p) => p,
        PeerAt::AfterRequest(who) => {
            let mut lines = crate::jsonl::LineReader::new(conn.reader, MAX_LINE);
            let line = match lines.next_line() {
                Ok(Some(l)) => l,
                _ => {
                    abort();
                    return;
                }
            };
            let p = who();
            let (mut rest, reader) = lines.into_parts();
            let mut first = line;
            first.push(b'\n');
            first.append(&mut rest);
            conn.reader = Box::new(std::io::Cursor::new(first).chain(reader));
            p
        }
    };
    if !(policy.allow)(peer.as_ref()) {
        tracing::warn!(peer = ?peer, door = policy.what, "refused a peer that may not use the door");
        return refuse(conn, &(policy.refusal)(peer.as_ref()));
    }
    conn.peer = peer;
    if policy.whole.is_none() {
        let dog = std::sync::Mutex::new(Some(dog));
        conn.on_hello = Box::new(move || {
            drop(dog.lock_ok().take());
        });
        on_conn(conn);
    } else {
        on_conn(conn);
        drop(dog);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_the_agent_and_the_claude_user_are_served_on_unix() {
        let a = unix_allowed(0, &[1000]);
        assert!(peer_allowed(Some(&Peer::Uid(0)), &a));
        assert!(peer_allowed(Some(&Peer::Uid(1000)), &a));
        assert!(!peer_allowed(Some(&Peer::Uid(1001)), &a));
        assert!(!peer_allowed(None, &a));
        // The controller: its own user, root, nobody else by default.
        let c = unix_allowed(1000, &[]);
        assert!(peer_allowed(Some(&Peer::Uid(1000)), &c));
        assert!(peer_allowed(Some(&Peer::Uid(0)), &c));
        assert!(!peer_allowed(Some(&Peer::Uid(100999)), &c));
        // A SID is never a uid.
        assert!(!peer_allowed(Some(&Peer::Sid("S-1-5-18".into())), &c));
    }

    #[test]
    fn system_and_the_logged_on_users_are_served_on_windows() {
        let me = "S-1-5-21-1-2-3-1001".to_string();
        let a = windows_allowed(vec![me.clone()]);
        assert!(peer_allowed(Some(&Peer::Sid(SYSTEM_SID.into())), &a));
        assert!(peer_allowed(Some(&Peer::Sid(me)), &a));
        assert!(!peer_allowed(
            Some(&Peer::Sid("S-1-5-21-1-2-3-1002".into())),
            &a
        ));
        // Nobody logged on: SYSTEM alone.
        let none = windows_allowed(vec![]);
        assert!(!peer_allowed(
            Some(&Peer::Sid("S-1-5-21-1-2-3-1001".into())),
            &none
        ));
        assert!(!peer_allowed(Some(&Peer::Uid(0)), &none));
    }

    #[test]
    fn the_client_trusts_the_service_by_what_it_can_see_of_it() {
        let me = Peer::Uid(1000);
        let unix = |uid, file_owner| ServerSide::Unix { uid, file_owner };
        // Root, on a socket file root owns: the installed service.
        assert!(server_trusted(&unix(Some(0), Some(0)), Some(&me), false));
        // This user, on its own socket: the controller's operator, a dev run.
        assert!(server_trusted(
            &unix(Some(1000), Some(1000)),
            Some(&me),
            false
        ));
        // Anyone else, or a server that is not the file's owner, or unread.
        assert!(!server_trusted(
            &unix(Some(1001), Some(1001)),
            Some(&me),
            false
        ));
        assert!(!server_trusted(
            &unix(Some(1000), Some(0)),
            Some(&me),
            false
        ));
        assert!(!server_trusted(
            &unix(Some(0), Some(1001)),
            Some(&me),
            false
        ));
        assert!(!server_trusted(&unix(None, Some(0)), Some(&me), false));
        // A pipe the service made: SYSTEM or Administrators own it, session 0.
        let sid = Peer::Sid("S-1-5-21-9".into());
        let pipe = |owner: Option<&str>, owner_privileged, session| ServerSide::Pipe {
            owner: owner.map(str::to_string),
            owner_privileged,
            session,
        };
        assert!(server_trusted(
            &pipe(Some(SYSTEM_SID), true, Some(0)),
            Some(&sid),
            false
        ));
        // Privileged but in a user's session, or unprivileged: no.
        assert!(!server_trusted(
            &pipe(Some(SYSTEM_SID), true, Some(1)),
            Some(&sid),
            false
        ));
        assert!(!server_trusted(
            &pipe(Some("S-1-5-21-8"), false, Some(0)),
            Some(&sid),
            false
        ));
        // This user's own pipe: a development run only.
        assert!(!server_trusted(
            &pipe(Some("S-1-5-21-9"), false, Some(1)),
            Some(&sid),
            false
        ));
        assert!(server_trusted(
            &pipe(Some("S-1-5-21-9"), false, Some(1)),
            Some(&sid),
            true
        ));
        assert!(!server_trusted(
            &pipe(Some("S-1-5-21-8"), false, Some(1)),
            Some(&sid),
            true
        ));
        assert!(!server_trusted(&pipe(None, false, None), Some(&sid), true));
    }
}
