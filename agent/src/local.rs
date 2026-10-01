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
//! | `status`         | —                | the status document (status.rs)                 |
//! | `claude`         | —                | the session's full report, or null             |
//! | `claude.report`  | a `Report`       | the `ReportAnswer` (the session's poll)        |
//! | `claude.roster`  | a `Roster`       | null                                           |
//! | `claude.restart` | —                | a sentence; the session restarts the server    |
//! | `claude.update`  | —                | a sentence; refused where nix pins Claude      |
//! | `update.check`   | —                | a sentence; the updater looks now              |
//! | `link.reload`    | —                | a sentence; the link reads config.toml again   |
//! | `enroll.begin`   | `{app_url}`      | a log-in begun: key, fingerprint, challenge    |
//! | `enroll.finish`  | `{code}`         | a sentence; redeemed, tunnel up (root alone)   |
//! | `enroll.leave`   | —                | a sentence; logged out                         |
//! | `settings.get`   | —                | the settings, and whether this peer may change them |
//! | `settings.set`   | `{key, value}`   | `{sent}`, `{unchanged}` or `{confirm_url}` (the operator) |
//!
//! The report and the roster are the session's to post; any peer the gate
//! lets through may, since each of those is a user the machine runs Claude
//! for (or root). Nothing on this socket names the controller a machine
//! trusts: pairing is `pair` run as an administrator (pair.rs) — the tray
//! runs it elevated, behind the OS's own prompt — which writes config.toml
//! itself and asks `link.reload`, harmless to anyone (it reads a file only
//! root or SYSTEM can write, and changes nothing unless the keys did). A
//! pairing method here would let any user the socket serves hand a fresh
//! machine, and with it the service's privileges, to a controller of their
//! own. A log-in's last step does name it (`enroll.finish`, macOS and Linux,
//! enroll.rs), which is why it is root's alone: the tray runs it behind the
//! administrator prompt.
//!
//! A machine's own settings (settings.rs) are read by any peer the gate
//! admits, and changed only by the operator — the user santree's socket
//! serves (`os::operator_allowed`) — on macOS and Linux; on Windows, by
//! the users the socket admits, for the two settings there. Changing one
//! asks the box; santree ON sends nothing and answers the page where an
//! admin confirms it, which the caller opens.

use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::claude::{Report, Roster};
use crate::door::{Conn, Peer, Policy};
use crate::jsonl::LineReader;
use crate::rpc::{error_line, line_of, methods, ApiError, ErrorCode, Incoming, Response};
use crate::shared::Shared;
use crate::util::Rebinding;

/// The longest line either way.
pub const MAX_LINE: usize = crate::door::MAX_LINE;
/// The whole exchange, from connect to the answer: room for the slowest
/// method, a log-in's redeem at the app (enroll.rs `REDEEM_TIMEOUT`).
pub const DEADLINE: Duration = Duration::from_secs(15);
/// A client's whole exchange: short, since the session asks every poll
/// and a tray's clicks wait behind it.
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
        ErrorCode::Forbidden,
        format!("{who} may not use this agent's socket (root, the service's own user and the user it runs Claude for may)"),
    )
}

/// The line a connection past the limit gets.
pub fn too_many(max: usize) -> String {
    error_line(
        ErrorCode::Busy,
        format!("at most {max} connections at once"),
    )
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(ErrorCode::BadRequest, msg)
}

fn value<T: Serialize>(v: &T) -> Result<Value, ApiError> {
    serde_json::to_value(v).map_err(|e| ApiError::new(ErrorCode::Internal, e.to_string()))
}

methods! {
    /// The local socket's methods (module doc's table): a unit variant takes
    /// no parameters. The service reads a request as this, and a client
    /// writes one (`call`).
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub enum LocalRequest {
        "status" => Status,
        "claude" => Claude,
        "claude.report" => ClaudeReport(Box<Report>),
        "claude.roster" => ClaudeRoster(Box<Roster>),
        "claude.restart" => ClaudeRestart,
        "claude.update" => ClaudeUpdate,
        "update.check" => UpdateCheck,
        "link.reload" => LinkReload,
        "enroll.begin" => EnrollBegin(BeginParams),
        "enroll.finish" => EnrollFinish(FinishParams),
        "enroll.leave" => EnrollLeave,
        "settings.get" => SettingsGet,
        "settings.set" => SettingsSet(SetParams),
    }
}

/// `enroll.begin`'s parameters: the app the operator named.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BeginParams {
    pub app_url: String,
}

