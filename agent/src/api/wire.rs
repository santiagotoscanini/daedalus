//! The local API's wire types: every request, answer and event, as serde
//! writes them. This file is the contract — the app's TypeScript client is
//! generated from these types (ts.rs: each type, the `Methods` map from
//! `ApiRequest`, the `ApiEvent` union and the constants), and the golden
//! tests at the bottom pin each one's exact JSON and write it beside the
//! generated types, where the app's tests read it.
//!
//! Framing (controller/api/mod.rs has the rest): one JSON object per line.
//!
//! ```text
//! → {"id":1,"m":"hello","p":{"api":1,"client":"daedalus-app/2026.9"}}
//! ← {"id":1,"ok":{"api":1,"version":"0.13.0","mode":"controller",…}}
//! → {"id":2,"m":"claude.restart"}
//! ← {"id":2,"err":{"code":"unavailable","msg":"…"}}
//! ← {"e":"nodes.left","p":{"id":"0123456789abcdef"}}
//! ```
//!
//! A method's parameters are exact: its own fields and nothing else, and
//! none at all for a method that takes none (`ApiRequest`). Only `hello`'s
//! are lenient — a newer app may send more, and must still be told which
//! version this agent speaks.

use serde::{Deserialize, Serialize};

use crate::claude::{Report, Roster, SessionAction, Summary};
use crate::core::config::{Mode, TelemetryLevel};
use crate::core::role::Role;
use crate::core::status::StatusDocument;
use crate::link::wire::{Command, Hello, NodeState, Policy, PolicyRequest};
use crate::node::providers::ProviderReport;
use crate::telemetry::Telemetry;

/// What an agent offers, from its role and config (api/mod.rs
/// `capabilities`): a method whose capability is absent answers
/// `unsupported`. `unknown`: a newer machine's word, read in its hello.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Capability {
    /// Claude remote control runs in the user's session (`claude.status`,
    /// `claude.restart`).
    #[serde(rename = "claude.remote_control")]
    ClaudeRemoteControl,
    /// The agent updates Claude Code (never on the controller: nix pins it).
    #[serde(rename = "claude.update")]
    ClaudeUpdate,
    /// The roster of Claude sessions and their verbs.
    #[serde(rename = "claude.sessions")]
    ClaudeSessions,
    #[serde(rename = "telemetry.full")]
    TelemetryFull,
    #[serde(rename = "telemetry.minimal")]
    TelemetryMinimal,
    /// A machine reads its providers and drives their residency for the box.
    #[serde(rename = "providers.residency")]
    ProvidersResidency,
    /// The controller listens for machines (`nodes.*`).
    #[serde(rename = "nodes")]
    Nodes,
    /// The controller reaches the root helper (`root.*`).
    #[serde(rename = "root")]
    Root,
    /// The controller follows a session host (`santree.status`).
    #[serde(rename = "santree")]
    Santree,
    /// The controller holds its link key (`controller.rotate`).
    #[serde(rename = "controller")]
    Controller,
    #[serde(rename = "unknown", other)]
    Unknown,
}

impl std::fmt::Display for Capability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        crate::util::wire_name(self, f)
    }
}

