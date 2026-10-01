//! Protocol v1, one connection at a time.
//!
//! A port of santree's in-process reference daemon (`crates/remote/src/fake.rs`)
//! onto real connections, by way of the parked 2026-09-27 daemon. Every
//! behaviour the doc leaves open is decided the way the fake decides it, so
//! code that passes against the fake passes here:
//!
//! - the `pty.attach` response is written before any `pty.data` of that
//!   attach (a gate buffers chunks until the response is queued);
//! - attaching to a session whose process already ended answers, then sends
//!   `pty.exit`;
//! - a dropped connection, and `pty.detach`, only detach the sessions *that
//!   connection* is the receiver of;
//! - `hooks.subscribe` has one subscriber at a time, the newest.
//!
//! What this host adds (README.md, "Deviations"): every connection is a node,
//! proved by its TLS key, and every PTY is tagged with the node that opened
//! it, so a node leaving the allow-list loses its links and its PTYs; the
//! caps ([`MAX_PTYS`], [`MAX_IN_FLIGHT`], [`MAX_CONNS_PER_NODE`],
//! [`OUT_QUEUE_BYTES`], [`REAP_AFTER`]); confinement of working directories and
//! written files to the projects root (fsops.rs); `hooks.push` only on the
//! local hook socket; `workspaces.list` and `workspaces.icon`; and an audit line per connection and
//! per consequential request — never data, file contents or env values.

mod conn;
mod hooks;
mod pty;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use santree_pty::PtyManager;
use santree_remote_proto::*;
use serde::Serialize;
use serde_json::value::RawValue;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use crate::allow::AllowList;
use crate::util::{err, lock};
use crate::{exec, fsops, workspaces};

use conn::Conn;
pub use conn::{serve_conn, ConnSummary, Peer};
pub use hooks::serve_hook_conn;
use hooks::HookQueue;
use pty::{pty_err, SessState};

/// The longest request line accepted, the client's own cap.
pub const MAX_REQUEST_LINE: usize = 32 * 1024 * 1024;
/// PTY sessions, live or exited, on the whole host (each holds a 2 MiB ring).
pub const MAX_PTYS: usize = 64;
/// Requests one connection may have running at once; more get `busy`.
pub const MAX_IN_FLIGHT: usize = 32;
/// Connections one node may hold at once; another is closed at once.
pub const MAX_CONNS_PER_NODE: usize = 4;
/// Bytes queued for one connection's writer, each line counted with
/// [`LINE_OVERHEAD`]. A peer that stops reading fills it; the link is then
/// dropped and its sessions parked — nothing is lost, the ring replays it on
/// the next attach. Bytes only, no line count: a whole hook backlog (up to
/// [`HOOK_QUEUE_BYTES`], ~4/3 of it in base64) must fit, however many events
/// it holds.
pub const OUT_QUEUE_BYTES: usize = 128 * 1024 * 1024;
/// What one queued line costs besides its text (its allocation and its
/// slot), so a flood of tiny lines still fills the queue.
pub const LINE_OVERHEAD: usize = 64;
/// Hook events cloned from the queue per lock while a backlog is sent.
const BACKLOG_CHUNK: usize = 256;
/// How long a closing connection's writer may take to finish its last write
/// and send TLS `close_notify`, so the peer can tell a close from a cut.
const WRITER_CLOSE: Duration = Duration::from_secs(1);
/// Blocking work (the handlers that run on tokio's blocking pool) one node
/// may have running at once; more get `busy`. Counted per node, not per
/// connection, and held by the work itself until it returns: a reconnect
/// does not reset it, so work that outlives its connection cannot pile up.
pub const MAX_BLOCKING_PER_NODE: usize = 32;
/// Bytes waiting to be written into one PTY (`pty.write`): a program that
/// does not read its input fills it, and further writes get `busy`.
pub const PTY_INPUT_QUEUE: usize = 1024 * 1024;
/// PTY input threads at once (`Input`): one per session that was written
/// to, plus any a closed session left parked in the kernel.
pub const MAX_INPUT_THREADS: usize = 2 * MAX_PTYS;
/// How long a `pty.write` waits for its bytes to go in before it answers
/// `timeout` (they stay queued, in order).
pub const PTY_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Bytes of hook events kept for a subscriber, besides their count.
pub const HOOK_QUEUE_BYTES: usize = 64 * 1024 * 1024;
/// The longest `hello.client` kept (status file, log).
pub const MAX_CLIENT_NAME: usize = 128;
/// An exited session nobody is attached to is closed after this long.
pub const REAP_AFTER: Duration = Duration::from_secs(3600);
/// How often exited sessions are looked for.
pub const REAP_EVERY: Duration = Duration::from_secs(60);
/// What `hello` names in `features`.
pub const FEATURES: &[&str] = &[m::WorkspacesList::NAME, workspaces::ICON_METHOD];

