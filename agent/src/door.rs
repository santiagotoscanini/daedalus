//! A local door: a unix socket or a Windows named pipe that knows who is
//! calling. What is the same on every OS lives here — the transport a
//! connection is handed over as (`Conn`), the peer the kernel names
//! (`Peer`), the gate's policy (`Policy`), and the client's check on the
//! server (`server_trusted`); the OS supplies only the socket or pipe and
//! the peer's identity (os/). Two doors use it: the controller's API
//! (api/) and the agent's own local socket (local.rs).

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