/// The API's methods, each with its parameters and its answer — the one
/// list: `ApiRequest` is read from it, and ts.rs writes the app's `Methods`
/// map from it (`signatures`).
macro_rules! api_methods {
    ($( $(#[$doc:meta])* $wire:literal => $variant:ident $(($params:ty))? : $answer:ty ),* $(,)?) => {
        crate::ipc::rpc::methods! {
            /// One request to the API (controller/api/mod.rs's table).
            #[derive(Clone, Debug, Deserialize)]
            pub enum ApiRequest {
                $( $(#[$doc])* $wire => $variant $(($params))? ),*
            }
        }

        /// Each method: its name, the TypeScript of its parameters (None:
        /// it takes none) and of its answer.
        #[cfg(test)]
        pub fn signatures(cfg: &ts_rs::Config) -> Vec<(&'static str, Option<String>, String)> {
            use ts_rs::TS;
            vec![$( ($wire, None::<String>$(.or(Some(<$params>::name(cfg))))?, <$answer>::name(cfg)) ),*]
        }
    };
}

api_methods! {
    /// First on every connection.
    "hello" => Hello(HelloParams): HelloOk,
    /// The events follow on the same connection.
    "events.subscribe" => EventsSubscribe: Subscribed,
    "system.info" => SystemInfo: SystemInfo,
    "claude.status" => ClaudeStatus: ClaudeStatus,
    "claude.restart" => ClaudeRestart: Queued,
    "claude.roster" => ClaudeRoster: ClaudeRosterGet,
    "claude.session" => ClaudeSession(ClaudeSession): SessionQueued,
    "telemetry.get" => TelemetryGet: TelemetryGet,
    /// How a verb request stands, from the document that reports it.
    "actions.get" => ActionsGet(ActionQuery): Option<ActionOutcome>,
    "nodes.list" => NodesList: NodesList,
    "nodes.get" => NodesGet(NodeGet): NodeDetail,
    "nodes.providers" => NodesProviders(NodeId): NodeProviders,
    "nodes.claude" => NodesClaude(NodeId): NodeClaude,
    "nodes.claude_roster" => NodesClaudeRoster(NodeId): NodeClaudeRoster,
    "nodes.claude_session" => NodesClaudeSession(NodeClaudeSession): ClaudeSessionSent,
    "nodes.provider_model" => NodesProviderModel(NodeProviderModel): ProviderModelSent,
    "nodes.set_desired" => NodesSetDesired(SetDesired): SetDesiredOk,
    "nodes.command" => NodesCommand(NodeCommand): CommandOk,
    "controller.rotate" => ControllerRotate(ControllerRotate): ControllerInfo,
    "root.run" => RootRun(RootRun): RootRunOk,
    "root.follow" => RootFollow(RootFollow): RootFollowOk,
    "root.runs" => RootRuns(RootRuns): RootRunsOk,
    "santree.status" => SantreeStatus: SantreeStatus,
}

/// An event, pushed to a connection that asked for them
/// (`events.subscribe`): what moved, for the app to act on.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "e", content = "p")]
pub enum ApiEvent {
    /// An approved machine logged out and asks to be forgotten.
    #[serde(rename = "nodes.left")]
    NodesLeft(NodeLeft),
    /// An approved machine's user asks to change one of its settings: the
    /// app decides, and its next set carries it.
    #[serde(rename = "nodes.policy_request")]
    NodesPolicyRequest(NodePolicyRequest),
}

// ── the methods ───────────────────────────────────────────────────────────

/// `hello`'s parameters: the version the client speaks, and who it is (for
/// the log, and required). Other fields are ignored, and a missing `client`
/// is refused only after the version is checked (conn.rs), so a newer client
/// is always told which version this agent speaks.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct HelloParams {
    pub api: u32,
    #[serde(default)]
    pub client: String,
}

/// `hello`'s answer.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HelloOk {
    pub api: u32,
    pub version: String,
    pub mode: Mode,
    pub hostname: String,
    pub capabilities: Vec<Capability>,
}

/// The operating system and the machine, as `system.info` states them.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct OsInfo {
    /// "linux", "windows", "macos".
    pub os: String,
    /// "NixOS"; empty when unknown.
    pub name: String,
    /// "25.11"; empty when unknown.
    pub version: String,
    /// "x86_64", "aarch64".
    pub arch: String,
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
    pub capabilities: Vec<Capability>,
    /// The controller's own key and where machines reach it; null anywhere
    /// but the controller.
    pub controller: Option<ControllerInfo>,
}

/// A rotation under way, as `system.info` states it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RotationInfo {
    /// The key being retired, hex, and its fingerprint.
    pub from_public_key: String,
    pub from_fingerprint: String,
    /// RFC 3339.
    pub started_at: String,
    /// When the old key is retired, RFC 3339 (wall-clock time).
    pub retires_at: String,
    /// Machines connected under the old key now: each has been sent the
    /// statement, and one that stays is an agent that does not know it.
    pub old_key_connections: u32,
}

/// The controller as `system.info` states it: the key every machine pins,
/// as hex and as its fingerprint (identity.rs), the address its listener
/// is bound to (null when it listens for no machine), and the `host:port`s
/// config.toml says machines should dial — what the app hands an install
/// command — and, while its key is rotated, where the key came from
/// (controller/rotation.rs; `public_key` is then the new key, the one to pin).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ControllerInfo {
    pub public_key: String,
    pub fingerprint: String,
    pub listen: Option<String>,
    pub advertise: Vec<String>,
    /// The rotation under way; null when none is.
    pub rotation: Option<RotationInfo>,
}

// ── the machines (controller/link/) ─────────────────────────────────────

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
    /// What shape the machine is ("laptop", "desktop", …) and its model —
    /// the board's product where the firmware names one, else the
    /// machine's — from its last telemetry; null without one.
    pub form: Option<String>,
    pub model: Option<String>,
    /// Its status document, as it last pushed it, and when.
    pub status: Option<StatusDocument>,
    pub status_at: Option<String>,
}

/// `nodes.list`'s answer.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
pub struct NodesList {
    pub nodes: Vec<NodeSummary>,
}

