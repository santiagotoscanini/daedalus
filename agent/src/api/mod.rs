//! The local API: the one door the Daedalus app uses to reach the
//! controller — a unix socket on the box, mounted into the app's container
//! (PLAN, feature 13). Served only where the role says so (role.rs
//! `api_socket`: the controller); a node never listens on one.
//!
//! **Who may connect.** Every connection is checked by its peer's
//! credentials (`SO_PEERCRED`): the agent's own uid is always served, and
//! so are the HOST uids config.toml lists in `[controller]
//! api_allowed_uids` (`peer_allowed`); anyone else gets a `forbidden` line
//! and a closed connection. Under rootless podman a container's uid 0 is
//! the operator's uid on the host — the controller's own — but the
//! published app image runs as `node` (container uid 1000, host uid
//! 100999), so the app's container passes only if nix lists that uid or
//! runs the container with `--userns=keep-id` (which maps the operator in
//! as itself); the agent supports both and chooses neither. The socket is
//! 0600 in a directory made 0700 (os `serve_local_socket`); with uids
//! listed, 0666 in one made 0711 — the kernel would refuse their connect
//! to a 0600 socket before the peer check ran, so the check is the gate.
//!
//! **Limits.** At most `MAX_CONNECTIONS` connections at once (one more gets
//! `busy` and is closed); `hello` must arrive within `HELLO_DEADLINE` or
//! the connection is closed; a write that cannot complete within
//! `WRITE_TIMEOUT` — a peer that stopped reading — breaks the connection
//! and tears it down, so no peer can pin a thread. Each connection is a
//! few threads and two descriptors: the unit nix writes should give the
//! process room (`LimitNOFILE`).
//!
//! **Framing.** Newline-delimited JSON, one object per line, a line at most
//! `MAX_LINE` bytes. A request is `{"id":<u64>,"m":"<method>","p":{…}}`,
//! answered by `{"id":…,"ok":…}` or `{"id":…,"err":{"code","msg"}}`; an
//! event is `{"e":"<name>","p":{…}}`. Requests are handled concurrently
//! (up to `MAX_IN_FLIGHT` per connection), so answers can come back in
//! another order than asked — match them by `id`. wire.rs has every type
//! and pins each one's JSON.
//!
//! **Versioned.** The first request on a connection must be
//! `hello` `{"api":1,"client":"<name/version>"}`; its answer says the
//! agent's version, mode, hostname and capabilities. A client asking for
//! another API version gets a `version` error carrying the one this agent
//! speaks (`API_VERSION`) — the version is read before anything else in
//! `hello`, and unknown fields there and in the envelope are ignored, so a
//! newer client always gets that answer (wire.rs); anything before a
//! `hello` gets `bad_request`.
//! The app and the controller ship from one engine rev, but the app moves
//! on save (dev mode) and the controller with a lock bump: the app compares
//! `hello`'s version with the release its engine builds and says so when
//! they differ, rather than reading a contract it does not share.
//!
//! **Fixed verbs.** The "no shell" rule: each method is a fixed verb with
//! typed parameters (wire.rs `ApiRequest`, one list with each method's
//! answer). None takes a command, a path or a flag from the caller, and
//! none ever will.
//!
//! | method             | answers                                               | needs                   |
//! |--------------------|-------------------------------------------------------|-------------------------|
//! | `hello`            | `HelloOk`                                              | first on the connection |
//! | `events.subscribe` | `{}`, then the events below                           | —                       |
//! | `system.info`      | `SystemInfo`: version, mode, OS, uptime, role, capabilities | —                  |
//! | `claude.status`    | `ClaudeStatus`: the session's last report              | `claude.remote_control` |
//! | `claude.restart`   | `Queued`; the session restarts the server (`unavailable` while off or no session reports) | `claude.remote_control` |
//! | `claude.roster`    | `ClaudeRosterGet`: the session's roster of Claude sessions (claude/roster/) | `claude.sessions` |
//! | `claude.session`   | `SessionQueued`: one verb `{action, id}` queued for the session; its roster's `actions` reports it under `request` | `claude.sessions` |
//! | `telemetry.get`    | `TelemetryGet`: the document at the configured level   | —                       |
//! | `actions.get`      | `ActionOutcome` or null: how one verb request `{request, node?}` stands — the roster's `actions` (a session verb) or the providers' (a residency verb) of that machine, or of the controller's own session | `nodes`, or `claude.sessions` without `node` |
//! | `nodes.list`       | `NodesList`: every machine known, its standing, connection, shape and status document | `nodes` |
//! | `nodes.get`        | `NodeDetail`: one machine's key and hello; with `full`, its telemetry and providers document too `{id, full?}` | `nodes` |
//! | `nodes.providers`  | `NodeProviders`: its providers document `{id}`        | `nodes`                 |
//! | `nodes.claude`     | `NodeClaude`: its full Claude report `{id}`            | `nodes`                 |
//! | `nodes.claude_roster` | `NodeClaudeRoster`: its roster of Claude sessions `{id}` | `nodes`             |
//! | `nodes.claude_session` | `ClaudeSessionSent`: one verb `{id, action, session}` delivered and acknowledged | `nodes` |
//! | `nodes.provider_model` | `ProviderModelSent`: one residency verb `{id, kind, action, model, pinned?, replacing?}` delivered and acknowledged | `nodes` |
//! | `nodes.set_desired`| `SetDesiredOk`: the app's complete approved/revoked set with policies and names `{nodes:[…]}` | `nodes` |
//! | `nodes.command`    | `CommandOk`: delivered, or queued `{id, command}`      | `nodes`                 |
//! | `controller.rotate`| `ControllerInfo` with its `rotation`: a new controller key, the old one retired after `{grace_secs?}` (link/rotation.rs) | `controller` |
//! | `root.run`         | `RootRunOk`: one root verb `{verb, selectors?, payload?, detach?}` run by the root helper to its end — `done`, `refused` or `failed` with a detail; with `detach`, answered once its unit has started (outcome null); `status` lists the verbs (root/) | `root` |
//! | `root.follow`      | `RootFollowOk`: a run's lines past `{run, after?}` and how it stands, from the controller's run store (root/runs.rs); `not_found` for a run it does not hold | `root` |
//! | `root.runs`        | `RootRunsOk`: the runs of `{verb}` the store holds, newest first | `root` |
//! | `santree.status`   | `SantreeStatus`: the session host from its status file — `running`, `stale`, `stopped` or `missing`, its version, whether a restart would apply a newer build, its live PTYs and connections by machine, and why the controller cannot read it or write its allow-list (session_host.rs) | `santree` |
//!
//! `root.run` answers when the verb's unit has finished, which can be
//! minutes: a client gives it a timeout of its own, or asks `detach` and
//! reads the rest with `root.follow`, so a long verb holds neither a
//! request slot nor a client's wait. Every run's lines and outcome are kept
//! for an hour after it ends, whoever asked (root/runs.rs). It is the only
//! door to the root helper — the app never connects to that socket.
//!
//! The `nodes.*` methods read and steer the machines connected to the
//! controller (link/controller/). Their selector is a node id — sixteen
//! lowercase hex characters, checked before anything else — and their
//! parameters are exact; `command` is one of `check_update`,
//! `claude_update`, `claude_restart`. A session verb (`claude.session`
//! and `nodes.claude_session`) is `resume`, `stop` or `remove` with the
//! selector each takes — a canonical lowercase uuid for `resume`, that or a
//! background agent's eight hex digits for `stop`, the eight digits for
//! `remove` (claude/sessions/ `check_selector`) — checked here, again by
//! the machine that takes it, and again by its session, which refuses
//! every verb while its policy keeps Claude off. `nodes.claude_session`
//! reaches only a connected, approved machine that offers
//! `claude.sessions`, and is never queued for later. `set_desired` checks
//! every entry (an id that is not its key's, a key twice, a policy that
//! names the session host, a `name` longer than `MAX_NODE_NAME` characters
//! or with a control character) before applying any. A machine the
//! controller has never heard of is `not_found`; a command for one that is
//! not approved is `unavailable`.
//!
//! **Capabilities** come from the role table, the config and what the
//! controller serves, never from the OS (`capabilities`):
//! `claude.remote_control` where a session runs and may run Claude — on the
//! controller only when `[controller] claude_remote_control` says so, and
//! `claude.sessions` beside it (the roster and the session verbs);
//! `claude.update` where the role lets the agent update Claude Code — never
//! on the controller, whose Claude nix pins; `telemetry.full` or
//! `telemetry.minimal` as `telemetry` says (nothing at `off`); `nodes` where
//! the controller listens for machines (`[controller] listen`); `root`
//! where `[controller] root_socket` names the helper; `santree` where it
//! follows a session host; `controller` where it holds its link key. A
//! method whose capability is absent answers `unsupported`.
//!
//! **Events** (wire.rs `ApiEvent`) are what the app must act on: `nodes.left`
//! `{id}` when an approved machine logs out (the link's `leave`: the app
//! forgets it and deletes its wg-easy client); `nodes.policy_request` `{id,
//! changes}` when an approved machine's user asks for one of its settings
//! (the link's `policy_request`: the app writes the keys `changes` names and
//! sends the set again; never santree on). The machine that asked is
//! answered only once a subscriber took the event. A subscriber that does
//! not read fills its queue (`EVENT_QUEUE`) and loses the events after
//! that, never the connection. Everything else is read when it is wanted.