/// `enroll.finish`'s parameters: the code the loopback took.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinishParams {
    pub code: String,
}

/// One method for the service's shared state (module doc's table), asked
/// by `peer` (as the door checked it).
fn handle(shared: &Shared, peer: Option<&Peer>, req: LocalRequest) -> Result<Value, ApiError> {
    use LocalRequest as R;
    match req {
        R::Status => value(&crate::status::document(shared)),
        R::Claude => value(&shared.claude.report()),
        R::ClaudeReport(r) => value(&shared.claude.take_report(*r, &shared.settings.policy())),
        R::ClaudeRoster(r) => {
            shared.claude.set_roster(*r);
            Ok(Value::Null)
        }
        R::ClaudeRestart => {
            shared.claude.request_restart();
            Ok("restart queued for the session".into())
        }
        R::ClaudeUpdate => {
            if !shared.role.claude_update {
                return Err(ApiError::new(
                    ErrorCode::Unsupported,
                    "Claude Code is updated by nix on this machine",
                ));
            }
            shared.claude.request_update();
            Ok("update queued for the session".into())
        }
        R::UpdateCheck => {
            shared.update.request_check();
            Ok("checking".into())
        }
        R::LinkReload => link_reload(shared, &crate::link::KeyFiles::here()),
        R::SettingsGet => value(&crate::status::settings_view(
            shared,
            Some(may_change(peer)),
        )),
        R::SettingsSet(p) => settings_set(shared, peer, p, &crate::paths::config_path()),
        R::EnrollBegin(_) | R::EnrollFinish(_) | R::EnrollLeave => enroll(shared, peer, req),
    }
}

/// `link.reload` against the link's keys in `files` (module doc).
fn link_reload(shared: &Shared, files: &crate::link::KeyFiles) -> Result<Value, ApiError> {
    if !shared.role.link {
        return Err(ApiError::new(
            ErrorCode::Unsupported,
            "the controller has no link to reload",
        ));
    }
    match crate::pair::reload(shared, files) {
        Ok(true) => {
            tracing::info!("the link's keys changed in config.toml; connecting under them");
            Ok("the link follows config.toml's new keys now".into())
        }
        Ok(false) => Ok("config.toml's link keys are the ones in use".into()),
        Err(e) => Err(ApiError::new(ErrorCode::Internal, format!("{e:#}"))),
    }
}

/// Whether `peer` may change this machine's settings (`settings.set`):
/// on macOS and Linux the operator — root, the service's own uid, the user
/// who installed the agent (`os::operator_allowed`, as santree's socket and
/// a log-in); on Windows every user the socket admits, for the two settings
/// there (neither grants anything on the box).
fn may_change(peer: Option<&Peer>) -> bool {
    #[cfg(unix)]
    return crate::door::peer_allowed(peer, &crate::os::operator_allowed());
    #[cfg(windows)]
    {
        let _ = peer;
        true
    }
}

/// `settings.set`'s parameters: one setting, its value.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetParams {
    pub key: crate::settings::Key,
    pub value: bool,
}

/// `settings.set`'s answer: exactly one of the three is present.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct SetAnswer {
    /// Recorded; the link asks the box now.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sent: bool,
    /// The box already holds that value.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unchanged: bool,
    /// santree ON: the page where an admin confirms it, for the caller to
    /// open (the service opens no browser).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_url: Option<String>,
}

