//! One admitted connection: its bounded outgoing queue ([`Out`]), the read
//! loop that dispatches its requests, its writer and pings, and its teardown.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use santree_remote_proto::*;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinSet;

use super::pty::SessState;
use super::*;
use crate::allow::{AllowList, AllowSet};
use crate::framing::{read_line, ReadEnd};

/// One connection's outgoing queue, bounded by bytes ([`OUT_QUEUE_BYTES`]).
/// A send that finds it full closes the connection (`close`) instead of
/// waiting.
#[derive(Clone)]
pub(super) struct Out {
    pub(super) tx: mpsc::UnboundedSender<String>,
    pub(super) conn: u64,
    /// Bytes queued and not yet taken by the writer ([`queued_cost`]).
    pub(super) queued: Arc<AtomicUsize>,
    pub(super) full: Arc<AtomicBool>,
    pub(super) close: Arc<Notify>,
}

/// What a queued line counts against [`OUT_QUEUE_BYTES`].
fn queued_cost(line: &str) -> usize {
    line.len() + LINE_OVERHEAD
}

impl Out {
    /// Queue one line; false when it was not (the queue is full, and the
    /// connection is closing, or already gone).
    pub(super) fn send(&self, line: String) -> bool {
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

pub(super) struct Conn {
    pub(super) id: u64,
    pub(super) node: String,
    pub(super) out: Out,
    /// Set before its sessions are parked at teardown: an attach that lands
    /// after that sweep parks the session again instead of routing it to a
    /// dead connection.
    pub(super) closed: AtomicBool,
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
    let (tx, out_rx) = mpsc::unbounded_channel::<String>();
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
    let (stop, stopped) = oneshot::channel::<()>();
    let mut writer_task = tokio::spawn(write_out(writer, out_rx, queued, stopped));
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
            if let Reply::Answer(outcome) = daemon.handle(&conn, &request).await {
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

/// One connection's writer: every queued line, batched into as few flushes
/// as what is already waiting allows, until `stopped` or the queue closes;
/// then TLS `close_notify`.
async fn write_out<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut out_rx: mpsc::UnboundedReceiver<String>,
    queued: Arc<AtomicUsize>,
    mut stopped: oneshot::Receiver<()>,
) {
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
}