pub mod conn;
pub mod wire;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use serde_json::value::RawValue;

use crate::config::{Config, TelemetryLevel};
use crate::link::wire::Policy;
use crate::role::Role;
use crate::rpc::{error_line, ApiError, ErrorCode, Events};
use crate::shared::Shared;
use wire::{ApiRequest, Capability, ClaudeStatus, OsInfo, Queued, SystemInfo, TelemetryGet};

/// The API version this agent speaks.
pub const API_VERSION: u32 = 1;
/// The longest line read or accepted, request or otherwise.
pub const MAX_LINE: usize = 1 << 20;
/// Requests one connection may have in flight before `busy`.
pub const MAX_IN_FLIGHT: usize = 32;
/// Connections served at once.
pub const MAX_CONNECTIONS: usize = 16;
/// How long a new connection has to send `hello`.
pub const HELLO_DEADLINE: Duration = Duration::from_secs(10);
/// How long one write may block before the peer is taken for gone.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest `root.run` waits for any one line from the root helper: a
/// backstop only — the helper answers within its verb's own timeout.
pub const ROOT_SILENCE: Duration = Duration::from_secs(2 * 60 * 60);
/// How long a `detach` run may take to start before `root.run` stops
/// waiting for it (the run goes on, and `root.follow` reads it).
pub const ROOT_DETACH_WAIT: Duration = Duration::from_secs(30);

/// What the socket enforces before a connection reaches `conn` (the os
/// layer applies it; `Limits::of` is the service's).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Host uids served besides the agent's own.
    pub allowed_uids: Vec<u32>,
    pub max_connections: usize,
    pub hello_deadline: Duration,
    pub write_timeout: Duration,
}

impl Limits {
    pub fn of(cfg: &Config) -> Self {
        Self {
            allowed_uids: cfg.controller.api_allowed_uids.clone(),
            max_connections: MAX_CONNECTIONS,
            hello_deadline: HELLO_DEADLINE,
            write_timeout: WRITE_TIMEOUT,
        }
    }

    /// The door's policy (door.rs): this agent's own uid and the listed
    /// ones, `hello` within its deadline, the file modes opened to others
    /// when uids are listed.
    pub fn policy(&self) -> crate::door::Policy {
        let own = crate::os::own_uid().unwrap_or(u32::MAX);
        let listed = self.allowed_uids.clone();
        let uid = |p: Option<&crate::door::Peer>| match p {
            Some(crate::door::Peer::Uid(u)) => Some(*u),
            _ => None,
        };
        crate::door::Policy {
            what: "api",
            allow: std::sync::Arc::new(move |p| peer_allowed(uid(p), own, &listed)),
            refusal: std::sync::Arc::new(move |p| refusal(uid(p))),
            busy: too_many(self.max_connections),
            max_connections: self.max_connections,
            first_line: self.hello_deadline,
            write_timeout: self.write_timeout,
            whole: None,
            open_to_others: !self.allowed_uids.is_empty(),
        }
    }
}

