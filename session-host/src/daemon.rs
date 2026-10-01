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

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use santree_pty::{OpenOpts, PtyManager};
use santree_remote_proto::*;
use serde::Serialize;
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

use crate::allow::{AllowList, AllowSet};
use crate::framing::{read_line, ReadEnd};
use crate::{exec, fsops, workspaces};

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
    /// This host's own version (`hello.version`).
    pub version: String,
    pub hostname: String,
    pub user: String,
    pub home: String,
    pub projects_root: PathBuf,
    pub hook_bin: String,
    pub workspaces: PathBuf,
    pub workspace_icons: PathBuf,
    pub ping_interval: Duration,
    pub hook_queue_cap: usize,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn err(code: ErrorCode, msg: impl Into<String>) -> WireError {
    WireError::new(code, msg)
}

type Outcome = Result<Box<RawValue>, WireError>;

fn ok<T: Serialize>(value: &T) -> Outcome {
    serde_json::value::to_raw_value(value).map_err(|e| err(ErrorCode::Io, e.to_string()))
}

// ── connections ───────────────────────────────────────────────────────────

/// One connection's outgoing queue, bounded by bytes ([`OUT_QUEUE_BYTES`]).
/// A send that finds it full closes the connection (`close`) instead of
/// waiting.
#[derive(Clone)]
struct Out {
    tx: mpsc::UnboundedSender<String>,
    conn: u64,
    /// Bytes queued and not yet taken by the writer ([`queued_cost`]).
    queued: Arc<AtomicUsize>,
    full: Arc<AtomicBool>,
    close: Arc<Notify>,
}

/// What a queued line counts against [`OUT_QUEUE_BYTES`].
fn queued_cost(line: &str) -> usize {
    line.len() + LINE_OVERHEAD
}

impl Out {
    /// Queue one line; false when it was not (the queue is full, and the
    /// connection is closing, or already gone).
    fn send(&self, line: String) -> bool {
        let cost = queued_cost(&line);
        if self.queued.fetch_add(cost, Ordering::AcqRel) + cost > OUT_QUEUE_BYTES {
            self.queued.fetch_sub(cost, Ordering::AcqRel);
            if !self.full.swap(true, Ordering::AcqRel) {
                log::warn!(
                    "connection {}: too much queued and unread; dropping the link",
                    self.conn
                );
                self.close.notify_one();
            }
            return false;
        }
        if self.tx.send(line).is_err() {
            self.queued.fetch_sub(cost, Ordering::AcqRel);
            return false;
        }
        true
    }
}

struct Conn {
    id: u64,
    node: String,
    out: Out,
    /// Set before its sessions are parked at teardown: an attach that lands
    /// after that sweep parks the session again instead of routing it to a
    /// dead connection.
    closed: AtomicBool,
}

/// What the status file reports about one connection.
#[derive(Debug, Clone)]
pub struct ConnSummary {
    pub id: u64,
    pub node: String,
    pub peer: SocketAddr,
    pub connected_at: SystemTime,
    /// `hello.client`, once a hello succeeded.
    pub client: Option<String>,
}

// ── pty routing ───────────────────────────────────────────────────────────

/// One attach's delivery: chunks wait here until the attach response has been
/// queued, so the response always precedes them on the wire.
struct Gate {
    id: SessionId,
    out: Out,
    st: Mutex<GateState>,
}

#[derive(Default)]
struct GateState {
    open: bool,
    pending: Vec<Vec<u8>>,
    exit_sent: bool,
}

impl Gate {
    fn deliver(&self, bytes: Vec<u8>) {
        let mut st = lock(&self.st);
        if st.open {
            self.emit(&mut st, bytes);
        } else {
            st.pending.push(bytes);
        }
    }

    /// Empty = the exit sentinel, sent once; nothing follows it.
    fn emit(&self, st: &mut GateState, bytes: Vec<u8>) {
        if st.exit_sent {
            return;
        }
        let event = if bytes.is_empty() {
            st.exit_sent = true;
            Event::PtyExit(PtyExit { id: self.id })
        } else {
            Event::PtyData(PtyData {
                id: self.id,
                data: bytes,
            })
        };
        self.out.send(event.encode());
    }
}

struct SessState {
    /// The node that opened it: its PTYs end when it leaves the allow-list.
    node: String,
    /// Serialises attach/park for this session. Never held by a sink.
    attach: Mutex<()>,
    live: Mutex<Live>,
    /// The daemon's status-change signal, raised when the process ends.
    changed: Arc<Notify>,
    /// Its input (`pty.write`), started on the first write.
    input: Mutex<Option<Input>>,
}

/// One PTY's input: a thread of its own that writes the queued bytes in
/// order. A program that does not read its input blocks that thread — and
/// only it: no pool thread waits, and a full queue answers `busy`. The
/// thread ends when the session's state is dropped (it was closed) and the
/// write in progress, if any, returns.
///
/// That write may not return: santree-pty's writer is a blocking master fd
/// this crate cannot reach, and on Linux (seen on 6.18) a write blocked on a
/// full PTY stays blocked after the session is closed and its process is
/// gone. Such a thread holds its
/// queue (at most [`PTY_INPUT_QUEUE`]) until the host restarts, so input
/// threads are capped at [`MAX_INPUT_THREADS`]; past it `pty.write` answers
/// `busy`. The fix belongs in santree-pty (a non-blocking master writer and
/// a deadline).
struct Input {
    tx: std::sync::mpsc::Sender<InputJob>,
    queued: Arc<AtomicUsize>,
}

struct InputJob {
    data: Vec<u8>,
    done: oneshot::Sender<Result<(), String>>,
}

