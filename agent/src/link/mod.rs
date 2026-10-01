//! The link: every machine's one connection to the controller, the box's
//! agent (PLAN, feature 13). A star — machines dial OUT to the controller
//! and keep the connection; they never contact the app, and only the
//! controller talks to the app, over its local socket (api/). The link
//! carries control messages only: who a machine is, how it is, what it
//! runs, and the box's word back. Data-plane traffic (a model server's
//! requests) never rides it.
//!
//! **Transport.** TLS 1.3 over TCP on every OS (tls.rs, over the pure-Rust
//! primitives in crypto.rs), with mutual authentication by pinned ed25519
//! keys: each end presents a self-signed certificate made from its
//! identity key (cert.rs) and signs the handshake with it. No CA, no
//! hostname. The machine accepts the controller only by its pin; the
//! controller accepts any machine's key at the TLS layer and decides right
//! after whether that key is approved, pending or revoked.
//!
//! **Framing.** Newline-delimited JSON with the local API's envelope
//! (wire.rs), lines at most `MAX_LINE`; the protocol version rides the
//! first request. Heartbeats both ways every `HEARTBEAT`; a side that hears
//! nothing for `DEAD_AFTER` drops the connection. A machine reconnects with
//! backoff from `BACKOFF_MIN` to `BACKOFF_MAX`.
//!
//! **Trust.** A machine pins the controller's key by its fingerprint
//! (identity.rs): config.toml's `controller_pin` (what `install --pin` and
//! `pair` write, pair.rs) and nothing else, never silently replaced:
//! another key is a loud error on the status page and in the tray, and a
//! machine with no pin is `unpaired` and dials nobody (node.rs).
//!
//! **Enrollment.** A key the app has not approved is held PENDING: the
//! controller lists it for the app (`nodes.list`) and tells the machine nothing else; the machine shows "waiting
//! for approval" with both fingerprints, its own and the controller's, so
//! the operator can compare them. When the app's desired set approves the
//! key (`nodes.set_desired`) the controller upgrades the open connection —
//! no reconnect — and sends the policy; a revoked key is told so and
//! disconnected.
//!
//! **Threads.** Blocking std threads, as the rest of the crate: one per
//! connection on each side, polling its socket every `TICK` and its
//! outgoing queue in between.
//!
//! **Limits on the controller** (controller.rs has the reasons). Two pools:
//! before a key is admitted a connection holds a PRE-AUTH slot
//! (`MAX_PREAUTH` in all, `PREAUTH_PER_IP` per address) and has
//! `PREAUTH_BUDGET` for the handshake and a `hello` of at most
//! `wire::MAX_HELLO_LINE` bytes; admitted, it holds one of
//! `MAX_CONNECTIONS`. Unknown keys: at most `UNKNOWN_PER_MINUTE` per address
//! (an IPv6 /64 counts as one), judged after the handshake so an approved
//! key is never refused for its address; at most `MAX_PENDING` pending, and
//! `PENDING_PER_IP` per address, each for at most `PENDING_TTL` per
//! connection. An approved key may take a pending one's place when the
//! pool is full.
//!
//! Where each part lives: tls.rs (configs, pin checks, the line
//! connection), cert.rs, crypto.rs, wire.rs (the messages), node.rs (the
//! machine's side: finding and trusting the controller, the pushes),
//! controller.rs (the listener and the registry of machines the local API
//! reads).

pub mod cert;
pub mod controller;
pub mod crypto;
pub mod node;
pub mod rotation;
pub mod tls;
pub mod wire;

use std::time::Duration;

use serde::Serialize;

/// How long one read waits before the loop looks at its queue again.
pub const TICK: Duration = Duration::from_millis(200);
/// How often each side says it is there.
pub const HEARTBEAT: Duration = Duration::from_secs(15);
/// Silence after which a connection is taken for dead.
pub const DEAD_AFTER: Duration = Duration::from_secs(45);
/// A machine's first retry, and its slowest.
pub const BACKOFF_MIN: Duration = Duration::from_secs(1);
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// The machine's TCP connect, TLS handshake and wait for the answer, each.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// A write that cannot complete in this long ends the connection.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Admitted connections the controller serves at once.
pub const MAX_CONNECTIONS: usize = 64;
/// Connections not yet admitted (handshake and `hello`), in all…
pub const MAX_PREAUTH: usize = 32;
/// …and from one address.
pub const PREAUTH_PER_IP: usize = 3;
/// The whole time a connection has, from accept, to be admitted.
pub const PREAUTH_BUDGET: Duration = Duration::from_secs(5);
/// Unknown keys the controller holds pending at once, in all…
pub const MAX_PENDING: usize = 16;
/// …and from one address.
pub const PENDING_PER_IP: usize = 2;
/// How long one pending connection may wait before it is closed (the
/// machine reconnects and waits again).
pub const PENDING_TTL: Duration = Duration::from_secs(3600);
/// Unknown keys one address may present in a minute.
pub const UNKNOWN_PER_MINUTE: usize = 10;
/// Settings requests (`policy_request`, wire.rs) one approved machine may
/// send in a minute: each is a write to the app's table and a desired sync.
pub const POLICY_REQUESTS_PER_MINUTE: usize = 10;
/// Addresses whose unknown keys are counted at once (the oldest go).
pub const UNKNOWN_ADDRESSES: usize = 1024;
/// The SRV record a machine asks for when it has no address.
pub const SRV_SERVICE: &str = "_daedalus-controller._tcp";