/// The one check on who may talk to the API: the peer's uid, as the kernel
/// states it, is this agent's own or one config.toml lists. A peer whose
/// credentials could not be read is refused.
pub fn peer_allowed(peer_uid: Option<u32>, own_uid: u32, listed: &[u32]) -> bool {
    peer_uid.is_some_and(|p| p == own_uid || listed.contains(&p))
}

/// What the controller serves beyond its config, as it starts: machines
/// (`[controller] listen`), a session host it follows, its own link key.
/// A node serves none of them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Serves {
    pub nodes: bool,
    pub santree: bool,
    pub keys: bool,
}

/// What this agent offers the app, from its role and config (module doc).
pub fn capabilities(cfg: &Config, serves: Serves) -> Vec<Capability> {
    let role = cfg.role();
    let mut c = Vec::new();
    // A node runs Claude as the box's policy says; the controller only
    // when nix turned it on — never offered while it cannot run.
    let claude = match role.mode {
        crate::config::Mode::Node => true,
        crate::config::Mode::Controller => cfg.controller.claude_remote_control,
    };
    if role.session && claude {
        c.push(Capability::ClaudeRemoteControl);
        if role.claude_update {
            c.push(Capability::ClaudeUpdate);
        }
        c.push(Capability::ClaudeSessions);
    }
    match cfg.telemetry {
        TelemetryLevel::Full => c.push(Capability::TelemetryFull),
        TelemetryLevel::Minimal => c.push(Capability::TelemetryMinimal),
        TelemetryLevel::Off => {}
    }
    // A node reads its providers and drives their residency for the box.
    if role.link {
        c.push(Capability::ProvidersResidency);
    }
    if serves.nodes && role.node_listener {
        c.push(Capability::Nodes);
    }
    // The root helper answers only the controller (root/mod.rs), and only
    // where nix named its socket.
    if role.api_socket && cfg.controller.root_socket.is_some() {
        c.push(Capability::Root);
    }
    if role.api_socket && serves.santree {
        c.push(Capability::Santree);
    }
    if role.api_socket && serves.keys {
        c.push(Capability::Controller);
    }
    c
}

/// What the methods read: the service's shared state and what this agent
/// is.
pub struct Api {
    shared: Arc<Shared>,
    role: Role,
    telemetry: TelemetryLevel,
    capabilities: Vec<Capability>,
    /// The root helper's socket, where `root` is offered.
    root_socket: Option<std::path::PathBuf>,
    /// Every root run this controller asked for, while it keeps them.
    runs: Arc<crate::root::runs::Runs>,
    /// `MAX_IN_FLIGHT`, except in the tests of the `busy` answer.
    max_in_flight: usize,
}

impl Api {
    pub fn new(shared: Arc<Shared>, cfg: &Config) -> Self {
        let role = cfg.role();
        Self {
            capabilities: capabilities(
                cfg,
                Serves {
                    nodes: shared.nodes().is_some(),
                    santree: shared.session_host().is_some(),
                    keys: shared.controller_keys().is_some(),
                },
            ),
            shared,
            role,
            telemetry: cfg.telemetry,
            root_socket: cfg.controller.root_socket.clone(),
            runs: Arc::default(),
            max_in_flight: MAX_IN_FLIGHT,
        }
    }

    pub fn max_in_flight(&self) -> usize {
        self.max_in_flight
    }

    #[cfg(test)]
    pub fn with_max_in_flight(mut self, n: usize) -> Self {
        self.max_in_flight = n;
        self
    }

    pub fn hello(&self) -> wire::HelloOk {
        wire::HelloOk {
            api: API_VERSION,
            version: crate::VERSION.into(),
            mode: self.role.mode,
            hostname: crate::facts::hostname(),
            capabilities: self.capabilities.clone(),
        }
    }

    pub fn events(&self) -> &Events {
        self.shared.events()
    }

    fn has(&self, capability: Capability) -> Result<(), ApiError> {
        if self.capabilities.contains(&capability) {
            Ok(())
        } else {
            Err(ApiError::new(
                ErrorCode::Unsupported,
                format!("this agent does not offer `{capability}`"),
            ))
        }
    }