/// The error code of a request refused for a cap.
fn busy(msg: impl Into<String>) -> WireError {
    WireError::new(ErrorCode::Other("busy".into()), msg)
}

#[derive(Debug, Clone)]
pub struct Options {
    pub hostname: String,
    pub user: String,
    pub home: String,
    pub projects_root: PathBuf,
    pub hook_bin: String,
    pub workspaces: PathBuf,
    pub workspace_icons: PathBuf,
    pub hook_queue_cap: usize,
}

type Outcome = Result<Box<RawValue>, WireError>;

fn ok<T: Serialize>(value: &T) -> Outcome {
    serde_json::value::to_raw_value(value).map_err(|e| err(ErrorCode::Io, e.to_string()))
}

// ── the daemon ────────────────────────────────────────────────────────────

pub struct Daemon {
    opts: Options,
    root: fsops::Root,
    /// `hello`'s `bootId`: fresh per `serve` start.
    boot_id: String,
    mgr: PtyManager,
    sessions: Mutex<HashMap<SessionId, Arc<SessState>>>,
    /// The nodes whose PTYs may live.
    allow: Arc<AllowList>,
    /// Held across a `pty.open` (the allow-list check, the count, the open)
    /// and across [`Daemon::close_revoked`], so [`MAX_PTYS`] is exact and no
    /// open can slip between a revocation and its sweep.
    opening: Mutex<()>,
    hooks: Mutex<HookQueue>,
    /// Each node's blocking work ([`MAX_BLOCKING_PER_NODE`]).
    blocking: Mutex<HashMap<String, Arc<Semaphore>>>,
    /// PTY input threads alive ([`MAX_INPUT_THREADS`]).
    inputs: Arc<AtomicUsize>,
    next_conn: AtomicU64,
    conns: Mutex<HashMap<u64, ConnSummary>>,
    /// Raised on every change the status file reports.
    changed: Arc<Notify>,
}

impl Daemon {
    pub fn new(opts: Options, boot_id: String, allow: Arc<AllowList>) -> Arc<Self> {
        let cap = opts.hook_queue_cap;
        Arc::new(Self {
            root: fsops::Root::new(opts.projects_root.clone()),
            allow,
            opts,
            boot_id,
            mgr: PtyManager::new(),
            sessions: Mutex::new(HashMap::new()),
            opening: Mutex::new(()),
            hooks: Mutex::new(HookQueue {
                cap,
                max_bytes: HOOK_QUEUE_BYTES,
                bytes: 0,
                last_seq: 0,
                items: VecDeque::new(),
                dropped: 0,
                subscriber: None,
            }),
            blocking: Mutex::new(HashMap::new()),
            inputs: Arc::new(AtomicUsize::new(0)),
            next_conn: AtomicU64::new(1),
            conns: Mutex::new(HashMap::new()),
            changed: Arc::new(Notify::new()),
        })
    }

