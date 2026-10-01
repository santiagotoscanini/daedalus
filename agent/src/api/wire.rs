//! The local API's wire types: every request, answer and event, as serde
//! writes them. This file is the contract — the app's TypeScript client is
//! generated from, or checked against, these types, and the golden tests at
//! the bottom pin each one's exact JSON, so a change here that is not also
//! a change of `API_VERSION` shows up as a failing test.
//!
//! Framing (api/mod.rs has the rest): one JSON object per line.
//!
//! ```text
//! → {"id":1,"m":"hello","p":{"api":1,"client":"daedalus-app/2026.9"}}
//! ← {"id":1,"ok":{"api":1,"version":"0.13.0","mode":"controller",…}}
//! → {"id":2,"m":"claude.restart"}
//! ← {"id":2,"err":{"code":"unavailable","msg":"…"}}
//! ← {"e":"claude.changed","p":{"reporting":true,"state":"running","pid":4242}}
//! ```
//!
//! Strict where strictness protects, lenient where it would break a newer
//! client: the request envelope and `hello`'s parameters ignore fields
//! they do not know (a newer app may send more, and must still be told
//! which version this agent speaks), while a method's own parameters are
//! exact — today every method but `hello` takes none, and one that takes a
//! selector later refuses what it does not know.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::claude::{Report, Roster, SessionAction, Summary};
use crate::config::{Mode, TelemetryLevel};
use crate::link::wire::{Command, Hello, NodeState, PolicyRequest};
use crate::link::wire::{Policy, ProviderPolicy, ProvidersPolicy};
use crate::providers::ProviderReport;
use crate::role::Role;
use crate::telemetry::Telemetry;

/// The event names, all of them.
pub mod event {
    /// Claude remote control's state or pid moved (`ClaudeChanged`).
    pub const CLAUDE_CHANGED: &str = "claude.changed";
    /// A new telemetry sample is in (`TelemetryUpdated`).
    pub const TELEMETRY_UPDATED: &str = "telemetry.updated";
    /// A machine connected, left, or changed standing (`NodeChanged`).
    pub const NODES_CHANGED: &str = "nodes.changed";
    /// An unknown key asks to join (`NodePending`).
    pub const NODES_PENDING: &str = "nodes.pending";
    /// A root verb's unit wrote a line (`RootProgress`).
    pub const ROOT_PROGRESS: &str = "root.progress";
    /// An approved machine logged out and asks to be forgotten (`NodeLeft`).
    pub const NODES_LEFT: &str = "nodes.left";
    /// An approved machine's user asks to change one of its settings
    /// (`NodePolicyRequest`): the app decides, and its next set carries it.
    pub const NODES_POLICY_REQUEST: &str = "nodes.policy_request";
}

// ── the methods ───────────────────────────────────────────────────────────

/// `hello`'s parameters: the version the client speaks, and who it is (for
/// the log). Other fields are ignored, and the version is read before
/// anything else (`hello_api`), so a newer client is always told which
/// version this agent speaks.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct HelloParams {
    pub api: u32,
    pub client: String,
}

/// The API version a `hello` asks for, read from its raw parameters before
/// they are parsed; None when `api` is missing or not a whole number.
pub fn hello_api(p: &Value) -> Option<u64> {
    p.get("api")?.as_u64()
}

/// `hello`'s answer.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HelloOk {
    pub api: u32,
    pub version: String,
    pub mode: Mode,
    pub hostname: String,
    pub capabilities: Vec<&'static str>,
}

/// The operating system and the machine, as `system.info` states them.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct OsInfo {
    /// "linux", "windows", "macos".
    pub os: &'static str,
    /// "NixOS"; empty when unknown.
    pub name: String,
    /// "25.11"; empty when unknown.
    pub version: String,
    /// "x86_64", "aarch64".
    pub arch: &'static str,
    pub cpu: String,
    pub memory_bytes: Option<u64>,
}

/// `system.info`'s answer: the agent, the machine, and what runs here.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SystemInfo {
    pub api: u32,
    pub version: String,
    pub mode: Mode,
    pub hostname: String,
    pub os: OsInfo,
    /// The agent's, in seconds.
    pub uptime_secs: u64,
    /// The machine's.
    pub os_uptime_secs: Option<u64>,
    /// When the machine booted, RFC 3339 UTC.
    pub booted_at: Option<String>,
    /// Which parts of the agent run (role.rs's table).
    pub role: Role,
    pub telemetry: TelemetryLevel,
    pub capabilities: Vec<&'static str>,
    /// The controller's own key and where machines reach it; absent
    /// anywhere but the controller.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller: Option<ControllerInfo>,
}

/// The controller as `system.info` states it: the key every machine pins,
/// as hex and as its fingerprint (identity.rs), the address its listener
/// is bound to (null when it listens for no machine), and the `host:port`s
/// config.toml says machines should dial — what the app hands an install
/// command — and, while its key is rotated, where the key came from
/// (link/rotation.rs; `public_key` is then the new key, the one to pin).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ControllerInfo {
    pub public_key: String,
    pub fingerprint: String,
    pub listen: Option<String>,
    pub advertise: Vec<String>,
    /// The rotation under way; null when none is.
    pub rotation: Option<crate::link::rotation::RotationInfo>,
}

// ── the machines (link/controller.rs) ─────────────────────────────────────

/// A machine as `nodes.list` lists it: identity, standing, connection,
/// and what its `hello` said. The hello's fields are null for a key the app
/// named that has not connected since the controller started.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
pub struct NodeSummary {
    pub id: String,
    pub fingerprint: String,
    pub state: NodeState,
    pub connected: bool,
    /// When the current connection opened; null while disconnected.
    pub since: Option<String>,
    /// The last line heard from it, RFC 3339 UTC.
    pub last_seen: Option<String>,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub agent_version: Option<String>,
    pub lan_ip: Option<String>,
    pub mac: Option<String>,
    /// Claude Code there, from its last report; null without one.
    pub claude: Option<Summary>,
}

/// `nodes.list`'s answer.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
pub struct NodesList {
    pub nodes: Vec<NodeSummary>,
}

/// `nodes.get`'s answer: the summary, the whole hello, the status document
/// (what the machine's `/status` carries, without its telemetry), the
/// telemetry as the open page shows it (`Telemetry::public`), and the
/// providers document (null until the machine has pushed one).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
pub struct NodeDetail {
    #[serde(flatten)]
    pub node: NodeSummary,
    pub public_key: String,
    pub hello: Option<Hello>,
    /// The status page's document (`StatusPage`), as the machine sent it.
    #[cfg_attr(test, ts(type = "unknown"))]
    pub status: Option<Value>,
    pub status_at: Option<String>,
    pub telemetry: Option<Telemetry>,
    pub telemetry_at: Option<String>,
    pub providers: Option<Vec<ProviderReport>>,
    pub providers_at: Option<String>,
}

