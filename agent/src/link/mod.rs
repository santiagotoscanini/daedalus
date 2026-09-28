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
//! (identity.rs): config.toml's `controller_pin` (what `install --pin`
//! writes), else the first key the controller presents — trust on first
//! use — recorded and never silently replaced: another key afterwards is a
//! loud error on the status page and in the tray (node.rs).
//!
//! **Enrollment.** A key the app has not approved is held PENDING: the
//! controller lists it for the app (`nodes.list`, the `nodes.pending`
//! event) and tells the machine nothing else; the machine shows "waiting
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

/// The longest line either side sends or reads: the local API's.
pub const MAX_LINE: usize = crate::api::MAX_LINE;
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
/// Addresses whose unknown keys are counted at once (the oldest go).
pub const UNKNOWN_ADDRESSES: usize = 1024;
/// The SRV record a machine asks for when it has no address.
pub const SRV_SERVICE: &str = "_daedalus-controller._tcp";

/// The link as the machine's status page and tray show it (node.rs keeps
/// it current). Absent on the controller.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize)]
pub struct LinkStatus {
    /// The controller's host:port, once known.
    pub address: Option<String>,
    /// Where the address came from: "config", "stored" or "dns <suffix>".
    pub found_via: Option<String>,
    /// "connecting" | "pending" | "approved" | "revoked" | "refused" |
    /// "key-changed"; null while there is no controller to try.
    pub state: Option<String>,
    pub connected: bool,
    /// When the current connection opened.
    pub since: Option<String>,
    /// This machine's key.
    pub fingerprint: String,
    /// The controller's key this machine trusts, once it trusts one.
    pub controller_fingerprint: Option<String>,
    /// Where that trust came from: "config" or "tofu".
    pub pinned_via: Option<String>,
    /// The controller's key was trusted on first use, not pinned in
    /// config.toml: the link works, and the page and the tray warn until
    /// the operator pins it.
    pub unconfirmed: bool,
    /// The last time a signed rotation moved the trusted controller key:
    /// from which to which, and when (rotation.rs). Null until one does.
    pub rotated: Option<String>,
    /// What went wrong last, when something did — a changed controller key
    /// above all.
    pub error: Option<String>,
}
