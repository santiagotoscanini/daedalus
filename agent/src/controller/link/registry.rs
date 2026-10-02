//! The registry: what the controller knows about every machine (the
//! module doc of `link::controller` says how it is kept).

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::Value;

use crate::api::wire::{
    ActionOutcome, ApiEvent, Capability, ClaudeSessionSent, CommandOk, DesiredState, NodeClaude,
    NodeClaudeRoster, NodeDetail, NodeLeft, NodePolicyRequest, NodeProviders, NodeSummary,
    ProviderModelSent, SetDesiredOk,
};
use crate::claude::{Report, Roster, SessionAction};
use crate::core::state::now_rfc3339;
use crate::core::status::StatusDocument;
use crate::identity::{fingerprint, node_id_of};
use crate::ipc::rpc::{ApiError, ErrorCode, Events};
use crate::link::wire::PolicyRequest;
use crate::link::wire::{
    self, name, ClaudeSessionParams, Command, CommandParams, ControllerId, Hello, NodeState,
    StateEvent, Welcome, PROTO,
};
use crate::link::wire::{Policy, SessionHost};
use crate::link::{
    DEAD_AFTER, HEARTBEAT, MAX_CONNECTIONS, MAX_PENDING, MAX_PREAUTH, PENDING_PER_IP, PENDING_TTL,
    POLICY_REQUESTS_PER_MINUTE, PREAUTH_BUDGET, PREAUTH_PER_IP, UNKNOWN_ADDRESSES,
    UNKNOWN_PER_MINUTE,
};
use crate::node::providers::{ProviderKind, ProviderReport};
use crate::telemetry::Telemetry;
use crate::util::LockExt;

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
    pub policy_requests_per_minute: usize,
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
            policy_requests_per_minute: POLICY_REQUESTS_PER_MINUTE,
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
pub(super) enum Out {
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
    status: Option<(StatusDocument, String)>,
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
    /// The app offers its lemonade to the gateway; `/nodes/metrics` labels
    /// that `provider_up` `offered="1"`.
    offer_lemonade: bool,
    /// Its link going down should alert: `/nodes/metrics`'
    /// `daedalus_agent_link_alert`, which Machine Link Down reads.
    alert_link: bool,
}

/// One entry of the app's set, checked (controller/api/mod.rs parses and validates).
#[derive(Clone, Debug, PartialEq)]
pub struct DesiredEntry {
    pub id: String,
    pub public_key: [u8; 32],
    pub state: DesiredState,
    pub policy: Policy,
    pub name: Option<String>,
    /// The app offers its lemonade to the gateway (`/nodes/metrics`); the
    /// machine is not told.
    pub offer_lemonade: bool,
    /// Its link going down should alert (`/nodes/metrics`); the machine is
    /// not told.
    pub alert_link: bool,
}

#[derive(Default)]
pub(super) struct Reg {
    nodes: HashMap<String, Entry>,
    desired: HashMap<String, Desired>,
    queued: HashMap<String, Vec<Command>>,
    /// Where the session host is and its key, from its status file
    /// (session_host.rs): handed to every machine whose policy turns santree
    /// on (`effective`).
    session_host: Option<SessionHost>,
    /// Unknown keys presented per address, within the last minute.
    pub(super) unknown_by_ip: HashMap<IpAddr, VecDeque<Instant>>,
    /// Settings requests per approved machine, within the last minute.
    policy_requests: HashMap<String, VecDeque<Instant>>,
}

