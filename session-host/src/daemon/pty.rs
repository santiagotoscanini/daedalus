//! PTY sessions: who receives each one's output (the attach gate, parking),
//! its input thread, and open / attach / adopt / reap / revocation.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use santree_pty::{OpenOpts, PtyManager};
use santree_remote_proto::*;
use tokio::sync::{oneshot, Notify};

use super::conn::{Conn, Out};
use super::*;

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

pub(super) struct SessState {
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

impl Daemon {
    /// Queue `data` for session `id`'s input (`Input`).
    pub(super) fn pty_input(
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

    /// `pty.write`: the bytes go through the session's own input thread
    /// (`Input`); the answer waits at most [`PTY_WRITE_TIMEOUT`] for them to
    /// go in.
    pub(super) async fn pty_write(&self, p: PtyWriteParams) -> Outcome {
        let done = self.pty_input(p.id, p.data)?;
        match tokio::time::timeout(PTY_WRITE_TIMEOUT, done).await {
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
        }
    }

    /// Kill every session. Bounded (santree-pty gives up after ~2s).
    pub fn close_all(&self) {
        self.mgr.close_all();
        lock(&self.sessions).clear();
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

    pub(super) fn session(&self, id: SessionId) -> Option<Arc<SessState>> {
        lock(&self.sessions).get(&id).cloned()
    }

    pub(super) fn infos(&self, infos: Vec<santree_pty::SessionInfo>) -> Vec<SessionInfo> {
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

    pub(super) fn info(&self, id: SessionId) -> Option<SessionInfo> {
        let all = self.mgr.sessions();
        self.infos(all).into_iter().find(|info| info.id == id)
    }

    pub(super) fn pty_open(&self, p: PtyOpenParams, node: String) -> Outcome {
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

    pub(super) fn pty_attach(&self, conn: &Conn, req_id: u64, p: PtyAttachParams) -> Reply {
        let Some(sess) = self.session(p.id) else {
            return Reply::Answer(Err(err(
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
            Err(e) => return Reply::Answer(Err(pty_err(self, p.id, format!("{e:#}")))),
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
        Reply::Done
    }

    /// Detach a session into the parked state — only when `only_conn` (if
    /// given) is still its receiver.
    pub(super) fn park(&self, id: SessionId, sess: &Arc<SessState>, only_conn: Option<u64>) {
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

    pub(super) fn pty_adopt(&self, owner: &str) -> Outcome {
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

pub(super) fn pty_err(daemon: &Daemon, id: SessionId, e: impl std::fmt::Display) -> WireError {
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
