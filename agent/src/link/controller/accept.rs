//! The listener and one connection: pre-auth, admission, the conversation
//! (the module doc of `link::controller`).

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::Value;

use crate::identity::{node_id_of, Identity};
use crate::link::rotation::{ConnResolver, Keys, Served};
use crate::link::tls::{Recv, Tls};
use crate::link::wire::{
    self, name, Command, CommandParams, Hello, Incoming, MAX_HELLO_LINE, PROTO,
};
use crate::link::MAX_LINE;
use crate::rpc::{code, ApiError, Response};

use super::registry::{busy, ip_bucket, Admission, Out, PreauthSlot, Registry};

/// Why a connection the registry closed ended.
const CLOSED_BY_CONTROLLER: &str = "closed by the controller";
/// How long such a connection waits for the machine to close its side.
const CLOSE_LINGER: Duration = Duration::from_secs(1);

/// The listener: accepting until dropped.
pub struct Listener {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub local_addr: SocketAddr,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Accept the machines' links on `addr` for `registry`, presenting
/// `identity` alone, until the returned listener is dropped.
pub fn listen(addr: SocketAddr, identity: &Identity, registry: Arc<Registry>) -> Result<Listener> {
    listen_with(addr, Arc::new(Keys::fixed(identity)?), registry)
}

/// Accept the machines' links on `addr` for `registry`, presenting each the
/// controller key it pins (`keys`, rotation.rs), until the returned
/// listener is dropped (which also closes every connection within a
/// `TICK`).
pub fn listen_with(addr: SocketAddr, keys: Arc<Keys>, registry: Arc<Registry>) -> Result<Listener> {
    let listener =
        TcpListener::bind(addr).with_context(|| format!("binding the link listener on {addr}"))?;
    listener
        .set_nonblocking(true)
        .context("making the link listener non-blocking")?;
    let local_addr = listener.local_addr()?;
    let stop = Arc::new(AtomicBool::new(false));
    let fingerprint = keys.forward().fingerprint();
    let thread = {
        let stop = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("link-listener".into())
            .spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((sock, peer)) => {
                            // The pre-auth cap before a thread: past it, a
                            // socket costs a close, never a thread.
                            let Some(slot) = registry.preauth_slot(ip_bucket(peer.ip())) else {
                                tracing::debug!(%peer, "link: no pre-auth slot for this address; closed");
                                continue;
                            };
                            let (registry, keys, stop) =
                                (Arc::clone(&registry), Arc::clone(&keys), Arc::clone(&stop));
                            let spawned =
                                std::thread::Builder::new().name("link-conn".into()).spawn(
                                    move || {
                                        serve_connection(sock, peer, slot, &registry, &keys, &stop)
                                    },
                                );
                            if let Err(e) = spawned {
                                tracing::warn!(error = %e, "link: no thread for a connection");
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "link: accept failed");
                            std::thread::sleep(Duration::from_millis(500));
                        }
                    }
                }
            })
            .context("spawning the link listener")?
    };
    tracing::info!(address = %local_addr, %fingerprint, "link: listening for machines");
    Ok(Listener {
        stop,
        thread: Some(thread),
        local_addr,
    })
}

fn refuse(tls: &mut Tls, id: Option<u64>, e: ApiError) {
    let _ = tls.send(&serde_json::to_string(&Response::err(id, e)).unwrap_or_default());
    tls.close();
}

/// Everything before admission (module doc): the `hello` request's id and
/// the checked hello, or the refusal already sent.
fn pre_admission(tls: &mut Tls, deadline: Instant) -> Option<(u64, Hello)> {
    tls.set_max_line(MAX_HELLO_LINE);
    let first = loop {
        match tls.recv() {
            Ok(Recv::Line(l)) => break l,
            Ok(Recv::Idle) if Instant::now() < deadline => continue,
            // Silent past the budget, closed, or a line past the limit.
            _ => {
                tls.close();
                return None;
            }
        }
    };
    let (req_id, p) = match Incoming::parse(&first) {
        Ok(Incoming::Request { id, m, p }) if m == name::HELLO => (id, p),
        Ok(Incoming::Request { id, .. }) => {
            refuse(
                tls,
                Some(id),
                ApiError::new(code::BAD_REQUEST, "the first request must be `hello`"),
            );
            return None;
        }
        _ => {
            refuse(
                tls,
                None,
                ApiError::new(
                    code::BAD_REQUEST,
                    "the first line must be a `hello` request",
                ),
            );
            return None;
        }
    };
    if let Some(v) = p
        .get("proto")
        .and_then(Value::as_u64)
        .filter(|v| *v != u64::from(PROTO))
    {
        let e = ApiError {
            supported: Some(PROTO),
            ..ApiError::new(
                code::VERSION,
                format!(
                    "this controller speaks link protocol {PROTO}, not {v}; it is daedalus-agent {}",
                    crate::VERSION
                ),
            )
        };
        refuse(tls, Some(req_id), e);
        return None;
    }
    let hello = serde_json::from_value::<Hello>(p)
        .map_err(|e| e.to_string())
        .and_then(|h| h.check().map(|()| h));
    match hello {
        Ok(h) => Some((req_id, h)),
        Err(e) => {
            refuse(
                tls,
                Some(req_id),
                ApiError::new(code::BAD_REQUEST, format!("hello: {e}")),
            );
            None
        }
    }
}