/// `settings.set` (settings.rs): checked, then recorded and answered at
/// once — the link sends it, and the status page shows what became of it.
/// `config` is where the app's address is read for santree ON.
fn settings_set(
    shared: &Shared,
    peer: Option<&Peer>,
    p: SetParams,
    config: &Path,
) -> Result<Value, ApiError> {
    use crate::settings::{Asked, Key};
    if !shared.role.link {
        return Err(ApiError::new(
            ErrorCode::Unsupported,
            "the controller's settings are the box's own",
        ));
    }
    if !may_change(peer) {
        let who = peer
            .map(ToString::to_string)
            .unwrap_or_else(|| "a peer whose credentials could not be read".into());
        return Err(ApiError::new(
            ErrorCode::Forbidden,
            format!(
                "{who} may not change this machine's settings (root and the user who installed \
                 the agent may)"
            ),
        ));
    }
    if cfg!(windows) && p.key == Key::Santree {
        return Err(ApiError::new(
            ErrorCode::Unsupported,
            "santree has no door on Windows",
        ));
    }
    // santree ON is an admin's, in the browser: the page must exist before
    // anything is recorded.
    let mut confirm = None;
    if p.key == Key::Santree && p.value && !shared.settings.policy().santree {
        let app = crate::config::load_at(config)
            .ok()
            .and_then(|c| c.app_url)
            .ok_or_else(|| {
                ApiError::new(
                    ErrorCode::Unsupported,
                    "turn santree on in Settings › Machines (this machine has not logged in \
                     from its menu bar, so it knows no page to open)",
                )
            })?;
        let node = shared
            .node_id()
            .ok_or_else(|| ApiError::new(ErrorCode::Unavailable, "this machine has no key yet"))?;
        confirm = Some(crate::settings::confirm_url(&app, &node));
    }
    let answer = match shared.settings.ask(p.key, p.value, shared.link.linked())? {
        Asked::Sent => SetAnswer {
            sent: true,
            ..Default::default()
        },
        Asked::Unchanged => SetAnswer {
            unchanged: true,
            ..Default::default()
        },
        Asked::Confirm => SetAnswer {
            confirm_url: Some(confirm.ok_or_else(|| {
                ApiError::new(ErrorCode::Internal, "santree's page was not named")
            })?),
            ..Default::default()
        },
    };
    tracing::info!(key = ?p.key, value = p.value, ?answer, "settings: asked from this machine");
    value(&answer)
}

/// A log-in's three methods (enroll.rs): `begin` and `leave` for the
/// operator, `finish` for root alone — the tray runs it behind the
/// administrator prompt.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn enroll(shared: &Shared, peer: Option<&Peer>, req: LocalRequest) -> Result<Value, ApiError> {
    let who = || {
        peer.map(ToString::to_string)
            .unwrap_or_else(|| "a peer whose credentials could not be read".into())
    };
    let files = crate::enroll::Files::here();
    if let LocalRequest::EnrollFinish(p) = req {
        if !crate::enroll::may_finish(peer) {
            return Err(ApiError::new(
                ErrorCode::Forbidden,
                format!(
                    "{} may not finish a log-in: it names the box this machine trusts, so it \
                     runs as root (the menu bar asks for an administrator's password)",
                    who()
                ),
            ));
        }
        return crate::enroll::finish(shared, &files, p, crate::enroll::redeem_https)
            .map(Value::from);
    }
    if !crate::enroll::may_enroll(peer) {
        return Err(ApiError::new(
            ErrorCode::Forbidden,
            format!(
                "{} may not log this machine in or out (root and the user who installed the \
                 agent may)",
                who()
            ),
        ));
    }
    match req {
        LocalRequest::EnrollBegin(p) => value(&crate::enroll::begin(shared, &files, p)?),
        _ => crate::enroll::leave(shared, &files).map(Value::from),
    }
}

/// Windows has no log-in: a machine there is paired (pair.rs).
#[cfg(windows)]
fn enroll(_: &Shared, _: Option<&Peer>, _: LocalRequest) -> Result<Value, ApiError> {
    Err(ApiError::new(
        ErrorCode::Unsupported,
        "no log-in on Windows: pair the machine (`daedalus-agent pair`)",
    ))
}

/// The answer to one request line from `peer`.
fn answer(shared: &Shared, peer: Option<&Peer>, line: &[u8]) -> Response {
    let r = match Incoming::request(line) {
        Ok(r) => r,
        Err(e) => {
            return Response::err(
                crate::rpc::salvage_id(line),
                bad(format!("not a request: {e}")),
            )
        }
    };
    match r.typed().and_then(|req| handle(shared, peer, req)) {
        Ok(v) => Response::ok(r.id, &v),
        Err(e) => Response::err(Some(r.id), e),
    }
}

