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
//! **Who** (door.rs `peer_allowed`, the OS's `local_allowed`): on macOS and
//! Linux, root, the agent's own uid, and the user the machine runs Claude
//! for — on Linux the session user `install` recorded (`session.json`), on
//! macOS the user at the console (the owner of `/dev/console`); on Windows,
//! SYSTEM and the users logged on interactively (each session's token),
//! read from the client's process token. Anyone else gets one `forbidden`
//! error and a closed connection. The client checks the other end too
//! (door.rs `server_trusted`): root or SYSTEM, or its own user (a
//! development run), so a pipe squatted while the service is down cannot
//! hand the session orders.
//!
//! **Protocol.** The agent's one envelope (rpc.rs), one request per
//! connection, at most `MAX_LINE` bytes a line: `{"id":1,"m":"<method>","p":…}`
//! → `{"id":1,"ok":…}` or `{"id":1,"err":{"code","msg"}}`, then the service
//! closes. The whole exchange has `DEADLINE`; at most `MAX_CONNECTIONS` are
//! served at once. Both ends are this binary, so the envelope moves with it.
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

use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::claude::{Report, Roster};
use crate::door::{Conn, Peer, Policy};
use crate::jsonl::LineReader;
use crate::rpc::{code, error_line, line_of, Answer, ApiError, Request, Response};
use crate::shared::Shared;
use crate::util::Rebinding;

/// The longest line either way.
pub const MAX_LINE: usize = crate::door::MAX_LINE;
/// The whole exchange, from connect to the answer.
pub const DEADLINE: Duration = Duration::from_secs(5);
/// A client's whole exchange: short, since the tray asks from its UI
/// thread.
pub const CLIENT_DEADLINE: Duration = Duration::from_secs(2);
/// Connections served at once.
pub const MAX_CONNECTIONS: usize = 16;

/// The door's policy: `allow` asked per connection, at most `max`
/// connections, each whole exchange within `deadline`.
pub fn policy(allow: crate::door::Allow, max: usize, deadline: Duration) -> Policy {
    Policy {
        what: "local",
        allow,
        refusal: Arc::new(refusal),
        busy: too_many(max),
        max_connections: max,
        first_line: deadline,
        write_timeout: deadline,
        whole: Some(deadline),
        open_to_others: true,
    }
}

/// The service's: the OS's peers of the moment, asked per connection (a
/// Linux install records the session user after the service is up; a Mac's
/// console user changes).
pub fn service_policy() -> Policy {
    policy(
        Arc::new(|peer| crate::door::peer_allowed(peer, &crate::os::local_allowed())),
        MAX_CONNECTIONS,
        DEADLINE,
    )
}

/// The line a refused peer gets before its connection is closed.
pub fn refusal(peer: Option<&Peer>) -> String {
    let who = match peer {
        Some(p) => p.to_string(),
        None => "a peer whose credentials could not be read".into(),
    };
    error_line(
        code::FORBIDDEN,
        format!("{who} may not use this agent's socket (root, the service's own user and the user it runs Claude for may)"),
    )
}

/// The line a connection past the limit gets.
pub fn too_many(max: usize) -> String {
    error_line(code::BUSY, format!("at most {max} connections at once"))
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(code::BAD_REQUEST, msg)
}

fn value<T: Serialize>(v: &T) -> Result<Value, ApiError> {
    serde_json::to_value(v).map_err(|e| ApiError::new(code::INTERNAL, e.to_string()))
}

/// One method for the service's shared state (module doc's table).
fn handle(shared: &Shared, m: &str, p: Value) -> Result<Value, ApiError> {
    let none = |p: &Value| match p {
        Value::Null => Ok(()),
        Value::Object(o) if o.is_empty() => Ok(()),
        _ => Err(bad(format!("`{m}` takes no parameters"))),
    };
    match m {
        "status" => {
            none(&p)?;
            Ok(shared.document_value())
        }
        "claude" => {
            none(&p)?;
            value(&shared.claude_report())
        }
        "claude.report" => {
            let r: Report =
                serde_json::from_value(p).map_err(|e| bad(format!("not a report: {e}")))?;
            value(&shared.set_claude(r))
        }
        "claude.roster" => {
            let r: Roster =
                serde_json::from_value(p).map_err(|e| bad(format!("not a roster: {e}")))?;
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
                return Err(ApiError::new(
                    code::UNSUPPORTED,
                    "Claude Code is updated by nix on this machine",
                ));
            }
            shared.request_claude_update();
            Ok("update queued for the session".into())
        }
        "update.check" => {
            none(&p)?;
            shared.request_check();
            Ok("checking".into())
        }
        _ => Err(ApiError::new(
            code::UNKNOWN_METHOD,
            format!("no method `{m}`"),
        )),
    }
}

/// The answer to one request line.
fn answer(shared: &Shared, line: &[u8]) -> Response {
    match Request::parse(line) {
        Ok(r) => match handle(shared, &r.m, r.p) {
            Ok(v) => Response::ok(r.id, &v),
            Err(e) => Response::err(Some(r.id), e),
        },
        Err(e) => Response::err(
            crate::rpc::salvage_id(line),
            bad(format!("not a request: {e}")),
        ),
    }
}