    /// One method, after `hello` (conn.rs answers `hello` and
    /// `events.subscribe`, which belong to the connection).
    pub fn call(&self, req: ApiRequest) -> Result<Box<RawValue>, ApiError> {
        use ApiRequest as R;
        match req {
            R::Hello(_) | R::EventsSubscribe => Err(ApiError::new(
                ErrorCode::BadRequest,
                "`hello` and `events.subscribe` belong to the connection",
            )),
            R::SystemInfo => to_value(&self.system_info()),
            R::ClaudeStatus => {
                self.has(Capability::ClaudeRemoteControl)?;
                let report = self.shared.claude_report();
                to_value(&ClaudeStatus {
                    reporting: report.is_some(),
                    wanted: self.shared.policy().claude_remote_control,
                    report,
                })
            }
            R::ClaudeRestart => {
                self.has(Capability::ClaudeRemoteControl)?;
                if !self.shared.policy().claude_remote_control {
                    return Err(ApiError::new(
                        ErrorCode::Unavailable,
                        "Claude remote control is off on this machine; there is nothing to restart",
                    ));
                }
                // Queued for nobody, a restart would fire whenever a
                // session next came up — long after anyone asked.
                if self.shared.claude_report().is_none() {
                    return Err(ApiError::new(
                        ErrorCode::Unavailable,
                        "no session is reporting on this machine; there is nothing to restart",
                    ));
                }
                self.shared.request_claude_restart();
                to_value(&Queued { queued: true })
            }
            R::ClaudeRoster => {
                self.has(Capability::ClaudeSessions)?;
                let roster = self.shared.claude_roster();
                to_value(&wire::ClaudeRosterGet {
                    reporting: roster.is_some(),
                    roster,
                })
            }
            R::ClaudeSession(s) => {
                self.has(Capability::ClaudeSessions)?;
                crate::claude::sessions::check_selector(s.action, &s.id)
                    .map_err(|e| ApiError::new(ErrorCode::BadRequest, e))?;
                if !self.shared.policy().claude_remote_control {
                    return Err(ApiError::new(
                        ErrorCode::Unavailable,
                        "Claude is off on this machine; no session verb runs",
                    ));
                }
                if self.shared.claude_report().is_none() {
                    return Err(ApiError::new(
                        ErrorCode::Unavailable,
                        "no session is reporting on this machine; there is nobody to run it",
                    ));
                }
                let request = self
                    .shared
                    .queue_claude_session(s.action, s.id)
                    .ok_or_else(|| {
                        ApiError::new(
                            ErrorCode::Busy,
                            "the session has requests waiting that it has not taken",
                        )
                    })?;
                to_value(&wire::SessionQueued {
                    queued: true,
                    request,
                })
            }
            R::TelemetryGet => to_value(&TelemetryGet {
                level: self.telemetry,
                telemetry: match self.telemetry {
                    TelemetryLevel::Off => None,
                    _ => self.shared.telemetry(),
                },
            }),
            R::ActionsGet(q) => {
                // A request id is what `mint_request` makes: sixteen lowercase hex.
                if !wire::valid_node_id(&q.request) {
                    return Err(ApiError::new(
                        ErrorCode::BadRequest,
                        "a request id is sixteen lowercase hex characters",
                    ));
                }
                match q.node {
                    None => {
                        self.has(Capability::ClaudeSessions)?;
                        let roster = self.shared.claude_roster();
                        to_value(&wire::ActionOutcome::find(
                            &q.request,
                            roster.as_ref(),
                            None,
                        ))
                    }
                    Some(id) => to_value(&self.nodes()?.action(checked_id(&id)?, &q.request)?),
                }
            }
            R::ControllerRotate(p) => {
                use crate::link::rotation::{GRACE_DEFAULT, GRACE_MAX, GRACE_MIN};
                self.has(Capability::Controller)?;
                let keys = self.shared.controller_keys().ok_or_else(|| {
                    ApiError::new(ErrorCode::Unsupported, "this agent holds no link key")
                })?;
                let grace = p.grace_secs.map_or(GRACE_DEFAULT, Duration::from_secs);
                if !(GRACE_MIN..=GRACE_MAX).contains(&grace) {
                    return Err(ApiError::new(
                        ErrorCode::BadRequest,
                        format!(
                            "`controller.rotate`: grace_secs is {} to {}",
                            GRACE_MIN.as_secs(),
                            GRACE_MAX.as_secs()
                        ),
                    ));
                }
                keys.start(grace)
                    .map_err(|e| ApiError::new(ErrorCode::Unavailable, e))?;
                to_value(&self.shared.controller_info())
            }
            R::SantreeStatus => {
                self.has(Capability::Santree)?;
                let host = self.shared.session_host().ok_or_else(|| {
                    ApiError::new(ErrorCode::Unsupported, "no session host on this box")
                })?;
                to_value(&host.status())
            }
            R::RootRun(p) => {
                self.has(Capability::Root)?;
                to_value(&self.root_run(p)?)
            }
            R::RootFollow(p) => {
                self.has(Capability::Root)?;
                to_value(&self.root_follow(p)?)
            }
            R::RootRuns(p) => {
                self.has(Capability::Root)?;
                let runs = self
                    .runs
                    .of_verb(&p.verb)
                    .into_iter()
                    .map(Into::into)
                    .collect();
                to_value(&wire::RootRunsOk { runs })
            }
            R::NodesList => to_value(&wire::NodesList {
                nodes: self.nodes()?.list(),
            }),
            R::NodesGet(p) => to_value(&self.nodes()?.get(checked_id(&p.id)?, p.full)?),
            R::NodesProviders(p) => to_value(&self.nodes()?.providers(checked_id(&p.id)?)?),
            R::NodesClaude(p) => to_value(&self.nodes()?.claude(checked_id(&p.id)?)?),
            R::NodesClaudeRoster(p) => to_value(&self.nodes()?.claude_roster(checked_id(&p.id)?)?),
            R::NodesClaudeSession(c) => {
                let nodes = self.nodes()?;
                checked_id(&c.id)?;
                crate::claude::sessions::check_selector(c.action, &c.session)
                    .map_err(|e| ApiError::new(ErrorCode::BadRequest, e))?;
                to_value(&nodes.claude_session(&c.id, c.action, &c.session)?)
            }
            R::NodesProviderModel(c) => {
                let nodes = self.nodes()?;
                checked_id(&c.id)?;
                let p = crate::providers::ProviderModelParams {
                    kind: c.kind,
                    action: c.action,
                    model: c.model,
                    pinned: c.pinned.unwrap_or(false),
                    replacing: c.replacing,
                    request: crate::claude::sessions::mint_request(),
                };
                p.check()
                    .map_err(|e| ApiError::new(ErrorCode::BadRequest, e))?;
                to_value(&nodes.provider_model(&c.id, p)?)
            }
            R::NodesSetDesired(set) => {
                let nodes = self.nodes()?;
                to_value(&nodes.set_desired(desired_entries(set)?))
            }
            R::NodesCommand(c) => {
                let nodes = self.nodes()?;
                to_value(&nodes.command(checked_id(&c.id)?, c.command)?)
            }
        }
    }

    /// The machines this controller serves, where `nodes` is offered.
    fn nodes(&self) -> Result<&Arc<crate::link::controller::Registry>, ApiError> {
        self.has(Capability::Nodes)?;
        self.shared
            .nodes()
            .ok_or_else(|| ApiError::new(ErrorCode::Unsupported, "this agent serves no machines"))
    }