/// One connection: the request line, its answer, closed.
fn serve_one(shared: &Shared, c: Conn) {
    let mut w = c.writer;
    let response = match LineReader::new(c.reader, MAX_LINE).next_line() {
        Ok(Some(line)) => answer(shared, c.peer.as_ref(), &line),
        Err(e) if crate::jsonl::is_too_long(&e) => Response::err(
            None,
            ApiError::new(
                ErrorCode::TooLarge,
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

/// Why a call to the service failed: it could not be reached or read
/// (`Transport`), it answered an error (`Remote`, with its code), or its
/// answer is not the type asked for (`Decode`).
#[derive(Clone, Debug, PartialEq)]
pub enum CallError {
    Transport(String),
    Remote { code: ErrorCode, msg: String },
    Decode(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Transport(s) | CallError::Decode(s) => f.write_str(s),
            CallError::Remote { msg, .. } => f.write_str(msg),
        }
    }
}

impl std::error::Error for CallError {}

/// Ask the service: one method, its answer as `T` or why not.
pub fn call<T: DeserializeOwned>(req: &LocalRequest) -> Result<T, CallError> {
    call_at(&crate::paths::local_socket(), req)
}

/// A log-in's or log-out's whole exchange (enroll.rs): a redeem at the app,
/// or the controller's goodbye, inside the service's own `DEADLINE`.
pub const ENROLL_DEADLINE: Duration = DEADLINE;

/// `call` for a method that takes longer than `CLIENT_DEADLINE`, from a
/// thread that may wait.
pub fn call_within<T: DeserializeOwned>(
    req: &LocalRequest,
    deadline: Duration,
) -> Result<T, CallError> {
    call_at_within(&crate::paths::local_socket(), req, deadline)
}

/// The request line a client sends: one request, id 1.
fn request_line(req: &LocalRequest) -> String {
    #[derive(Serialize)]
    struct Out<'a> {
        id: u64,
        #[serde(flatten)]
        req: &'a LocalRequest,
    }
    line_of(&Out { id: 1, req })
}

/// The same, at `path`.
pub fn call_at<T: DeserializeOwned>(path: &Path, req: &LocalRequest) -> Result<T, CallError> {
    call_at_within(path, req, CLIENT_DEADLINE)
}

fn call_at_within<T: DeserializeOwned>(
    path: &Path,
    req: &LocalRequest,
    deadline: Duration,
) -> Result<T, CallError> {
    let transport = CallError::Transport;
    let c = crate::os::connect_local(path, deadline).map_err(|e| {
        transport(format!(
            "the agent did not answer at {} ({e})",
            path.display()
        ))
    })?;
    let mut w = c.writer;
    // A refusal is written before the request is read: a failed write is
    // only an error when no answer came either.
    let sent = w
        .write_all(request_line(req).as_bytes())
        .and_then(|()| w.flush())
        .map_err(|e| transport(format!("sending to the agent: {e}")));
    let read = LineReader::new(c.reader, MAX_LINE).next_line();
    (c.close)();
    let line = match read {
        Ok(Some(line)) => line,
        Ok(None) => {
            sent?;
            return Err(transport("the agent closed without answering".into()));
        }
        Err(e) => {
            sent?;
            return Err(transport(format!("reading the agent's answer: {e}")));
        }
    };
    match Incoming::parse(&line) {
        Ok(Incoming::Answer { result: Ok(v), .. }) => serde_json::from_value(v)
            .map_err(|e| CallError::Decode(format!("the agent's answer: {e}"))),
        Ok(Incoming::Answer { result: Err(e), .. }) => Err(CallError::Remote {
            code: e.code,
            msg: e.msg,
        }),
        Ok(_) => Err(CallError::Decode(
            "the agent wrote something other than an answer".into(),
        )),
        Err(e) => Err(CallError::Decode(format!(
            "the agent's answer did not parse: {e}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Mode;
    use crate::facts::Facts;
    use crate::link::wire::Policy;
    use crate::role::Role;
    use crate::state::State;

    #[test]
    fn the_lines_on_the_wire() {
        assert_eq!(
            request_line(&LocalRequest::Status),
            "{\"id\":1,\"m\":\"status\"}\n"
        );
        assert_eq!(
            request_line(&LocalRequest::SettingsSet(SetParams {
                key: crate::settings::Key::AwakeHold,
                value: false
            })),
            "{\"id\":1,\"m\":\"settings.set\",\"p\":{\"key\":\"awake_hold\",\"value\":false}}\n"
        );
        let s = shared(Mode::Node);
        let a = |line: &str| line_of(&answer(&s, None, line.as_bytes()));
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
        // A unit method sent with an empty object is still that method.
        assert!(a(r#"{"id":3,"m":"status","p":{}}"#).contains("bad_request"));
    }

    /// A request as a client writes it, read as the service reads it.
    fn ask(s: &Shared, peer: Option<&Peer>, m: &str, p: Value) -> Result<Value, ApiError> {
        crate::rpc::Request {
            id: 1,
            m: m.into(),
            p,
        }
        .typed()
        .and_then(|r| handle(s, peer, r))
    }

    fn shared(mode: Mode) -> Shared {
        Shared::new(
            Role::of(mode),
            Facts::default(),
            State::default(),
            Policy::default(),
            crate::util::Shutdown::new(),
        )
    }

    #[test]
    fn no_one_pairs_through_the_socket_and_a_reload_follows_the_file() {
        let dir = std::env::temp_dir().join(format!("daedalus-local-pair-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        let key = crate::identity::format_fingerprint(&[4; 32]);
        // As a system that pairs has them (Windows, Linux: a pin alone).
        let files = crate::link::KeyFiles {
            config: path.clone(),
            login: None,
        };
        let s = shared(Mode::Node);
        // Pairing is an administrator's (`pair`, elevated): the socket has
        // no method for it, whoever asks and whatever the machine's state.
        let e = ask(&s, None, "link.pair", serde_json::json!({"pin": key})).unwrap_err();
        assert_eq!(e.code, ErrorCode::UnknownMethod);
        assert_eq!(s.link.keys().0.pin, None);
        assert!(!path.exists());
        // What `pair` does as root: writes the file, then asks for a reload.
        crate::pair::Pairing::new(&key, Some("box.lan:7788"))
            .unwrap()
            .write_at(&path)
            .unwrap();
        assert!(link_reload(&s, &files)
            .unwrap()
            .as_str()
            .unwrap()
            .contains("new keys"));
        assert_eq!(s.link.keys().0.pin.as_deref(), Some(key.as_str()));
        // A reload with nothing new changes nothing.
        assert!(link_reload(&s, &files)
            .unwrap()
            .as_str()
            .unwrap()
            .contains("in use"));
        // The controller has no link to reload.
        assert_eq!(
            link_reload(&shared(Mode::Controller), &files)
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
        assert!(ask(&s, None, "link.reload", serde_json::json!({"x": 1})).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_methods_reach_the_shared_state() {
        let s = shared(Mode::Node);
        assert_eq!(ask(&s, None, "claude", Value::Null).unwrap(), Value::Null);
        let report = serde_json::to_value(Report {
            state: crate::claude::ClaudeState::Running,
            ..Default::default()
        })
        .unwrap();
        s.claude.request_restart();
        let answer = ask(&s, None, "claude.report", report).unwrap();
        assert_eq!(answer["restart"], true);
        assert_eq!(
            ask(&s, None, "claude", Value::Null).unwrap()["state"],
            "running"
        );
        assert_eq!(
            ask(&s, None, "status", Value::Null).unwrap()["claude"]["state"],
            "running"
        );
        assert!(ask(&s, None, "claude.update", Value::Null).is_ok());
        assert!(ask(&s, None, "update.check", Value::Null).is_ok());
        assert!(s.update.take_check_request());
        assert!(ask(&s, None, "claude.report", serde_json::json!({"state": 3})).is_err());
        assert!(ask(&s, None, "status", serde_json::json!({"x": 1})).is_err());
        assert!(ask(&s, None, "reboot", Value::Null)
            .unwrap_err()
            .msg
            .contains("no method"));
        // nix pins Claude on the controller.
        let c = shared(Mode::Controller);
        assert!(ask(&c, None, "claude.update", Value::Null)
            .unwrap_err()
            .msg
            .contains("nix"));
    }

    /// `settings.set`: the operator's alone; nothing sent for a value the box
    /// holds; santree ON sends nothing and names the page, or says where to
    /// turn it on when this machine knows no app.
    #[cfg(unix)]
    #[test]
    fn settings_are_the_operator_s_to_change_and_santree_on_is_the_browser_s() {
        use crate::settings::Key;
        let dir = std::env::temp_dir().join(format!("daedalus-local-set-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let with_app = dir.join("config.toml");
        std::fs::write(
            &with_app,
            "app_url = \"https://daedalus-app.example.org\"\n",
        )
        .unwrap();
        let without = dir.join("none.toml");

        let s = shared(Mode::Node).with_node(crate::shared::NodeKey {
            id: "0123456789abcdef".into(),
            fingerprint: "0123:4567:89ab:cdef".into(),
        });
        s.settings.set_policy(Policy {
            awake_hold: true,
            claude_remote_control: true,
            ..Default::default()
        });
        s.link.set_status(|l| {
            l.connected = true;
            l.state = Some(crate::link::LinkState::Approved);
        });
        let root = Peer::Uid(0);
        let set = |peer: &Peer, key: Key, v: bool, cfg: &Path| {
            settings_set(&s, Some(peer), SetParams { key, value: v }, cfg)
        };
        let answer = |v: Value| serde_json::from_value::<SetAnswer>(v).unwrap();

        // Someone else: refused, nothing recorded.
        let e = set(&Peer::Uid(4242), Key::AwakeHold, false, &with_app).unwrap_err();
        assert_eq!(e.code, ErrorCode::Forbidden);
        assert!(s.settings.take_request().is_none());
        // The value the box holds: nothing to send.
        assert!(answer(set(&root, Key::AwakeHold, true, &with_app).unwrap()).unchanged);
        assert!(s.settings.take_request().is_none());
        // Another value: recorded, and the link sends it.
        assert!(answer(set(&root, Key::AwakeHold, false, &with_app).unwrap()).sent);
        let (_, req) = s.settings.take_request().unwrap();
        assert_eq!(req.awake_hold, Some(false));
        // santree ON: the page, and nothing on the link.
        let a = answer(set(&root, Key::Santree, true, &with_app).unwrap());
        assert_eq!(
            a.confirm_url.as_deref(),
            Some(
                "https://daedalus-app.example.org/settings?tab=machines&node=0123456789abcdef&santree=on"
            )
        );
        assert!(s.settings.take_request().is_none());
        let view = crate::status::settings_view(&s, None);
        assert!(view
            .pending
            .iter()
            .any(|p| p.key == Key::Santree && p.via == crate::settings::Via::Browser));
        // No app known: where to turn it on instead, and nothing recorded.
        let s2 = shared(Mode::Node).with_node(crate::shared::NodeKey {
            id: "0123456789abcdef".into(),
            fingerprint: "x".into(),
        });
        let e = settings_set(
            &s2,
            Some(&root),
            SetParams {
                key: Key::Santree,
                value: true,
            },
            &without,
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Unsupported);
        assert!(e.msg.contains("Settings › Machines"));
        assert!(crate::status::settings_view(&s2, None).pending.is_empty());
        // Exact parameters.
        assert!(set_raw(
            &s,
            &root,
            serde_json::json!({"key": "providers", "value": true})
        )
        .is_err());
        assert!(set_raw(
            &s,
            &root,
            serde_json::json!({"key": "santree", "value": true, "x": 1})
        )
        .is_err());
        // Read by anyone the door admits; `may_change` says for whom.
        let got = ask(&s, Some(&Peer::Uid(4242)), "settings.get", Value::Null).unwrap();
        assert_eq!(got["may_change"], false);
        assert_eq!(got["node"], "0123456789abcdef");
        assert_eq!(
            ask(&s, Some(&root), "settings.get", Value::Null).unwrap()["may_change"],
            true
        );
        // The status page carries the same block, without `may_change`.
        let page = ask(&s, None, "status", Value::Null).unwrap();
        assert_eq!(page["settings"]["linked"], true);
        assert!(page["settings"].get("may_change").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    fn set_raw(s: &Shared, peer: &Peer, p: Value) -> Result<Value, ApiError> {
        ask(s, Some(peer), "settings.set", p)
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
            call_at::<String>(&path, &LocalRequest::UpdateCheck).unwrap(),
            "checking"
        );
        assert!(s.update.take_check_request());
        let doc: crate::status::StatusDocument = call_at(&path, &LocalRequest::Status).unwrap();
        assert_eq!(doc.version, crate::VERSION);
        // An answer of another type than asked is said so, not misread.
        assert!(matches!(
            call_at::<u32>(&path, &LocalRequest::UpdateCheck),
            Err(CallError::Decode(_))
        ));
        drop(served);

        // A gate that says no: one line, closed.
        let refusing = crate::os::serve_local(
            &path,
            &policy(Arc::new(|_| false), 4, Duration::from_secs(2)),
            |_| unreachable!("refused before serving"),
        )
        .unwrap();
        let e = call_at::<Value>(&path, &LocalRequest::Status).unwrap_err();
        assert!(
            matches!(&e, CallError::Remote { code: ErrorCode::Forbidden, msg } if msg.starts_with("uid ")),
            "{e:?}"
        );
        drop(refusing);
        assert!(matches!(
            call_at::<Value>(&path, &LocalRequest::Status),
            Err(CallError::Transport(_))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A client that drips its request never holds the connection past the
    /// whole exchange's deadline.
    #[cfg(unix)]
    #[test]
    fn a_dripping_client_is_cut_off_at_the_whole_deadline() {
        use std::io::Write as _;
        use std::time::Instant;
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