impl Input {
    /// Start one, counted in `inputs` until its thread ends.
    fn start(mgr: PtyManager, id: SessionId, inputs: Arc<AtomicUsize>) -> Result<Self, WireError> {
        inputs
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_INPUT_THREADS).then_some(n + 1)
            })
            .map_err(|_| {
                busy(format!(
                    "{MAX_INPUT_THREADS} terminals' input writers are running; \
                     restart the session host to clear the stuck ones"
                ))
            })?;
        let (tx, rx) = std::sync::mpsc::channel::<InputJob>();
        let queued = Arc::new(AtomicUsize::new(0));
        let left = queued.clone();
        let count = inputs.clone();
        let started = std::thread::Builder::new()
            .name(format!("pty-input-{id}"))
            .spawn(move || {
                for job in rx {
                    let written = mgr.write(id, &job.data).map_err(|e| format!("{e:#}"));
                    left.fetch_sub(job.data.len(), Ordering::AcqRel);
                    let _ = job.done.send(written);
                }
                count.fetch_sub(1, Ordering::AcqRel);
            });
        if let Err(e) = started {
            inputs.fetch_sub(1, Ordering::AcqRel);
            return Err(err(ErrorCode::Io, format!("starting its input: {e}")));
        }
        Ok(Self { tx, queued })
    }

    /// Queue `data`; the receiver says when it went in. `busy` when the
    /// queue holds [`PTY_INPUT_QUEUE`] bytes already (a write into an empty
    /// queue is always taken, however large).
    fn queue(&self, data: Vec<u8>) -> Result<oneshot::Receiver<Result<(), String>>, WireError> {
        let len = data.len();
        self.queued
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |q| {
                (q == 0 || q + len <= PTY_INPUT_QUEUE).then_some(q + len)
            })
            .map_err(|q| {
                busy(format!(
                    "{q} bytes are waiting for this terminal to read its input"
                ))
            })?;
        let (done, rx) = oneshot::channel();
        if self.tx.send(InputJob { data, done }).is_err() {
            self.queued.fetch_sub(len, Ordering::AcqRel);
            return Err(err(ErrorCode::Io, "the terminal's input is closed"));
        }
        Ok(rx)
    }
}

impl SessState {
    fn new(node: String, changed: Arc<Notify>) -> Self {
        Self {
            node,
            attach: Mutex::new(()),
            live: Mutex::new(Live::default()),
            changed,
            input: Mutex::new(None),
        }
    }

    fn mark_ended(&self) {
        lock(&self.live).ended = true;
        self.changed.notify_one();
    }
}

#[derive(Default)]
struct Live {
    /// The pump emitted its exit sentinel: no more output will ever come.
    ended: bool,
    /// The connection receiving this session's output.
    route: Option<u64>,
    /// `adopt_others` dropped the sink for a moment, so an exit sentinel may
    /// have gone nowhere; attach falls back to asking whether it's alive.
    sentinel_maybe_lost: bool,
    /// Since when the reaper has seen it exited and unattached.
    idle_dead_since: Option<Instant>,
}

/// A sink that delivers nothing but still notices the process ending — the
/// "detached" state. `PtyManager::detach` would drop the sink and, with it,
/// the only way to learn of an exit that happens while detached.
fn parked_sink(sess: Arc<SessState>) -> impl Fn(Vec<u8>) + Send + 'static {
    move |bytes: Vec<u8>| {
        if bytes.is_empty() {
            sess.mark_ended();
        }
    }
}

// ── hooks ─────────────────────────────────────────────────────────────────

struct HookQueue {
    cap: usize,
    /// The queue's budget in bytes ([`hook_size`]), besides its count: one
    /// push can carry a 32 MiB stdin, and nobody may be subscribed for days.
    max_bytes: usize,
    bytes: usize,
    last_seq: u64,
    items: VecDeque<HookEvent>,
    /// Overflow not yet reported to a subscriber.
    dropped: u64,
    subscriber: Option<(u64, Out)>,
}

impl HookQueue {
    fn notify(&mut self, line: String) {
        if let Some((_, out)) = &self.subscriber {
            if !out.send(line) {
                self.subscriber = None;
            }
        }
    }

    fn report_dropped(&mut self) {
        if self.dropped > 0 && self.subscriber.is_some() {
            let count = std::mem::take(&mut self.dropped);
            self.notify(Event::HooksDropped(HooksDropped { count }).encode());
        }
    }

    fn push(&mut self, event: String, env: Vec<(String, String)>, stdin: Vec<u8>) -> u64 {
        self.last_seq += 1;
        let hook = HookEvent {
            seq: self.last_seq,
            at: now_ms(),
            event,
            env,
            stdin,
        };
        let size = hook_size(&hook);
        // The oldest go first, counted as dropped, until the new one fits
        // (one larger than the whole budget is still kept, alone).
        while !self.items.is_empty()
            && (self.items.len() >= self.cap.max(1) || self.bytes + size > self.max_bytes)
        {
            if let Some(old) = self.items.pop_front() {
                self.bytes -= hook_size(&old);
            }
            self.dropped += 1;
        }
        self.report_dropped();
        self.bytes += size;
        self.items.push_back(hook.clone());
        self.notify(Event::Hook(hook).encode());
        self.last_seq
    }

    /// `hooks.ack`: drop everything up to `up_to`.
    fn ack(&mut self, up_to: u64) {
        self.items.retain(|h| h.seq > up_to);
        self.bytes = self.items.iter().map(hook_size).sum();
    }
}