    /// `root.run`: one verb on the root helper, its unit's lines kept in the
    /// run store while it runs (`root.follow` reads them), its outcome the
    /// answer — or, with `detach`, the answer as soon as the unit has
    /// started, the rest the store's (`root.follow`). The helper is the
    /// authority on what exists; the words are checked here only so nonsense
    /// costs no root process.
    fn root_run(&self, p: wire::RootRun) -> Result<wire::RootRunOk, ApiError> {
        use crate::root::{self, relay::RelayError, relay::Relayed};
        let socket = self
            .root_socket
            .clone()
            .ok_or_else(|| ApiError::new(ErrorCode::Unsupported, "no root helper is configured"))?;
        if !root::valid_name(&p.verb) {
            return Err(ApiError::new(
                ErrorCode::BadRequest,
                "`root.run`: a verb is [a-z][a-z0-9-]{0,31}",
            ));
        }
        if p.selectors
            .iter()
            .any(|(k, v)| !root::valid_name(k) || !root::valid_free_value(v, root::MAX_PATTERN_LEN))
        {
            return Err(ApiError::new(
                ErrorCode::BadRequest,
                "`root.run`: a selector is a name and a value of printable ASCII, at most 256, not starting with -",
            ));
        }
        if p.payload
            .as_ref()
            .is_some_and(|x| x.len() > root::MAX_PAYLOAD)
        {
            return Err(ApiError::new(
                ErrorCode::BadRequest,
                format!(
                    "`root.run`: a payload is at most {} bytes",
                    root::MAX_PAYLOAD
                ),
            ));
        }
        let run = crate::claude::sessions::mint_request();
        let verb = p.verb.clone();
        let request = root::Request {
            verb: p.verb,
            id: run.clone(),
            selectors: p.selectors,
            payload: p.payload,
        };
        tracing::info!(verb = %verb, run = %run, detach = ?p.detach, "root: asking the helper");
        self.runs.begin(&run, &verb);
        let relay = {
            let runs = Arc::clone(&self.runs);
            let (run, verb) = (run.clone(), verb.clone());
            move || {
                let answer = root::relay::run(&socket, &request, ROOT_SILENCE, |r| match r {
                    Relayed::Started => runs.started(&run),
                    Relayed::Progress(line) => runs.line(&run, line),
                });
                match answer {
                    Ok(a) => {
                        tracing::info!(verb = %verb, run = %run, outcome = ?a.outcome, detail = %a.detail, "root: answered");
                        Ok(wire::RootRunOk {
                            run,
                            verb,
                            outcome: Some(a.outcome),
                            detail: a.detail,
                            verbs: a.verbs,
                        })
                    }
                    Err(e) => {
                        tracing::warn!(verb = %verb, run = %run, error = %e, "root: no answer");
                        Err(match &e {
                            RelayError::Refused { code: c, .. }
                                if c == root::code::BAD_REQUEST
                                    || c == root::code::UNKNOWN_VERB =>
                            {
                                ApiError::new(ErrorCode::BadRequest, e.to_string())
                            }
                            _ => ApiError::new(ErrorCode::Unavailable, e.to_string()),
                        })
                    }
                }
            }
        };
        let record = {
            let runs = Arc::clone(&self.runs);
            let run = run.clone();
            move |r: &Result<wire::RootRunOk, ApiError>| match r {
                Ok(ok) => runs.finish(&run, ok.outcome.unwrap_or(root::Outcome::Done), &ok.detail),
                Err(e) => runs.finish(&run, root::Outcome::Failed, &e.msg),
            }
        };
        if p.detach != Some(true) {
            let answer = relay();
            record(&answer);
            return answer;
        }
        // The answer goes out first and the store moves after it, so a wait
        // the store's move ends finds the answer already there.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("root-run".into())
            .spawn(move || {
                let answer = relay();
                let _ = tx.send(answer.clone());
                record(&answer);
            })
            .map_err(|e| {
                ApiError::new(ErrorCode::Internal, format!("no thread for the run: {e}"))
            })?;
        let started = self.runs.wait_started(&run, ROOT_DETACH_WAIT);
        if let Ok(answer) = rx.try_recv() {
            return answer;
        }
        if !started {
            return Err(ApiError::new(
                ErrorCode::Unavailable,
                format!(
                    "the root helper did not start `{verb}` within {} s; root.follow {run} says what became of it",
                    ROOT_DETACH_WAIT.as_secs()
                ),
            ));
        }
        Ok(wire::RootRunOk {
            run,
            verb,
            outcome: None,
            detail: String::new(),
            verbs: None,
        })
    }

    /// `root.follow`: a run's lines past `after`, and how it stands.
    fn root_follow(&self, p: wire::RootFollow) -> Result<wire::RootFollowOk, ApiError> {
        let f = self
            .runs
            .follow(&p.run, p.after.unwrap_or(0))
            .ok_or_else(|| {
                ApiError::new(
                    ErrorCode::NotFound,
                    format!(
                        "no run {:?}: this controller never ran it, or has forgotten it",
                        p.run.chars().take(64).collect::<String>()
                    ),
                )
            })?;
        Ok(wire::RootFollowOk {
            run: f.summary.into(),
            lines: f
                .lines
                .into_iter()
                .map(|(seq, line)| wire::RootLine { seq, line })
                .collect(),
            next: f.next,
            more: f.more,
            dropped: f.dropped,
        })
    }

    fn system_info(&self) -> SystemInfo {
        let f = self.shared.facts();
        let os_uptime = crate::power::os_uptime_secs();
        SystemInfo {
            api: API_VERSION,
            version: crate::VERSION.into(),
            mode: self.role.mode,
            hostname: crate::facts::hostname(),
            os: OsInfo {
                os: f.os.clone(),
                name: f.os_name.clone(),
                version: f.os_version.clone(),
                arch: f.arch.clone(),
                cpu: f.cpu.clone(),
                memory_bytes: f.memory_bytes,
            },
            uptime_secs: self.shared.uptime().as_secs(),
            os_uptime_secs: os_uptime,
            booted_at: os_uptime.map(crate::state::rfc3339_ago),
            role: self.role,
            telemetry: self.telemetry,
            capabilities: self.capabilities.clone(),
            controller: self.shared.controller_info(),
        }
    }
}

