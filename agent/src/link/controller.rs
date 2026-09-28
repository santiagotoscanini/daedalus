//! The controller's side of the link: the listener the machines dial, one
//! thread per connection, and the `Registry` — what the controller knows
//! about every machine, which the local API reads (api/, `nodes.*`) and
//! `/nodes/metrics` renders.
//!
//! **Observed and desired.** The registry holds OBSERVED state in memory
//! only — per machine the last hello, status document, telemetry, Claude
//! report and providers, when it connected and when it was last heard —
//! and nothing on disk: after a restart the machines reconnect and fill
//! it again. DESIRED state is the app's: `nodes.set_desired` hands over
//! the complete set of decided keys with their standing (approved or
//! revoked) and policies, and the registry applies the difference to the
//! connections open now (`set_desired`). A key outside that set is
//! PENDING while connected and UNKNOWN once it leaves; of an unknown key
//! only its id, fingerprint, hostname and when it was last seen are kept.
//! A decision is for one KEY: an id the app decided for another key (two
//! keys sharing sixteen hex characters) is neither approved nor revoked
//! for this one, and is refused.
//!
//! **A connection** (`serve_connection`), before admission: a PRE-AUTH
//! slot, `PREAUTH_BUDGET` for the TLS handshake (the machine's key proved,
//! tls.rs) and the first line — `hello`, at most `MAX_HELLO_LINE` bytes, of
//! protocol `PROTO` (another gets a `version` error naming this one), with
//! the node id of the key the handshake proved and fields within
//! `Hello::check`'s bounds. Then the key's standing: revoked is told so and
//! closed; unknown is counted against its address's `UNKNOWN_PER_MINUTE`
//! and admitted PENDING — restricted: listed and announced to the app
//! (`nodes.pending`), heartbeats flow, nothing it pushes is kept — within
//! `MAX_PENDING` and `PENDING_PER_IP`; approved gets its policy in the
//! answer and any commands queued for it. A second connection with the same
//! key replaces the first. From then on the thread interleaves the
//! machine's lines with its outgoing queue every `TICK`, sends a heartbeat
//! every `HEARTBEAT`, gives up after `DEAD_AFTER` of silence, and closes a
//! connection pending past `PENDING_TTL`.
//!
//! **Why the pools.** Anyone on the LAN can open a TCP connection, so what
//! a connection can hold before it has proved an approved key is bounded
//! apart from what admitted machines hold: `MAX_PREAUTH` pre-auth slots in
//! all and `PREAUTH_PER_IP` per address (an IPv6 /64 is one address), each
//! released at admission or after `PREAUTH_BUDGET`; `MAX_CONNECTIONS`
//! admitted. The unknown-key rate is judged after the handshake, from the
//! key, so an approved machine is never refused for sharing an address; and
//! when the admitted pool is full an approved key takes the place of the
//! oldest pending one. The addresses counted are at most
//! `UNKNOWN_ADDRESSES` (the least recently seen go), and at most
//! `MAX_FORGOTTEN` keys that are neither decided nor connected are
//! remembered.
//!
//! **Commands** (`command`): delivered at once to a connected, approved
//! machine and acknowledged by it within `ACK_TIMEOUT`; queued, one of each
//! kind, for an approved machine that is not connected, and delivered when
//! it next connects.
//!
//! **Session verbs** (`claude_session`): one verb on one of a machine's
//! Claude sessions, delivered only to a connected, approved machine that
//! offers `claude.sessions` and acknowledged within `ACK_TIMEOUT` — never
//! queued, since a resume that fires whenever the machine next connects is
//! one nobody asked for then. The outcome rides the machine's next
//! `claude_roster` push, under the request id minted here.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::Value;

use super::tls::{Recv, Tls};
use super::wire::{
    self, name, ClaudeSessionParams, Command, CommandParams, ControllerId, Hello, Incoming,
    NodeState, StateEvent, Welcome, MAX_HELLO_LINE, PROTO,
};
use super::{
    DEAD_AFTER, HEARTBEAT, MAX_CONNECTIONS, MAX_LINE, MAX_PENDING, MAX_PREAUTH, PENDING_PER_IP,
    PENDING_TTL, PREAUTH_BUDGET, PREAUTH_PER_IP, UNKNOWN_ADDRESSES, UNKNOWN_PER_MINUTE,
    WRITE_TIMEOUT,
};
use crate::api::wire::{
    code, event, ApiError, ClaudeSessionSent, CommandOk, DesiredState, NodeChanged, NodeClaude,
    NodeClaudeRoster, NodeDetail, NodePending, NodeProviders, NodeSummary, NodeTelemetry,
    ProviderModelSent, Response, SetDesiredOk,
};
use crate::api::Events;
use crate::claude::{Report, Roster, SessionAction};
use crate::identity::{fingerprint, node_id_of, Identity};
use crate::link::wire::Policy;
use crate::providers::ProviderReport;
use crate::state::now_rfc3339;
use crate::telemetry::Telemetry;

/// How long `command` waits for the machine's acknowledgement.
pub const ACK_TIMEOUT: Duration = Duration::from_secs(5);
/// Keys neither decided nor connected that are still remembered.
pub const MAX_FORGOTTEN: usize = 256;