impl Reg {
    /// The policy a machine is sent: the app's, with the session host filled
    /// in while santree is on (and never otherwise).
    fn effective(&self, d: &Desired) -> Policy {
        let mut p = d.policy.clone();
        p.session_host = if p.santree {
            self.session_host.clone()
        } else {
            None
        };
        p
    }

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
        let machine = e
            .and_then(|e| e.telemetry.as_ref())
            .map(|(t, _)| &t.machine);
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
            form: machine.and_then(|m| m.form.clone()),
            model: machine.and_then(|m| m.board_product.clone().or_else(|| m.model.clone())),
            status: e.and_then(|e| e.status.as_ref()).map(|(s, _)| s.clone()),
            status_at: e.and_then(|e| e.status.as_ref()).map(|(_, at)| at.clone()),
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
pub(super) enum Admission {
    Welcome {
        id: String,
        conn_id: u64,
        rx: Receiver<Out>,
        welcome: Box<Welcome>,
        queued: Vec<Command>,
    },
    Refuse(ApiError),
}

/// Holds one pre-auth slot (in all and for its address) until dropped; the
/// listener takes it before it spawns the connection's thread, which owns it.
pub(super) struct PreauthSlot {
    registry: Arc<Registry>,
    bucket: IpAddr,
}

impl Drop for PreauthSlot {
    fn drop(&mut self) {
        self.registry.preauth_open.fetch_sub(1, Ordering::AcqRel);
        let mut per = self.registry.preauth.lock_ok();
        if let Some(n) = per.get_mut(&self.bucket) {
            *n -= 1;
            if *n == 0 {
                per.remove(&self.bucket);
            }
        }
    }
}

pub(super) fn busy(msg: impl Into<String>) -> ApiError {
    ApiError::new(ErrorCode::Busy, msg)
}

/// What the controller knows about the machines (module doc).
pub struct Registry {
    me: ControllerId,
    pub(super) limits: Limits,
    inner: Mutex<Reg>,
    events: Arc<Events>,
    next_conn: AtomicU64,
    pub(super) next_request: AtomicU64,
    /// Pre-auth connections, in all and per address.
    preauth_open: AtomicUsize,
    preauth: Mutex<HashMap<IpAddr, usize>>,
    /// The session host's allow-list, where this box has one
    /// (session_host.rs).
    allow: Option<crate::controller::session_host::AllowList>,
    /// One `set_desired` at a time: the allow-list is written and the set
    /// applied in the order the sets came, so the file never ends on an
    /// older set than the registry.
    apply: Mutex<()>,
}

impl Registry {
    pub fn new(events: Arc<Events>, limits: Limits) -> Self {
        Self {
            // The fingerprint is the key each connection was served
            // (accept.rs), set as its welcome is sent.
            me: ControllerId {
                version: crate::VERSION.into(),
                hostname: crate::core::facts::hostname(),
                fingerprint: String::new(),
            },
            limits,
            inner: Mutex::new(Reg::default()),
            events,
            next_conn: AtomicU64::new(1),
            next_request: AtomicU64::new(1),
            preauth_open: AtomicUsize::new(0),
            preauth: Mutex::new(HashMap::new()),
            allow: None,
            apply: Mutex::new(()),
        }
    }

    /// Keep the session host's allow-list at `path` (session_host.rs).
    pub fn with_allow_list(mut self, path: std::path::PathBuf) -> Self {
        self.allow = Some(crate::controller::session_host::AllowList::new(path));
        self
    }

    /// Why the allow-list could not be written last time, if it could not.
    pub fn allow_list_error(&self) -> Option<String> {
        self.allow.as_ref().and_then(|a| a.error())
    }

    /// Write the allow-list again if its last write failed
    /// (session_host.rs).
    pub fn retry_allow_list(&self) {
        if let Some(allow) = &self.allow {
            allow.retry();
        }
    }

    /// The session host machines are told of; None until its status file
    /// named a key.
    pub fn session_host(&self) -> Option<SessionHost> {
        self.lock().session_host.clone()
    }

    /// Where the session host is and its key moved: every connected, approved
    /// machine with santree on gets its policy again, with it.
    pub fn set_session_host(&self, pin: SessionHost) {
        let mut reg = self.lock();
        if reg.session_host.as_ref() == Some(&pin) {
            return;
        }
        tracing::info!(address = %pin.address, key = %pin.public_key, "session host: machines with santree on are told of it");
        reg.session_host = Some(pin);
        for (id, d) in &reg.desired {
            if d.state != DesiredState::Approved || !d.policy.santree {
                continue;
            }
            if reg.state_of(id) != NodeState::Approved {
                continue;
            }
            if let Some(e) = reg.nodes.get(id) {
                e.send(wire::event(name::POLICY, &reg.effective(d)));
            }
        }
    }