/// `nodes.get`'s answer: the summary, the key and the whole hello; with
/// `full`, the telemetry the machine last pushed (the full document, at its
/// level) and its providers document — null otherwise, and null until the
/// machine has pushed one.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
pub struct NodeDetail {
    #[serde(flatten)]
    pub node: NodeSummary,
    pub public_key: String,
    pub hello: Option<Hello>,
    pub telemetry: Option<Telemetry>,
    pub telemetry_at: Option<String>,
    pub providers: Option<Vec<ProviderReport>>,
    pub providers_at: Option<String>,
}

/// `nodes.providers`'s answer: the machine's providers as it last pushed
/// them (providers/), null until it has, and when they arrived.
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
    pub kind: crate::node::providers::ProviderKind,
    pub action: crate::node::providers::ModelAction,
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

/// `nodes.get`'s parameters: the machine, and whether its telemetry and
/// providers document ride along (`full`).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "NodeGetParams"))]
pub struct NodeGet {
    pub id: String,
    #[serde(default)]
    pub full: bool,
}

/// The parameters of `nodes.providers`, `nodes.claude` and
/// `nodes.claude_roster`.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "NodeIdParams"))]
pub struct NodeId {
    pub id: String,
}

/// `actions.get`'s parameters: a verb's request id, as `claude.session`,
/// `nodes.claude_session` or `nodes.provider_model` answered it, and the
/// machine it went to — absent for the controller's own session.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "ActionQueryParams"))]
pub struct ActionQuery {
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub node: Option<String>,
    pub request: String,
}

/// How a verb request stands, whichever document reports it — a session
/// verb in the roster's `actions`, a residency verb in the providers'.
/// `actions.get` answers null while neither lists it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ActionOutcome {
    pub state: crate::claude::ActionState,
    /// What was done, or why not, in the machine's own words.
    pub detail: String,
}

impl ActionOutcome {
    /// The request's outcome in a roster or a providers document, if either
    /// lists it.
    pub fn find(
        request: &str,
        roster: Option<&Roster>,
        providers: Option<&[ProviderReport]>,
    ) -> Option<ActionOutcome> {
        let session = roster
            .into_iter()
            .flat_map(|r| &r.actions)
            .find(|a| a.request == request)
            .map(|a| ActionOutcome {
                state: a.state,
                detail: a.detail.clone(),
            });
        session.or_else(|| {
            providers
                .into_iter()
                .flatten()
                .flat_map(|p| &p.actions)
                .find(|a| a.request == request)
                .map(|a| ActionOutcome {
                    state: if a.ok {
                        crate::claude::ActionState::Done
                    } else {
                        crate::claude::ActionState::Failed
                    },
                    detail: a.message.clone(),
                })
        })
    }
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

/// A machine's policy as the app hands it over: the policy the machine is
/// sent (link/wire.rs `Policy` — its `session_host` is the controller's to
/// fill, and refused here), and what only the controller keeps for
/// `/nodes/metrics`: whether the app offers the machine's lemonade to the
/// gateway, and whether the machine's link going down should alert
/// (`daedalus_agent_link_alert`; on unless the app says otherwise).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesiredPolicy {
    pub policy: Policy,
    #[serde(default)]
    pub offer_lemonade: bool,
    #[serde(default = "alert_link_default")]
    pub alert_link: bool,
}

const fn alert_link_default() -> bool {
    true
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
/// the old one retires, in seconds (controller/rotation.rs `GRACE_MIN` to
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

/// How a verb ended.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "RootOutcome"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// The unit ran and exited 0.
    Done,
    /// The unit (or the helper: already running) declined; `detail` says why.
    Refused,
    /// The unit failed, or gave no result in time.
    Failed,
}

/// One verb as `status` states it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "RootVerb"))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerbState {
    pub verb: String,
    pub unit: String,
    pub description: String,
    pub selectors: std::collections::BTreeMap<String, Vec<String>>,
    /// Pattern selector → its regex.
    pub patterns: std::collections::BTreeMap<String, String>,
    /// The largest payload it takes, if it takes one.
    pub payload_max: Option<usize>,
    /// The unit's `ActiveState` — a template's is `activating` while an
    /// instance runs, else `inactive`; null when systemd could not be asked
    /// or the unit has a selector in its name.
    pub active_state: Option<String>,
    /// Its `Result` from the last run.
    pub result: Option<String>,
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
    /// Answer once the unit has started rather than when it has finished;
    /// its lines and outcome are then `root.follow`'s.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub detach: Option<bool>,
}

/// Never the payload, whatever prints the parameters.
impl std::fmt::Debug for RootRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RootRun")
            .field("verb", &self.verb)
            .field("detach", &self.detach)
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

/// `root.run`'s answer: how the verb ended, with the run's id (`root.follow`
/// takes it) and, for `status`, every verb. `outcome` is null only for a `detach` run that
/// started and goes on.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RootRunOk {
    pub run: String,
    pub verb: String,
    pub outcome: Option<Outcome>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub verbs: Option<Vec<VerbState>>,
}