/// The limits a registry and its connections keep; `Default` is the
/// module's constants, the tests shrink them.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_connections: usize,
    pub max_preauth: usize,
    pub preauth_per_ip: usize,
    pub preauth_budget: Duration,
    pub max_pending: usize,
    pub pending_per_ip: usize,
    pub pending_ttl: Duration,
    pub unknown_per_minute: usize,
    pub heartbeat: Duration,
    pub dead_after: Duration,
    pub ack_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections: MAX_CONNECTIONS,
            max_preauth: MAX_PREAUTH,
            preauth_per_ip: PREAUTH_PER_IP,
            preauth_budget: PREAUTH_BUDGET,
            max_pending: MAX_PENDING,
            pending_per_ip: PENDING_PER_IP,
            pending_ttl: PENDING_TTL,
            unknown_per_minute: UNKNOWN_PER_MINUTE,
            heartbeat: HEARTBEAT,
            dead_after: DEAD_AFTER,
            ack_timeout: ACK_TIMEOUT,
        }
    }
}

/// The address a limit counts: an IPv4 address as it is (an IPv4-mapped
/// IPv6 one as its IPv4), an IPv6 address by its /64 — one host has a whole
/// /64 to pick from.
pub fn ip_bucket(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => IpAddr::V4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

/// What a connection's thread is asked to do.
enum Out {
    Line(String),
    Close,
}

/// One open connection, as the registry reaches it.
struct Conn {
    id: u64,
    tx: Sender<Out>,
    since: String,
    opened: Instant,
    /// The address it came from, as the limits count it (`ip_bucket`).
    bucket: IpAddr,
    /// Commands sent and not yet acknowledged, by request id.
    acks: HashMap<u64, SyncSender<Result<(), String>>>,
}

/// A machine, as observed.
struct Entry {
    public_key: [u8; 32],
    /// From its last `hello`, kept when the rest of an unknown key's hello
    /// is dropped.
    hostname: Option<String>,
    hello: Option<Hello>,
    status: Option<(Value, String)>,
    telemetry: Option<(Telemetry, String)>,
    claude: Option<(Option<Report>, String)>,
    roster: Option<(Option<Roster>, String)>,
    providers: Option<(Vec<ProviderReport>, String)>,
    conn: Option<Conn>,
    last_seen: Option<String>,
    last_seen_at: Option<Instant>,
}

impl Entry {
    fn new(public_key: [u8; 32]) -> Self {
        Self {
            public_key,
            hostname: None,
            hello: None,
            status: None,
            telemetry: None,
            claude: None,
            roster: None,
            providers: None,
            conn: None,
            last_seen: None,
            last_seen_at: None,
        }
    }

    fn touch(&mut self) {
        self.last_seen = Some(now_rfc3339());
        self.last_seen_at = Some(Instant::now());
    }

    fn send(&self, line: String) {
        if let Some(c) = &self.conn {
            let _ = c.tx.send(Out::Line(line));
        }
    }

    fn close(&self) {
        if let Some(c) = &self.conn {
            let _ = c.tx.send(Out::Close);
        }
    }

    /// An unknown key that left: its id (the map's key), fingerprint (from
    /// `public_key`), hostname and last-seen stay; nothing else.
    fn forget_details(&mut self) {
        self.hello = None;
        self.status = None;
        self.telemetry = None;
        self.claude = None;
        self.roster = None;
        self.providers = None;
    }
}

/// A machine, as the app decided.
#[derive(Clone, Debug, PartialEq)]
struct Desired {
    public_key: [u8; 32],
    state: DesiredState,
    policy: Policy,
    /// What the pages call the machine; `/nodes/metrics` labels it `machine`.
    name: Option<String>,
    /// The provider kinds the app offers to the gateway; `/nodes/metrics`
    /// labels their `provider_up` `offered="1"`.
    offered: Vec<String>,
}

/// One entry of the app's set, checked (api/mod.rs parses and validates).
#[derive(Clone, Debug, PartialEq)]
pub struct DesiredEntry {
    pub id: String,
    pub public_key: [u8; 32],
    pub state: DesiredState,
    pub policy: Policy,
    pub name: Option<String>,
    pub offered: Vec<String>,
}

#[derive(Default)]
struct Reg {
    nodes: HashMap<String, Entry>,
    desired: HashMap<String, Desired>,
    queued: HashMap<String, Vec<Command>>,
    /// Unknown keys presented per address, within the last minute.
    unknown_by_ip: HashMap<IpAddr, VecDeque<Instant>>,
}

impl Reg {
    /// The app's decision for `id` — if it was made for the key this entry
    /// holds (or there is no entry): a decision is for a key, not an id.
    fn decided(&self, id: &str) -> Option<&Desired> {
        let d = self.desired.get(id)?;
        match self.nodes.get(id) {
            Some(e) if e.public_key != d.public_key => None,
            _ => Some(d),
        }
    }

    fn state_of(&self, id: &str) -> NodeState {
        match self.decided(id).map(|d| d.state) {
            Some(DesiredState::Approved) => NodeState::Approved,
            Some(DesiredState::Revoked) => NodeState::Revoked,
            None if self.nodes.get(id).is_some_and(|e| e.conn.is_some()) => NodeState::Pending,
            None => NodeState::Unknown,
        }
    }

    /// Pending connections, oldest first: (id, opened, address).
    fn pending(&self) -> Vec<(String, Instant, IpAddr)> {
        let mut v: Vec<(String, Instant, IpAddr)> = self
            .nodes
            .iter()
            .filter(|(id, _)| self.state_of(id) == NodeState::Pending)
            .filter_map(|(id, e)| e.conn.as_ref().map(|c| (id.clone(), c.opened, c.bucket)))
            .collect();
        v.sort_by_key(|(_, at, _)| *at);
        v
    }

    fn connected(&self) -> usize {
        self.nodes.values().filter(|e| e.conn.is_some()).count()
    }

    fn summary(&self, id: &str) -> NodeSummary {
        let e = self.nodes.get(id);
        let key = e
            .map(|e| e.public_key)
            .or_else(|| self.desired.get(id).map(|d| d.public_key))
            .unwrap_or([0; 32]);
        let h = e.and_then(|e| e.hello.as_ref());
        NodeSummary {
            id: id.to_string(),
            fingerprint: fingerprint(&key),
            state: self.state_of(id),
            connected: e.is_some_and(|e| e.conn.is_some()),
            since: e.and_then(|e| e.conn.as_ref()).map(|c| c.since.clone()),
            last_seen: e.and_then(|e| e.last_seen.clone()),
            hostname: e.and_then(|e| e.hostname.clone()),
            os: h.map(|h| h.os.clone()),
            arch: h.map(|h| h.arch.clone()),
            agent_version: h.map(|h| h.agent_version.clone()),
            lan_ip: h.and_then(|h| h.lan_ip.clone()),
            mac: h.and_then(|h| h.mac.clone()),
            claude: e
                .and_then(|e| e.claude.as_ref())
                .and_then(|(r, _)| r.as_ref())
                .map(Report::summary),
        }
    }

    /// Forget the oldest keys that are neither decided nor connected, past
    /// `MAX_FORGOTTEN`.
    fn prune(&mut self) {
        let mut idle: Vec<(String, Option<Instant>)> = self
            .nodes
            .iter()
            .filter(|(id, e)| e.conn.is_none() && !self.desired.contains_key(*id))
            .map(|(id, e)| (id.clone(), e.last_seen_at))
            .collect();
        if idle.len() <= MAX_FORGOTTEN {
            return;
        }
        idle.sort_by_key(|(_, at)| *at);
        for (id, _) in idle.iter().take(idle.len() - MAX_FORGOTTEN) {
            self.nodes.remove(id);
        }
    }
}

/// What `admit` decided about a new connection.
enum Admission {
    Welcome {
        id: String,
        conn_id: u64,
        rx: Receiver<Out>,
        welcome: Welcome,
        queued: Vec<Command>,
    },
    Refuse(ApiError),
}

/// Holds one pre-auth slot (in all and for its address) until dropped.
struct PreauthSlot<'a> {
    registry: &'a Registry,
    bucket: IpAddr,
}