fn to_value<T: Serialize>(v: &T) -> Result<Box<RawValue>, ApiError> {
    serde_json::value::to_raw_value(v)
        .map_err(|e| ApiError::new(ErrorCode::Internal, e.to_string()))
}

/// A node id as a selector: sixteen lowercase hex characters.
fn checked_id(id: &str) -> Result<&str, ApiError> {
    if wire::valid_node_id(id) {
        Ok(id)
    } else {
        Err(ApiError::new(
            ErrorCode::BadRequest,
            format!("a node id is sixteen lowercase hex characters, not {id:?}"),
        ))
    }
}

/// A machine's name as `nodes.set_desired` hands it: not blank, at most
/// `MAX_NODE_NAME` characters, no control character — it becomes a label
/// value in `/nodes/metrics`.
fn checked_name(id: &str, name: &str) -> Result<(), ApiError> {
    let bad = if name.trim().is_empty() {
        "is blank".to_string()
    } else if name.chars().count() > wire::MAX_NODE_NAME {
        format!("is longer than {} characters", wire::MAX_NODE_NAME)
    } else if name.chars().any(char::is_control) {
        "has a control character".to_string()
    } else {
        return Ok(());
    };
    Err(ApiError::new(
        ErrorCode::BadRequest,
        format!("{id}: the name {bad}"),
    ))
}

/// The app's set, every entry checked before any is applied: the id is its
/// key's node id, no id is named twice, and no policy names the session
/// host (the controller fills it, registry.rs `effective`). An approved
/// entry without a policy gets `Policy::default()`; a revoked one's policy
/// is kept unused.
fn desired_entries(
    set: wire::SetDesired,
) -> Result<Vec<crate::link::controller::DesiredEntry>, ApiError> {
    let mut seen = std::collections::HashSet::new();
    set.nodes
        .into_iter()
        .map(|n| {
            checked_id(&n.id)?;
            let key = crate::identity::parse_public_key(&n.public_key)
                .map_err(|e| ApiError::new(ErrorCode::BadRequest, format!("{}: {e}", n.id)))?;
            let of_key = crate::identity::node_id_of(&key);
            if of_key != n.id {
                return Err(ApiError::new(
                    ErrorCode::BadRequest,
                    format!(
                        "{} is not the node id of its public_key ({of_key} is)",
                        n.id
                    ),
                ));
            }
            if !seen.insert(n.id.clone()) {
                return Err(ApiError::new(
                    ErrorCode::BadRequest,
                    format!("{} is named twice", n.id),
                ));
            }
            if let Some(name) = &n.name {
                checked_name(&n.id, name)?;
            }
            let (mut policy, offer_lemonade) = n.policy.map_or_else(
                || (Policy::default(), false),
                |d| (d.policy, d.offer_lemonade),
            );
            if policy.session_host.is_some() {
                return Err(ApiError::new(
                    ErrorCode::BadRequest,
                    format!("{}: the session host is the controller's to name", n.id),
                ));
            }
            policy.claude_workdir = policy.claude_workdir.filter(|w| !w.trim().is_empty());
            Ok(crate::link::controller::DesiredEntry {
                id: n.id,
                public_key: key,
                state: n.state,
                policy,
                name: n.name,
                offer_lemonade,
            })
        })
        .collect()
}

/// Serve the API on the socket config.toml names (`Config::api_socket`)
/// until the returned handle is dropped, which removes the socket.
pub fn serve(cfg: &Config, shared: Arc<Shared>) -> Result<crate::os::LocalSocket> {
    let path = cfg.api_socket();
    let api = Arc::new(Api::new(shared, cfg));
    let limits = Limits::of(cfg);
    let socket = crate::os::serve_api_socket(&path, &limits.policy(), move |c| {
        conn::serve_connection(Arc::clone(&api), c);
    })?;
    tracing::info!(
        socket = %path.display(),
        api = API_VERSION,
        allowed_uids = ?limits.allowed_uids,
        "local API answering"
    );
    Ok(socket)
}

/// The line a refused peer gets before its connection is closed.
pub fn refusal(peer_uid: Option<u32>) -> String {
    let who = match peer_uid {
        Some(uid) => format!("uid {uid}"),
        None => "a peer whose credentials could not be read".into(),
    };
    error_line(
        ErrorCode::Forbidden,
        format!("{who} may not use this socket (the agent's own uid and controller.api_allowed_uids may)"),
    )
}