/// What one queued hook costs, roughly its size in memory.
fn hook_size(h: &HookEvent) -> usize {
    64 + h.event.len() + h.stdin.len() + h.env.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>()
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

    /// Queue `data` for session `id`'s input (`Input`).
    fn pty_input(
        &self,
        id: SessionId,
        data: Vec<u8>,
    ) -> Result<oneshot::Receiver<Result<(), String>>, WireError> {
        let Some(sess) = self.session(id) else {
            return Err(err(
                ErrorCode::NotFound,
                format!("no terminal session {id}"),
            ));
        };
        let mut input = lock(&sess.input);
        if input.is_none() {
            *input = Some(Input::start(self.mgr.clone(), id, self.inputs.clone())?);
        }
        input.as_ref().expect("just made").queue(data)
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }

    pub fn options(&self) -> &Options {
        &self.opts
    }

    /// Resolves after the next status-relevant change (or at once, if one
    /// happened since the last wait).
    pub async fn changed(&self) {
        self.changed.notified().await;
    }

    fn touch(&self) {
        self.changed.notify_one();
    }

    /// Kill every session. Bounded (santree-pty gives up after ~2s).
    pub fn close_all(&self) {
        self.mgr.close_all();
        lock(&self.sessions).clear();
    }

    pub fn connections(&self) -> Vec<ConnSummary> {
        let mut conns: Vec<ConnSummary> = lock(&self.conns).values().cloned().collect();
        conns.sort_by_key(|c| c.id);
        conns
    }

    /// PTY sessions whose process is still running.
    pub fn live_sessions(&self) -> usize {
        self.mgr.sessions().iter().filter(|s| s.alive).count()
    }

    /// Close every PTY opened by a node the allow-list no longer names. The
    /// sessions are taken out under `opening`, so no open slips between the
    /// revocation and this sweep (`pty_open` checks the set under it too),
    /// and closed after it is released, so a sweep of many sessions (each
    /// close can take a quarter second) does not hold up other nodes' opens.
    pub fn close_revoked(&self) {
        let gone: Vec<(SessionId, String)> = {
            let _one = lock(&self.opening);
            let set = self.allow.current();
            let mut sessions = lock(&self.sessions);
            let gone: Vec<(SessionId, String)> = sessions
                .iter()
                .filter(|(_, s)| !set.contains_node(&s.node))
                .map(|(id, s)| (*id, s.node.clone()))
                .collect();
            for (id, _) in &gone {
                sessions.remove(id);
            }
            gone
        };
        for (id, node) in gone {
            let _ = self.mgr.close(id);
            log::info!("node {node} is no longer allowed: closed pty session {id}");
        }
        self.touch();
    }

    /// Close the sessions that have been exited and unattached for `after`.
    pub fn reap(&self, after: Duration) {
        let now = Instant::now();
        let dead: Vec<SessionId> = self
            .mgr
            .sessions()
            .into_iter()
            .filter(|s| !s.alive)
            .map(|s| s.id)
            .collect();
        let mut expired = Vec::new();
        for (id, sess) in lock(&self.sessions).iter() {
            let mut live = lock(&sess.live);
            if !dead.contains(id) || live.route.is_some() {
                live.idle_dead_since = None;
                continue;
            }
            let since = *live.idle_dead_since.get_or_insert(now);
            if now.duration_since(since) >= after {
                expired.push(*id);
            }
        }
        for id in expired {
            let _ = self.mgr.close(id);
            lock(&self.sessions).remove(&id);
            log::info!(
                "closed pty session {id}: exited and unattached for {}s",
                after.as_secs()
            );
            self.touch();
        }
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
            version: self.opts.version.clone(),
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

    /// Queue one hook (the local hook socket's only method).
    fn push_hook(&self, p: HookPushParams) -> u64 {
        let seq = lock(&self.hooks).push(p.event, p.env, p.stdin);
        self.touch();
        seq
    }

    /// `None` = the handler already wrote its response (attach, subscribe:
    /// both must order it ahead of the events they start).
    async fn handle(self: &Arc<Self>, conn: &Arc<Conn>, request: &RawRequest) -> Option<Outcome> {
        macro_rules! params {
            ($ty:ty) => {
                match request.params::<$ty>() {
                    Ok(p) => p,
                    Err(e) => return Some(Err(e)),
                }
            };
        }
        // A slot of this node's blocking work, or the `busy` answer.
        macro_rules! permit {
            () => {
                match self.permit(&conn.node) {
                    Ok(permit) => permit,
                    Err(e) => return Some(Err(e)),
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
                blocking(permit!(), move || Some(this.pty_open(p, node))).await
            }
            m::PtyAttach::NAME => {
                let p = params!(PtyAttachParams);
                let (conn, id, sid) = (conn.clone(), request.id, p.id);
                blocking(permit!(), move || {
                    let outcome = this.pty_attach(&conn, id, p);
                    // Its connection ended while this ran: the teardown's
                    // sweep may have missed the route just set (`Conn`).
                    if conn.closed.load(Ordering::SeqCst) {
                        if let Some(sess) = this.session(sid) {
                            this.park(sid, &sess, Some(conn.id));
                        }
                    }
                    outcome
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
                    Some(ok(&Empty))
                })
                .await
            }
            m::PtyWrite::NAME => {
                // Through the session's own input thread (`Input`), never
                // the blocking pool; the answer waits at most
                // PTY_WRITE_TIMEOUT.
                let p = params!(PtyWriteParams);
                let done = match self.pty_input(p.id, p.data) {
                    Ok(done) => done,
                    Err(e) => return Some(Err(e)),
                };
                Some(match tokio::time::timeout(PTY_WRITE_TIMEOUT, done).await {
                    Ok(Ok(Ok(()))) => ok(&Empty),
                    Ok(Ok(Err(e))) => Err(pty_err(self, p.id, e)),
                    Ok(Err(_)) => Err(err(ErrorCode::Io, "the terminal's input is closed")),
                    Err(_) => Err(err(
                        ErrorCode::Timeout,
                        format!(
                            "terminal session {} has not read its input for {}s; the bytes stay queued",
                            p.id,
                            PTY_WRITE_TIMEOUT.as_secs()
                        ),
                    )),
                })
            }
            m::PtyResize::NAME => {
                let p = params!(PtyResizeParams);
                blocking(permit!(), move || {
                    Some(
                        this.mgr
                            .resize(p.id, p.cols, p.rows)
                            .map_err(|e| pty_err(&this, p.id, e))
                            .and_then(|()| ok(&Empty)),
                    )
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
                    Some(ok(&Empty))
                })
                .await
            }
            m::PtySessions::NAME => {
                blocking(permit!(), move || {
                    Some(ok(&this.infos(this.mgr.sessions())))
                })
                .await
            }
            m::PtyAdopt::NAME => {
                let p = params!(PtyAdoptParams);
                audit(String::new());
                blocking(permit!(), move || Some(this.pty_adopt(&p.owner))).await
            }
            m::ExecRun::NAME => {
                let p = params!(ExecParams);
                audit(format!(
                    "{:?} in {:?}",
                    p.argv.first().map(String::as_str).unwrap_or(""),
                    p.cwd
                ));
                let root = self.root.clone();
                let cwd = p.cwd.clone();
                let permit = permit!();
                let cwd = match tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    root.cwd(Some(&cwd))
                })
                .await
                {
                    Ok(Ok(cwd)) => cwd,
                    Ok(Err(e)) => return Some(Err(e)),
                    Err(e) => return Some(Err(err(ErrorCode::Io, e.to_string()))),
                };
                Some(exec::run(p, cwd).await.and_then(|r| ok(&r)))
            }
            m::FsRead::NAME => {
                let p = params!(FsReadParams);
                blocking(permit!(), move || {
                    Some(fsops::read(&p).and_then(|r| ok(&r)))
                })
                .await
            }
            m::FsWrite::NAME => {
                let p = params!(FsWriteParams);
                audit(format!("{:?}", p.path));
                blocking(permit!(), move || {
                    Some(
                        this.root
                            .write_target(&p.path)
                            .and_then(|target| fsops::write(&p, &target))
                            .and_then(|()| ok(&Empty)),
                    )
                })
                .await
            }
            m::FsStat::NAME => {
                let p = params!(FsStatParams);
                blocking(permit!(), move || {
                    Some(fsops::stat(&p.path).and_then(|r| ok(&r)))
                })
                .await
            }
            m::HooksSubscribe::NAME => {
                let p = params!(HooksSubscribeParams);
                self.subscribe_hooks(conn, request.id, p.after);
                log::info!("connection {}: subscribed to hooks", conn.id);
                self.touch();
                None
            }
            m::HooksAck::NAME => {
                let p = params!(HooksAckParams);
                lock(&self.hooks).ack(p.up_to);
                self.touch();
                Some(ok(&Empty))
            }
            m::WorkspacesList::NAME => {
                blocking(permit!(), move || {
                    Some(
                        workspaces::list(&this.opts.workspaces, &this.opts.projects_root)
                            .map_err(|e| err(ErrorCode::Io, e))
                            .and_then(|r| ok(&r)),
                    )
                })
                .await
            }
            workspaces::ICON_METHOD => {
                let p = params!(workspaces::IconParams);
                blocking(permit!(), move || {
                    Some(workspaces::icon(&this.opts.workspace_icons, &p.name).and_then(|r| ok(&r)))
                })
                .await
            }
            m::HooksPush::NAME => Some(Err(err(
                ErrorCode::BadRequest,
                "hooks.push is served on the local hook socket only",
            ))),
            other => Some(Err(err(
                ErrorCode::BadRequest,
                format!("unknown method {other}"),
            ))),
        }
    }

    /// `hooks.subscribe`: the response, the dropped report, the backlog
    /// after `after`, then live events. The backlog is cloned
    /// [`BACKLOG_CHUNK`] events at a time under the queue's lock and encoded
    /// outside it; `conn` becomes the subscriber under the lock that finds
    /// nothing more to send, so no event is missed, repeated or reordered.
    fn subscribe_hooks(&self, conn: &Conn, req_id: u64, mut after: Option<u64>) {
        if !conn
            .out
            .send(encode_ok(req_id, &Empty).expect("empty serializes"))
        {
            return;
        }
        loop {
            let (dropped, chunk) = {
                let mut hooks = lock(&self.hooks);
                let start = hooks
                    .items
                    .partition_point(|h| after.is_some_and(|after| h.seq <= after));
                let chunk: Vec<HookEvent> = hooks
                    .items
                    .range(start..)
                    .take(BACKLOG_CHUNK)
                    .cloned()
                    .collect();
                if chunk.is_empty() {
                    hooks.subscriber = Some((conn.id, conn.out.clone()));
                    hooks.report_dropped();
                    return;
                }
                (std::mem::take(&mut hooks.dropped), chunk)
            };
            if dropped > 0
                && !conn
                    .out
                    .send(Event::HooksDropped(HooksDropped { count: dropped }).encode())
            {
                return;
            }
            for hook in chunk {
                after = Some(hook.seq);
                if !conn.out.send(Event::Hook(hook).encode()) {
                    return;
                }
            }
        }
    }

    fn session(&self, id: SessionId) -> Option<Arc<SessState>> {
        lock(&self.sessions).get(&id).cloned()
    }

    fn infos(&self, infos: Vec<santree_pty::SessionInfo>) -> Vec<SessionInfo> {
        let sessions = lock(&self.sessions);
        infos
            .into_iter()
            .map(|info| SessionInfo {
                attached: sessions
                    .get(&info.id)
                    .is_some_and(|s| lock(&s.live).route.is_some()),
                id: info.id,
                pid: info.pid,
                cwd: info.cwd,
                command: info.command,
                owner: info.owner,
                label: info.label,
                agent_kind: info.agent_kind,
                cols: info.cols,
                rows: info.rows,
                alive: info.alive,
                epoch: info.epoch,
            })
            .collect()
    }

    fn info(&self, id: SessionId) -> Option<SessionInfo> {
        let all = self.mgr.sessions();
        self.infos(all).into_iter().find(|info| info.id == id)
    }

    fn pty_open(&self, p: PtyOpenParams, node: String) -> Outcome {
        let cwd = self.root.cwd(p.cwd.as_deref())?;
        let _one = lock(&self.opening);
        // Its link is closing too (serve_conn); this only stops an open that
        // raced the revocation.
        if !self.allow.current().contains_node(&node) {
            return Err(err(
                ErrorCode::Other("access_denied".into()),
                format!("node {node} is no longer allowed"),
            ));
        }
        if self.mgr.sessions().len() >= MAX_PTYS {
            return Err(busy(format!(
                "{MAX_PTYS} terminal sessions are open; close one first"
            )));
        }
        let sess = Arc::new(SessState::new(node, self.changed.clone()));
        let id = self
            .mgr
            .open(
                OpenOpts {
                    cwd: Some(cwd.to_string_lossy().into_owned()),
                    command: p.command,
                    args: p.args,
                    cols: p.cols,
                    rows: p.rows,
                    env: p.env,
                    owner: p.owner,
                    label: p.label,
                    agent_kind: p.agent_kind,
                },
                parked_sink(sess.clone()),
            )
            .map_err(|e| err(ErrorCode::Io, format!("{e:#}")))?;
        lock(&self.sessions).insert(id, sess);
        self.touch();
        match self.info(id) {
            Some(info) => ok(&info),
            None => Err(err(ErrorCode::NotFound, format!("session {id} vanished"))),
        }
    }

    fn pty_attach(&self, conn: &Conn, req_id: u64, p: PtyAttachParams) -> Option<Outcome> {
        let Some(sess) = self.session(p.id) else {
            return Some(Err(err(
                ErrorCode::NotFound,
                format!("no terminal session {}", p.id),
            )));
        };
        let _serial = lock(&sess.attach);
        let gate = Arc::new(Gate {
            id: p.id,
            out: conn.out.clone(),
            st: Mutex::new(GateState::default()),
        });
        let sink = {
            let gate = gate.clone();
            let sess = sess.clone();
            move |bytes: Vec<u8>| {
                if bytes.is_empty() {
                    sess.mark_ended();
                }
                gate.deliver(bytes);
            }
        };
        let anchor = match p.anchor {
            Anchor::At { epoch, seq } => santree_pty::Anchor::At { epoch, seq },
            Anchor::Fresh => santree_pty::Anchor::Fresh,
            Anchor::Unknown => santree_pty::Anchor::Unknown,
        };
        let replay = match self.mgr.attach(p.id, &anchor, sink) {
            Ok(replay) => replay,
            Err(e) => return Some(Err(pty_err(self, p.id, format!("{e:#}")))),
        };
        let maybe_lost = {
            let mut live = lock(&sess.live);
            live.route = Some(conn.id);
            live.sentinel_maybe_lost
        };
        // Asked before the gate is locked: `sessions()` takes the manager's
        // sink locks, which a pump holds while it calls into the gate.
        let dead = maybe_lost
            && self
                .mgr
                .sessions()
                .iter()
                .any(|info| info.id == p.id && !info.alive);

        let result = AttachResult {
            mode: match replay.mode {
                santree_pty::ReplayMode::Exact => ReplayMode::Exact,
                santree_pty::ReplayMode::Tail => ReplayMode::Tail,
                santree_pty::ReplayMode::Reanchor => ReplayMode::Reanchor,
            },
            epoch: replay.epoch,
            seq: replay.seq,
            data: replay.bytes,
        };
        {
            let mut st = lock(&gate.st);
            conn.out
                .send(encode_ok(req_id, &result).expect("attach results serialize"));
            for bytes in std::mem::take(&mut st.pending) {
                gate.emit(&mut st, bytes);
            }
            st.open = true;
            if lock(&sess.live).ended || dead {
                gate.emit(&mut st, Vec::new());
            }
        }
        log::debug!("connection {}: pty.attach #{req_id} ok", conn.id);
        self.touch();
        None
    }

    /// Detach a session into the parked state — only when `only_conn` (if
    /// given) is still its receiver.
    fn park(&self, id: SessionId, sess: &Arc<SessState>, only_conn: Option<u64>) {
        let _serial = lock(&sess.attach);
        {
            let mut live = lock(&sess.live);
            if live.route.is_none() || only_conn.is_some_and(|c| live.route != Some(c)) {
                return;
            }
            live.route = None;
        }
        let _ = self
            .mgr
            .attach(id, &santree_pty::Anchor::Unknown, parked_sink(sess.clone()));
        self.touch();
    }

    fn pty_adopt(&self, owner: &str) -> Outcome {
        let adopted = self.mgr.adopt_others(owner);
        let live: Vec<SessionId> = self.mgr.sessions().iter().map(|s| s.id).collect();
        {
            let mut sessions = lock(&self.sessions);
            // Superseded duplicates were closed by the manager.
            sessions.retain(|id, _| live.contains(id));
        }
        for info in &adopted {
            if let Some(sess) = self.session(info.id) {
                let _serial = lock(&sess.attach);
                {
                    let mut live = lock(&sess.live);
                    live.route = None;
                    live.sentinel_maybe_lost = true;
                }
                let _ = self.mgr.attach(
                    info.id,
                    &santree_pty::Anchor::Unknown,
                    parked_sink(sess.clone()),
                );
            }
        }
        self.touch();
        ok(&self.infos(adopted))
    }
}