/// One connection: the request line, its answer, closed.
fn serve_one(shared: &Shared, c: Conn) {
    let mut w = c.writer;
    let response = match LineReader::new(c.reader, MAX_LINE).next_line() {
        Ok(Some(line)) => answer(shared, &line),
        Err(e) if crate::jsonl::is_too_long(&e) => Response::err(
            None,
            ApiError::new(
                code::TOO_LARGE,
                format!("a line is at most {MAX_LINE} bytes"),
            ),
        ),
        Ok(None) | Err(_) => {
            tracing::debug!("local: a request that never came");
            (c.close)();
            return;
        }
    };
    let _ = w.write_all(line_of(&response).as_bytes());
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
pub struct Door(Rebinding<crate::os::LocalSocket>);

impl Door {
    pub fn start(shared: Arc<Shared>) -> Self {
        let mut last: Option<String> = None;
        Self(Rebinding::start(
            "local-bind",
            BIND_RETRY,
            move || match serve(Arc::clone(&shared)) {
                Ok(s) => Some(s),
                Err(e) => {
                    let why = format!("{e:#}");
                    if last.as_deref() != Some(why.as_str()) {
                        tracing::error!(
                            error = %why,
                            "the local socket could not be made; the service runs on and tries again"
                        );
                        last = Some(why);
                    }
                    None
                }
            },
        ))
    }

    /// How long the socket has been served; None while it is not.
    pub fn up_for(&self) -> Option<Duration> {
        self.0.up_for()
    }
}

/// Serve the agent's socket at `paths::local_socket()` until the returned
/// handle is dropped (which removes it, where it is a file).
pub fn serve(shared: Arc<Shared>) -> anyhow::Result<crate::os::LocalSocket> {
    let path = crate::paths::local_socket();
    let socket = crate::os::serve_local(&path, &service_policy(), move |c| serve_one(&shared, c))?;
    tracing::info!(socket = %path.display(), "local socket answering");
    Ok(socket)
}

/// Ask the service: one method, its answer or why not.
pub fn call(m: &str, p: Value) -> Result<Value, String> {
    call_at(&crate::paths::local_socket(), m, p)
}

/// The request line a client sends: one request, id 1.
fn request_line(m: &str, p: Value) -> String {
    #[derive(Serialize)]
    struct Out<'a> {
        id: u64,
        m: &'a str,
        p: Value,
    }
    line_of(&Out { id: 1, m, p })
}

/// The same, at `path`.
pub fn call_at(path: &Path, m: &str, p: Value) -> Result<Value, String> {
    let c = crate::os::connect_local(path, CLIENT_DEADLINE)
        .map_err(|e| format!("the agent did not answer at {} ({e})", path.display()))?;
    let mut w = c.writer;
    // A refusal is written before the request is read: a failed write is
    // only an error when no answer came either.
    let sent = w
        .write_all(request_line(m, p).as_bytes())
        .and_then(|()| w.flush())
        .map_err(|e| format!("sending to the agent: {e}"));
    let read = LineReader::new(c.reader, MAX_LINE).next_line();
    (c.close)();
    let line = match read {
        Ok(Some(line)) => line,
        Ok(None) => {
            sent?;
            return Err("the agent closed without answering".into());
        }
        Err(e) => {
            sent?;
            return Err(format!("reading the agent's answer: {e}"));
        }
    };
    match crate::rpc::Answer::parse(&line) {
        Ok(Answer::Ok(v)) => Ok(v),
        Ok(Answer::Err { msg, .. }) => Err(msg),
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
    fn the_lines_on_the_wire() {
        assert_eq!(
            request_line("status", Value::Null),
            "{\"id\":1,\"m\":\"status\",\"p\":null}\n"
        );
        let s = shared(Mode::Node);
        let a = |line: &str| line_of(&answer(&s, line.as_bytes()));
        assert_eq!(
            a(r#"{"id":1,"m":"update.check"}"#),
            "{\"id\":1,\"ok\":\"checking\"}\n"
        );
        assert_eq!(
            a(r#"{"id":2,"m":"nope"}"#),
            "{\"id\":2,\"err\":{\"code\":\"unknown_method\",\"msg\":\"no method `nope`\"}}\n"
        );
        assert!(
            a(r#"{"m":"status"}"#).starts_with("{\"id\":null,\"err\":{\"code\":\"bad_request\"")
        );
        assert_eq!(
            refusal(Some(&Peer::Uid(1001))),
            "{\"id\":null,\"err\":{\"code\":\"forbidden\",\"msg\":\"uid 1001 may not use this agent's socket \
             (root, the service's own user and the user it runs Claude for may)\"}}\n"
        );
        assert_eq!(
            too_many(16),
            "{\"id\":null,\"err\":{\"code\":\"busy\",\"msg\":\"at most 16 connections at once\"}}\n"
        );
        // The client reads both shapes, a null answer included.
        assert_eq!(
            Answer::parse(b"{\"id\":1,\"ok\":null}"),
            Ok(Answer::Ok(Value::Null))
        );
        assert_eq!(
            Answer::parse(b"{\"id\":1,\"err\":{\"code\":\"busy\",\"msg\":\"m\"}}"),
            Ok(Answer::Err {
                code: "busy".into(),
                msg: "m".into()
            })
        );
        assert!(Answer::parse(b"{\"id\":1}").is_err());
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
            .msg
            .contains("no method"));
        // nix pins Claude on the controller.
        let c = shared(Mode::Controller);
        assert!(handle(&c, "claude.update", Value::Null)
            .unwrap_err()
            .msg
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
                &policy(
                    Arc::new(|peer| {
                        crate::door::peer_allowed(
                            peer,
                            &crate::door::unix_allowed(crate::os::own_uid().unwrap(), &[]),
                        )
                    }),
                    4,
                    Duration::from_secs(2),
                ),
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
            &policy(Arc::new(|_| false), 4, Duration::from_secs(2)),
            |_| unreachable!("refused before serving"),
        )
        .unwrap();
        let e = call_at(&path, "status", Value::Null).unwrap_err();
        assert!(e.starts_with("uid "), "{e}");
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
            &policy(Arc::new(|_| true), 4, Duration::from_millis(500)),
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