    /// What the pages call machine `id`: the app's name, else its hostname.
    pub fn node_name(&self, id: &str) -> Option<String> {
        let reg = self.lock();
        reg.desired
            .get(id)
            .and_then(|d| d.name.clone())
            .or_else(|| reg.nodes.get(id).and_then(|e| e.hostname.clone()))
    }

    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, Reg> {
        self.inner.lock_ok()
    }

    /// A pre-auth slot for a connection from `bucket`, or None when the
    /// pool, or this address's share of it, is full.
    pub(super) fn preauth_slot(self: &Arc<Self>, bucket: IpAddr) -> Option<PreauthSlot> {
        let mut per = self.preauth.lock_ok();
        let mine = per.get(&bucket).copied().unwrap_or(0);
        if mine >= self.limits.preauth_per_ip
            || self.preauth_open.load(Ordering::Acquire) >= self.limits.max_preauth
        {
            return None;
        }
        per.insert(bucket, mine + 1);
        self.preauth_open.fetch_add(1, Ordering::AcqRel);
        Some(PreauthSlot {
            registry: Arc::clone(self),
            bucket,
        })
    }

    /// Whether `key` is one the app decided (approved or revoked): such a
    /// key is never counted against its address.
    pub(super) fn decided_key(&self, key: &[u8; 32]) -> bool {
        self.lock()
            .desired
            .get(&node_id_of(key))
            .is_some_and(|d| d.public_key == *key)
    }