/// One machine's connection (module doc), holding the pre-auth `slot` the
/// listener took for it until it is admitted.
fn serve_connection(
    sock: TcpStream,
    peer: SocketAddr,
    slot: PreauthSlot,
    registry: &Registry,
    keys: &Arc<Keys>,
    stop: &AtomicBool,
) {
    let bucket = ip_bucket(peer.ip());
    let limits = registry.limits;
    let deadline = Instant::now() + limits.preauth_budget;
    if sock.set_nonblocking(false).is_err() {
        return;
    }
    // The keys as this connection is served them, fixed now: its handshake
    // chooses among them, and what it chose is its key for good
    // (rotation.rs).
    let resolver = Arc::new(ConnResolver::new(keys.snapshot()));
    let config = match crate::link::tls::server_config_resolving(Arc::clone(&resolver) as _) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "link: no TLS config for a connection");
            return;
        }
    };
    let mut tls = match Tls::server(sock, config, limits.preauth_budget) {
        Ok(t) => t,
        Err(e) => {
            tracing::debug!(%peer, error = %e, "link: handshake failed");
            return;
        }
    };
    let Some(key) = tls.peer_key() else {
        return;
    };
    let Some(served) = resolver.served() else {
        return;
    };

    let Some((req_id, hello)) = pre_admission(&mut tls, deadline) else {
        return;
    };
    // Unknown keys count against their address; a decided key never does.
    if !registry.decided_key(&key) && !registry.allow_unknown(bucket) {
        tracing::info!(%peer, node = %node_id_of(&key), "link: too many unknown keys from this address");
        return refuse(
            &mut tls,
            Some(req_id),
            busy("too many unknown keys from this address; try again in a minute"),
        );
    }
    let admission = registry.admit(key, hello, bucket);
    drop(slot);
    let (id, conn_id, rx, queued) = match admission {
        Admission::Refuse(e) => {
            tracing::info!(%peer, node = %node_id_of(&key), reason = %e.msg, "link: refused");
            return refuse(&mut tls, Some(req_id), e);
        }
        Admission::Welcome {
            id,
            conn_id,
            rx,
            mut welcome,
            queued,
        } => {
            tracing::info!(%peer, node = %id, state = welcome.state.as_str(), "link: machine connected");
            welcome.controller.fingerprint = served.fingerprint.clone();
            if tls
                .send(&serde_json::to_string(&Response::ok(req_id, &welcome)).unwrap_or_default())
                .is_err()
            {
                registry.detach(&id, conn_id);
                return;
            }
            (id, conn_id, rx, queued)
        }
    };
    tls.set_max_line(MAX_LINE);
    // Counted while it lives, by the key it was served (rotation.rs).
    let _counted = keys.connection(&served);

    let why = converse(
        &mut tls, registry, &id, conn_id, &rx, queued, keys, &served, stop,
    );
    // Cut by the controller (a revocation, a key decided for another): the
    // machine must read why before the connection goes (`close_gracefully`).
    if why == CLOSED_BY_CONTROLLER {
        tls.close_gracefully(CLOSE_LINGER);
    } else {
        tls.close();
    }
    registry.detach(&id, conn_id);
    tracing::info!(%peer, node = %id, why, "link: machine left");
}

