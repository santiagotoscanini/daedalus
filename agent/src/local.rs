//! The agent's local door: one socket on the machine for the tray, the
//! session and the verbs (`daedalus-agent status`, `claude restart`) — a
//! unix socket on macOS and Linux, a named pipe on Windows — that knows who
//! is calling. The kernel names the peer and the service decides; nothing
//! listens on TCP for them, so loopback is no longer a credential.
//!
//! **Where.** `paths::local_socket()`: `<data_dir>/run/agent.sock` on
//! macOS and Linux, in a directory the service makes 0711 (root's on a
//! node, the operator's on the controller) with the socket 0666 — the file
//! modes let every local user reach it and the peer check below is the
//! gate; `\\.\pipe\daedalus-agent` on Windows, whose DACL grants SYSTEM and
//! the interactive users read and write-data (never the right to create a
//! second instance of the pipe) and which refuses remote clients. A
//! development run (`DAEDALUS_AGENT_DATA_DIR`) gets a pipe of its own, as
//! it gets its own Claude unit.
//!
//! **Who** (`peer_allowed`, the OS's `local_allowed`): on macOS and Linux,
//! root, the agent's own uid, and the user the machine runs Claude for —
//! on Linux the session user `install` recorded (`session.json`), on macOS
//! the user at the console (the owner of `/dev/console`); on Windows,
//! SYSTEM and the users logged on interactively (each session's token),
//! read from the client's process token (`GetNamedPipeClientProcessId`).
//! Anyone else gets one `forbidden` line and a closed connection. The
//! client checks the other end too (`server_trusted`): root or SYSTEM, or
//! its own user (a development run), so a pipe squatted while the service
//! is down cannot hand the session orders.
//!
//! **Protocol.** One request per connection, one JSON line each way, at
//! most `MAX_LINE` bytes: `{"m":"<method>","p":…}` → `{"ok":…}` or
//! `{"err":"…"}`, then the service closes. The whole exchange has
//! `DEADLINE`; at most `MAX_CONNECTIONS` are served at once.
//!
//! | method           | takes            | answers                                        |
//! |------------------|------------------|------------------------------------------------|
//! | `status`         | —                | the status document (shared.rs `Document`)     |
//! | `claude`         | —                | the session's full report, or null             |
//! | `claude.report`  | a `Report`       | the `ReportAnswer` (the session's poll)        |
//! | `claude.roster`  | a `Roster`       | null                                           |
//! | `claude.restart` | —                | a sentence; the session restarts the server    |
//! | `claude.update`  | —                | a sentence; refused where nix pins Claude      |
//! | `update.check`   | —                | a sentence; the updater looks now              |
//!
//! The report and the roster are the session's to post; any peer the gate
//! lets through may, since each of those is a user the machine runs Claude
//! for (or root).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::conn::Conn;
use crate::claude::{Report, Roster};
use crate::shared::Shared;

/// The longest line either way.
pub const MAX_LINE: usize = 1 << 20;
/// The whole exchange, from connect to the answer.
pub const DEADLINE: Duration = Duration::from_secs(5);
/// A client's whole exchange: short, since the tray asks from its UI
/// thread.
pub const CLIENT_DEADLINE: Duration = Duration::from_secs(2);
/// Connections served at once.
pub const MAX_CONNECTIONS: usize = 16;
/// Windows' LocalSystem.
pub const SYSTEM_SID: &str = "S-1-5-18";

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
pub type Gate = Arc<dyn Fn(Option<&Peer>) -> bool + Send + Sync>;

/// What the os layer applies to every connection before `serve` sees it.
#[derive(Clone)]
pub struct Serve {
    /// Asked for each connection, with the peer the kernel named.
    pub allow: Gate,
    pub max_connections: usize,
    /// The read deadline for the request, and the write timeout.
    pub deadline: Duration,
}