    /// Count an unknown key from `bucket`; false when the address already
    /// presented `unknown_per_minute` within the last minute. The table
    /// holds at most `UNKNOWN_ADDRESSES` addresses, the least recently seen
    /// going first.
    pub(super) fn allow_unknown(&self, bucket: IpAddr) -> bool {
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

    pub(super) fn admit(&self, key: [u8; 32], hello: Hello, bucket: IpAddr) -> Admission {
        let id = node_id_of(&key);
        if hello.node_id != id {
            return Admission::Refuse(ApiError::new(
                ErrorCode::BadRequest,
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
                    ErrorCode::Forbidden,
                    format!("node id {id} is decided for another key; this key is not it"),
                ))
            }
            Some(d) if d.state == DesiredState::Revoked => {
                return Admission::Refuse(ApiError::new(
                    ErrorCode::Revoked,
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
            .map(|d| reg.effective(d));
        let queued = if state == NodeState::Approved {
            reg.queued.remove(&id).unwrap_or_default()
        } else {
            Vec::new()
        };
        let conn_id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
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
        entry.hostname = Some(hello.hostname.clone());
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
        Admission::Welcome {
            welcome: Box::new(Welcome {
                proto: PROTO,
                node_id: id.clone(),
                state,
                controller: self.me.clone(),
                policy,
            }),
            id,
            conn_id,
            rx,
            queued,
        }
    }

    /// Whether machine `id` is pending (for the connection's TTL).
    pub(super) fn is_pending(&self, id: &str) -> bool {
        self.lock().state_of(id) == NodeState::Pending
    }

    /// Whether machine `id` is approved (a `leave` is heard from no other).
    pub(super) fn is_approved(&self, id: &str) -> bool {
        self.lock().state_of(id) == NodeState::Approved
    }

    /// An approved machine logged out (enroll.rs, the link's `leave`): the
    /// app hears `nodes.left`, deletes its tunnel's client and forgets it;
    /// its next set is what removes the machine here. Refused as
    /// `unavailable` when no subscriber's queue took the event, as
    /// `policy_request` is: nobody heard it, so it is not acknowledged.
    pub(super) fn left(&self, id: &str) -> Result<(), ApiError> {
        let told = self
            .events
            .publish(&ApiEvent::NodesLeft(NodeLeft { id: id.to_string() }));
        tracing::info!(
            node = id,
            told,
            "link: the machine logged out and asks to be forgotten"
        );
        if told == 0 {
            return Err(ApiError::new(
                ErrorCode::Unavailable,
                "Daedalus is not listening (the app is down); the log-out was not heard",
            ));
        }
        Ok(())
    }

    /// An approved machine's user asks the box to change one of its
    /// settings (wire.rs `PolicyRequest`). Checked — at least one setting,
    /// santree only ever off — and counted against the machine's
    /// `policy_requests_per_minute`; then the app hears
    /// `nodes.policy_request`, writes the keys into the machine's policy and
    /// hands the set over again, which is what changes the machine. The
    /// controller keeps nothing and changes no policy itself. Refused as
    /// `unavailable` when no subscriber's queue took the event: the app is
    /// not listening, and the machine says so rather than wait.
    pub(super) fn policy_request(&self, id: &str, req: &PolicyRequest) -> Result<(), ApiError> {
        req.check()
            .map_err(|e| ApiError::new(ErrorCode::BadRequest, e))?;
        {
            let mut reg = self.lock();
            let now = Instant::now();
            let seen = reg.policy_requests.entry(id.to_string()).or_default();
            while seen
                .front()
                .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
            {
                seen.pop_front();
            }
            if seen.len() >= self.limits.policy_requests_per_minute {
                return Err(busy(format!(
                    "at most {} settings requests a minute from one machine",
                    self.limits.policy_requests_per_minute
                )));
            }
            seen.push_back(now);
        }
        let told = self
            .events
            .publish(&ApiEvent::NodesPolicyRequest(NodePolicyRequest {
                id: id.to_string(),
                changes: req.clone(),
            }));
        tracing::info!(
            node = id,
            ?req,
            told,
            "link: the machine asks to change its settings"
        );
        if told == 0 {
            return Err(ApiError::new(
                ErrorCode::Unavailable,
                "Daedalus is not listening (the app is down)",
            ));
        }
        Ok(())
    }
    /// A line from connection `conn_id` of machine `id`: it is alive, and
    /// what it pushed is kept — if it is approved.
    pub(super) fn record(&self, id: &str, conn_id: u64, e: &str, p: Value) {
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
            name::STATUS => match serde_json::from_value::<StatusDocument>(p) {
                Ok(s) => entry.status = Some((s, at)),
                Err(err) => bad("status document", err),
            },
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
                Ok(v) => match crate::node::providers::check(&v) {
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
    pub(super) fn ack(&self, id: &str, conn_id: u64, req: u64, result: Result<(), String>) {
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
    pub(super) fn detach(&self, id: &str, conn_id: u64) {
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
    }

    /// The app's complete set of decided keys (module doc). The caller
    /// has checked each entry (ids are their keys' node ids, no id twice).
    pub fn set_desired(&self, set: Vec<DesiredEntry>) -> SetDesiredOk {
        // One set at a time, the session host's allow-list before the
        // registry and its policy events (session_host.rs).
        let _one = self.apply.lock_ok();
        if let Some(allow) = &self.allow {
            allow.write(&set);
        }
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
                        offer_lemonade: d.offer_lemonade,
                        alert_link: d.alert_link,
                    },
                )
            })
            .collect();
        let mut ok = SetDesiredOk {
            nodes: reg.desired.len(),
            ..Default::default()
        };
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
            let policy = reg.desired.get(&id).map(|d| reg.effective(d));
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
                        let old_policy = old.get(&id).map(|d| reg.effective(d));
                        if old_policy != policy {
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
        }
        reg.prune();
        ok
    }

    /// Deliver `command` to machine `id` (module doc).
    pub fn command(&self, id: &str, command: Command) -> Result<CommandOk, ApiError> {
        let mut reg = self.lock();
        match reg.state_of(id) {
            NodeState::Approved => {}
            NodeState::Unknown if !reg.desired.contains_key(id) && !reg.nodes.contains_key(id) => {
                return Err(ApiError::new(
                    ErrorCode::NotFound,
                    format!("no machine {id}"),
                ))
            }
            other => {
                return Err(ApiError::new(
                    ErrorCode::Unavailable,
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
                ErrorCode::Unavailable,
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
                    ErrorCode::Unavailable,
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
            Err(ApiError::new(
                ErrorCode::NotFound,
                format!("no machine {id}"),
            ))
        }
    }

    /// One machine; with `full`, its telemetry and providers document too.
    pub fn get(&self, id: &str, full: bool) -> Result<NodeDetail, ApiError> {
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
            telemetry: e
                .and_then(|e| e.telemetry.as_ref())
                .filter(|_| full)
                .map(|(t, _)| t.clone()),
            telemetry_at: e
                .and_then(|e| e.telemetry.as_ref())
                .filter(|_| full)
                .map(|(_, at)| at.clone()),
            providers: e
                .and_then(|e| e.providers.as_ref())
                .filter(|_| full)
                .map(|(p, _)| p.clone()),
            providers_at: e
                .and_then(|e| e.providers.as_ref())
                .filter(|_| full)
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

    /// How a verb request to the machine stands, from its roster or its
    /// providers document; None while neither lists it.
    pub fn action(&self, id: &str, request: &str) -> Result<Option<ActionOutcome>, ApiError> {
        let reg = self.lock();
        Self::known(&reg, id)?;
        let e = reg.nodes.get(id);
        let roster = e
            .and_then(|e| e.roster.as_ref())
            .and_then(|(r, _)| r.as_ref());
        let providers = e
            .and_then(|e| e.providers.as_ref())
            .map(|(p, _)| p.as_slice());
        Ok(ActionOutcome::find(request, roster, providers))
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
        let request = crate::util::mint_id();
        self.deliver(
            id,
            Capability::ClaudeSessions,
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
        params: crate::node::providers::ProviderModelParams,
    ) -> Result<ProviderModelSent, ApiError> {
        self.deliver(
            id,
            Capability::ProvidersResidency,
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
        capability: Capability,
        what: &str,
        without: &str,
        m: &str,
        params: &P,
    ) -> Result<(), ApiError> {
        let mut reg = self.lock();
        match reg.state_of(id) {
            NodeState::Approved => {}
            NodeState::Unknown if !reg.desired.contains_key(id) && !reg.nodes.contains_key(id) => {
                return Err(ApiError::new(
                    ErrorCode::NotFound,
                    format!("no machine {id}"),
                ))
            }
            other => {
                return Err(ApiError::new(
                    ErrorCode::Unavailable,
                    format!("machine {id} is {}, not approved", other.as_str()),
                ))
            }
        }
        let offers = reg
            .nodes
            .get(id)
            .and_then(|e| e.hello.as_ref())
            .is_some_and(|h| h.capabilities.contains(&capability));
        let Some(conn) = reg.nodes.get_mut(id).and_then(|e| e.conn.as_mut()) else {
            return Err(ApiError::new(
                ErrorCode::Unavailable,
                format!("machine {id} is not connected; {what} is never kept for later"),
            ));
        };
        if !offers {
            return Err(ApiError::new(
                ErrorCode::Unsupported,
                format!("machine {id} does not offer `{capability}` ({without})"),
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
                ErrorCode::Unavailable,
                format!("machine {id} refused it: {msg}"),
            )),
            Err(RecvTimeoutError::Disconnected) => Err(ApiError::new(
                ErrorCode::Unavailable,
                format!("machine {id} left before acknowledging it"),
            )),
            Err(RecvTimeoutError::Timeout) => {
                let mut reg = self.lock();
                if let Some(c) = reg.nodes.get_mut(id).and_then(|e| e.conn.as_mut()) {
                    c.acks.remove(&req);
                }
                Err(ApiError::new(
                    ErrorCode::Unavailable,
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
    /// `daedalus_agent_link_up` (1 while connected) and
    /// `daedalus_agent_link_alert` (1 unless the app turned its alert off;
    /// labelled `node` alone, and there before the machine's first hello
    /// since a restart), and the connected
    /// ones' telemetry and Claude series (telemetry/metrics.rs; the
    /// controller's own Claude is added by metrics_page.rs). Every series carries the
    /// machine's `node` id, `host` and `os` from its hello, and `machine`:
    /// the name the app gave it in `nodes.set_desired`, else its hostname.
    pub fn metrics(&self) -> String {
        /// One approved machine, copied out under the lock: the text is
        /// formatted after it is released, so a scrape never holds up the
        /// links (or an admission) for the time telemetry takes to render.
        struct Row {
            id: String,
            host: String,
            machine: String,
            os: String,
            agent_version: String,
            connected: bool,
            offer_lemonade: bool,
            telemetry: Option<Telemetry>,
            claude: Option<Report>,
            providers: Option<Vec<ProviderReport>>,
        }
        let (rows, alerts): (Vec<Row>, Vec<(String, bool)>) = {
            let reg = self.lock();
            // Every approved machine's alert switch, hello or not: after a
            // restart a machine that has not connected since has no
            // `link_up`, and Machine Link Down counts it down from its
            // history, so the switch must be there to exclude it.
            let mut alerts: Vec<(String, bool)> = reg
                .desired
                .keys()
                .filter_map(|id| {
                    let d = reg.decided(id)?;
                    (d.state == DesiredState::Approved).then(|| (id.clone(), d.alert_link))
                })
                .collect();
            alerts.sort();
            let mut ids: Vec<&String> = reg.nodes.keys().collect();
            ids.sort();
            let rows = ids
                .into_iter()
                .filter_map(|id| {
                    let d = reg.decided(id)?;
                    if d.state != DesiredState::Approved {
                        return None;
                    }
                    let e = &reg.nodes[id];
                    let h = e.hello.as_ref()?;
                    let connected = e.conn.is_some();
                    Some(Row {
                        id: id.clone(),
                        host: h.hostname.clone(),
                        machine: d.name.clone().unwrap_or_else(|| h.hostname.clone()),
                        os: h.os.clone(),
                        agent_version: h.agent_version.clone(),
                        connected,
                        offer_lemonade: d.offer_lemonade,
                        // A machine that left says nothing but its `link_up`
                        // (below): only a connected one's are copied.
                        telemetry: e
                            .telemetry
                            .as_ref()
                            .filter(|_| connected)
                            .map(|(t, _)| t.clone()),
                        claude: e
                            .claude
                            .as_ref()
                            .filter(|_| connected)
                            .and_then(|(r, _)| r.clone()),
                        providers: e
                            .providers
                            .as_ref()
                            .filter(|_| connected)
                            .map(|(l, _)| l.clone()),
                    })
                })
                .collect();
            (rows, alerts)
        };
        let mut out = String::new();
        // Node ids are 16 hex digits (api/mod.rs `checked_id`): no escaping.
        for (id, on) in &alerts {
            out.push_str(&format!(
                "daedalus_agent_link_alert{{node=\"{id}\"}} {}\n",
                u8::from(*on)
            ));
        }
        for r in &rows {
            let labels = crate::telemetry::Labels {
                node: &r.id,
                host: &r.host,
                machine: &r.machine,
                os: &r.os,
            };
            out.push_str(&format!(
                "daedalus_agent_link_up{{{}}} {}\n",
                labels.render(),
                u8::from(r.connected)
            ));
            if let Some(t) = &r.telemetry {
                out.push_str(&crate::telemetry::metrics_text(
                    t,
                    &r.agent_version,
                    &labels,
                ));
            }
            // A connected machine's Claude, from its last report; a machine
            // that left says nothing (its `link_up` is 0), rather than a
            // state it may no longer be in.
            if r.connected {
                out.push_str(&crate::telemetry::claude_text(r.claude.as_ref(), &labels));
                // Its providers likewise: an asleep machine's model server
                // is Machine Link Down's business, not Model Server Down's.
                if let Some(list) = &r.providers {
                    out.push_str(&crate::telemetry::providers_text(
                        list,
                        |k| k == ProviderKind::Lemonade && r.offer_lemonade,
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