/// The line a connection past `max` gets before it is closed.
pub fn too_many(max: usize) -> String {
    error_line(
        ErrorCode::Busy,
        format!("at most {max} connections at once; closing"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn the_agents_own_uid_and_the_listed_ones_are_served() {
        assert!(peer_allowed(Some(1000), 1000, &[]));
        // Another user on the machine, root included.
        assert!(!peer_allowed(Some(1001), 1000, &[]));
        assert!(!peer_allowed(Some(0), 1000, &[]));
        // Credentials that could not be read are no credentials.
        assert!(!peer_allowed(None, 1000, &[]));
        assert!(!peer_allowed(None, 1000, &[100999]));
        // An agent run as root serves root and nobody else.
        assert!(peer_allowed(Some(0), 0, &[]));
        assert!(!peer_allowed(Some(1000), 0, &[]));
        // The published app image's `node` user, when nix lists it; the
        // agent's own uid stays served whatever the list says.
        assert!(peer_allowed(Some(100999), 1000, &[100999]));
        assert!(peer_allowed(Some(1000), 1000, &[100999]));
        assert!(!peer_allowed(Some(100998), 1000, &[100999]));
    }

    #[test]
    fn the_lines_a_closed_connection_gets() {
        assert_eq!(
            refusal(Some(1001)),
            "{\"id\":null,\"err\":{\"code\":\"forbidden\",\"msg\":\"uid 1001 may not use this socket \
             (the agent's own uid and controller.api_allowed_uids may)\"}}\n"
        );
        assert_eq!(
            too_many(16),
            "{\"id\":null,\"err\":{\"code\":\"busy\",\"msg\":\"at most 16 connections at once; closing\"}}\n"
        );
    }

    #[test]
    fn capabilities_come_from_the_role_and_the_config() {
        let cfg = |text: &str| toml::from_str::<Config>(text).unwrap();
        let nodes = Serves {
            nodes: true,
            ..Serves::default()
        };
        let capabilities = |cfg: &Config, serves: Serves| -> Vec<String> {
            super::capabilities(cfg, serves)
                .iter()
                .map(ToString::to_string)
                .collect()
        };
        assert_eq!(
            capabilities(&cfg(""), Serves::default()),
            [
                "claude.remote_control",
                "claude.update",
                "claude.sessions",
                "telemetry.full",
                "providers.residency"
            ]
        );
        // A node never offers `nodes`, whatever it is told.
        assert_eq!(
            capabilities(&cfg("telemetry = \"off\""), nodes),
            [
                "claude.remote_control",
                "claude.update",
                "claude.sessions",
                "providers.residency"
            ]
        );
        // The controller offers Claude only when nix turned it on, and never
        // `claude.update`: nix pins Claude there.
        let on = "mode = \"controller\"\n[controller]\nclaude_remote_control = true\n";
        assert_eq!(
            capabilities(&cfg(on), Serves::default()),
            ["claude.remote_control", "claude.sessions", "telemetry.full"]
        );
        assert_eq!(
            capabilities(&cfg("mode = \"controller\""), Serves::default()),
            ["telemetry.full"]
        );
        assert_eq!(
            capabilities(
                &cfg("mode = \"controller\"\ntelemetry = \"minimal\""),
                nodes
            ),
            ["telemetry.minimal", "nodes"]
        );
        assert_eq!(
            capabilities(
                &cfg(&format!("telemetry = \"off\"\n{on}")),
                Serves::default()
            ),
            ["claude.remote_control", "claude.sessions"]
        );
        // `root` only on the controller, and only with the helper's socket.
        let root = "mode = \"controller\"\ntelemetry = \"off\"\n[controller]\nroot_socket = \"/run/r.sock\"\n";
        assert_eq!(capabilities(&cfg(root), Serves::default()), ["root"]);
        let node_root = "telemetry = \"off\"\n[controller]\nroot_socket = \"/run/r.sock\"\n";
        assert!(!capabilities(&cfg(node_root), Serves::default()).contains(&"root".to_string()));
        // `santree` and `controller` where the controller follows a session
        // host and holds its link key; a node offers neither.
        let all = Serves {
            nodes: true,
            santree: true,
            keys: true,
        };
        assert_eq!(
            capabilities(&cfg("mode = \"controller\"\ntelemetry = \"off\""), all),
            ["nodes", "santree", "controller"]
        );
        assert!(capabilities(&cfg("telemetry = \"off\""), all)
            .iter()
            .all(|c| c != "santree" && c != "controller"));
    }

    /// The app's set: the policy the machine is sent and the offer the
    /// controller keeps; the session host is the controller's to name.
    #[test]
    fn the_desired_set_is_checked_before_it_is_taken() {
        let id = crate::identity::Identity::from_seed([7; 32]);
        let set = |policy: Value| -> Result<Vec<crate::link::controller::DesiredEntry>, ApiError> {
            desired_entries(
                serde_json::from_value(serde_json::json!({"nodes":[{
                    "id": id.node_id(), "public_key": id.public_key_hex(),
                    "state": "approved", "policy": policy
                }]}))
                .unwrap(),
            )
        };
        let e = set(serde_json::json!({
            "policy": {"awake_hold": true, "claude_remote_control": false, "claude_workdir": " ",
                       "providers": {"lemonade": {"port": 8000}}},
            "offer_lemonade": true
        }))
        .unwrap();
        assert!(e[0].offer_lemonade);
        assert_eq!(
            e[0].policy.claude_workdir, None,
            "a blank directory is none"
        );
        assert_eq!(
            e[0].policy.providers.lemonade.as_ref().and_then(|l| l.port),
            Some(8000)
        );
        let named = set(serde_json::json!({"policy": {
            "awake_hold": true, "claude_remote_control": true, "santree": true,
            "session_host": {"address": "evil.example:1", "public_key": "00"}
        }}));
        assert_eq!(named.unwrap_err().code, ErrorCode::BadRequest);
    }

    /// A request as the app writes it, through the typed door.
    #[cfg(unix)]
    fn ask_api(api: &Api, m: &str, p: Value) -> Result<Box<RawValue>, ApiError> {
        crate::rpc::Request {
            id: 1,
            m: m.into(),
            p,
        }
        .typed()
        .and_then(|r| api.call(r))
    }

    /// `root.run` through a fake helper: the progress lands in the run store
    /// under the run's id, the result is the answer, and a helper's refusal
    /// or absence is an error with the helper's words.
    #[cfg(unix)]
    #[test]
    fn root_run_relays_the_helper() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;

        let dir = std::env::temp_dir().join(format!("daedalus-api-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("root.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let helper = std::thread::spawn(move || {
            let mut asked = Vec::new();
            for answer in [
                "{\"t\":\"progress\",\"line\":\"rebooting\"}\n{\"t\":\"result\",\"outcome\":\"done\",\"detail\":\"rebooting\"}\n",
                "{\"t\":\"error\",\"code\":\"unknown_verb\",\"msg\":\"no verb \\\"halt\\\"\"}\n",
            ] {
                let (s, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
                asked.push(line);
                (&s).write_all(answer.as_bytes()).unwrap();
            }
            asked
        });

        let text = format!(
            "mode = \"controller\"\ntelemetry = \"off\"\n[controller]\nroot_socket = {:?}\n",
            sock.display().to_string()
        );
        let cfg: Config = toml::from_str(&text).unwrap();
        let shared = Arc::new(Shared::new(
            crate::state::State::default(),
            crate::facts::Facts::default(),
            std::time::Instant::now(),
            cfg.initial_policy(),
            cfg.role(),
        ));
        let api = Api::new(Arc::clone(&shared), &cfg);

        let ok: Value = serde_json::from_str(
            ask_api(&api, "root.run", serde_json::json!({"verb": "reboot"}))
                .unwrap()
                .get(),
        )
        .unwrap();
        assert_eq!(ok["outcome"], "done");
        assert_eq!(ok["detail"], "rebooting");
        assert_eq!(ok["verb"], "reboot");
        let run = ok["run"].as_str().unwrap().to_string();
        let followed: Value = serde_json::from_str(
            ask_api(&api, "root.follow", serde_json::json!({"run": run}))
                .unwrap()
                .get(),
        )
        .unwrap();
        assert_eq!(
            followed["lines"],
            serde_json::json!([{"seq": 1, "line": "rebooting"}])
        );

        let e = ask_api(&api, "root.run", serde_json::json!({"verb": "halt"})).unwrap_err();
        assert_eq!(e.code, ErrorCode::BadRequest);
        assert!(e.msg.contains("halt"), "{}", e.msg);

        // Nonsense is refused here, before a root process is spent on it.
        for p in [
            serde_json::json!({"verb": "Reboot"}),
            serde_json::json!({"verb": "deploy", "selectors": {"app": "a\nb"}}),
            serde_json::json!({"verb": "deploy", "selectors": {"app": "-rf"}}),
            serde_json::json!({"verb": "secret", "payload": "x".repeat(crate::root::MAX_PAYLOAD + 1)}),
            serde_json::json!({"verb": "reboot", "unit": "sshd.service"}),
        ] {
            assert_eq!(
                ask_api(&api, "root.run", p.clone()).unwrap_err().code,
                ErrorCode::BadRequest,
                "{p}"
            );
        }
        let asked = helper.join().unwrap();
        assert!(
            asked[0].starts_with("{\"verb\":\"reboot\",\"id\":\""),
            "{}",
            asked[0]
        );

        // The helper gone: unavailable, saying so.
        drop(std::fs::remove_file(&sock));
        let e = ask_api(&api, "root.run", serde_json::json!({"verb": "reboot"})).unwrap_err();
        assert_eq!(e.code, ErrorCode::Unavailable);
        let _ = std::fs::remove_dir_all(dir);

        // No socket configured: not offered at all.
        let plain: Config = toml::from_str("mode = \"controller\"").unwrap();
        let api = Api::new(shared, &plain);
        assert_eq!(
            ask_api(&api, "root.run", serde_json::json!({"verb": "status"}))
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
    }

    /// A `detach` run answers once the helper says the unit started; its
    /// later lines and its outcome are the store's, read with `root.follow`
    /// from any line and listed by `root.runs`. A refusal before the start
    /// is the answer itself.
    #[cfg(unix)]
    #[test]
    fn a_detached_run_answers_at_its_start_and_is_followed() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;

        let dir = std::env::temp_dir().join(format!("daedalus-api-detach-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("root.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let (go, wait) = std::sync::mpsc::channel::<()>();
        let helper = std::thread::spawn(move || {
            let accept = || {
                let (s, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(s.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                s
            };
            let s = accept();
            (&s).write_all(b"{\"t\":\"started\",\"unit\":\"daedalus-build@x.service\"}\n{\"t\":\"progress\",\"line\":\"one\"}\n").unwrap();
            wait.recv().unwrap();
            (&s).write_all(b"{\"t\":\"progress\",\"line\":\"two\"}\n{\"t\":\"result\",\"outcome\":\"failed\",\"detail\":\"fence\"}\n").unwrap();
            drop(s);
            let s = accept();
            (&s).write_all(
                b"{\"t\":\"result\",\"outcome\":\"refused\",\"detail\":\"another build runs\"}\n",
            )
            .unwrap();
        });

        let text = format!(
            "mode = \"controller\"\ntelemetry = \"off\"\n[controller]\nroot_socket = {:?}\n",
            sock.display().to_string()
        );
        let cfg: Config = toml::from_str(&text).unwrap();
        let shared = Arc::new(Shared::new(
            crate::state::State::default(),
            crate::facts::Facts::default(),
            std::time::Instant::now(),
            cfg.initial_policy(),
            cfg.role(),
        ));
        let api = Api::new(shared, &cfg);
        let call = |m: &str, p: Value| -> Value {
            serde_json::from_str(ask_api(&api, m, p).unwrap().get()).unwrap()
        };

        let ok = call(
            "root.run",
            serde_json::json!({"verb": "build", "detach": true}),
        );
        assert_eq!(ok["outcome"], Value::Null, "{ok}");
        let run = ok["run"].as_str().unwrap().to_string();
        let followed = call("root.follow", serde_json::json!({"run": run}));
        assert_eq!(followed["run"]["started"], true);
        assert_eq!(followed["run"]["outcome"], Value::Null);
        go.send(()).unwrap();
        // The rest arrives in the store, not on the answered request.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let last = loop {
            let f = call("root.follow", serde_json::json!({"run": run, "after": 1}));
            if f["run"]["outcome"] != Value::Null || std::time::Instant::now() > deadline {
                break f;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(last["run"]["outcome"], "failed");
        assert_eq!(last["run"]["detail"], "fence");
        assert_eq!(
            last["lines"],
            serde_json::json!([{"seq": 2, "line": "two"}])
        );
        assert_eq!(last["next"], 2);

        let refused = call(
            "root.run",
            serde_json::json!({"verb": "build", "detach": true}),
        );
        assert_eq!(refused["outcome"], "refused");
        assert_eq!(refused["detail"], "another build runs");
        helper.join().unwrap();

        let runs = call("root.runs", serde_json::json!({"verb": "build"}));
        let listed: Vec<&str> = runs["runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["outcome"].as_str().unwrap())
            .collect();
        assert_eq!(listed, ["refused", "failed"], "newest first");
        assert_eq!(
            ask_api(&api, "root.follow", serde_json::json!({"run": "nope"}))
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