/// `root.follow`'s parameters: a run, and the last line the caller has.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "RootFollowParams"))]
pub struct RootFollow {
    pub run: String,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub after: Option<u64>,
}

/// A run the controller holds (root/runs.rs), without its lines. Times are
/// RFC 3339; `outcome` is null while it runs.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RootRunSummary {
    pub run: String,
    pub verb: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    /// The helper started the verb's unit.
    pub started: bool,
    pub outcome: Option<Outcome>,
    pub detail: String,
}

/// One line a run's unit wrote, numbered from 1.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RootLine {
    pub seq: u64,
    pub line: String,
}

/// `root.follow`'s answer: the run, its lines past `after` (at most a page;
/// `more` when others wait), `next` to ask from, and `dropped` when lines
/// past `after` were already forgotten.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RootFollowOk {
    pub run: RootRunSummary,
    pub lines: Vec<RootLine>,
    pub next: u64,
    pub more: bool,
    pub dropped: bool,
}

/// `root.runs`'s parameters: one verb.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, ts(rename = "RootRunsParams"))]
pub struct RootRuns {
    pub verb: String,
}

/// `root.runs`'s answer: the verb's runs the controller holds, newest first.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RootRunsOk {
    pub runs: Vec<RootRunSummary>,
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

/// `claude.roster`'s answer: the session's last roster (claude/roster/)
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