/// `nodes.providers`'s answer: the machine's providers as it last pushed
/// them (providers.rs), null until it has, and when they arrived.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, ts(rename = "NodeProvidersOk"))]
pub struct NodeProviders {
    pub id: String,
    /// Whether the machine's link is open now: a report from a machine
    /// that left is what it said before it went.
    pub connected: bool,
    pub providers: Option<Vec<ProviderReport>>,
    pub received_at: Option<String>,
}

/// `nodes.telemetry`'s answer: the full document at the machine's level.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, ts(rename = "NodeTelemetryOk"))]
pub struct NodeTelemetry {
    pub id: String,
    pub telemetry: Option<Telemetry>,
    pub received_at: Option<String>,
}

/// `nodes.claude`'s answer: the machine's full Claude report.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, ts(rename = "NodeClaudeOk"))]
pub struct NodeClaude {
    pub id: String,
    pub report: Option<Report>,
    pub received_at: Option<String>,
}

/// `nodes.claude_roster`'s answer: the machine's roster of Claude
/// sessions, as it last pushed it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, ts(rename = "NodeClaudeRosterOk"))]
pub struct NodeClaudeRoster {
    pub id: String,
    pub roster: Option<Roster>,
    pub received_at: Option<String>,
}

/// `nodes.claude_session`'s parameters: the machine, the verb and its
/// selector.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "NodeClaudeSessionParams"))]
pub struct NodeClaudeSession {
    pub id: String,
    pub action: SessionAction,
    /// A session uuid or a background agent's short id.
    pub session: String,
}

/// `nodes.claude_session`'s answer: the machine took the request, and its
/// roster reports the outcome under `request`.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ClaudeSessionSent {
    pub delivered: bool,
    pub request: String,
}

/// `nodes.provider_model`'s parameters: the machine, the provider's kind,
/// the verb and the model — never an address; the machine finds its
/// provider by kind and its policy's port.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "NodeProviderModelParams"))]
pub struct NodeProviderModel {
    pub id: String,
    pub kind: String,
    pub action: crate::providers::ModelAction,
    pub model: String,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub pinned: Option<bool>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub replacing: Option<String>,
}

/// `nodes.provider_model`'s answer: the machine took the verb, and its
/// providers document reports the outcome under `request` (`actions`).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderModelSent {
    pub delivered: bool,
    pub request: String,
}

/// The parameters of `nodes.get`, `nodes.telemetry`, `nodes.claude` and
/// `nodes.claude_roster`.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "NodeIdParams"))]
pub struct NodeId {
    pub id: String,
}

/// The longest `DesiredNode::name`, in characters.
pub const MAX_NODE_NAME: usize = 64;

/// `nodes.set_desired`'s parameters: the app's COMPLETE set of decided
/// keys. A key absent from it is pending (while connected) or unknown.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetDesired {
    pub nodes: Vec<DesiredNode>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesiredNode {
    pub id: String,
    /// 64 hex characters; `id` must be its node id.
    pub public_key: String,
    pub state: DesiredState,
    /// The machine's policy; absent for an approved one, `Policy::default()`.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub policy: Option<DesiredPolicy>,
    /// What the pages call the machine, at most `MAX_NODE_NAME` characters
    /// and no control characters; `/nodes/metrics` labels its series
    /// `machine` with it, or with the hostname when absent.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub name: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesiredState {
    Approved,
    Revoked,
}

/// The policy as the app sends it: link/wire.rs's `Policy`, field for field,
/// but exact — a field the controller does not know is refused.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesiredPolicy {
    pub awake_hold: bool,
    pub claude_remote_control: bool,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub claude_workdir: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<DesiredProviders>", optional))]
    pub providers: DesiredProviders,
    /// santree on this machine may open its projects on the box.
    pub santree: bool,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesiredProviders {
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub lemonade: Option<DesiredProvider>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesiredProvider {
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub port: Option<u16>,
    /// The app offers it to the gateway. The controller keeps it for
    /// `/nodes/metrics` (`offered`); the machine is not told.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub offer: Option<bool>,
}

impl From<DesiredPolicy> for Policy {
    fn from(p: DesiredPolicy) -> Self {
        Policy {
            awake_hold: p.awake_hold,
            claude_remote_control: p.claude_remote_control,
            claude_workdir: p.claude_workdir.filter(|w| !w.trim().is_empty()),
            providers: ProvidersPolicy {
                lemonade: p
                    .providers
                    .lemonade
                    .map(|l| ProviderPolicy { port: l.port }),
            },
            santree: p.santree,
            // The controller's to fill (registry.rs `effective`), never the app's.
            session_host: None,
        }
    }
}

/// `nodes.set_desired`'s answer: how many keys the set holds, and what
/// changed on the connections open now — upgraded to approved (policy
/// sent, no reconnect), revoked and disconnected, back to pending, or sent
/// a changed policy.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SetDesiredOk {
    pub nodes: usize,
    pub approved: Vec<String>,
    pub revoked: Vec<String>,
    pub pending: Vec<String>,
    pub policy: Vec<String>,
}

/// `controller.rotate`'s parameters: how long both keys are served before
/// the old one retires, in seconds (link/rotation.rs `GRACE_MIN` to
/// `GRACE_MAX`; absent, `GRACE_DEFAULT`). Its answer is the controller as
/// `system.info` then states it (`ControllerInfo`, with its `rotation`).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "ControllerRotateParams"))]
pub struct ControllerRotate {
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub grace_secs: Option<u64>,
}

/// `nodes.command`'s parameters: one of the fixed instructions.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "NodeCommandParams"))]
pub struct NodeCommand {
    pub id: String,
    pub command: Command,
}

/// `nodes.command`'s answer: acknowledged by the connected machine
/// (`delivered`), or kept for it until it next connects (`queued`).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CommandOk {
    pub delivered: bool,
    pub queued: bool,
}

/// `nodes.changed`'s payload.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NodeChanged {
    pub id: String,
    pub state: NodeState,
    pub connected: bool,
}

/// `nodes.left`'s payload: an approved machine logged out (enroll.rs) and
/// asks the app to forget it — its tunnel's client too. The controller
/// forgets nothing itself: the app's next set does.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NodeLeft {
    pub id: String,
}