fn pty_err(daemon: &Daemon, id: SessionId, e: impl std::fmt::Display) -> WireError {
    let known = lock(&daemon.sessions).contains_key(&id);
    err(
        if known {
            ErrorCode::Io
        } else {
            ErrorCode::NotFound
        },
        e.to_string(),
    )
}

/// Run a blocking handler off the async workers, holding its node's
/// `permit` until it returns — even when its request is aborted (the
/// connection ended), which cannot stop a blocking task.
async fn blocking<F>(permit: OwnedSemaphorePermit, f: F) -> Option<Outcome>
where
    F: FnOnce() -> Option<Outcome> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        f()
    })
    .await
    .unwrap_or_else(|e| Some(Err(err(ErrorCode::Io, format!("handler panicked: {e}")))))
}

// ── one connection ────────────────────────────────────────────────────────

/// Who is on the other end of a connection the handshake admitted.
pub struct Peer {
    pub key: [u8; 32],
    pub node: String,
    pub addr: SocketAddr,
}

/// Whether `set` still admits this key as this node.
fn admits(set: &AllowSet, key: &[u8; 32], node: &str) -> bool {
    set.node_of(key) == Some(node)
}

/// Serve one admitted connection until it closes, its node leaves the
/// allow-list, or it stops reading.
pub async fn serve_conn<S>(daemon: Arc<Daemon>, allow: Arc<AllowList>, stream: S, peer: Peer)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    // Subscribed before this re-check, so a revocation that landed between
    // the handshake's check and now is seen here, and one after it by the
    // watch below.
    let mut allowed = allow.subscribe();
    if !admits(&allowed.borrow_and_update(), &peer.key, &peer.node) {
        log::info!(
            "node {} from {}: no longer allowed; closed",
            peer.node,
            peer.addr
        );
        return;
    }
    let id = daemon.next_conn.fetch_add(1, Ordering::Relaxed);
    {
        let mut conns = lock(&daemon.conns);
        let held = conns.values().filter(|c| c.node == peer.node).count();
        if held >= MAX_CONNS_PER_NODE {
            log::warn!(
                "node {} from {}: already holds {held} connections; closed",
                peer.node,
                peer.addr
            );
            return;
        }
        conns.insert(
            id,
            ConnSummary {
                id,
                node: peer.node.clone(),
                peer: peer.addr,
                connected_at: SystemTime::now(),
                client: None,
            },
        );
    }
    log::info!(
        "node {} connection {id}: opened from {}",
        peer.node,
        peer.addr
    );
    daemon.touch();

    let (reader, writer) = tokio::io::split(stream);
    let (tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let close = Arc::new(Notify::new());
    let queued = Arc::new(AtomicUsize::new(0));
    let conn = Arc::new(Conn {
        id,
        node: peer.node.clone(),
        out: Out {
            tx,
            conn: id,
            queued: queued.clone(),
            full: Arc::new(AtomicBool::new(false)),
            close: close.clone(),
        },
        closed: AtomicBool::new(false),
    });

    // Stopped by the teardown (`stop`), it ends its write and sends
    // `close_notify` within WRITER_CLOSE, so the peer reads a clean close.
    let (stop, mut stopped) = oneshot::channel::<()>();
    let mut writer_task = tokio::spawn(async move {
        let mut writer = writer;
        loop {
            let line = tokio::select! {
                biased;
                _ = &mut stopped => break,
                line = out_rx.recv() => match line {
                    Some(line) => line,
                    None => break,
                },
            };
            queued.fetch_sub(queued_cost(&line), Ordering::AcqRel);
            let mut batch = line;
            batch.push('\n');
            // Whatever else is already queued goes in the same flush.
            while let Ok(mut more) = out_rx.try_recv() {
                queued.fetch_sub(queued_cost(&more), Ordering::AcqRel);
                more.push('\n');
                batch.push_str(&more);
                if batch.len() > 1024 * 1024 {
                    break;
                }
            }
            if writer.write_all(batch.as_bytes()).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });
    let ping_task = {
        let conn = conn.clone();
        let every = daemon.opts.ping_interval;
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(every);
            ticks.tick().await;
            loop {
                ticks.tick().await;
                conn.out.send(Event::Ping.encode());
            }
        })
    };
    // The node leaving the allow-list closes the connection.
    let guard_task = {
        let (close, key, node) = (close.clone(), peer.key, peer.node.clone());
        tokio::spawn(async move {
            while allowed.changed().await.is_ok() {
                if !admits(&allowed.borrow_and_update(), &key, &node) {
                    log::info!("node {node} connection {id}: no longer allowed; closing");
                    close.notify_one();
                    return;
                }
            }
        })
    };

    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut greeted = false;
    let mut requests = JoinSet::new();
    loop {
        // `read_line` is only ever cancelled here, when the connection ends.
        let read = tokio::select! {
            read = read_line(&mut reader, &mut line, MAX_REQUEST_LINE) => read,
            _ = close.notified() => break,
        };
        if let Err(end) = read {
            if let ReadEnd::Failed(reason) = end {
                log::warn!("connection {id}: {reason}");
            }
            break;
        }
        if line.is_empty() {
            continue;
        }
        let request = match std::str::from_utf8(&line)
            .map_err(|e| e.to_string())
            .and_then(|text| decode_request(text).map_err(|e| e.to_string()))
        {
            Ok(request) => request,
            Err(e) => {
                // No id to answer to; a daemon can only log it.
                log::warn!("connection {id}: undecodable request: {e}");
                continue;
            }
        };
        // `hello` is handled in line so nothing overtakes it.
        if request.m == m::Hello::NAME {
            let outcome = match daemon.hello(&request) {
                Ok((params, result)) => {
                    greeted = true;
                    let client: String = params.client.chars().take(MAX_CLIENT_NAME).collect();
                    log::info!("connection {id}: hello from {client:?}");
                    if let Some(c) = lock(&daemon.conns).get_mut(&id) {
                        c.client = Some(client);
                    }
                    daemon.touch();
                    Ok(result)
                }
                Err(e) => Err(e),
            };
            reply(&conn, &request, outcome);
            continue;
        }
        if !greeted {
            reply(
                &conn,
                &request,
                Err(err(ErrorCode::BadRequest, "send hello first")),
            );
            continue;
        }
        while requests.try_join_next().is_some() {}
        if requests.len() >= MAX_IN_FLIGHT {
            reply(
                &conn,
                &request,
                Err(busy(format!(
                    "{MAX_IN_FLIGHT} requests are already running"
                ))),
            );
            continue;
        }
        let daemon = daemon.clone();
        let conn = conn.clone();
        requests.spawn(async move {
            if let Some(outcome) = daemon.handle(&conn, &request).await {
                reply(&conn, &request, outcome);
            }
        });
    }

    // Whatever is still running for this connection has no one to answer:
    // an `exec.run` among it kills its process group.
    requests.abort_all();
    // Before the sweep: an attach still running parks again (`Conn`).
    conn.closed.store(true, Ordering::SeqCst);
    // A dropped connection detaches, never closes.
    let routed: Vec<(SessionId, Arc<SessState>)> = lock(&daemon.sessions)
        .iter()
        .map(|(id, sess)| (*id, sess.clone()))
        .collect();
    tokio::task::spawn_blocking({
        let daemon = daemon.clone();
        move || {
            for (sid, sess) in routed {
                daemon.park(sid, &sess, Some(id));
            }
        }
    })
    .await
    .ok();
    {
        let mut hooks = lock(&daemon.hooks);
        if hooks.subscriber.as_ref().is_some_and(|(c, _)| *c == id) {
            hooks.subscriber = None;
        }
    }
    lock(&daemon.conns).remove(&id);
    guard_task.abort();
    ping_task.abort();
    let _ = stop.send(());
    if tokio::time::timeout(WRITER_CLOSE, &mut writer_task)
        .await
        .is_err()
    {
        writer_task.abort();
    }
    log::info!("node {} connection {id}: closed", peer.node);
    daemon.touch();
}