/// One answer of each method, each event and an error, as the agent writes
/// them — the golden tests' own values. ts.rs writes them beside the
/// generated types (`fixtures/<name>.json`), where the app's tests decode
/// every one with the decoder its method names.
#[cfg(all(test, feature = "controller"))]
pub(crate) fn fixtures() -> Vec<(String, String)> {
    use crate::claude::Session;
    use tests::{provider_report, report, roster, summary};
    fn v<T: Serialize>(x: &T) -> String {
        serde_json::to_string_pretty(x).expect("a fixture serialises")
    }
    let id = "0123456789abcdef".to_string();
    let rotating = ControllerInfo {
        public_key: "cd".repeat(32),
        fingerprint: "77aa:0102".into(),
        listen: Some("0.0.0.0:7788".into()),
        advertise: vec!["box.lan:7788".into()],
        rotation: Some(RotationInfo {
            from_public_key: "ab".repeat(32),
            from_fingerprint: "3f2a:9c01".into(),
            started_at: "2026-09-28T10:00:00Z".into(),
            retires_at: "2026-10-05T10:00:00Z".into(),
            old_key_connections: 2,
        }),
    };
    let mut status = StatusDocument {
        agent: crate::SERVICE_NAME.into(),
        version: "0.25.0".into(),
        hostname: "PC".into(),
        awake_hold: true,
        claude: Some(report().summary()),
        controller: Some(crate::link::LinkStatus {
            address: Some("box.lan:7788".into()),
            found_via: Some(crate::link::FoundVia::Config),
            state: Some(crate::link::LinkState::Approved),
            connected: true,
            fingerprint: "0123:4567".into(),
            ..Default::default()
        }),
        ..Default::default()
    };
    status.facts.os = "windows".into();
    status.state.last_update_check = Some("2026-09-27T10:00:00Z".into());
    let listed = NodeSummary {
        form: Some("desktop".into()),
        model: Some("B650 AORUS ELITE AX".into()),
        status: Some(status),
        status_at: Some("2026-09-27T10:00:15Z".into()),
        ..summary()
    };
    let telemetry = crate::telemetry::Telemetry {
        sampled_at: "2026-09-27T10:00:15Z".into(),
        ..Default::default()
    };
    let mut live = report();
    live.sessions = vec![Session {
        pid: 42,
        transcript_id: Some("abdda3a9-0cb2-43f1-b13e-37f25a755fce".into()),
        alive: true,
        ..Default::default()
    }];
    let run = RootRunSummary {
        run: "00112233445566ff".into(),
        verb: "build".into(),
        started_at: "2026-09-27T10:00:00Z".into(),
        finished_at: Some("2026-09-27T10:01:00Z".into()),
        started: true,
        outcome: Some(Outcome::Failed),
        detail: "fence".into(),
    };
    let answers = vec![
        ("hello", v(&tests::hello_ok())),
        ("events.subscribe", v(&Subscribed {})),
        ("system.info", v(&tests::system_info())),
        (
            "claude.status",
            v(&ClaudeStatus {
                reporting: true,
                wanted: true,
                report: Some(live.clone()),
            }),
        ),
        ("claude.restart", v(&Queued { queued: true })),
        (
            "claude.roster",
            v(&ClaudeRosterGet {
                reporting: true,
                roster: Some(roster()),
            }),
        ),
        (
            "claude.session",
            v(&SessionQueued {
                queued: true,
                request: "00112233445566ff".into(),
            }),
        ),
        (
            "telemetry.get",
            v(&TelemetryGet {
                level: TelemetryLevel::Minimal,
                telemetry: Some(telemetry.minimal()),
            }),
        ),
        (
            "actions.get",
            v(&ActionOutcome::find(
                "00112233445566ff",
                None,
                Some(&[provider_report()]),
            )),
        ),
        (
            "nodes.list",
            v(&NodesList {
                nodes: vec![listed.clone()],
            }),
        ),
        (
            "nodes.get",
            v(&NodeDetail {
                node: listed,
                public_key: "ab".repeat(32),
                hello: Some(crate::link::wire::tests::hello()),
                telemetry: Some(telemetry.clone()),
                telemetry_at: Some("2026-09-27T10:00:15Z".into()),
                providers: Some(vec![provider_report()]),
                providers_at: Some("2026-09-28T10:00:01Z".into()),
            }),
        ),
        (
            "nodes.providers",
            v(&NodeProviders {
                id: id.clone(),
                connected: true,
                providers: Some(vec![provider_report()]),
                received_at: Some("2026-09-28T10:00:01Z".into()),
            }),
        ),
        (
            "nodes.claude",
            v(&NodeClaude {
                id: id.clone(),
                report: Some(live),
                received_at: Some("t".into()),
            }),
        ),
        (
            "nodes.claude_roster",
            v(&NodeClaudeRoster {
                id: id.clone(),
                roster: Some(roster()),
                received_at: Some("t".into()),
            }),
        ),
        (
            "nodes.claude_session",
            v(&ClaudeSessionSent {
                delivered: true,
                request: "00112233445566ff".into(),
            }),
        ),
        (
            "nodes.provider_model",
            v(&ProviderModelSent {
                delivered: true,
                request: "00112233445566ff".into(),
            }),
        ),
        (
            "nodes.set_desired",
            v(&SetDesiredOk {
                nodes: 2,
                approved: vec![id.clone()],
                ..Default::default()
            }),
        ),
        (
            "nodes.command",
            v(&CommandOk {
                delivered: true,
                queued: false,
            }),
        ),
        ("controller.rotate", v(&rotating)),
        (
            "root.run",
            v(&RootRunOk {
                run: "00112233445566ff".into(),
                verb: "status".into(),
                outcome: Some(Outcome::Done),
                detail: "1 verb".into(),
                verbs: Some(vec![VerbState {
                    verb: "deploy".into(),
                    unit: "app-%i-deploy.service".into(),
                    description: "Deploy one app".into(),
                    selectors: [("app".to_string(), vec!["iris".to_string()])].into(),
                    patterns: Default::default(),
                    payload_max: None,
                    active_state: Some("inactive".into()),
                    result: Some("success".into()),
                }]),
            }),
        ),
        (
            "root.follow",
            v(&RootFollowOk {
                run: run.clone(),
                lines: vec![RootLine {
                    seq: 2,
                    line: "two".into(),
                }],
                next: 2,
                more: false,
                dropped: false,
            }),
        ),
        ("root.runs", v(&RootRunsOk { runs: vec![run] })),
        ("santree.status", v(&tests::santree_status())),
    ];
    let mut out: Vec<(String, String)> = answers
        .into_iter()
        .map(|(m, a)| (m.to_string(), a))
        .collect();
    out.push((
        "event.nodes.left".into(),
        v(&ApiEvent::NodesLeft(NodeLeft { id: id.clone() })),
    ));
    out.push((
        "event.nodes.policy_request".into(),
        v(&ApiEvent::NodesPolicyRequest(NodePolicyRequest {
            id,
            changes: PolicyRequest {
                santree: Some(false),
                ..Default::default()
            },
        })),
    ));
    out.push((
        "error.version".into(),
        v(&crate::ipc::rpc::Response::err(
            Some(1),
            crate::ipc::rpc::ApiError {
                supported: Some(crate::api::API_VERSION),
                ..crate::ipc::rpc::ApiError::new(
                    crate::ipc::rpc::ErrorCode::Version,
                    "this agent speaks api 1",
                )
            },
        )),
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::rpc::{ApiError, ErrorCode, Incoming, Response};
    use serde_json::{json, Value};

    fn wire<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).unwrap()
    }

    /// One line as the API reads it: the envelope, then the method.
    fn request(line: &str) -> Result<ApiRequest, ApiError> {
        Incoming::request(line.as_bytes())
            .map_err(|e| ApiError::new(ErrorCode::BadRequest, e))?
            .typed()
    }

    #[test]
    fn requests_parse_and_nothing_else_does() {
        let ApiRequest::Hello(h) =
            request(r#"{"id":7,"m":"hello","p":{"api":1,"client":"daedalus-app/2026.9"}}"#)
                .unwrap()
        else {
            panic!("not a hello");
        };
        assert_eq!(
            h,
            HelloParams {
                api: 1,
                client: "daedalus-app/2026.9".into()
            }
        );
        assert!(matches!(
            request(r#"{"id":8,"m":"system.info"}"#),
            Ok(ApiRequest::SystemInfo)
        ));
        for bad in [
            r#"{"m":"hello"}"#,
            r#"{"id":-1,"m":"hello"}"#,
            r#"{"id":1}"#,
            r#"[1,"hello"]"#,
        ] {
            assert!(Incoming::request(bad.as_bytes()).is_err(), "{bad}");
        }
        // A newer client's extra fields are ignored, in the envelope and in
        // hello's parameters, and a hello without its client still reads, so
        // conn.rs can answer the version first.
        let Ok(ApiRequest::Hello(newer)) =
            request(r#"{"id":1,"m":"hello","trace":"x","p":{"api":2,"features":["x"]}}"#)
        else {
            panic!("a newer hello does not read");
        };
        assert_eq!((newer.api, newer.client.as_str()), (2, ""));
        assert_eq!(
            request(r#"{"id":1,"m":"hello","p":{"api":"1"}}"#)
                .unwrap_err()
                .code,
            ErrorCode::BadRequest
        );
        // Every other method's parameters are exact.
        for (line, code) in [
            (
                r#"{"id":1,"m":"system.info","p":{"x":1}}"#,
                ErrorCode::BadRequest,
            ),
            (
                r#"{"id":1,"m":"nodes.get","p":{"id":"x","path":"/etc"}}"#,
                ErrorCode::BadRequest,
            ),
            (r#"{"id":1,"m":"nodes.get"}"#, ErrorCode::BadRequest),
            (r#"{"id":1,"m":"claude.update"}"#, ErrorCode::UnknownMethod),
        ] {
            assert_eq!(request(line).unwrap_err().code, code, "{line}");
        }
    }

    #[test]
    fn answers_and_errors_on_the_wire() {
        assert_eq!(wire(&Response::ok(1, &json!({}))), r#"{"id":1,"ok":{}}"#);
        assert_eq!(
            wire(&Response::err(
                Some(2),
                ApiError::new(ErrorCode::UnknownMethod, "no method x")
            )),
            r#"{"id":2,"err":{"code":"unknown_method","msg":"no method x"}}"#
        );
        assert_eq!(
            wire(&Response::err(
                None,
                ApiError::new(ErrorCode::BadRequest, "not JSON")
            )),
            r#"{"id":null,"err":{"code":"bad_request","msg":"not JSON"}}"#
        );
        let v = ApiError {
            supported: Some(1),
            ..ApiError::new(ErrorCode::Version, "this agent speaks api 1")
        };
        assert_eq!(
            wire(&Response::err(Some(3), v)),
            r#"{"id":3,"err":{"code":"version","msg":"this agent speaks api 1","supported":1}}"#
        );
    }

    pub fn hello_ok() -> HelloOk {
        HelloOk {
            api: 1,
            version: "0.13.0".into(),
            mode: Mode::Controller,
            hostname: "box".into(),
            capabilities: vec![Capability::ClaudeRemoteControl, Capability::TelemetryFull],
        }
    }

    #[test]
    fn hello_on_the_wire() {
        let ok = hello_ok();
        assert_eq!(
            wire(&ok),
            r#"{"api":1,"version":"0.13.0","mode":"controller","hostname":"box","capabilities":["claude.remote_control","telemetry.full"]}"#
        );
    }

    pub fn system_info() -> SystemInfo {
        SystemInfo {
            api: 1,
            version: "0.13.0".into(),
            mode: Mode::Controller,
            hostname: "box".into(),
            os: OsInfo {
                os: "linux".into(),
                name: "NixOS".into(),
                version: "25.11".into(),
                arch: "x86_64".into(),
                cpu: "AMD Ryzen 7".into(),
                memory_bytes: Some(64),
            },
            uptime_secs: 5,
            os_uptime_secs: Some(100),
            booted_at: Some("2026-09-27T10:00:00Z".into()),
            role: Role::of(Mode::Controller),
            telemetry: TelemetryLevel::Minimal,
            capabilities: vec![
                Capability::ClaudeRemoteControl,
                Capability::TelemetryMinimal,
                Capability::Nodes,
            ],
            controller: Some(ControllerInfo {
                rotation: None,
                public_key: "ab".repeat(32),
                fingerprint: "3f2a:9c01".into(),
                listen: Some("0.0.0.0:7788".into()),
                advertise: vec!["box.lan:7788".into()],
            }),
        }
    }

    #[test]
    fn system_info_on_the_wire() {
        let info = system_info();
        assert_eq!(
            wire(&info),
            concat!(
                r#"{"api":1,"version":"0.13.0","mode":"controller","hostname":"box","#,
                r#""os":{"os":"linux","name":"NixOS","version":"25.11","arch":"x86_64","cpu":"AMD Ryzen 7","memory_bytes":64},"#,
                r#""uptime_secs":5,"os_uptime_secs":100,"booted_at":"2026-09-27T10:00:00Z","#,
                r#""role":{"mode":"controller","link":false,"self_update":false,"keep_awake":false,"#,
                r#""installer":false,"session":true,"session_in_service":true,"claude_update":false,"#,
                r#""tray":false,"metrics_page":true,"api_socket":true,"node_listener":true},"#,
                r#""telemetry":"minimal","capabilities":["claude.remote_control","telemetry.minimal","nodes"],"#,
                r#""controller":{"public_key":"abababababababababababababababababababababababababababababababab","#,
                r#""fingerprint":"3f2a:9c01","listen":"0.0.0.0:7788","advertise":["box.lan:7788"],"rotation":null}}"#
            )
        );
        // Anywhere but the controller the block is null.
        let bare = SystemInfo {
            controller: None,
            ..info
        };
        assert!(wire(&bare).ends_with(r#""controller":null}"#));
        // A rotation under way: the key going forward, and where it came from.
        let rotating = ControllerInfo {
            public_key: "cd".repeat(32),
            fingerprint: "77aa:0102".into(),
            listen: None,
            advertise: vec![],
            rotation: Some(RotationInfo {
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

    pub fn summary() -> NodeSummary {
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
                state: crate::claude::ClaudeState::Running,
                sessions: 2,
                signed_in: true,
                ..Default::default()
            }),
            form: None,
            model: None,
            status: None,
            status_at: None,
        }
    }

    const SUMMARY: &str = concat!(
        r#""id":"0123456789abcdef","fingerprint":"0123:4567","state":"approved","connected":true,"#,
        r#""since":"2026-09-27T10:00:00Z","last_seen":"2026-09-27T10:00:15Z","hostname":"PC","#,
        r#""os":"windows","arch":"x86_64","agent_version":"0.14.0","lan_ip":"192.168.0.120","#,
        r#""mac":"aa:bb:cc:dd:ee:ff","claude":{"state":"running","detail":null,"cli_version":null,"#,
        r#""server_version":null,"sessions":2,"started_at":null,"signed_in":true},"#,
        r#""form":null,"model":null,"status":null,"status_at":null"#
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
                r#""lan_ip":null,"mac":null,"claude":null,"form":null,"model":null,"status":null,"status_at":null}"#
            )
        );
        let detail = NodeDetail {
            node: summary(),
            public_key: "ab".repeat(32),
            hello: None,
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
                    r#""hello":null,"#,
                    r#""telemetry":null,"telemetry_at":null,"providers":null,"providers_at":null"#
                )
            )
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
        let report = provider_report();
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
             "policy":{"policy":{"awake_hold":false,"claude_remote_control":true,"claude_workdir":"C:/p","santree":false,
                                 "providers":{"lemonade":{"port":8000}}},
                       "offer_lemonade":true},
             "name":"Gaming PC"},
            {"id":"fedcba9876543210","public_key":"cd","state":"revoked"}
        ]}))
        .unwrap();
        assert_eq!(set.nodes[0].name.as_deref(), Some("Gaming PC"));
        assert_eq!(set.nodes[1].name, None);
        assert_eq!(set.nodes[1].state, DesiredState::Revoked);
        assert_eq!(set.nodes[1].policy, None);
        // The offer is the controller's (metrics); the machine's policy is the rest.
        let d = set.nodes[0].policy.clone().unwrap();
        assert!(d.offer_lemonade);
        assert!(d.alert_link, "an absent alert switch is on");
        let p = d.policy;
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"awake_hold":false,"claude_remote_control":true,"claude_workdir":"C:/p","providers":{"lemonade":{"port":8000}}}"#
        );
        for bad in [
            json!({"nodes":[{"id":"a","public_key":"b","state":"pending"}]}),
            json!({"nodes":[{"id":"a","public_key":"b","state":"approved","name":7}]}),
            json!({"nodes":[{"id":"a","public_key":"b","state":"approved","extra":1}]}),
            json!({"nodes":[{"id":"a","public_key":"b","state":"approved",
                             "policy":{"policy":{"awake_hold":true},"shell":"x"}}]}),
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
            wire(&ApiEvent::NodesLeft(NodeLeft {
                id: "0123456789abcdef".into()
            })),
            r#"{"e":"nodes.left","p":{"id":"0123456789abcdef"}}"#
        );
        assert_eq!(
            wire(&ApiEvent::NodesPolicyRequest(NodePolicyRequest {
                id: "0123456789abcdef".into(),
                changes: PolicyRequest {
                    awake_hold: Some(false),
                    ..Default::default()
                }
            })),
            r#"{"e":"nodes.policy_request","p":{"id":"0123456789abcdef","changes":{"awake_hold":false}}}"#
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
        let r = report();
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

    /// A provider with one of everything.
    pub fn provider_report() -> crate::node::providers::ProviderReport {
        crate::node::providers::ProviderReport {
            kind: crate::node::providers::ProviderKind::Lemonade,
            port: 13305,
            version: Some("9.1.2".into()),
            running: true,
            healthy: true,
            loaded: vec![crate::node::providers::LoadedModel {
                id: "Gemma-4".into(),
                device: Some("gpu".into()),
                max_context: Some(65536),
                pinned: true,
            }],
            models: vec![crate::node::providers::ProviderModel {
                id: "Gemma-4".into(),
                labels: vec!["tool-calling".into()],
                downloaded: true,
                size_gb: Some(7.5),
                recipe: Some("llamacpp".into()),
            }],
            downloads: vec![crate::node::providers::ProviderDownload {
                model: "Qwen".into(),
                percent: Some(12.5),
                status: "downloading".into(),
            }],
            backends: vec![crate::node::providers::ProviderBackend {
                recipe: "llamacpp".into(),
                backend: "vulkan".into(),
                version: Some("b6000".into()),
                url: None,
            }],
            figures: vec![crate::node::providers::ModelFigures {
                model: "Gemma-4".into(),
                requests: Some(3.0),
                tps: Some(40.0),
                ..Default::default()
            }],
            read_at: "2026-09-28T10:00:00Z".into(),
            error: None,
            actions: vec![crate::node::providers::ProviderAction {
                request: "00112233445566ff".into(),
                model: "Gemma-4".into(),
                ok: true,
                message: "Loaded".into(),
                at: "2026-09-28T09:59:00Z".into(),
            }],
        }
    }

    /// A running server's report.
    pub fn report() -> Report {
        Report {
            state: crate::claude::ClaudeState::Running,
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
        }
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
    fn an_action_is_found_in_either_document_as_one_outcome() {
        let r = roster();
        let p = [provider_report()];
        // The roster's session verb, as it reads.
        assert_eq!(
            wire(&ActionOutcome::find("00112233445566ff", Some(&r), None)),
            r#"{"state":"done","detail":"stopped"}"#
        );
        // The providers' residency verb, its `ok` and `message` as a state and a detail.
        assert_eq!(
            wire(&ActionOutcome::find("00112233445566ff", None, Some(&p))),
            r#"{"state":"done","detail":"Loaded"}"#
        );
        let mut failed = provider_report();
        failed.actions[0].ok = false;
        failed.actions[0].message = "out of memory".into();
        assert_eq!(
            ActionOutcome::find("00112233445566ff", None, Some(&[failed])).map(|o| o.state),
            Some(crate::claude::ActionState::Failed)
        );
        assert_eq!(
            ActionOutcome::find("ffffffffffffffff", Some(&r), Some(&p)),
            None
        );
        assert_eq!(wire(&None::<ActionOutcome>), "null");
    }

    #[test]
    fn restart_and_subscribe_on_the_wire() {
        assert_eq!(wire(&Queued { queued: true }), r#"{"queued":true}"#);
        assert_eq!(wire(&Subscribed {}), r#"{}"#);
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

    pub fn santree_status() -> SantreeStatus {
        SantreeStatus {
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
        }
    }

    #[test]
    fn santree_in_the_desired_set_and_the_status_on_the_wire() {
        let entry = |policy: Value| json!({"nodes":[{"id":"0123456789abcdef","public_key":"ab","state":"approved","policy":{"policy":policy}}]});
        let set: SetDesired = serde_json::from_value(entry(
            json!({"awake_hold":true,"claude_remote_control":true,"santree":true}),
        ))
        .unwrap();
        let p = set.nodes[0].policy.clone().unwrap().policy;
        assert!(p.santree);
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"awake_hold":true,"claude_remote_control":true,"santree":true}"#
        );
        // Off is absent; a value that is not one is refused (controller/api/mod.rs
        // refuses a session host the app names).
        let off: SetDesired = serde_json::from_value(entry(
            json!({"awake_hold":true,"claude_remote_control":true}),
        ))
        .unwrap();
        assert!(!off.nodes[0].policy.clone().unwrap().policy.santree);
        assert!(serde_json::from_value::<SetDesired>(entry(
            json!({"awake_hold":true,"claude_remote_control":true,"santree":"yes"})
        ))
        .is_err());

        let status = santree_status();
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