/// The connection after `hello`, until it ends; says why it ended. While a
/// rotation runs that retires the key it was `served`, it is sent the
/// rotation's statement once (rotation.rs).
#[allow(clippy::too_many_arguments)]
fn converse(
    tls: &mut Tls,
    registry: &Registry,
    id: &str,
    conn_id: u64,
    rx: &Receiver<Out>,
    queued: Vec<Command>,
    keys: &Keys,
    served: &Served,
    stop: &AtomicBool,
) -> &'static str {
    for c in queued {
        let rid = registry.next_request.fetch_add(1, Ordering::Relaxed);
        if tls
            .send(&wire::request(
                rid,
                name::COMMAND,
                &CommandParams { command: c },
            ))
            .is_err()
        {
            return "a write failed";
        }
    }
    let limits = registry.limits;
    let opened = Instant::now();
    let mut heard = Instant::now();
    let mut said = Instant::now();
    let mut rotation_sent: Option<u64> = None;
    loop {
        if stop.load(Ordering::Relaxed) {
            return "the controller is stopping";
        }
        loop {
            match rx.try_recv() {
                Ok(Out::Line(l)) => {
                    if tls.send(&l).is_err() {
                        return "a write failed";
                    }
                    said = Instant::now();
                }
                Ok(Out::Close) => return CLOSED_BY_CONTROLLER,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return "replaced",
            }
        }
        // A pending key pushes nothing it could need a long line for: it
        // gets the hello's limit until it is approved.
        let pending = registry.is_pending(id);
        tls.set_max_line(if pending { MAX_HELLO_LINE } else { MAX_LINE });
        if pending && opened.elapsed() > limits.pending_ttl {
            return "pending past its time; it may connect again";
        }
        // A rotation under way reaches a machine under the old key once.
        if let (None, Some(st)) = (
            rotation_sent,
            served
                .statement
                .clone()
                .or_else(|| keys.statement_for(&served.fingerprint)),
        ) {
            let rid = registry.next_request.fetch_add(1, Ordering::Relaxed);
            if tls.send(&wire::request(rid, name::ROTATE, &st)).is_err() {
                return "a write failed";
            }
            tracing::info!(node = id, "link: sent the controller key rotation");
            rotation_sent = Some(rid);
            said = Instant::now();
        }
        if said.elapsed() >= limits.heartbeat {
            if tls.send(wire::HB_LINE).is_err() {
                return "a write failed";
            }
            said = Instant::now();
        }
        match tls.recv() {
            Ok(Recv::Line(line)) => {
                heard = Instant::now();
                match Incoming::parse(&line) {
                    Ok(Incoming::Event { e, p }) => registry.record(id, conn_id, &e, p),
                    Ok(Incoming::Answer {
                        id: Some(req),
                        result,
                    }) => {
                        registry.record(id, conn_id, name::HB, Value::Null);
                        if rotation_sent == Some(req) {
                            match &result {
                                Ok(_) => tracing::info!(
                                    node = id,
                                    "link: the machine re-pinned to the new controller key"
                                ),
                                Err(e) => {
                                    tracing::warn!(node = id, error = %e.msg, "link: the machine refused the key rotation")
                                }
                            }
                        }
                        registry.ack(id, conn_id, req, result.map(|_| ()).map_err(|e| e.msg));
                    }
                    Ok(Incoming::Request { id: rid, m, .. })
                        if m == name::LEAVE && registry.is_approved(id) =>
                    {
                        // Heard and acknowledged, and the machine closes once
                        // it has the answer; or nobody heard it, and the
                        // machine is told so.
                        let line = match registry.left(id) {
                            Ok(()) => Response::ok(rid, &serde_json::json!({})),
                            Err(e) => Response::err(Some(rid), e),
                        };
                        if tls
                            .send(&serde_json::to_string(&line).unwrap_or_default())
                            .is_err()
                        {
                            return "a write failed";
                        }
                        said = Instant::now();
                    }
                    Ok(Incoming::Request { id: rid, m, p }) if m == name::POLICY_REQUEST => {
                        // The machine's own settings, asked for: only an
                        // approved machine's, and only what `PolicyRequest`
                        // names (registry.rs `policy_request`).
                        registry.record(id, conn_id, name::HB, Value::Null);
                        let answer = if !registry.is_approved(id) {
                            Err(ApiError::new(
                                code::UNAVAILABLE,
                                "this machine is not approved",
                            ))
                        } else {
                            serde_json::from_value::<wire::PolicyRequest>(p)
                                .map_err(|e| {
                                    ApiError::new(code::BAD_REQUEST, format!("policy_request: {e}"))
                                })
                                .and_then(|req| registry.policy_request(id, &req))
                        };
                        let line = match answer {
                            Ok(()) => Response::ok(rid, &wire::Accepted { accepted: true }),
                            Err(e) => Response::err(Some(rid), e),
                        };
                        if tls
                            .send(&serde_json::to_string(&line).unwrap_or_default())
                            .is_err()
                        {
                            return "a write failed";
                        }
                        said = Instant::now();
                    }
                    Ok(Incoming::Request { id: rid, m, .. }) => {
                        registry.record(id, conn_id, name::HB, Value::Null);
                        let e = ApiError::new(
                            code::UNKNOWN_METHOD,
                            format!(
                                "no method `{}` on the controller",
                                m.chars().take(64).collect::<String>()
                            ),
                        );
                        if tls
                            .send(
                                &serde_json::to_string(&Response::err(Some(rid), e))
                                    .unwrap_or_default(),
                            )
                            .is_err()
                        {
                            return "a write failed";
                        }
                    }
                    Ok(Incoming::Answer { id: None, .. }) => {}
                    Err(e) => {
                        tracing::debug!(node = id, error = %e, "link: a line that is not a message")
                    }
                }
            }
            Ok(Recv::Idle) => {}
            Ok(Recv::Closed) => return "closed by the machine",
            Err(_) => return "the connection failed",
        }
        if heard.elapsed() > limits.dead_after {
            return "silent past the dead line";
        }
    }
}
