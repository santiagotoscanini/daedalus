//! The service's end of the local socket: the door's policy, each method
//! answered from the shared state, and the socket served (`Door`).

use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::{LocalRequest, SetAnswer, SetParams, DEADLINE, MAX_CONNECTIONS};
use crate::core::shared::Shared;
use crate::ipc::door::{Conn, Peer, Policy, MAX_LINE};
use crate::ipc::jsonl::LineReader;
use crate::ipc::rpc::{line_of, ApiError, ErrorCode, Incoming, Response};
use crate::util::Rebinding;

/// The door's policy: `allow` asked per connection, at most `max`
/// connections, each whole exchange within `deadline`.
pub fn policy(allow: crate::ipc::door::Allow, max: usize, deadline: Duration) -> Policy {
    Policy {
        what: "local",
        allow,
        refusal: Arc::new(refusal),
        busy: crate::ipc::door::busy(max),
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
        Arc::new(|peer| crate::ipc::door::peer_allowed(peer, &crate::os::local_allowed())),
        MAX_CONNECTIONS,
        DEADLINE,
    )
}

/// The line a refused peer gets before its connection is closed.
pub fn refusal(peer: Option<&Peer>) -> String {
    crate::ipc::door::refusal(
        "this agent's socket",
        peer,
        "root, the service's own user and the user it runs Claude for",
    )
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(ErrorCode::BadRequest, msg)
}

fn value<T: Serialize>(v: &T) -> Result<Value, ApiError> {
    serde_json::to_value(v).map_err(|e| ApiError::new(ErrorCode::Internal, e.to_string()))
}

/// by `peer` (as the door checked it).
pub(super) fn handle(
    shared: &Shared,
    peer: Option<&Peer>,
    req: LocalRequest,
) -> Result<Value, ApiError> {
    use LocalRequest as R;
    match req {
        R::Status => value(&crate::core::status::document(shared)),
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
        R::SettingsGet => value(&crate::core::status::settings_view(
            shared,
            Some(may_change(peer)),
        )),
        R::SettingsSet(p) => settings_set(shared, peer, p, &crate::core::paths::config_path()),
        R::EnrollBegin(_) | R::EnrollFinish(_) | R::EnrollLeave => enroll(shared, peer, req),
    }
}

/// `link.reload` against the link's keys in `files` (module doc).
pub(super) fn link_reload(
    shared: &Shared,
    files: &crate::link::KeyFiles,
) -> Result<Value, ApiError> {
    if !shared.role.link {
        return Err(ApiError::new(
            ErrorCode::Unsupported,
            "the controller has no link to reload",
        ));
    }
    match crate::node::pair::reload(shared, files) {
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
    return crate::ipc::door::peer_allowed(peer, &crate::os::operator_allowed());
    #[cfg(windows)]
    {
        let _ = peer;
        true
    }
}

/// `settings.set`'s parameters: one setting, its value.
/// `settings.set` (settings.rs): checked, then recorded and answered at
/// once — the link sends it, and the status page shows what became of it.
/// `config` is where the app's address is read for santree ON.
pub(super) fn settings_set(
    shared: &Shared,
    peer: Option<&Peer>,
    p: SetParams,
    config: &Path,
) -> Result<Value, ApiError> {
    use crate::node::settings::{Asked, Key};
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
        let app = crate::core::config::load_at(config)
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
        confirm = Some(crate::node::settings::confirm_url(&app, &node));
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
    let files = crate::node::enroll::Files::here();
    if let LocalRequest::EnrollFinish(p) = req {
        if !crate::node::enroll::may_finish(peer) {
            return Err(ApiError::new(
                ErrorCode::Forbidden,
                format!(
                    "{} may not finish a log-in: it names the box this machine trusts, so it \
                     runs as root (the menu bar asks for an administrator's password)",
                    who()
                ),
            ));
        }
        return crate::node::enroll::finish(shared, &files, p, crate::node::enroll::redeem_https)
            .map(Value::from);
    }
    if !crate::node::enroll::may_enroll(peer) {
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
        LocalRequest::EnrollBegin(p) => value(&crate::node::enroll::begin(shared, &files, p)?),
        _ => crate::node::enroll::leave(shared, &files).map(Value::from),
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
pub(super) fn answer(shared: &Shared, peer: Option<&Peer>, line: &[u8]) -> Response {
    let r = match Incoming::request(line) {
        Ok(r) => r,
        Err(e) => {
            return Response::err(
                crate::ipc::rpc::salvage_id(line),
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
pub(super) fn serve_one(shared: &Shared, c: Conn) {
    let mut w = c.writer;
    let response = match LineReader::new(c.reader, MAX_LINE).next_line() {
        Ok(Some(line)) => answer(shared, c.peer.as_ref(), &line),
        Err(e) if crate::ipc::jsonl::is_too_long(&e) => Response::err(
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
    let path = crate::core::paths::local_socket();
    let socket = crate::os::serve_local(&path, &service_policy(), move |c| serve_one(&shared, c))?;
    tracing::info!(socket = %path.display(), "local socket answering");
    Ok(socket)
}