    /// A slot for one piece of `node`'s blocking work, or `busy`. The work
    /// holds it until it returns (`blocking`), not until its connection
    /// ends.
    fn permit(&self, node: &str) -> Result<OwnedSemaphorePermit, WireError> {
        let sem = lock(&self.blocking)
            .entry(node.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_BLOCKING_PER_NODE)))
            .clone();
        sem.try_acquire_owned().map_err(|_| {
            busy(format!(
                "{MAX_BLOCKING_PER_NODE} requests of this machine are still running on the host"
            ))
        })
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }

    /// Resolves after the next status-relevant change (or at once, if one
    /// happened since the last wait).
    pub async fn changed(&self) {
        self.changed.notified().await;
    }

    fn touch(&self) {
        self.changed.notify_one();
    }

    pub fn connections(&self) -> Vec<ConnSummary> {
        let mut conns: Vec<ConnSummary> = lock(&self.conns).values().cloned().collect();
        conns.sort_by_key(|c| c.id);
        conns
    }

    fn hello(&self, request: &RawRequest) -> Result<(HelloParams, Box<RawValue>), WireError> {
        let p: HelloParams = request.params()?;
        if p.protocol != PROTOCOL_VERSION {
            return Err(WireError {
                code: ErrorCode::Version,
                msg: format!(
                    "protocol {} is not supported; this host speaks {}",
                    p.protocol, PROTOCOL_VERSION
                ),
                protocol: Some(PROTOCOL_VERSION),
            });
        }
        let result = ok(&HelloResult {
            protocol: PROTOCOL_VERSION,
            version: crate::VERSION.to_string(),
            hostname: self.opts.hostname.clone(),
            user: self.opts.user.clone(),
            home: self.opts.home.clone(),
            boot_id: self.boot_id.clone(),
            projects_root: self.opts.projects_root.to_string_lossy().into_owned(),
            hook_bin: self.opts.hook_bin.clone(),
            features: FEATURES.iter().map(|f| f.to_string()).collect(),
        })?;
        Ok((p, result))
    }

    /// One request after `hello`. `hello` itself is answered in line by
    /// [`serve_conn`], so nothing overtakes it.
    async fn handle(self: &Arc<Self>, conn: &Arc<Conn>, request: &RawRequest) -> Reply {
        macro_rules! params {
            ($ty:ty) => {
                match request.params::<$ty>() {
                    Ok(p) => p,
                    Err(e) => return Reply::Answer(Err(e)),
                }
            };
        }
        // A slot of this node's blocking work, or the `busy` answer.
        macro_rules! permit {
            () => {
                match self.permit(&conn.node) {
                    Ok(permit) => permit,
                    Err(e) => return Reply::Answer(Err(e)),
                }
            };
        }
        let this = self.clone();
        let audit = |what: String| {
            log::info!(
                "node {} connection {}: {} #{} {what}",
                conn.node,
                conn.id,
                request.m,
                request.id
            )
        };
        match request.m.as_str() {
            m::PtyOpen::NAME => {
                let p = params!(PtyOpenParams);
                audit(format!(
                    "{:?} in {:?}",
                    if p.command.is_empty() {
                        "login shell"
                    } else {
                        &p.command
                    },
                    p.cwd.as_deref().unwrap_or("-")
                ));
                let node = conn.node.clone();
                blocking(permit!(), move || this.pty_open(p, node)).await
            }
            m::PtyAttach::NAME => {
                let p = params!(PtyAttachParams);
                let (conn, id, sid) = (conn.clone(), request.id, p.id);
                blocking(permit!(), move || {
                    let reply = this.pty_attach(&conn, id, p);
                    // Its connection ended while this ran: the teardown's
                    // sweep may have missed the route just set (`Conn`).
                    if conn.closed.load(Ordering::SeqCst) {
                        if let Some(sess) = this.session(sid) {
                            this.park(sid, &sess, Some(conn.id));
                        }
                    }
                    reply
                })
                .await
            }
            m::PtyDetach::NAME => {
                let p = params!(SessionRef);
                let conn = conn.id;
                blocking(permit!(), move || {
                    if let Some(sess) = this.session(p.id) {
                        this.park(p.id, &sess, Some(conn));
                    }
                    ok(&Empty)
                })
                .await
            }
            // Through the session's own input thread, never the blocking pool.
            m::PtyWrite::NAME => Reply::Answer(self.pty_write(params!(PtyWriteParams)).await),
            m::PtyResize::NAME => {
                let p = params!(PtyResizeParams);
                blocking(permit!(), move || {
                    this.mgr
                        .resize(p.id, p.cols, p.rows)
                        .map_err(|e| pty_err(&this, p.id, e))
                        .and_then(|()| ok(&Empty))
                })
                .await
            }
            m::PtyClose::NAME => {
                let p = params!(SessionRef);
                audit(format!("session {}", p.id));
                blocking(permit!(), move || {
                    let _ = this.mgr.close(p.id);
                    lock(&this.sessions).remove(&p.id);
                    this.touch();
                    ok(&Empty)
                })
                .await
            }
            m::PtySessions::NAME => {
                blocking(permit!(), move || ok(&this.infos(this.mgr.sessions()))).await
            }
            m::PtyAdopt::NAME => {
                let p = params!(PtyAdoptParams);
                audit(String::new());
                blocking(permit!(), move || this.pty_adopt(&p.owner)).await
            }
            m::ExecRun::NAME => {
                let p = params!(ExecParams);
                audit(format!(
                    "{:?} in {:?}",
                    p.argv.first().map(String::as_str).unwrap_or(""),
                    p.cwd
                ));
                Reply::Answer(self.exec_run(permit!(), p).await)
            }
            m::FsRead::NAME => {
                let p = params!(FsReadParams);
                blocking(permit!(), move || fsops::read(&p).and_then(|r| ok(&r))).await
            }
            m::FsWrite::NAME => {
                let p = params!(FsWriteParams);
                audit(format!("{:?}", p.path));
                blocking(permit!(), move || {
                    this.root
                        .write_target(&p.path)
                        .and_then(|target| fsops::write(&p, &target))
                        .and_then(|()| ok(&Empty))
                })
                .await
            }
            m::FsStat::NAME => {
                let p = params!(FsStatParams);
                blocking(permit!(), move || fsops::stat(&p.path).and_then(|r| ok(&r))).await
            }
            m::HooksSubscribe::NAME => {
                let p = params!(HooksSubscribeParams);
                self.subscribe_hooks(conn, request.id, p.after);
                log::info!("connection {}: subscribed to hooks", conn.id);
                self.touch();
                Reply::Done
            }
            m::HooksAck::NAME => {
                let p = params!(HooksAckParams);
                lock(&self.hooks).ack(p.up_to);
                self.touch();
                Reply::Answer(ok(&Empty))
            }
            m::WorkspacesList::NAME => {
                blocking(permit!(), move || {
                    workspaces::list(&this.opts.workspaces, &this.opts.projects_root)
                        .map_err(|e| err(ErrorCode::Io, e))
                        .and_then(|r| ok(&r))
                })
                .await
            }
            workspaces::ICON_METHOD => {
                let p = params!(workspaces::IconParams);
                blocking(permit!(), move || {
                    workspaces::icon(&this.opts.workspace_icons, &p.name).and_then(|r| ok(&r))
                })
                .await
            }
            m::HooksPush::NAME => Reply::Answer(Err(err(
                ErrorCode::BadRequest,
                "hooks.push is served on the local hook socket only",
            ))),
            other => Reply::Answer(Err(err(
                ErrorCode::BadRequest,
                format!("unknown method {other}"),
            ))),
        }
    }

    /// `exec.run`: its `cwd` is resolved on the blocking pool under the
    /// node's `permit`; the process itself runs on the async side.
    async fn exec_run(&self, permit: OwnedSemaphorePermit, p: ExecParams) -> Outcome {
        let root = self.root.clone();
        let cwd = p.cwd.clone();
        let cwd = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            root.cwd(Some(&cwd))
        })
        .await
        .map_err(|e| err(ErrorCode::Io, e.to_string()))??;
        exec::run(p, cwd).await.and_then(|r| ok(&r))
    }
}

/// What a request's handler leaves to the connection.
enum Reply {
    /// The handler queued its response itself: `pty.attach` and
    /// `hooks.subscribe` must order it ahead of the events they start.
    Done,
    /// The response for the connection to send.
    Answer(Outcome),
}

impl From<Outcome> for Reply {
    fn from(outcome: Outcome) -> Self {
        Reply::Answer(outcome)
    }
}

/// Run a blocking handler off the async workers, holding its node's
/// `permit` until it returns — even when its request is aborted (the
/// connection ended), which cannot stop a blocking task.
async fn blocking<F, R>(permit: OwnedSemaphorePermit, f: F) -> Reply
where
    F: FnOnce() -> R + Send + 'static,
    R: Into<Reply> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        f().into()
    })
    .await
    .unwrap_or_else(|e| Reply::Answer(Err(err(ErrorCode::Io, format!("handler panicked: {e}")))))
}