impl Serve {
    /// The service's: the OS's peers of the moment, asked per connection
    /// (a Linux install records the session user after the service is up;
    /// a Mac's console user changes).
    pub fn service() -> Self {
        Self {
            allow: Arc::new(|peer| peer_allowed(peer, &crate::os::local_allowed())),
            max_connections: MAX_CONNECTIONS,
            deadline: DEADLINE,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Request {
    m: String,
    #[serde(default)]
    p: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Answer {
    Ok(Value),
    Err(String),
}

fn line_of(a: &Answer) -> String {
    let mut s = serde_json::to_string(a).unwrap_or_else(|_| r#"{"err":"internal"}"#.into());
    s.push('\n');
    s
}

/// The line a refused peer gets before its connection is closed.
pub fn refusal(peer: Option<&Peer>) -> String {
    let who = match peer {
        Some(p) => p.to_string(),
        None => "a peer whose credentials could not be read".into(),
    };
    line_of(&Answer::Err(format!(
        "forbidden: {who} may not use this agent's socket (root, the service's own user and the user it runs Claude for may)"
    )))
}

/// The line a connection past the limit gets.
pub fn too_many(max: usize) -> String {
    line_of(&Answer::Err(format!(
        "busy: at most {max} connections at once"
    )))
}

/// One method for the service's shared state (module doc's table).
fn handle(shared: &Shared, m: &str, p: Value) -> Result<Value, String> {
    let none = |p: &Value| match p {
        Value::Null => Ok(()),
        Value::Object(o) if o.is_empty() => Ok(()),
        _ => Err(format!("`{m}` takes no parameters")),
    };
    match m {
        "status" => {
            none(&p)?;
            Ok(shared.document_value())
        }
        "claude" => {
            none(&p)?;
            serde_json::to_value(shared.claude_report()).map_err(|e| e.to_string())
        }
        "claude.report" => {
            let r: Report = serde_json::from_value(p).map_err(|e| format!("not a report: {e}"))?;
            serde_json::to_value(shared.set_claude(r)).map_err(|e| e.to_string())
        }
        "claude.roster" => {
            let r: Roster = serde_json::from_value(p).map_err(|e| format!("not a roster: {e}"))?;
            shared.set_claude_roster(r);
            Ok(Value::Null)
        }
        "claude.restart" => {
            none(&p)?;
            shared.request_claude_restart();
            Ok("restart queued for the session".into())
        }
        "claude.update" => {
            none(&p)?;
            if !shared.role().claude_update {
                return Err("Claude Code is updated by nix on this machine".into());
            }
            shared.request_claude_update();
            Ok("update queued for the session".into())
        }
        "update.check" => {
            none(&p)?;
            shared.request_check();
            Ok("checking".into())
        }
        _ => Err(format!("no method `{m}`")),
    }
}

/// One connection: the request line, its answer, closed.
fn serve_one(shared: &Shared, c: Conn) {
    let mut w = c.writer;
    let mut line = Vec::new();
    let read = BufReader::new(c.reader.take(MAX_LINE as u64 + 1)).read_until(b'\n', &mut line);
    let answer = match read {
        Ok(_) if line.len() > MAX_LINE => {
            Answer::Err(format!("a line is at most {MAX_LINE} bytes"))
        }
        Ok(_) => match serde_json::from_slice::<Request>(&line) {
            Ok(r) => match handle(shared, &r.m, r.p) {
                Ok(v) => Answer::Ok(v),
                Err(e) => Answer::Err(e),
            },
            Err(e) => Answer::Err(format!("not a request: {e}")),
        },
        Err(e) => {
            tracing::debug!(error = %e, "local: a request that never came");
            (c.close)();
            return;
        }
    };
    let _ = w.write_all(line_of(&answer).as_bytes());
    let _ = w.flush();
    (c.close)();
}

/// How often a local socket that could not be made tries again.
pub const BIND_RETRY: Duration = Duration::from_secs(15);

/// The agent's local socket, served now or later: one that cannot be made
/// (a squatter on the pipe's name, a live socket of another agent, a
/// directory that is not ours) does not stop the service — the link, the
/// telemetry and the awake hold go on — and is tried again every
/// `BIND_RETRY`, the reason logged each time it changes.
pub struct Door {
    socket: Arc<std::sync::Mutex<Option<crate::os::LocalSocket>>>,
    since: Arc<std::sync::Mutex<Option<std::time::Instant>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

impl Door {
    pub fn start(shared: Arc<Shared>) -> Self {
        let door = Self {
            socket: Arc::new(std::sync::Mutex::new(None)),
            since: Arc::new(std::sync::Mutex::new(None)),
            stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        let (socket, since, stop) = (
            Arc::clone(&door.socket),
            Arc::clone(&door.since),
            Arc::clone(&door.stop),
        );
        let mut last: Option<String> = None;
        let mut open = move || -> bool {
            match serve(Arc::clone(&shared)) {
                Ok(s) => {
                    *socket.lock().unwrap_or_else(|p| p.into_inner()) = Some(s);
                    *since.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(std::time::Instant::now());
                    true
                }
                Err(e) => {
                    let why = format!("{e:#}");
                    if last.as_deref() != Some(why.as_str()) {
                        tracing::error!(
                            error = %why,
                            "the local socket could not be made; the service runs on and tries again"
                        );
                        last = Some(why);
                    }
                    false
                }
            }
        };
        if !open() {
            let _ = std::thread::Builder::new()
                .name("local-bind".into())
                .spawn(move || {
                    while !crate::util::sleep_until(&stop, BIND_RETRY) {
                        if open() {
                            return;
                        }
                    }
                });
        }
        door
    }

    /// How long the socket has been served; None while it is not.
    pub fn up_for(&self) -> Option<Duration> {
        self.since
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map(|t| t.elapsed())
    }
}

impl Drop for Door {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        drop(self.socket.lock().unwrap_or_else(|p| p.into_inner()).take());
    }
}

/// Serve the agent's socket at `paths::local_socket()` until the returned
/// handle is dropped (which removes it, where it is a file).
pub fn serve(shared: Arc<Shared>) -> anyhow::Result<crate::os::LocalSocket> {
    let path = crate::paths::local_socket();
    let socket = crate::os::serve_local(&path, &Serve::service(), move |c| serve_one(&shared, c))?;
    tracing::info!(socket = %path.display(), "local socket answering");
    Ok(socket)
}

/// Ask the service: one method, its answer or why not.
pub fn call(m: &str, p: Value) -> Result<Value, String> {
    call_at(&crate::paths::local_socket(), m, p)
}

/// The same, at `path`.
pub fn call_at(path: &Path, m: &str, p: Value) -> Result<Value, String> {
    let c = crate::os::connect_local(path, CLIENT_DEADLINE)
        .map_err(|e| format!("the agent did not answer at {} ({e})", path.display()))?;
    let mut w = c.writer;
    let mut req = serde_json::to_string(&Request { m: m.into(), p }).map_err(|e| e.to_string())?;
    req.push('\n');
    // A refusal is written before the request is read: a failed write is
    // only an error when no answer came either.
    let sent = w
        .write_all(req.as_bytes())
        .and_then(|()| w.flush())
        .map_err(|e| format!("sending to the agent: {e}"));
    let mut line = Vec::new();
    let read = BufReader::new(c.reader.take(MAX_LINE as u64 + 1)).read_until(b'\n', &mut line);
    if line.is_empty() {
        sent?;
        read.map_err(|e| format!("reading the agent's answer: {e}"))?;
    }
    (c.close)();
    match serde_json::from_slice::<Answer>(&line) {
        Ok(Answer::Ok(v)) => Ok(v),
        Ok(Answer::Err(e)) => Err(e),
        Err(_) if line.is_empty() => Err("the agent closed without answering".into()),
        Err(e) => Err(format!("the agent's answer did not parse: {e}")),
    }
}

/// `call`, typed.
pub fn call_as<T: serde::de::DeserializeOwned>(m: &str, p: Value) -> Result<T, String> {
    serde_json::from_value(call(m, p)?).map_err(|e| format!("`{m}`'s answer: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Mode;
    use crate::facts::Facts;
    use crate::link::wire::Policy;
    use crate::role::Role;
    use crate::state::State;
    use std::time::Instant;

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

    #[test]
    fn the_lines_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&Request {
                m: "status".into(),
                p: Value::Null
            })
            .unwrap(),
            r#"{"m":"status","p":null}"#
        );
        assert_eq!(
            line_of(&Answer::Ok("checking".into())),
            "{\"ok\":\"checking\"}\n"
        );
        assert_eq!(line_of(&Answer::Err("no".into())), "{\"err\":\"no\"}\n");
        assert_eq!(
            refusal(Some(&Peer::Uid(1001))),
            "{\"err\":\"forbidden: uid 1001 may not use this agent's socket \
             (root, the service's own user and the user it runs Claude for may)\"}\n"
        );
        assert_eq!(
            too_many(16),
            "{\"err\":\"busy: at most 16 connections at once\"}\n"
        );
        // A request without `p` is one without parameters.
        let r: Request = serde_json::from_str(r#"{"m":"claude"}"#).unwrap();
        assert_eq!((r.m.as_str(), r.p), ("claude", Value::Null));
    }

    fn shared(mode: Mode) -> Shared {
        Shared::new(
            State::default(),
            Facts::default(),
            Instant::now(),
            Policy::default(),
            Role::of(mode),
        )
    }

    #[test]
    fn the_methods_reach_the_shared_state() {
        let s = shared(Mode::Node);
        assert_eq!(handle(&s, "claude", Value::Null).unwrap(), Value::Null);
        let report = serde_json::to_value(Report {
            state: "running".into(),
            ..Default::default()
        })
        .unwrap();
        s.request_claude_restart();
        let answer = handle(&s, "claude.report", report).unwrap();
        assert_eq!(answer["restart"], true);
        assert_eq!(
            handle(&s, "claude", Value::Null).unwrap()["state"],
            "running"
        );
        assert_eq!(
            handle(&s, "status", Value::Null).unwrap()["claude"]["state"],
            "running"
        );
        assert!(handle(&s, "claude.update", Value::Null).is_ok());
        assert!(handle(&s, "update.check", Value::Null).is_ok());
        assert!(s.take_check_request());
        assert!(handle(&s, "claude.report", serde_json::json!({"state": 3})).is_err());
        assert!(handle(&s, "status", serde_json::json!({"x": 1})).is_err());
        assert!(handle(&s, "reboot", Value::Null)
            .unwrap_err()
            .contains("no method"));
        // nix pins Claude on the controller.
        let c = shared(Mode::Controller);
        assert!(handle(&c, "claude.update", Value::Null)
            .unwrap_err()
            .contains("nix"));
    }

    /// The socket itself, on unix: served to this uid, answered, refused
    /// past the gate.
    #[cfg(unix)]
    #[test]
    fn the_socket_answers_this_user_and_refuses_the_gate() {
        let dir = std::env::temp_dir().join(format!("daedalus-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("run").join("agent.sock");
        let s = Arc::new(shared(Mode::Node));
        let served = {
            let s = Arc::clone(&s);
            crate::os::serve_local(
                &path,
                &Serve {
                    allow: Arc::new(|peer| {
                        peer_allowed(peer, &unix_allowed(crate::os::own_uid().unwrap(), &[]))
                    }),
                    max_connections: 4,
                    deadline: Duration::from_secs(2),
                },
                move |c| serve_one(&s, c),
            )
            .unwrap()
        };
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o666);
            assert_eq!(mode(path.parent().unwrap()), 0o711);
        }
        assert_eq!(
            call_at(&path, "update.check", Value::Null).unwrap(),
            "checking"
        );
        assert!(s.take_check_request());
        let doc = call_at(&path, "status", Value::Null).unwrap();
        assert_eq!(doc["version"], crate::VERSION);
        assert!(call_at(&path, "nope", Value::Null)
            .unwrap_err()
            .contains("no method"));
        drop(served);

        // A gate that says no: one line, closed.
        let refusing = crate::os::serve_local(
            &path,
            &Serve {
                allow: Arc::new(|_| false),
                max_connections: 4,
                deadline: Duration::from_secs(2),
            },
            |_| unreachable!("refused before serving"),
        )
        .unwrap();
        let e = call_at(&path, "status", Value::Null).unwrap_err();
        assert!(e.starts_with("forbidden: uid "), "{e}");
        drop(refusing);
        assert!(call_at(&path, "status", Value::Null).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A client that drips its request never holds the connection past the
    /// whole exchange's deadline.
    #[cfg(unix)]
    #[test]
    fn a_dripping_client_is_cut_off_at_the_whole_deadline() {
        use std::io::Write as _;
        let dir = std::env::temp_dir().join(format!("daedalus-drip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("run").join("agent.sock");
        let s = Arc::new(shared(Mode::Node));
        let served = crate::os::serve_local(
            &path,
            &Serve {
                allow: Arc::new(|_| true),
                max_connections: 4,
                deadline: Duration::from_millis(500),
            },
            move |c| serve_one(&s, c),
        )
        .unwrap();
        let mut c = std::os::unix::net::UnixStream::connect(&path).unwrap();
        let t = Instant::now();
        let mut cut = false;
        while t.elapsed() < Duration::from_secs(4) {
            if c.write_all(b" ").is_err() {
                cut = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(cut, "still open after {:?}", t.elapsed());
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
        drop(served);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