/// `nodes.policy_request`'s payload: machine `id` asks the box to change the
/// settings in `changes` (link/wire.rs `PolicyRequest`: absolute values,
/// never santree on). The controller changes nothing itself; the app writes
/// the keys the machine sent into its policy and hands the set over again.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NodePolicyRequest {
    pub id: String,
    pub changes: PolicyRequest,
}

/// `nodes.pending`'s payload: an unknown key connected and waits.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NodePending {
    pub id: String,
    pub fingerprint: String,
    pub hostname: String,
}

/// `root.run`'s parameters: one of the root helper's verbs, its selectors
/// and, for a verb that takes one, a payload (root/mod.rs, "The run file").
/// The helper's table is the authority; this side checks only the shape of
/// the words before a connection is spent.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "RootRunParams"))]
pub struct RootRun {
    pub verb: String,
    #[serde(default)]
    pub selectors: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub payload: Option<String>,
}

/// Never the payload, whatever prints the parameters.
impl std::fmt::Debug for RootRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RootRun")
            .field("verb", &self.verb)
            .field("selectors", &self.selectors)
            .field(
                "payload",
                &self
                    .payload
                    .as_ref()
                    .map(|p| format!("<{} bytes>", p.len())),
            )
            .finish()
    }
}

/// `root.run`'s answer: how the verb ended, with the run's id (its
/// `root.progress` events carry it) and, for `status`, every verb.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RootRunOk {
    pub run: String,
    pub verb: String,
    pub outcome: crate::root::Outcome,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub verbs: Option<Vec<crate::root::VerbState>>,
}

/// `root.progress`'s payload: one line the verb's unit wrote.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RootProgress {
    pub run: String,
    pub verb: String,
    pub line: String,
}

// ── the session host (session_host.rs) ──────────────────────────────────────

/// `santree.status`'s answer: the session host as its status file tells it,
/// and the allow-list the controller keeps for it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SantreeStatus {
    pub state: SessionHostState,
    /// The running host's version; null without a status file.
    pub version: Option<String>,
    /// The build that runs is not the one installed: a restart applies it
    /// (and ends `live_ptys` terminals).
    pub restart_pending: bool,
    /// Terminals whose process runs: what a restart ends.
    pub live_ptys: u32,
    /// The machines connected now, one entry each, most connections first.
    pub connections: Vec<SantreeConnections>,
    /// What stops the controller from reading the host or writing its
    /// allow-list, when something does.
    pub error: Option<String>,
}

/// Where the session host stands, from its status file: `running`, `stale`
/// (it says running but has not written for a while: killed, or hung),
/// `stopped` (it said so as it stopped), `missing` (no file to read).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionHostState {
    Running,
    Stale,
    Stopped,
    Missing,
}

/// One machine's connections to the session host.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SantreeConnections {
    pub node: String,
    /// What the pages call it (`nodes.set_desired`), else its hostname.
    pub name: Option<String>,
    pub count: u32,
}

/// A node id as the API takes it: sixteen lowercase hex characters.
pub fn valid_node_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `claude.status`'s answer. `reporting` false means no session has
/// reported within the freshness window (the session thread is gone, or
/// has not reported yet), and `report` is null.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
pub struct ClaudeStatus {
    pub reporting: bool,
    /// Whether this machine's policy wants the server running.
    pub wanted: bool,
    pub report: Option<Report>,
}

/// `claude.roster`'s answer: the session's last roster (claude/roster.rs)
/// while it is fresh; `reporting` false and `roster` null otherwise.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
pub struct ClaudeRosterGet {
    pub reporting: bool,
    pub roster: Option<Roster>,
}

/// `claude.session`'s parameters: the verb and its selector — a session
/// uuid, or a background agent's short id. Exact: nothing else.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "ClaudeSessionParams"))]
pub struct ClaudeSession {
    pub action: SessionAction,
    pub id: String,
}

/// `claude.session`'s answer: queued for the session under `request`, the
/// id its roster's `actions` reports the outcome by.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionQueued {
    pub queued: bool,
    pub request: String,
}

/// `claude.restart`'s answer: the instruction is queued for the session,
/// which takes it with its next report.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Queued {
    pub queued: bool,
}

/// `telemetry.get`'s answer: the level config.toml sets, and the latest
/// document at that level — null when the level is `off`, or before the
/// first sample.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TelemetryGet {
    pub level: TelemetryLevel,
    pub telemetry: Option<Telemetry>,
}

/// `events.subscribe`'s answer; the events follow on the same connection.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Subscribed {}

/// `claude.changed`'s payload. Sent when a session starts reporting, when
/// its report's state or pid moves, and when it stops reporting (nothing
/// within the freshness window) — then `reporting` is false and the state
/// and pid are null.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ClaudeChanged {
    pub reporting: bool,
    pub state: Option<String>,
    pub pid: Option<u32>,
}

/// `telemetry.updated`'s payload: when the new sample was taken; read it
/// with `telemetry.get`.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TelemetryUpdated {
    pub sampled_at: String,
}

// ── logging in (enroll.rs): the agent and the app, over HTTPS ─────────────

/// What a machine's service sends to redeem its log-in: `POST
/// <app>/api/agent/enroll` with this JSON, the one route past the app's
/// forward-auth gate that a machine calls. `code` is what the app handed
/// the browser for the machine's loopback, once; `code_verifier` the PKCE
/// verifier (RFC 7636, S256) whose challenge the machine put in the page it
/// opened — only the service that began the log-in holds it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnrollRedeem {
    pub code: String,
    pub code_verifier: String,
}

/// The app's answer to a redeem: everything the machine needs to link
/// through its own tunnel. Read leniently: a newer app may say more.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct EnrollRedeemed {
    /// The node id the app approved: this machine's, or the log-in stops.
    pub node: String,
    pub controller: EnrollController,
    pub wireguard: WireguardConfig,
}

/// The controller as a logged-in machine trusts and dials it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnrollController {
    /// Its key's fingerprint (`ControllerInfo::fingerprint`): the pin.
    pub pin: String,
    /// Its link inside the tunnel: the box's LAN address and the link's
    /// port, `a.b.c.d:port` — the address must be the tunnel's AllowedIPs.
    pub address: String,
}

/// A wg-easy client config, as wg-quick names its fields: what the app
/// reads back from wg-easy for the machine (`[Interface]` PrivateKey and
/// Address, `[Peer]` PublicKey, PresharedKey, Endpoint and AllowedIPs), and
/// what the machine keeps in `tunnel.toml` (tunnel/). Its keys are wiped
/// from memory when it is dropped, and it is never printed.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireguardConfig {
    pub private_key: String,
    /// This machine inside the tunnel, `a.b.c.d` — wg-easy writes a prefix
    /// (`/24`), which is ignored.
    pub address: String,
    pub server_public_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub preshared_key: Option<String>,
    /// `host:port`.
    pub endpoint: String,
    /// Exactly one: the box's LAN address, `/32`.
    pub allowed_ips: Vec<String>,
}