impl Drop for PreauthSlot<'_> {
    fn drop(&mut self) {
        self.registry.preauth_open.fetch_sub(1, Ordering::AcqRel);
        let mut per = self
            .registry
            .preauth
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(n) = per.get_mut(&self.bucket) {
            *n -= 1;
            if *n == 0 {
                per.remove(&self.bucket);
            }
        }
    }
}

fn busy(msg: impl Into<String>) -> ApiError {
    ApiError::new(code::BUSY, msg)
}

/// What the controller knows about the machines (module doc).
pub struct Registry {
    me: ControllerId,
    limits: Limits,
    inner: Mutex<Reg>,
    events: Arc<Events>,
    next_conn: AtomicU64,
    next_request: AtomicU64,
    /// Pre-auth connections, in all and per address.
    preauth_open: AtomicUsize,
    preauth: Mutex<HashMap<IpAddr, usize>>,
}

impl Registry {
    pub fn new(identity: &Identity, events: Arc<Events>, limits: Limits) -> Self {
        Self {
            me: ControllerId {
                version: crate::VERSION.into(),
                hostname: crate::facts::hostname(),
                fingerprint: identity.fingerprint(),
            },
            limits,
            inner: Mutex::new(Reg::default()),
            events,
            next_conn: AtomicU64::new(1),
            next_request: AtomicU64::new(1),
            preauth_open: AtomicUsize::new(0),
            preauth: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Reg> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn changed(&self, id: &str, state: NodeState, connected: bool) {
        self.events.publish(
            event::NODES_CHANGED,
            &NodeChanged {
                id: id.to_string(),
                state,
                connected,
            },
        );
    }

    /// A pre-auth slot for a connection from `bucket`, or None when the
    /// pool, or this address's share of it, is full.
    fn preauth_slot(&self, bucket: IpAddr) -> Option<PreauthSlot<'_>> {
        let mut per = self.preauth.lock().unwrap_or_else(|p| p.into_inner());
        let mine = per.get(&bucket).copied().unwrap_or(0);
        if mine >= self.limits.preauth_per_ip
            || self.preauth_open.load(Ordering::Acquire) >= self.limits.max_preauth
        {
            return None;
        }
        per.insert(bucket, mine + 1);
        self.preauth_open.fetch_add(1, Ordering::AcqRel);
        Some(PreauthSlot {
            registry: self,
            bucket,
        })
    }

    /// Whether `key` is one the app decided (approved or revoked): such a
    /// key is never counted against its address.
    fn decided_key(&self, key: &[u8; 32]) -> bool {
        self.lock()
            .desired
            .get(&node_id_of(key))
            .is_some_and(|d| d.public_key == *key)
    }

    /// Count an unknown key from `bucket`; false when the address already
    /// presented `unknown_per_minute` within the last minute. The table
    /// holds at most `UNKNOWN_ADDRESSES` addresses, the least recently seen
    /// going first.
    fn allow_unknown(&self, bucket: IpAddr) -> bool {
        let mut reg = self.lock();
        let window = Duration::from_secs(60);
        let table = &mut reg.unknown_by_ip;
        if !table.contains_key(&bucket) && table.len() >= UNKNOWN_ADDRESSES {
            let oldest = table
                .iter()
                .min_by_key(|(_, q)| q.back().copied())
                .map(|(ip, _)| *ip);
            if let Some(ip) = oldest {
                table.remove(&ip);
            }
        }
        let q = table.entry(bucket).or_default();
        while q.front().is_some_and(|t| t.elapsed() > window) {
            q.pop_front();
        }
        if q.len() >= self.limits.unknown_per_minute {
            return false;
        }
        q.push_back(Instant::now());
        true
    }

    fn admit(&self, key: [u8; 32], hello: Hello, bucket: IpAddr) -> Admission {
        let id = node_id_of(&key);
        if hello.node_id != id {
            return Admission::Refuse(ApiError::new(
                code::BAD_REQUEST,
                format!(
                    "hello names node {:?}, but the key this connection proved is node {id}",
                    hello.node_id
                ),
            ));
        }
        let mut reg = self.lock();
        let mut evict: Option<String> = None;
        let already = reg.nodes.get(&id).is_some_and(|e| e.conn.is_some());
        let full = !already && reg.connected() >= self.limits.max_connections;
        let state = match reg.desired.get(&id) {
            Some(d) if d.public_key != key => {
                return Admission::Refuse(ApiError::new(
                    code::FORBIDDEN,
                    format!("node id {id} is decided for another key; this key is not it"),
                ))
            }
            Some(d) if d.state == DesiredState::Revoked => {
                return Admission::Refuse(ApiError::new(
                    code::FORBIDDEN,
                    "revoked: the box has turned this machine's key away",
                ))
            }
            Some(_) => {
                if full {
                    // An approved key takes the oldest pending one's place.
                    match reg.pending().into_iter().next() {
                        Some((pid, _, _)) => evict = Some(pid),
                        None => {
                            return Admission::Refuse(busy(format!(
                                "{} machines are connected; try again later",
                                self.limits.max_connections
                            )))
                        }
                    }
                }
                NodeState::Approved
            }
            None => {
                let pending = reg.pending();
                if !already {
                    if full {
                        return Admission::Refuse(busy(format!(
                            "{} machines are connected; try again later",
                            self.limits.max_connections
                        )));
                    }
                    if pending.len() >= self.limits.max_pending {
                        return Admission::Refuse(busy(format!(
                            "{} machines already wait for approval; try again later",
                            self.limits.max_pending
                        )));
                    }
                    let here = pending.iter().filter(|(_, _, b)| *b == bucket).count();
                    if here >= self.limits.pending_per_ip {
                        return Admission::Refuse(busy(format!(
                            "{} machines from this address already wait for approval",
                            self.limits.pending_per_ip
                        )));
                    }
                }
                NodeState::Pending
            }
        };
        if let Some(pid) = &evict {
            if let Some(e) = reg.nodes.get(pid) {
                tracing::info!(node = %pid, "link: a pending machine makes room for an approved one");
                e.close();
            }
        }
        let policy = reg
            .desired
            .get(&id)
            .filter(|d| d.state == DesiredState::Approved)
            .map(|d| d.policy.clone());
        let queued = if state == NodeState::Approved {
            reg.queued.remove(&id).unwrap_or_default()
        } else {
            Vec::new()
        };
        let conn_id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        let hostname = hello.hostname.clone();
        let entry = reg
            .nodes
            .entry(id.clone())
            .or_insert_with(|| Entry::new(key));
        if let Some(old) = entry.conn.take() {
            // The same machine again (a network blip, a restart): the new
            // connection wins.
            let _ = old.tx.send(Out::Close);
        }
        entry.public_key = key;
        entry.hostname = Some(hostname.clone());
        entry.hello = Some(hello);
        entry.conn = Some(Conn {
            id: conn_id,
            tx,
            since: now_rfc3339(),
            opened: Instant::now(),
            bucket,
            acks: HashMap::new(),
        });
        entry.touch();
        drop(reg);
        self.changed(&id, state, true);
        if state == NodeState::Pending {
            self.events.publish(
                event::NODES_PENDING,
                &NodePending {
                    id: id.clone(),
                    fingerprint: fingerprint(&key),
                    hostname,
                },
            );
        }
        Admission::Welcome {
            welcome: Welcome {
                proto: PROTO,
                node_id: id.clone(),
                state,
                controller: self.me.clone(),
                policy,
            },
            id,
            conn_id,
            rx,
            queued,
        }
    }

    /// Whether machine `id` is pending (for the connection's TTL).
    fn is_pending(&self, id: &str) -> bool {
        self.lock().state_of(id) == NodeState::Pending
    }
    /// A line from connection `conn_id` of machine `id`: it is alive, and
    /// what it pushed is kept — if it is approved.
    fn record(&self, id: &str, conn_id: u64, e: &str, p: Value) {
        let mut reg = self.lock();
        let approved = reg.state_of(id) == NodeState::Approved;
        let Some(entry) = reg.nodes.get_mut(id) else {
            return;
        };
        if entry.conn.as_ref().map(|c| c.id) != Some(conn_id) {
            return;
        }
        entry.touch();
        if !approved {
            return;
        }
        let at = now_rfc3339();
        let bad = |what: &str, err: serde_json::Error| {
            tracing::warn!(node = id, error = %err, "link: a {what} that does not parse; dropped");
        };
        match e {
            name::STATUS if p.is_object() => entry.status = Some((p, at)),
            name::TELEMETRY => match serde_json::from_value::<Telemetry>(p) {
                Ok(t) => entry.telemetry = Some((t, at)),
                Err(err) => bad("telemetry document", err),
            },
            name::CLAUDE => match serde_json::from_value::<Option<Report>>(p) {
                Ok(r) => entry.claude = Some((r, at)),
                Err(err) => bad("Claude report", err),
            },
            name::CLAUDE_ROSTER => match serde_json::from_value::<Option<Roster>>(p) {
                Ok(r) => entry.roster = Some((r, at)),
                Err(err) => bad("Claude roster", err),
            },
            name::PROVIDERS => match serde_json::from_value::<Vec<ProviderReport>>(p) {
                Ok(v) => match crate::providers::check(&v) {
                    Ok(()) => entry.providers = Some((v, at)),
                    Err(why) => {
                        tracing::warn!(
                            node = id,
                            why,
                            "link: a providers document refused; dropped"
                        );
                    }
                },
                Err(err) => bad("providers document", err),
            },
            _ => {}
        }
    }

    /// The machine answered request `req` on connection `conn_id`.
    fn ack(&self, id: &str, conn_id: u64, req: u64, result: Result<(), String>) {
        let mut reg = self.lock();
        let Some(conn) = reg
            .nodes
            .get_mut(id)
            .and_then(|e| e.conn.as_mut())
            .filter(|c| c.id == conn_id)
        else {
            return;
        };
        if let Some(tx) = conn.acks.remove(&req) {
            let _ = tx.try_send(result);
        }
    }

    /// Connection `conn_id` of machine `id` ended.
    fn detach(&self, id: &str, conn_id: u64) {
        let mut reg = self.lock();
        let Some(entry) = reg.nodes.get_mut(id) else {
            return;
        };
        if entry.conn.as_ref().map(|c| c.id) != Some(conn_id) {
            // Replaced by a newer connection, which stays.
            return;
        }
        entry.conn = None;
        entry.touch();
        let state = reg.state_of(id);
        if matches!(state, NodeState::Unknown) {
            if let Some(e) = reg.nodes.get_mut(id) {
                e.forget_details();
            }
        }
        reg.prune();
        drop(reg);
        self.changed(id, state, false);
    }

    /// The app's complete set of decided keys (module doc). The caller
    /// has checked each entry (ids are their keys' node ids, no id twice).
    pub fn set_desired(&self, set: Vec<DesiredEntry>) -> SetDesiredOk {
        let mut reg = self.lock();
        let before: HashMap<String, NodeState> = reg
            .nodes
            .keys()
            .chain(reg.desired.keys())
            .map(|id| (id.clone(), reg.state_of(id)))
            .collect();
        let old = std::mem::take(&mut reg.desired);
        reg.desired = set
            .into_iter()
            .map(|d| {
                (
                    d.id,
                    Desired {
                        public_key: d.public_key,
                        state: d.state,
                        policy: d.policy,
                        name: d.name,
                        offered: d.offered,
                    },
                )
            })
            .collect();
        let mut ok = SetDesiredOk {
            nodes: reg.desired.len(),
            ..Default::default()
        };
        let mut changes = Vec::new();
        let mut ids: Vec<String> = before.keys().cloned().collect();
        ids.extend(
            reg.desired
                .keys()
                .filter(|k| !before.contains_key(*k))
                .cloned(),
        );
        ids.sort();
        for id in ids {
            let was = before.get(&id).copied().unwrap_or(NodeState::Unknown);
            let now = reg.state_of(&id);
            let policy = reg.desired.get(&id).map(|d| d.policy.clone());
            let connected = reg.nodes.get(&id).is_some_and(|e| e.conn.is_some());
            if now != NodeState::Approved {
                reg.queued.remove(&id);
            }
            // Connected with a key the app did not decide for this id: it is
            // not the machine the app means, and goes.
            let foreign = reg.nodes.get(&id).is_some_and(|e| {
                reg.desired
                    .get(&id)
                    .is_some_and(|d| d.public_key != e.public_key)
            });
            if connected && foreign {
                if let Some(e) = reg.nodes.get(&id) {
                    e.close();
                }
                continue;
            }
            if connected {
                let queued = if now == NodeState::Approved && was != NodeState::Approved {
                    reg.queued.remove(&id).unwrap_or_default()
                } else {
                    Vec::new()
                };
                let request_ids: Vec<u64> = queued
                    .iter()
                    .map(|_| self.next_request.fetch_add(1, Ordering::Relaxed))
                    .collect();
                let entry = reg.nodes.get(&id).expect("connected");
                match (was, now) {
                    (w, NodeState::Approved) if w != NodeState::Approved => {
                        entry.send(wire::event(name::STATE, &StateEvent { state: now }));
                        entry.send(wire::event(name::POLICY, &policy));
                        for (c, rid) in queued.iter().zip(request_ids) {
                            entry.send(wire::request(
                                rid,
                                name::COMMAND,
                                &CommandParams { command: *c },
                            ));
                        }
                        ok.approved.push(id.clone());
                    }
                    (NodeState::Approved, NodeState::Approved) => {
                        let old_policy = old.get(&id).map(|d| &d.policy);
                        if old_policy != policy.as_ref() {
                            entry.send(wire::event(name::POLICY, &policy));
                            ok.policy.push(id.clone());
                        }
                    }
                    (_, NodeState::Revoked) => {
                        entry.send(wire::event(name::STATE, &StateEvent { state: now }));
                        if let Some(c) = &entry.conn {
                            let _ = c.tx.send(Out::Close);
                        }
                        ok.revoked.push(id.clone());
                    }
                    (NodeState::Approved, NodeState::Pending) => {
                        entry.send(wire::event(name::STATE, &StateEvent { state: now }));
                        ok.pending.push(id.clone());
                    }
                    _ => {}
                }
            }
            if was != now {
                changes.push((id, now, connected));
            }
        }
        reg.prune();
        drop(reg);
        for (id, state, connected) in changes {
            self.changed(&id, state, connected);
        }
        ok
    }

    /// Deliver `command` to machine `id` (module doc).
    pub fn command(&self, id: &str, command: Command) -> Result<CommandOk, ApiError> {
        let mut reg = self.lock();
        match reg.state_of(id) {
            NodeState::Approved => {}
            NodeState::Unknown if !reg.desired.contains_key(id) && !reg.nodes.contains_key(id) => {
                return Err(ApiError::new(code::NOT_FOUND, format!("no machine {id}")))
            }
            other => {
                return Err(ApiError::new(
                    code::UNAVAILABLE,
                    format!("machine {id} is {}, not approved", other.as_str()),
                ))
            }
        }
        let req = self.next_request.fetch_add(1, Ordering::Relaxed);
        let waiting = match reg.nodes.get_mut(id).and_then(|e| e.conn.as_mut()) {
            Some(conn) => {
                let (tx, rx) = mpsc::sync_channel(1);
                conn.acks.insert(req, tx);
                let line = wire::request(req, name::COMMAND, &CommandParams { command });
                let _ = conn.tx.send(Out::Line(line));
                Some(rx)
            }
            None => None,
        };
        let Some(rx) = waiting else {
            let q = reg.queued.entry(id.to_string()).or_default();
            if !q.contains(&command) {
                q.push(command);
            }
            return Ok(CommandOk {
                delivered: false,
                queued: true,
            });
        };
        drop(reg);
        match rx.recv_timeout(self.limits.ack_timeout) {
            Ok(Ok(())) => Ok(CommandOk {
                delivered: true,
                queued: false,
            }),
            Ok(Err(msg)) => Err(ApiError::new(
                code::UNAVAILABLE,
                format!("machine {id} refused it: {msg}"),
            )),
            // The connection ended before an answer: keep it for the next.
            Err(RecvTimeoutError::Disconnected) => {
                let mut reg = self.lock();
                let q = reg.queued.entry(id.to_string()).or_default();
                if !q.contains(&command) {
                    q.push(command);
                }
                Ok(CommandOk {
                    delivered: false,
                    queued: true,
                })
            }
            Err(RecvTimeoutError::Timeout) => {
                let mut reg = self.lock();
                if let Some(c) = reg.nodes.get_mut(id).and_then(|e| e.conn.as_mut()) {
                    c.acks.remove(&req);
                }
                Err(ApiError::new(
                    code::UNAVAILABLE,
                    format!(
                        "machine {id} did not acknowledge within {} s",
                        self.limits.ack_timeout.as_secs()
                    ),
                ))
            }
        }
    }

    /// Every machine known: decided by the app, connected, or seen.
    pub fn list(&self) -> Vec<NodeSummary> {
        let reg = self.lock();
        let mut ids: Vec<&String> = reg.nodes.keys().collect();
        ids.extend(reg.desired.keys().filter(|k| !reg.nodes.contains_key(*k)));
        ids.sort();
        ids.into_iter().map(|id| reg.summary(id)).collect()
    }

    fn known(reg: &Reg, id: &str) -> Result<(), ApiError> {
        if reg.nodes.contains_key(id) || reg.desired.contains_key(id) {
            Ok(())
        } else {
            Err(ApiError::new(code::NOT_FOUND, format!("no machine {id}")))
        }
    }

    pub fn get(&self, id: &str) -> Result<NodeDetail, ApiError> {
        let reg = self.lock();
        Self::known(&reg, id)?;
        let node = reg.summary(id);
        let e = reg.nodes.get(id);
        let key = e
            .map(|e| e.public_key)
            .or_else(|| reg.desired.get(id).map(|d| d.public_key))
            .unwrap_or([0; 32]);
        Ok(NodeDetail {
            node,
            public_key: hex::encode(key),
            hello: e.and_then(|e| e.hello.clone()),
            status: e.and_then(|e| e.status.as_ref()).map(|(v, _)| v.clone()),
            status_at: e.and_then(|e| e.status.as_ref()).map(|(_, at)| at.clone()),
            telemetry: e
                .and_then(|e| e.telemetry.as_ref())
                .map(|(t, _)| t.public()),
            telemetry_at: e
                .and_then(|e| e.telemetry.as_ref())
                .map(|(_, at)| at.clone()),
            providers: e.and_then(|e| e.providers.as_ref()).map(|(p, _)| p.clone()),
            providers_at: e
                .and_then(|e| e.providers.as_ref())
                .map(|(_, at)| at.clone()),
        })
    }

    /// The machine's providers as it last pushed them.
    pub fn providers(&self, id: &str) -> Result<NodeProviders, ApiError> {
        let reg = self.lock();
        Self::known(&reg, id)?;
        let e = reg.nodes.get(id);
        let p = e.and_then(|e| e.providers.clone());
        Ok(NodeProviders {
            id: id.to_string(),
            connected: e.is_some_and(|e| e.conn.is_some()),
            received_at: p.as_ref().map(|(_, at)| at.clone()),
            providers: p.map(|(p, _)| p),
        })
    }

    pub fn telemetry(&self, id: &str) -> Result<NodeTelemetry, ApiError> {
        let reg = self.lock();
        Self::known(&reg, id)?;
        let t = reg.nodes.get(id).and_then(|e| e.telemetry.clone());
        Ok(NodeTelemetry {
            id: id.to_string(),
            received_at: t.as_ref().map(|(_, at)| at.clone()),
            telemetry: t.map(|(t, _)| t),
        })
    }

    /// The machine's roster of Claude sessions, as it last pushed it.
    pub fn claude_roster(&self, id: &str) -> Result<NodeClaudeRoster, ApiError> {
        let reg = self.lock();
        Self::known(&reg, id)?;
        let r = reg.nodes.get(id).and_then(|e| e.roster.clone());
        Ok(NodeClaudeRoster {
            id: id.to_string(),
            received_at: r.as_ref().map(|(_, at)| at.clone()),
            roster: r.and_then(|(r, _)| r),
        })
    }

    /// One verb on one of the machine's Claude sessions: delivered to a
    /// connected, approved machine that offers `claude.sessions`, and
    /// acknowledged within `ACK_TIMEOUT` — never queued for later, since a
    /// resume that fires when the machine next connects is one nobody is
    /// watching. The outcome rides the machine's roster under `request`.
    pub fn claude_session(
        &self,
        id: &str,
        action: SessionAction,
        session: &str,
    ) -> Result<ClaudeSessionSent, ApiError> {
        let request = crate::claude::sessions::mint_request();
        self.deliver(
            id,
            "claude.sessions",
            "a session verb",
            "Claude is not run there",
            name::CLAUDE_SESSION,
            &ClaudeSessionParams {
                action,
                id: session.to_string(),
                request: request.clone(),
            },
        )?;
        Ok(ClaudeSessionSent {
            delivered: true,
            request,
        })
    }

    /// One residency verb on one model of one of the machine's providers:
    /// delivered to a connected, approved machine that offers
    /// `providers.residency`, acknowledged within `ACK_TIMEOUT`, never
    /// queued. The outcome rides the machine's providers document under
    /// `request` (`actions`).
    pub fn provider_model(
        &self,
        id: &str,
        params: crate::providers::ProviderModelParams,
    ) -> Result<ProviderModelSent, ApiError> {
        self.deliver(
            id,
            "providers.residency",
            "a residency verb",
            "it reads no providers",
            name::PROVIDER_MODEL,
            &params,
        )?;
        Ok(ProviderModelSent {
            delivered: true,
            request: params.request,
        })
    }

    /// Send request `m` to a connected, approved machine that offers
    /// `capability`, and wait for its acknowledgement. `what` names the
    /// request in the errors, `without` says why a machine may lack the
    /// capability.
    fn deliver<P: serde::Serialize>(
        &self,
        id: &str,
        capability: &str,
        what: &str,
        without: &str,
        m: &str,
        params: &P,
    ) -> Result<(), ApiError> {
        let mut reg = self.lock();
        match reg.state_of(id) {
            NodeState::Approved => {}
            NodeState::Unknown if !reg.desired.contains_key(id) && !reg.nodes.contains_key(id) => {
                return Err(ApiError::new(code::NOT_FOUND, format!("no machine {id}")))
            }
            other => {
                return Err(ApiError::new(
                    code::UNAVAILABLE,
                    format!("machine {id} is {}, not approved", other.as_str()),
                ))
            }
        }
        let offers = reg
            .nodes
            .get(id)
            .and_then(|e| e.hello.as_ref())
            .is_some_and(|h| h.capabilities.iter().any(|c| c == capability));
        let Some(conn) = reg.nodes.get_mut(id).and_then(|e| e.conn.as_mut()) else {
            return Err(ApiError::new(
                code::UNAVAILABLE,
                format!("machine {id} is not connected; {what} is never kept for later"),
            ));
        };
        if !offers {
            return Err(ApiError::new(
                code::UNSUPPORTED,
                format!(
                    "machine {id} does not offer `{capability}` (an older agent, or {without})"
                ),
            ));
        }
        let req = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        conn.acks.insert(req, tx);
        let _ = conn.tx.send(Out::Line(wire::request(req, m, params)));
        drop(reg);
        match rx.recv_timeout(self.limits.ack_timeout) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(msg)) => Err(ApiError::new(
                code::UNAVAILABLE,
                format!("machine {id} refused it: {msg}"),
            )),
            Err(RecvTimeoutError::Disconnected) => Err(ApiError::new(
                code::UNAVAILABLE,
                format!("machine {id} left before acknowledging it"),
            )),
            Err(RecvTimeoutError::Timeout) => {
                let mut reg = self.lock();
                if let Some(c) = reg.nodes.get_mut(id).and_then(|e| e.conn.as_mut()) {
                    c.acks.remove(&req);
                }
                Err(ApiError::new(
                    code::UNAVAILABLE,
                    format!(
                        "machine {id} did not acknowledge within {} s",
                        self.limits.ack_timeout.as_secs()
                    ),
                ))
            }
        }
    }

    pub fn claude(&self, id: &str) -> Result<NodeClaude, ApiError> {
        let reg = self.lock();
        Self::known(&reg, id)?;
        let c = reg.nodes.get(id).and_then(|e| e.claude.clone());
        Ok(NodeClaude {
            id: id.to_string(),
            received_at: c.as_ref().map(|(_, at)| at.clone()),
            report: c.and_then(|(r, _)| r),
        })
    }

    /// Prometheus text for `/nodes/metrics`: every approved machine's
    /// `daedalus_agent_link_up` (1 while connected), and the connected
    /// ones' telemetry and Claude series (telemetry/metrics.rs; the
    /// controller's own Claude is added by status.rs). Every series carries the
    /// machine's `node` id, `host` and `os` from its hello, and `machine`:
    /// the name the app gave it in `nodes.set_desired`, else its hostname.
    pub fn metrics(&self) -> String {
        let reg = self.lock();
        let mut ids: Vec<&String> = reg.nodes.keys().collect();
        ids.sort();
        let mut out = String::new();
        for id in ids {
            let Some(d) = reg.decided(id) else { continue };
            if d.state != DesiredState::Approved {
                continue;
            }
            let e = &reg.nodes[id];
            let Some(h) = &e.hello else { continue };
            let labels = crate::telemetry::Labels {
                node: id,
                host: &h.hostname,
                machine: d.name.as_deref().unwrap_or(&h.hostname),
                os: &h.os,
            };
            out.push_str(&format!(
                "daedalus_agent_link_up{{{}}} {}\n",
                labels.render(),
                u8::from(e.conn.is_some())
            ));
            if let (Some((t, _)), Some(_)) = (&e.telemetry, &e.conn) {
                out.push_str(&crate::telemetry::metrics_text(
                    t,
                    &h.agent_version,
                    &labels,
                ));
            }
            // A connected machine's Claude, from its last report; a machine
            // that left says nothing (its `link_up` is 0), rather than a
            // state it may no longer be in.
            if e.conn.is_some() {
                let report = e.claude.as_ref().and_then(|(r, _)| r.as_ref());
                out.push_str(&crate::telemetry::claude_text(report, &labels));
                // Its providers likewise: an asleep machine's model server
                // is Machine Link Down's business, not Model Server Down's.
                if let Some((list, _)) = &e.providers {
                    out.push_str(&crate::telemetry::providers_text(
                        list,
                        |k| d.offered.iter().any(|o| o == k),
                        &labels,
                    ));
                }
            }
        }
        out
    }

    /// How many machines are connected (admitted).
    pub fn open_connections(&self) -> usize {
        self.lock().connected()
    }

    /// How many connections wait before admission.
    pub fn preauth_connections(&self) -> usize {
        self.preauth_open.load(Ordering::Acquire)
    }
}

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
/// `identity`, until the returned listener is dropped (which also closes
/// every connection within a `TICK`).
pub fn listen(addr: SocketAddr, identity: &Identity, registry: Arc<Registry>) -> Result<Listener> {
    let config = super::tls::server_config(identity)?;
    let listener =
        TcpListener::bind(addr).with_context(|| format!("binding the link listener on {addr}"))?;
    listener
        .set_nonblocking(true)
        .context("making the link listener non-blocking")?;
    let local_addr = listener.local_addr()?;
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let stop = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("link-listener".into())
            .spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((sock, peer)) => {
                            let (config, registry, stop) = (
                                Arc::clone(&config),
                                Arc::clone(&registry),
                                Arc::clone(&stop),
                            );
                            let spawned =
                                std::thread::Builder::new().name("link-conn".into()).spawn(
                                    move || serve_connection(sock, peer, config, &registry, &stop),
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
    tracing::info!(address = %local_addr, fingerprint = %identity.fingerprint(), "link: listening for machines");
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

/// One machine's connection (module doc).
fn serve_connection(
    sock: TcpStream,
    peer: SocketAddr,
    config: Arc<rustls::ServerConfig>,
    registry: &Registry,
    stop: &AtomicBool,
) {
    let bucket = ip_bucket(peer.ip());
    let Some(slot) = registry.preauth_slot(bucket) else {
        tracing::debug!(%peer, "link: no pre-auth slot for this address; closed");
        return;
    };
    let limits = registry.limits;
    let deadline = Instant::now() + limits.preauth_budget;
    if sock.set_nonblocking(false).is_err() || sock.set_write_timeout(Some(WRITE_TIMEOUT)).is_err()
    {
        return;
    }
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
            welcome,
            queued,
        } => {
            tracing::info!(%peer, node = %id, state = welcome.state.as_str(), "link: machine connected");
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
    let why = converse(&mut tls, registry, &id, conn_id, &rx, queued, stop);
    tls.close();
    registry.detach(&id, conn_id);
    tracing::info!(%peer, node = %id, why, "link: machine left");
}

/// The connection after `hello`, until it ends; says why it ended.
fn converse(
    tls: &mut Tls,
    registry: &Registry,
    id: &str,
    conn_id: u64,
    rx: &Receiver<Out>,
    queued: Vec<Command>,
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
                Ok(Out::Close) => return "closed by the controller",
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return "replaced",
            }
        }
        if opened.elapsed() > limits.pending_ttl && registry.is_pending(id) {
            return "pending past its time; it may connect again";
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
                        registry.ack(id, conn_id, req, result.map(|_| ()).map_err(|e| e.msg));
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

#[cfg(test)]
mod tests;