/// config.toml's two link keys as the service holds them (shared/link.rs
/// `LinkHub::keys`): read at start, read again when the machine is paired
/// while running (pair.rs `reload`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LinkKeys {
    pub pin: Option<String>,
    pub address: Option<String>,
}

impl LinkKeys {
    /// Whether a pin is set at all (a pin that does not parse is still one:
    /// the link says what is wrong with it).
    pub fn paired(&self) -> bool {
        self.pin.as_deref().is_some_and(|p| !p.trim().is_empty())
    }
}

/// Where the link's keys are read from: config.toml, and — on a system that
/// logs in rather than pairs — the tunnel config a log-in writes beside the
/// pin. A Mac joins the box by logging in from its menu bar alone
/// (enroll.rs): a pin WITHOUT a tunnel config — a log-out cut short — is
/// a Mac logged out, and the link dials nobody.
/// Other systems pair, and a pin is all they need.
///
/// The files are named, never assumed: a test (on any system) reads its
/// own scratch files under either rule, and never the machine's own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyFiles {
    pub config: std::path::PathBuf,
    /// The tunnel config whose absence is a logged-out machine, where this
    /// system logs in (macOS); None where a pin alone is paired.
    pub login: Option<std::path::PathBuf>,
}

impl KeyFiles {
    /// The service's own: config.toml and tunnel.toml in their directories,
    /// under this system's rule.
    pub fn here() -> Self {
        Self::on_this_os(crate::paths::config_path(), crate::paths::tunnel_path())
    }

    /// `config` and `tunnel` under this system's rule: a Mac logs in.
    pub fn on_this_os(config: std::path::PathBuf, tunnel: std::path::PathBuf) -> Self {
        Self {
            config,
            login: cfg!(target_os = "macos").then_some(tunnel),
        }
    }

    /// Whether the machine is logged out: it logs in, and has no tunnel.
    pub fn logged_out(&self) -> bool {
        self.login.as_deref().is_some_and(|t| !t.exists())
    }

    /// config.toml's keys as the link follows them: `cfg`'s, or none while
    /// logged out.
    pub fn keys(&self, cfg: &crate::config::Config) -> LinkKeys {
        if self.logged_out() {
            return LinkKeys::default();
        }
        LinkKeys {
            pin: cfg.controller_pin.clone(),
            address: cfg.controller_address.clone(),
        }
    }

    /// `keys`, reading config.toml (an absent file names none).
    pub fn load(&self) -> anyhow::Result<LinkKeys> {
        Ok(self.keys(&crate::config::load_at(&self.config)?))
    }
}

/// Where the link stands, as the status page and the tray say it:
/// `unpaired` (no pin: nothing is dialled until `pair`), `connecting`,
/// where the box has the machine (`pending`, `approved`, `revoked`),
/// `refused` (no controller to try, or one that would not have it) and
/// `key-changed` (the controller proved another key than the pin).
/// `unknown`: a newer machine's word, read on the controller.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkState {
    Unpaired,
    Connecting,
    Pending,
    Approved,
    Revoked,
    Refused,
    KeyChanged,
    #[serde(other)]
    Unknown,
}

impl std::fmt::Display for LinkState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        crate::util::wire_name(self, f)
    }
}

impl From<wire::NodeState> for LinkState {
    fn from(s: wire::NodeState) -> Self {
        match s {
            wire::NodeState::Pending => LinkState::Pending,
            wire::NodeState::Approved => LinkState::Approved,
            wire::NodeState::Revoked => LinkState::Revoked,
            wire::NodeState::Unknown => LinkState::Unknown,
        }
    }
}

/// Where the controller's address came from: config.toml, or a DNS search
/// (discover.rs).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FoundVia {
    Config,
    Dns,
    #[serde(other)]
    Unknown,
}

/// The link as the machine's status page and tray show it (node.rs keeps
/// it current). Absent on the controller.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct LinkStatus {
    /// The controller's host:port, once known.
    pub address: Option<String>,
    pub found_via: Option<FoundVia>,
    /// Null while there is no controller to try.
    pub state: Option<LinkState>,
    pub connected: bool,
    /// When the current connection opened.
    pub since: Option<String>,
    /// This machine's key.
    pub fingerprint: String,
    /// The controller's key this machine trusts: config.toml's pin.
    pub controller_fingerprint: Option<String>,
    /// The last time a signed rotation moved the trusted controller key:
    /// from which to which, and when (rotation.rs). Null until one does.
    pub rotated: Option<String>,
    /// What went wrong last, when something did — a changed controller key
    /// above all.
    pub error: Option<String>,
    /// The machine's own WireGuard tunnel to the box, while a tunnel config
    /// governs it (tunnel/): the link and santree go through it alone.
    /// Null without one.
    pub tunnel: Option<TunnelStatus>,
}

/// The tunnel as the status page and the tray show it (tunnel/ `status`).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct TunnelStatus {
    /// `host:port` of the box's WireGuard socket, as tunnel.toml names it.
    pub endpoint: String,
    /// What that name resolved to last; null until it has.
    pub resolved: Option<String>,
    /// This machine inside the tunnel.
    pub address: String,
    /// Seconds since the last handshake with the box; null without one.
    pub last_handshake_secs: Option<u64>,
    /// Data bytes through the tunnel, each way.
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// What went wrong last: a name that does not resolve, a network that
    /// refuses to send, no handshake for long, a tunnel config that could
    /// not be brought up.
    pub error: Option<String>,
}