fn reply(conn: &Conn, request: &RawRequest, outcome: Outcome) {
    match &outcome {
        Ok(_) => log::debug!("connection {}: {} #{} ok", conn.id, request.m, request.id),
        Err(e) => log::info!(
            "node {} connection {}: {} #{} failed: {}: {}",
            conn.node,
            conn.id,
            request.m,
            request.id,
            e.code,
            e.msg
        ),
    }
    conn.out.send(match outcome {
        Ok(result) => encode_ok(request.id, &result).expect("raw results serialize"),
        Err(e) => encode_err(request.id, &e),
    });
}

// ── the local hook socket ─────────────────────────────────────────────────

/// Serve one connection to the hook socket: `hooks.push` and nothing else,
/// no `hello` (the hook command has ~200 ms in all). The caller checked the
/// peer is this process's uid. The framing is frozen with protocol v1: the
/// `hook` command on PATH is always the newest build, and the running host
/// may be older.
pub async fn serve_hook_conn<S>(daemon: Arc<Daemon>, stream: S)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    while read_line(&mut reader, &mut line, MAX_REQUEST_LINE)
        .await
        .is_ok()
    {
        if line.is_empty() {
            continue;
        }
        let Ok(request) = std::str::from_utf8(&line)
            .map_err(|e| e.to_string())
            .and_then(|text| decode_request(text).map_err(|e| e.to_string()))
        else {
            log::warn!("hook socket: undecodable request");
            continue;
        };
        let answer = if request.m == m::HooksPush::NAME {
            match request.params::<HookPushParams>() {
                Ok(p) => {
                    let seq = daemon.push_hook(p);
                    encode_ok(request.id, &HookPushResult { seq }).expect("serializes")
                }
                Err(e) => encode_err(request.id, &e),
            }
        } else {
            encode_err(
                request.id,
                &err(
                    ErrorCode::BadRequest,
                    format!("the hook socket serves hooks.push only, not {}", request.m),
                ),
            )
        };
        let mut answer = answer.into_bytes();
        answer.push(b'\n');
        if writer.write_all(&answer).await.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use santree_remote_tls::Identity;

    fn options(root: &std::path::Path) -> Options {
        Options {
            version: "0".into(),
            hostname: "h".into(),
            user: "u".into(),
            home: "/h".into(),
            projects_root: root.to_path_buf(),
            hook_bin: "/bin/true".into(),
            workspaces: root.join("none.json"),
            workspace_icons: root.join("icons"),
            ping_interval: Duration::from_secs(15),
            hook_queue_cap: 10,
        }
    }

    /// An allow-list file naming `nodes`, as the controller writes it.
    fn write_allow(path: &std::path::Path, nodes: &[&Identity]) {
        use std::os::unix::fs::PermissionsExt;
        let entries: Vec<String> = nodes
            .iter()
            .map(|n| {
                let key = n.public_key();
                format!(
                    r#"{{"id":"{}","publicKey":"{}"}}"#,
                    crate::allow::node_id_of(&key),
                    santree_remote_tls::key_hex(&key)
                )
            })
            .collect();
        let temp = path.with_extension("tmp");
        std::fs::write(
            &temp,
            format!(r#"{{"schemaVersion":1,"nodes":[{}]}}"#, entries.join(",")),
        )
        .unwrap();
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::rename(&temp, path).unwrap();
    }

    fn node(id: &Identity) -> String {
        crate::allow::node_id_of(&id.public_key())
    }

    fn open(daemon: &Daemon, root: &std::path::Path, node: &str, argv: &[&str]) -> Outcome {
        daemon.pty_open(
            PtyOpenParams {
                cwd: Some(root.to_string_lossy().into_owned()),
                command: argv[0].into(),
                args: argv[1..].iter().map(|a| a.to_string()).collect(),
                cols: 80,
                rows: 24,
                owner: "o".into(),
                label: "t".into(),
                ..Default::default()
            },
            node.into(),
        )
    }

    fn id_of(outcome: Outcome) -> SessionId {
        serde_json::from_str::<SessionInfo>(outcome.unwrap().get())
            .unwrap()
            .id
    }

    fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !f() {
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn exited_unattached_sessions_are_reaped_and_live_ones_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let a = Identity::generate().unwrap();
        let list = dir.path().join("allow.json");
        write_allow(&list, &[&a]);
        let daemon = Daemon::new(options(dir.path()), "b".into(), AllowList::open(list));
        let done = id_of(open(&daemon, dir.path(), &node(&a), &["true"]));
        let running = id_of(open(&daemon, dir.path(), &node(&a), &["sleep", "30"]));
        wait_for("true exits", || {
            daemon
                .mgr
                .sessions()
                .iter()
                .any(|s| s.id == done && !s.alive)
        });
        // Not yet an hour: both stay.
        daemon.reap(REAP_AFTER);
        assert_eq!(daemon.mgr.sessions().len(), 2);
        // Aged out: the exited one goes, the running one stays.
        daemon.reap(Duration::ZERO);
        let left: Vec<SessionId> = daemon.mgr.sessions().iter().map(|s| s.id).collect();
        assert_eq!(left, vec![running]);
        daemon.close_all();
    }

    #[test]
    fn a_node_leaving_loses_only_its_sessions_and_opens_no_more() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (Identity::generate().unwrap(), Identity::generate().unwrap());
        let path = dir.path().join("allow.json");
        write_allow(&path, &[&a, &b]);
        let list = AllowList::open(path.clone());
        let daemon = Daemon::new(options(dir.path()), "b".into(), list.clone());
        let theirs = id_of(open(&daemon, dir.path(), &node(&a), &["sleep", "30"]));
        let mine = id_of(open(&daemon, dir.path(), &node(&b), &["sleep", "30"]));

        write_allow(&path, &[&b]);
        list.reload();
        daemon.close_revoked();
        let left: Vec<SessionId> = daemon.mgr.sessions().iter().map(|s| s.id).collect();
        assert_eq!(left, vec![mine]);
        assert!(daemon.session(theirs).is_none());
        let refused = open(&daemon, dir.path(), &node(&a), &["sleep", "30"]).unwrap_err();
        assert_eq!(refused.code, ErrorCode::Other("access_denied".into()));
        daemon.close_all();
    }

    /// Review S4: the hook queue is bounded by bytes as well as count; the
    /// oldest go first and are counted as dropped.
    #[test]
    fn the_hook_queue_is_bounded_by_bytes() {
        let mut q = HookQueue {
            cap: 100,
            max_bytes: 3 * (64 + 1 + 1000),
            bytes: 0,
            last_seq: 0,
            items: VecDeque::new(),
            dropped: 0,
            subscriber: None,
        };
        for _ in 0..5 {
            q.push("e".into(), Vec::new(), vec![0u8; 1000]);
        }
        let seqs: Vec<u64> = q.items.iter().map(|h| h.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5]);
        assert_eq!(q.dropped, 2);
        assert!(q.bytes <= q.max_bytes);
        // One larger than the whole budget is kept, alone.
        q.push("e".into(), Vec::new(), vec![0u8; 10_000]);
        assert_eq!(q.items.len(), 1);
        assert_eq!(q.dropped, 5);
        q.ack(6);
        assert_eq!((q.items.len(), q.bytes), (0, 0));
    }

    /// Review S5: blocking work is counted per node and held until it
    /// returns, not reset by a reconnect.
    #[test]
    fn blocking_work_is_capped_per_node() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(
            options(dir.path()),
            "b".into(),
            AllowList::open(dir.path().join("allow.json")),
        );
        let held: Vec<_> = (0..MAX_BLOCKING_PER_NODE)
            .map(|_| daemon.permit("a").unwrap())
            .collect();
        assert_eq!(
            daemon.permit("a").unwrap_err().code,
            ErrorCode::Other("busy".into())
        );
        assert!(daemon.permit("b").is_ok(), "another node is not affected");
        drop(held);
        assert!(daemon.permit("a").is_ok());
    }

    /// Review S5: a `pty.write` into a terminal that does not read its
    /// input waits on the session's own input thread, never the blocking
    /// pool; a full queue is `busy`; and a revocation closes the session at
    /// once regardless, which ends the stuck write.
    #[test]
    fn a_terminal_that_does_not_read_cannot_pin_writes_or_the_revocation() {
        let dir = tempfile::tempdir().unwrap();
        let a = Identity::generate().unwrap();
        let path = dir.path().join("allow.json");
        write_allow(&path, &[&a]);
        let list = AllowList::open(path.clone());
        let daemon = Daemon::new(options(dir.path()), "b".into(), list.clone());
        // Raw mode, so the line discipline stops taking input once full.
        let id = id_of(open(
            &daemon,
            dir.path(),
            &node(&a),
            &["sh", "-c", "stty raw -echo; exec sleep 60"],
        ));
        std::thread::sleep(Duration::from_millis(500));

        let mut stuck = daemon.pty_input(id, vec![b'x'; 512 * 1024]).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        assert!(
            matches!(stuck.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
            "the write went in: the terminal was reading"
        );
        let full = daemon
            .pty_input(id, vec![b'y'; PTY_INPUT_QUEUE])
            .unwrap_err();
        assert_eq!(full.code, ErrorCode::Other("busy".into()));

        write_allow(&path, &[]);
        list.reload();
        let started = Instant::now();
        daemon.close_revoked();
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "the revocation waited {:?}",
            started.elapsed()
        );
        assert!(daemon.session(id).is_none());
        let gone = daemon.pty_input(id, b"z".to_vec()).unwrap_err();
        assert_eq!(gone.code, ErrorCode::NotFound);
        // The kernel may keep that write parked after the close (`Input`):
        // it is counted against MAX_INPUT_THREADS, never the pool.
        assert!(daemon.inputs.load(Ordering::Acquire) <= 1);
        let _ = stuck.try_recv();
        daemon.close_all();
    }
    /// An attach that fails on a session this host still holds is `io`, not
    /// `not_found`: the client would forget a session that is still there.
    #[test]
    fn a_failed_attach_to_a_known_session_is_io() {
        let dir = tempfile::tempdir().unwrap();
        let a = Identity::generate().unwrap();
        let list = dir.path().join("allow.json");
        write_allow(&list, &[&a]);
        let daemon = Daemon::new(options(dir.path()), "b".into(), AllowList::open(list));
        let id = id_of(open(&daemon, dir.path(), &node(&a), &["sleep", "30"]));
        let (tx, _rx) = mpsc::unbounded_channel();
        let conn = Conn {
            id: 1,
            node: node(&a),
            out: Out {
                tx,
                conn: 1,
                queued: Default::default(),
                full: Default::default(),
                close: Default::default(),
            },
            closed: AtomicBool::new(false),
        };
        // Gone from the manager, still in the daemon's map.
        daemon.mgr.close(id).unwrap();
        let attach = |id| {
            daemon
                .pty_attach(
                    &conn,
                    7,
                    PtyAttachParams {
                        id,
                        anchor: Anchor::Fresh,
                    },
                )
                .unwrap()
                .unwrap_err()
                .code
        };
        assert_eq!(attach(id), ErrorCode::Io);
        lock(&daemon.sessions).remove(&id);
        assert_eq!(attach(id), ErrorCode::NotFound);
        daemon.close_all();
    }
}