impl Drop for WireguardConfig {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.private_key.zeroize();
        if let Some(k) = self.preshared_key.as_mut() {
            k.zeroize();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{code, ApiError, Event, Request, Response};
    use serde_json::json;

    fn wire<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).unwrap()
    }

    #[test]
    fn requests_parse_and_nothing_else_does() {
        let r: Request = serde_json::from_str(
            r#"{"id":7,"m":"hello","p":{"api":1,"client":"daedalus-app/2026.9"}}"#,
        )
        .unwrap();
        assert_eq!(r.id, 7);
        assert_eq!(r.m, "hello");
        let h: HelloParams = serde_json::from_value(r.p).unwrap();
        assert_eq!(
            h,
            HelloParams {
                api: 1,
                client: "daedalus-app/2026.9".into()
            }
        );
        let bare: Request = serde_json::from_str(r#"{"id":8,"m":"system.info"}"#).unwrap();
        assert_eq!(bare.p, Value::Null);
        for bad in [
            r#"{"m":"hello"}"#,
            r#"{"id":-1,"m":"hello"}"#,
            r#"{"id":1}"#,
            r#"[1,"hello"]"#,
        ] {
            assert!(Request::parse(bad.as_bytes()).is_err(), "{bad}");
        }
        // A newer client's extra fields are ignored, in the envelope and in
        // hello's parameters; the version is readable before any parse.
        let newer = Request::parse(
            br#"{"id":1,"m":"hello","trace":"x","p":{"api":2,"client":"app/9","features":["x"]}}"#,
        )
        .unwrap();
        assert_eq!(hello_api(&newer.p), Some(2));
        let h: HelloParams =
            serde_json::from_value(json!({"api":1,"client":"x","features":[]})).unwrap();
        assert_eq!(h.api, 1);
        assert!(serde_json::from_value::<HelloParams>(json!({"api":1})).is_err());
        assert_eq!(hello_api(&json!({"api":"1"})), None);
        assert_eq!(hello_api(&Value::Null), None);
    }

    #[test]
    fn answers_and_errors_on_the_wire() {
        assert_eq!(wire(&Response::ok(1, &json!({}))), r#"{"id":1,"ok":{}}"#);
        assert_eq!(
            wire(&Response::err(
                Some(2),
                ApiError::new(code::UNKNOWN_METHOD, "no method x")
            )),
            r#"{"id":2,"err":{"code":"unknown_method","msg":"no method x"}}"#
        );
        assert_eq!(
            wire(&Response::err(
                None,
                ApiError::new(code::BAD_REQUEST, "not JSON")
            )),
            r#"{"id":null,"err":{"code":"bad_request","msg":"not JSON"}}"#
        );
        let v = ApiError {
            supported: Some(1),
            ..ApiError::new(code::VERSION, "this agent speaks api 1")
        };
        assert_eq!(
            wire(&Response::err(Some(3), v)),
            r#"{"id":3,"err":{"code":"version","msg":"this agent speaks api 1","supported":1}}"#
        );
    }

    #[test]
    fn hello_on_the_wire() {
        let ok = HelloOk {
            api: 1,
            version: "0.13.0".into(),
            mode: Mode::Controller,
            hostname: "box".into(),
            capabilities: vec!["claude.remote_control", "telemetry.full"],
        };
        assert_eq!(
            wire(&ok),
            r#"{"api":1,"version":"0.13.0","mode":"controller","hostname":"box","capabilities":["claude.remote_control","telemetry.full"]}"#
        );
    }

    #[test]
    fn system_info_on_the_wire() {
        let info = SystemInfo {
            api: 1,
            version: "0.13.0".into(),
            mode: Mode::Controller,
            hostname: "box".into(),
            os: OsInfo {
                os: "linux",
                name: "NixOS".into(),
                version: "25.11".into(),
                arch: "x86_64",
                cpu: "AMD Ryzen 7".into(),
                memory_bytes: Some(64),
            },
            uptime_secs: 5,
            os_uptime_secs: Some(100),
            booted_at: Some("2026-09-27T10:00:00Z".into()),
            role: Role::of(Mode::Controller),
            telemetry: TelemetryLevel::Minimal,
            capabilities: vec!["claude.remote_control", "telemetry.minimal", "nodes"],
            controller: Some(ControllerInfo {
                rotation: None,
                public_key: "ab".repeat(32),
                fingerprint: "3f2a:9c01".into(),
                listen: Some("0.0.0.0:7788".into()),
                advertise: vec!["box.lan:7788".into()],
            }),
        };
        assert_eq!(
            wire(&info),
            concat!(
                r#"{"api":1,"version":"0.13.0","mode":"controller","hostname":"box","#,
                r#""os":{"os":"linux","name":"NixOS","version":"25.11","arch":"x86_64","cpu":"AMD Ryzen 7","memory_bytes":64},"#,
                r#""uptime_secs":5,"os_uptime_secs":100,"booted_at":"2026-09-27T10:00:00Z","#,
                r#""role":{"mode":"controller","link":false,"self_update":false,"keep_awake":false,"#,
                r#""installer":false,"session":true,"session_in_service":true,"claude_update":false,"#,
                r#""tray":false,"status_on_lan":true,"api_socket":true,"node_listener":true},"#,
                r#""telemetry":"minimal","capabilities":["claude.remote_control","telemetry.minimal","nodes"],"#,
                r#""controller":{"public_key":"abababababababababababababababababababababababababababababababab","#,
                r#""fingerprint":"3f2a:9c01","listen":"0.0.0.0:7788","advertise":["box.lan:7788"],"rotation":null}}"#
            )
        );
        // Anywhere but the controller the block is absent, not null.
        let bare = SystemInfo {
            controller: None,
            ..info
        };
        assert!(!wire(&bare).contains("\"controller\":"));
        // A rotation under way: the key going forward, and where it came from.
        let rotating = ControllerInfo {
            public_key: "cd".repeat(32),
            fingerprint: "77aa:0102".into(),
            listen: None,
            advertise: vec![],
            rotation: Some(crate::link::rotation::RotationInfo {
                from_public_key: "ab".repeat(32),
                from_fingerprint: "3f2a:9c01".into(),
                started_at: "2026-09-28T10:00:00Z".into(),
                retires_at: "2026-10-05T10:00:00Z".into(),
                old_key_connections: 2,
            }),
        };
        assert_eq!(
            wire(&rotating),
            format!(
                concat!(
                    r#"{{"public_key":"{cd}","fingerprint":"77aa:0102","listen":null,"advertise":[],"#,
                    r#""rotation":{{"from_public_key":"{ab}","from_fingerprint":"3f2a:9c01","#,
                    r#""started_at":"2026-09-28T10:00:00Z","retires_at":"2026-10-05T10:00:00Z","old_key_connections":2}}}}"#
                ),
                cd = "cd".repeat(32),
                ab = "ab".repeat(32)
            )
        );
    }

    fn summary() -> NodeSummary {
        NodeSummary {
            id: "0123456789abcdef".into(),
            fingerprint: "0123:4567".into(),
            state: NodeState::Approved,
            connected: true,
            since: Some("2026-09-27T10:00:00Z".into()),
            last_seen: Some("2026-09-27T10:00:15Z".into()),
            hostname: Some("PC".into()),
            os: Some("windows".into()),
            arch: Some("x86_64".into()),
            agent_version: Some("0.14.0".into()),
            lan_ip: Some("192.168.0.120".into()),
            mac: Some("aa:bb:cc:dd:ee:ff".into()),
            claude: Some(Summary {
                state: "running".into(),
                sessions: 2,
                signed_in: true,
                ..Default::default()
            }),
        }
    }

    const SUMMARY: &str = concat!(
        r#""id":"0123456789abcdef","fingerprint":"0123:4567","state":"approved","connected":true,"#,
        r#""since":"2026-09-27T10:00:00Z","last_seen":"2026-09-27T10:00:15Z","hostname":"PC","#,
        r#""os":"windows","arch":"x86_64","agent_version":"0.14.0","lan_ip":"192.168.0.120","#,
        r#""mac":"aa:bb:cc:dd:ee:ff","claude":{"state":"running","detail":null,"cli_version":null,"#,
        r#""server_version":null,"sessions":2,"started_at":null,"signed_in":true}"#
    );

    #[test]
    fn nodes_list_and_get_on_the_wire() {
        assert_eq!(
            wire(&NodesList {
                nodes: vec![summary()]
            }),
            format!(r#"{{"nodes":[{{{SUMMARY}}}]}}"#)
        );
        let unseen = NodeSummary {
            state: NodeState::Unknown,
            connected: false,
            since: None,
            last_seen: None,
            hostname: None,
            os: None,
            arch: None,
            agent_version: None,
            lan_ip: None,
            mac: None,
            claude: None,
            ..summary()
        };
        assert_eq!(
            wire(&unseen),
            concat!(
                r#"{"id":"0123456789abcdef","fingerprint":"0123:4567","state":"unknown","connected":false,"#,
                r#""since":null,"last_seen":null,"hostname":null,"os":null,"arch":null,"agent_version":null,"#,
                r#""lan_ip":null,"mac":null,"claude":null}"#
            )
        );
        let detail = NodeDetail {
            node: summary(),
            public_key: "ab".repeat(32),
            hello: None,
            status: Some(serde_json::json!({"awake_hold": true})),
            status_at: Some("2026-09-27T10:00:15Z".into()),
            telemetry: None,
            telemetry_at: None,
            providers: None,
            providers_at: None,
        };
        assert_eq!(
            wire(&detail),
            format!(
                "{{{SUMMARY},{}}}",
                concat!(
                    r#""public_key":"abababababababababababababababababababababababababababababababab","#,
                    r#""hello":null,"status":{"awake_hold":true},"status_at":"2026-09-27T10:00:15Z","#,
                    r#""telemetry":null,"telemetry_at":null,"providers":null,"providers_at":null"#
                )
            )
        );
        assert_eq!(
            wire(&NodeTelemetry {
                id: "0123456789abcdef".into(),
                telemetry: None,
                received_at: None
            }),
            r#"{"id":"0123456789abcdef","telemetry":null,"received_at":null}"#
        );
        assert_eq!(
            wire(&NodeClaude {
                id: "0123456789abcdef".into(),
                report: None,
                received_at: Some("t".into())
            }),
            r#"{"id":"0123456789abcdef","report":null,"received_at":"t"}"#
        );
        assert_eq!(
            wire(&NodeProviders {
                id: "0123456789abcdef".into(),
                connected: false,
                providers: None,
                received_at: None
            }),
            r#"{"id":"0123456789abcdef","connected":false,"providers":null,"received_at":null}"#
        );
        let report = crate::providers::ProviderReport {
            kind: "lemonade".into(),
            port: 13305,
            version: Some("9.1.2".into()),
            running: true,
            healthy: true,
            loaded: vec![crate::providers::LoadedModel {
                id: "Gemma-4".into(),
                device: Some("gpu".into()),
                max_context: Some(65536),
                pinned: true,
            }],
            models: vec![crate::providers::ProviderModel {
                id: "Gemma-4".into(),
                labels: vec!["tool-calling".into()],
                downloaded: true,
                size_gb: Some(7.5),
                recipe: Some("llamacpp".into()),
            }],
            downloads: vec![crate::providers::ProviderDownload {
                model: "Qwen".into(),
                percent: Some(12.5),
                status: "downloading".into(),
            }],
            backends: vec![crate::providers::ProviderBackend {
                recipe: "llamacpp".into(),
                backend: "vulkan".into(),
                version: Some("b6000".into()),
                url: None,
            }],
            figures: vec![crate::providers::ModelFigures {
                model: "Gemma-4".into(),
                requests: Some(3.0),
                tps: Some(40.0),
                ..Default::default()
            }],
            read_at: "2026-09-28T10:00:00Z".into(),
            error: None,
            actions: vec![crate::providers::ProviderAction {
                request: "00112233445566ff".into(),
                model: "Gemma-4".into(),
                ok: true,
                message: "Loaded".into(),
                at: "2026-09-28T09:59:00Z".into(),
            }],
        };
        assert_eq!(
            wire(&NodeProviders {
                id: "0123456789abcdef".into(),
                connected: true,
                providers: Some(vec![report]),
                received_at: Some("2026-09-28T10:00:01Z".into())
            }),
            concat!(
                r#"{"id":"0123456789abcdef","connected":true,"providers":[{"kind":"lemonade","port":13305,"#,
                r#""version":"9.1.2","running":true,"healthy":true,"#,
                r#""loaded":[{"id":"Gemma-4","device":"gpu","max_context":65536,"pinned":true}],"#,
                r#""models":[{"id":"Gemma-4","labels":["tool-calling"],"downloaded":true,"size_gb":7.5,"recipe":"llamacpp"}],"#,
                r#""downloads":[{"model":"Qwen","percent":12.5,"status":"downloading"}],"#,
                r#""backends":[{"recipe":"llamacpp","backend":"vulkan","version":"b6000","url":null}],"#,
                r#""figures":[{"model":"Gemma-4","requests":3.0,"input_tokens":null,"output_tokens":null,"#,
                r#""tps":40.0,"ttft_ms":null,"device":null,"checkpoint":null}],"#,
                r#""read_at":"2026-09-28T10:00:00Z","error":null,"actions":[{"request":"00112233445566ff","model":"Gemma-4","ok":true,"message":"Loaded","at":"2026-09-28T09:59:00Z"}]}],"received_at":"2026-09-28T10:00:01Z"}"#
            )
        );
    }

    #[test]
    fn nodes_parameters_are_exact() {
        let id: NodeId = serde_json::from_value(json!({"id":"0123456789abcdef"})).unwrap();
        assert_eq!(id.id, "0123456789abcdef");
        assert!(serde_json::from_value::<NodeId>(json!({"id":"x","path":"/etc"})).is_err());
        assert!(serde_json::from_value::<NodeId>(json!({})).is_err());
        assert!(valid_node_id("0123456789abcdef"));
        for bad in [
            "0123456789ABCDEF",
            "0123456789abcde",
            "0123456789abcdeg",
            "../../etc/passwd",
        ] {
            assert!(!valid_node_id(bad), "{bad}");
        }

        let set: SetDesired = serde_json::from_value(json!({"nodes":[
            {"id":"0123456789abcdef","public_key":"ab","state":"approved",
             "policy":{"awake_hold":false,"claude_remote_control":true,"claude_workdir":"C:/p","santree":false,
                       "providers":{"lemonade":{"port":8000,"offer":true}}},
             "name":"Gaming PC"},
            {"id":"fedcba9876543210","public_key":"cd","state":"revoked"}
        ]}))
        .unwrap();
        assert_eq!(set.nodes[0].name.as_deref(), Some("Gaming PC"));
        assert_eq!(set.nodes[1].name, None);
        assert_eq!(set.nodes[1].state, DesiredState::Revoked);
        assert_eq!(set.nodes[1].policy, None);
        // `offer` is the controller's (metrics); the machine's policy leaves it out.
        assert_eq!(
            set.nodes[0]
                .policy
                .as_ref()
                .and_then(|p| p.providers.lemonade.as_ref())
                .and_then(|l| l.offer),
            Some(true)
        );
        let p: Policy = set.nodes[0].policy.clone().unwrap().into();
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"awake_hold":false,"claude_remote_control":true,"claude_workdir":"C:/p","providers":{"lemonade":{"port":8000}}}"#
        );
        for bad in [
            json!({"nodes":[{"id":"a","public_key":"b","state":"pending"}]}),
            json!({"nodes":[{"id":"a","public_key":"b","state":"approved","name":7}]}),
            json!({"nodes":[{"id":"a","public_key":"b","state":"approved","extra":1}]}),
            json!({"nodes":[{"id":"a","public_key":"b","state":"approved",
                             "policy":{"awake_hold":true,"claude_remote_control":true,"santree":false,"shell":"x"}}]}),
            json!({"nodes":[],"more":1}),
        ] {
            assert!(
                serde_json::from_value::<SetDesired>(bad.clone()).is_err(),
                "{bad}"
            );
        }

        let c: NodeCommand =
            serde_json::from_value(json!({"id":"0123456789abcdef","command":"claude_restart"}))
                .unwrap();
        assert_eq!(c.command, Command::ClaudeRestart);
        for bad in [
            json!({"id":"0123456789abcdef","command":"reboot"}),
            json!({"id":"0123456789abcdef","command":"check_update","args":["-rf"]}),
        ] {
            assert!(
                serde_json::from_value::<NodeCommand>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn nodes_answers_and_events_on_the_wire() {
        assert_eq!(
            wire(&SetDesiredOk {
                nodes: 2,
                approved: vec!["0123456789abcdef".into()],
                revoked: vec![],
                pending: vec![],
                policy: vec!["fedcba9876543210".into()],
            }),
            r#"{"nodes":2,"approved":["0123456789abcdef"],"revoked":[],"pending":[],"policy":["fedcba9876543210"]}"#
        );
        assert_eq!(
            wire(&CommandOk {
                delivered: true,
                queued: false
            }),
            r#"{"delivered":true,"queued":false}"#
        );
        assert_eq!(
            wire(&Event {
                e: event::NODES_CHANGED,
                p: NodeChanged {
                    id: "0123456789abcdef".into(),
                    state: NodeState::Pending,
                    connected: true
                }
            }),
            r#"{"e":"nodes.changed","p":{"id":"0123456789abcdef","state":"pending","connected":true}}"#
        );
        assert_eq!(
            wire(&Event {
                e: event::NODES_PENDING,
                p: NodePending {
                    id: "0123456789abcdef".into(),
                    fingerprint: "0123:4567".into(),
                    hostname: "PC".into()
                }
            }),
            r#"{"e":"nodes.pending","p":{"id":"0123456789abcdef","fingerprint":"0123:4567","hostname":"PC"}}"#
        );
    }

    #[test]
    fn claude_status_on_the_wire() {
        let silent = ClaudeStatus {
            reporting: false,
            wanted: true,
            report: None,
        };
        assert_eq!(
            wire(&silent),
            r#"{"reporting":false,"wanted":true,"report":null}"#
        );
        let r = Report {
            state: "running".into(),
            pid: Some(4242),
            recovered: vec![crate::claude::Recovered {
                id: "abdda3a9-0cb2-43f1-b13e-37f25a755fce".into(),
                result: crate::claude::ActionState::Done,
                detail: "resumed".into(),
                at: "t".into(),
            }],
            job: Some("daedalus-claude-rc".into()),
            reported_at: "2026-09-27T10:00:00Z".into(),
            ..Default::default()
        };
        let live = ClaudeStatus {
            reporting: true,
            wanted: true,
            report: Some(r),
        };
        assert_eq!(
            wire(&live),
            concat!(
                r#"{"reporting":true,"wanted":true,"report":{"#,
                r#""path":null,"install_method":null,"cli_version":null,"last_update":null,"#,
                r#""state":"running","detail":null,"pid":4242,"started_at":null,"restarts":0,"#,
                r#""last_exit":null,"#,
                r#""server":{"version":null,"environment_id":null,"spawn_mode":null,"max_sessions":null},"#,
                r#""sessions":[],"recovered":[{"id":"abdda3a9-0cb2-43f1-b13e-37f25a755fce","result":"done","detail":"resumed","at":"t"}],"#,
                r#""credentials":{"present":false,"store":null,"subscription_type":null,"#,
                r#""rate_limit_tier":null,"expires_at":null,"refresh_expires_at":null,"scopes":[]},"#,
                r#""settings":{"model":null,"effort_level":null},"#,
                r#""user":null,"home":null,"workdir":null,"workdir_via":null,"log":null,"job":"daedalus-claude-rc","#,
                r#""reported_at":"2026-09-27T10:00:00Z"}}"#
            )
        );
    }

    /// A roster with one of everything: every field the app reads, pinned.
    pub fn roster() -> Roster {
        use crate::claude::roster::*;
        use crate::claude::ActionState;
        use crate::jobs::UnitCost;
        Roster {
            reported_at: "2026-09-27T10:00:00Z".into(),
            agents_available: true,
            agents: vec![Agent {
                id: Some("0a1b2c3d".into()),
                session_id: Some("abdda3a9-0cb2-43f1-b13e-37f25a755fce".into()),
                pid: None,
                kind: Some("background".into()),
                state: Some("blocked".into()),
                status: None,
                name: Some("nixos-7a".into()),
                cwd: Some("/etc/nixos".into()),
                started_at: Some(1),
            }],
            transcripts: vec![Transcript {
                id: "abdda3a9-0cb2-43f1-b13e-37f25a755fce".into(),
                project: "-etc-nixos".into(),
                cwd: "/etc/nixos".into(),
                cwd_exact: true,
                title: Some("Fix the build".into()),
                title_source: Some("custom-title".into()),
                started_at: Some(2),
                modified_at: 3000,
                size_bytes: 4,
                meta: Some(Meta {
                    exchanges: 5,
                    replies: 6,
                    thinking: 7,
                    images: 0,
                    attached: 1,
                    subagents: None,
                    span_ms: Some(8),
                    branch: Some("main".into()),
                    cli_version: Some("2.1.281".into()),
                    last_prompt: Some("ship it".into()),
                    cost: Some(Cost {
                        usd: serde_json::Number::from_f64(1.5),
                        lines_added: Some(9.into()),
                        lines_removed: None,
                        duration_ms: None,
                    }),
                }),
            }],
            transcript_total: 1,
            empty_count: 2,
            truncated: false,
            managed: vec![Managed {
                id: "bbdda3a9-0cb2-43f1-b13e-37f25a755fce".into(),
                job: "claude-session-bbdda3a9-0cb2-43f1-b13e-37f25a755fce".into(),
                pid: Some(42),
                memory_bytes: Some(10),
                cpu_nsec: None,
                log: "/l".into(),
                log_bytes: Some(11),
            }],
            session_stats: vec![SessionStat {
                pid: 42,
                cpu_ms: Some(12),
                rss_bytes: Some(13),
                log_bytes: None,
                bridge_at: None,
            }],
            server: Some(UnitCost {
                memory_bytes: Some(14),
                cpu_nsec: Some(15),
            }),
            actions: vec![ActionResult {
                request: "00112233445566ff".into(),
                action: SessionAction::Stop,
                id: "0a1b2c3d".into(),
                state: ActionState::Done,
                detail: "stopped".into(),
                started_at: "t0".into(),
                finished_at: Some("t1".into()),
            }],
            errors: vec![],
        }
    }

    pub const ROSTER: &str = concat!(
        r#"{"reported_at":"2026-09-27T10:00:00Z","agents_available":true,"#,
        r#""agents":[{"id":"0a1b2c3d","session_id":"abdda3a9-0cb2-43f1-b13e-37f25a755fce","pid":null,"#,
        r#""kind":"background","state":"blocked","status":null,"name":"nixos-7a","cwd":"/etc/nixos","started_at":1}],"#,
        r#""transcripts":[{"id":"abdda3a9-0cb2-43f1-b13e-37f25a755fce","project":"-etc-nixos","cwd":"/etc/nixos","#,
        r#""cwd_exact":true,"title":"Fix the build","title_source":"custom-title","started_at":2,"#,
        r#""modified_at":3000,"size_bytes":4,"meta":{"exchanges":5,"replies":6,"thinking":7,"images":0,"#,
        r#""attached":1,"subagents":null,"span_ms":8,"branch":"main","cli_version":"2.1.281","#,
        r#""last_prompt":"ship it","cost":{"usd":1.5,"lines_added":9,"lines_removed":null,"duration_ms":null}}}],"#,
        r#""transcript_total":1,"empty_count":2,"truncated":false,"#,
        r#""managed":[{"id":"bbdda3a9-0cb2-43f1-b13e-37f25a755fce","job":"claude-session-bbdda3a9-0cb2-43f1-b13e-37f25a755fce","#,
        r#""pid":42,"memory_bytes":10,"cpu_nsec":null,"log":"/l","log_bytes":11}],"#,
        r#""session_stats":[{"pid":42,"cpu_ms":12,"rss_bytes":13,"log_bytes":null,"bridge_at":null}],"#,
        r#""server":{"memory_bytes":14,"cpu_nsec":15},"#,
        r#""actions":[{"request":"00112233445566ff","action":"stop","id":"0a1b2c3d","state":"done","#,
        r#""detail":"stopped","started_at":"t0","finished_at":"t1"}],"errors":[]}"#
    );

    #[test]
    fn claude_roster_and_session_on_the_wire() {
        assert_eq!(
            wire(&ClaudeRosterGet {
                reporting: true,
                roster: Some(roster())
            }),
            format!(r#"{{"reporting":true,"roster":{ROSTER}}}"#)
        );
        assert_eq!(
            wire(&ClaudeRosterGet {
                reporting: false,
                roster: None
            }),
            r#"{"reporting":false,"roster":null}"#
        );
        // What travels comes back as it went (the link's push, the POST).
        let back: Roster = serde_json::from_str(ROSTER).unwrap();
        assert_eq!(back, roster());

        let s: ClaudeSession = serde_json::from_value(
            json!({"action":"resume","id":"abdda3a9-0cb2-43f1-b13e-37f25a755fce"}),
        )
        .unwrap();
        assert_eq!(s.action, SessionAction::Resume);
        for bad in [
            json!({"action":"resume"}),
            json!({"action":"fork","id":"x"}),
            json!({"action":"resume","id":"x","cwd":"/"}),
            json!({"action":"remove","id":"x","discard_unpushed":true}),
        ] {
            assert!(
                serde_json::from_value::<ClaudeSession>(bad.clone()).is_err(),
                "{bad}"
            );
        }
        assert_eq!(
            wire(&SessionQueued {
                queued: true,
                request: "00112233445566ff".into()
            }),
            r#"{"queued":true,"request":"00112233445566ff"}"#
        );

        assert_eq!(
            wire(&NodeClaudeRoster {
                id: "0123456789abcdef".into(),
                roster: Some(roster()),
                received_at: Some("t".into())
            }),
            format!(r#"{{"id":"0123456789abcdef","roster":{ROSTER},"received_at":"t"}}"#)
        );
        let n: NodeClaudeSession = serde_json::from_value(
            json!({"id":"0123456789abcdef","action":"stop","session":"0a1b2c3d"}),
        )
        .unwrap();
        assert_eq!(
            (n.action, n.session.as_str()),
            (SessionAction::Stop, "0a1b2c3d")
        );
        assert!(serde_json::from_value::<NodeClaudeSession>(
            json!({"id":"0123456789abcdef","action":"stop","session":"0a1b2c3d","args":[]})
        )
        .is_err());
        assert_eq!(
            wire(&ClaudeSessionSent {
                delivered: true,
                request: "00112233445566ff".into()
            }),
            r#"{"delivered":true,"request":"00112233445566ff"}"#
        );
    }

    #[test]
    fn restart_subscribe_and_events_on_the_wire() {
        assert_eq!(wire(&Queued { queued: true }), r#"{"queued":true}"#);
        assert_eq!(wire(&Subscribed {}), r#"{}"#);
        assert_eq!(
            wire(&Event {
                e: event::CLAUDE_CHANGED,
                p: ClaudeChanged {
                    reporting: true,
                    state: Some("starting".into()),
                    pid: Some(7)
                }
            }),
            r#"{"e":"claude.changed","p":{"reporting":true,"state":"starting","pid":7}}"#
        );
        assert_eq!(
            wire(&Event {
                e: event::CLAUDE_CHANGED,
                p: ClaudeChanged {
                    reporting: false,
                    state: None,
                    pid: None
                }
            }),
            r#"{"e":"claude.changed","p":{"reporting":false,"state":null,"pid":null}}"#
        );
        assert_eq!(
            wire(&Event {
                e: event::TELEMETRY_UPDATED,
                p: TelemetryUpdated {
                    sampled_at: "2026-09-27T10:00:15Z".into()
                }
            }),
            r#"{"e":"telemetry.updated","p":{"sampled_at":"2026-09-27T10:00:15Z"}}"#
        );
    }

    #[test]
    fn telemetry_get_on_the_wire() {
        assert_eq!(
            wire(&TelemetryGet {
                level: TelemetryLevel::Off,
                telemetry: None
            }),
            r#"{"level":"off","telemetry":null}"#
        );
        // The document itself is telemetry/model.rs's, pinned here at the
        // minimal level: the keys the app reads, every one of them.
        let t = Telemetry {
            sampled_at: "2026-09-27T10:00:15Z".into(),
            ..Default::default()
        }
        .minimal();
        assert_eq!(
            wire(&TelemetryGet {
                level: TelemetryLevel::Minimal,
                telemetry: Some(t)
            }),
            concat!(
                r#"{"level":"minimal","telemetry":{"sampled_at":"2026-09-27T10:00:15Z","#,
                r#""machine":{"manufacturer":null,"model":null,"chip":null,"bios_vendor":null,"#,
                r#""bios_version":null,"bios_date":null,"board_manufacturer":null,"board_product":null,"#,
                r#""form":null,"target":null},"#,
                r#""os":{"kernel":null,"build":null,"installed_at":null},"#,
                r#""cpu":{"model":null,"cores":null,"threads":null,"frequency_mhz":null,"usage_pct":null,"#,
                r#""load":null,"temperature_c":null},"#,
                r#""memory":{"total_bytes":null,"used_bytes":null,"available_bytes":null,"cached_bytes":null,"#,
                r#""compressed_bytes":null,"committed_bytes":null,"commit_limit_bytes":null,"#,
                r#""swap_total_bytes":null,"swap_used_bytes":null,"slots":null,"max_capacity_bytes":null,"#,
                r#""modules":[]},"#,
                r#""disks":[],"drives":[],"gpus":[],"temperatures":[],"network":[],"battery":null,"#,
                r#""processes":[],"process_count":null,"services":[],"service_count":null,"#,
                r#""browsers":[],"apps":[],"app_count":null,"updates":null,"errors":[]}}"#
            )
        );
    }

    #[test]
    fn santree_in_the_desired_set_and_the_status_on_the_wire() {
        let entry = |policy: Value| json!({"nodes":[{"id":"0123456789abcdef","public_key":"ab","state":"approved","policy":policy}]});
        // Required: a set that leaves it out is refused.
        assert!(serde_json::from_value::<SetDesired>(entry(
            json!({"awake_hold":true,"claude_remote_control":true}),
        ))
        .is_err());
        let set: SetDesired = serde_json::from_value(entry(
            json!({"awake_hold":true,"claude_remote_control":true,"santree":true}),
        ))
        .unwrap();
        let p: Policy = set.nodes[0].policy.clone().unwrap().into();
        assert!(p.santree);
        assert_eq!(
            p.session_host, None,
            "the controller fills it, never the app"
        );
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"awake_hold":true,"claude_remote_control":true,"santree":true}"#
        );
        // The app cannot name the session host, nor anything else.
        for bad in [
            json!({"awake_hold":true,"claude_remote_control":true,"santree":"yes"}),
            json!({"awake_hold":true,"claude_remote_control":true,"santree":true,
                   "session_host":{"address":"evil.example:1","public_key":"00"}}),
        ] {
            assert!(
                serde_json::from_value::<SetDesired>(entry(bad.clone())).is_err(),
                "{bad}"
            );
        }

        let status = SantreeStatus {
            state: SessionHostState::Running,
            version: Some("0.1.0".into()),
            restart_pending: false,
            live_ptys: 3,
            connections: vec![SantreeConnections {
                node: "0123456789abcdef".into(),
                name: Some("MacBook".into()),
                count: 2,
            }],
            error: None,
        };
        assert_eq!(
            wire(&status),
            concat!(
                r#"{"state":"running","version":"0.1.0","restart_pending":false,"live_ptys":3,"#,
                r#""connections":[{"node":"0123456789abcdef","name":"MacBook","count":2}],"error":null}"#
            )
        );
        for (s, w) in [
            (SessionHostState::Stale, "stale"),
            (SessionHostState::Stopped, "stopped"),
            (SessionHostState::Missing, "missing"),
        ] {
            assert_eq!(wire(&s), format!("\"{w}\""));
        }
    }
}
