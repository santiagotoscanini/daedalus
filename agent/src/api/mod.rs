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
//! The app deploys on save and the controller moves with a lock bump, so
//! the two meet at different versions as a matter of course.
//!
//! **Fixed verbs.** The "no shell" rule: each method is a fixed verb with
//! typed parameters. None takes a command, a path or a flag from the
//! caller, and none ever will.
//!
//! | method             | answers                                               | needs                   |
//! |--------------------|-------------------------------------------------------|-------------------------|
//! | `hello`            | `HelloOk`                                              | first on the connection |
//! | `system.info`      | `SystemInfo`: version, mode, OS, uptime, role, capabilities | —                  |
//! | `claude.status`    | `ClaudeStatus`: the session's last report              | `claude.remote_control` |
//! | `claude.restart`   | `Queued`; the session restarts the server (`unavailable` while off or no session reports) | `claude.remote_control` |
//! | `claude.roster`    | `ClaudeRosterGet`: the session's roster of Claude sessions (claude/roster.rs) | `claude.sessions` |
//! | `claude.session`   | `SessionQueued`: one verb `{action, id}` queued for the session; its roster's `actions` reports it under `request` | `claude.sessions` |
//! | `telemetry.get`    | `TelemetryGet`: the document at the configured level   | —                       |
//! | `events.subscribe` | `{}`, then the events below                           | —                       |
//! | `nodes.list`       | `NodesList`: every machine known, its standing and connection | `nodes`          |
//! | `nodes.get`        | `NodeDetail`: one machine's hello, status and open telemetry `{id}` | `nodes`     |
//! | `nodes.telemetry`  | `NodeTelemetry`: its full telemetry `{id}`             | `nodes`                 |
//! | `nodes.providers`  | `NodeProviders`: its providers document `{id}`        | `nodes`                 |
//! | `nodes.claude`     | `NodeClaude`: its full Claude report `{id}`            | `nodes`                 |
//! | `nodes.claude_roster` | `NodeClaudeRoster`: its roster of Claude sessions `{id}` | `nodes`             |
//! | `nodes.claude_session` | `ClaudeSessionSent`: one verb `{id, action, session}` delivered and acknowledged | `nodes` |
//! | `nodes.provider_model` | `ProviderModelSent`: one residency verb `{id, kind, action, model, pinned?, replacing?}` delivered and acknowledged | `nodes` |
//! | `nodes.set_desired`| `SetDesiredOk`: the app's complete approved/revoked set with policies and names `{nodes:[…]}` | `nodes` |
//! | `nodes.command`    | `CommandOk`: delivered, or queued `{id, command}`      | `nodes`                 |
//! | `controller.rotate`| `ControllerInfo` with its `rotation`: a new controller key, the old one retired after `{grace_secs?}` (link/rotation.rs) | the controller |
//! | `root.run`         | `RootRunOk`: one root verb `{verb, selectors?}` run by the root helper to its end — `done`, `refused` or `failed` with a detail; `status` lists the verbs (root/) | `root` |
//! | `santree.status` | `SantreeStatus`: the session host from its status file — `running`, `stale`, `stopped` or `missing`, its version, whether a restart would apply a newer build, its live PTYs and connections by machine, and why the controller cannot read it or write its allow-list (session_host.rs); `unavailable` where the box has none | — |
//!
//! `root.run` answers when the verb's unit has finished, which can be
//! minutes: a client gives it a timeout of its own. It is the only door to
//! the root helper — the app never connects to that socket.
//!
//! The `nodes.*` methods read and steer the machines connected to the
//! controller (link/controller.rs). Their selector is a node id — sixteen
//! lowercase hex characters, checked before anything else — and their
//! parameters are exact; `command` is one of `check_update`,
//! `claude_update`, `claude_restart`. A session verb (`claude.session`
//! and `nodes.claude_session`) is `resume`, `stop` or `remove` with the
//! selector each takes — a canonical lowercase uuid for `resume`, that or a
//! background agent's eight hex digits for `stop`, the eight digits for
//! `remove` (claude/sessions.rs `check_selector`) — checked here, again by
//! the machine that takes it, and again by its session, which refuses
//! every verb while its policy keeps Claude off. `nodes.claude_session`
//! reaches only a connected, approved machine that offers
//! `claude.sessions`, and is never queued for later. `set_desired` checks every entry (an
//! id that is not its key's, a key twice, a policy field it does not know,
//! a `name` longer than `MAX_NODE_NAME` characters or with a control
//! character) before applying any. A machine the controller has never heard of is
//! `not_found`; a command for one that is not approved is `unavailable`.
//! All of it is additive to api 1: no earlier method or event changed.
//!
//! **Capabilities** come from the role table and the config, never from
//! the OS (`capabilities`): `claude.remote_control` where a session runs
//! and may run Claude — on the controller only when `[controller]
//! claude_remote_control` says so, and `claude.sessions` beside it (the
//! roster and the session verbs); `claude.update` where the role lets the
//! agent update Claude Code — never on the controller, whose Claude nix
//! pins; `telemetry.full` or `telemetry.minimal` as `telemetry` says
//! (nothing at `off`); `nodes` where the controller listens for machines
//! (`[controller] listen`); `root` on the controller where `[controller]
//! root_socket` names the helper. A method whose capability is absent
//! answers `unsupported`.
//!
//! **Events** are best effort: a subscriber that does not read fills its
//! queue (`EVENT_QUEUE`) and loses the events after that, never the
//! connection; an event says what moved, and the method that reads the
//! whole picture is the source of truth. `claude.changed` goes out when a
//! session starts reporting, when a report's state or pid differs from the
//! previous report's, and when the session stops reporting (no report for
//! 30 s); `telemetry.updated` with every sample; `nodes.changed` `{id,
//! state, connected}` when a machine connects, leaves or changes standing;
//! `nodes.pending` `{id, fingerprint, hostname}` when an unknown key
//! connects and waits for approval; `nodes.left` `{id}` when an approved
//! machine logs out (the link's `leave`: the app forgets it and deletes its
//! wg-easy client); `nodes.policy_request` `{id, changes}` when an approved
//! machine's user asks for one of its settings (the link's
//! `policy_request`: the app writes the keys `changes` names and sends the
//! set again; never santree on); `root.progress` `{run, verb, line}` for
//! each line a running root verb's unit writes.

pub mod conn;
pub mod wire;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::Value;

use crate::config::{Config, TelemetryLevel};
use crate::role::Role;
use crate::rpc::{code, error_line, ApiError, Events};
use crate::shared::Shared;
use wire::{ClaudeStatus, OsInfo, Queued, SystemInfo, TelemetryGet};

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

/// What this agent offers the app, from its role and config (module doc).
pub fn capabilities(cfg: &Config, nodes: bool) -> Vec<&'static str> {
    let role = cfg.role();
    let mut c = Vec::new();
    // A node runs Claude as the box's policy says; the controller only
    // when nix turned it on — never offered while it cannot run.
    let claude = match role.mode {
        crate::config::Mode::Node => true,
        crate::config::Mode::Controller => cfg.controller.claude_remote_control,
    };
    if role.session && claude {
        c.push("claude.remote_control");
        if role.claude_update {
            c.push("claude.update");
        }
        c.push("claude.sessions");
    }
    match cfg.telemetry {
        TelemetryLevel::Full => c.push("telemetry.full"),
        TelemetryLevel::Minimal => c.push("telemetry.minimal"),
        TelemetryLevel::Off => {}
    }
    // A node reads its providers and drives their residency for the box.
    if role.link {
        c.push("providers.residency");
    }
    if nodes && role.node_listener {
        c.push("nodes");
    }
    // The root helper answers only the controller (root/mod.rs), and only
    // where nix named its socket.
    if role.api_socket && cfg.controller.root_socket.is_some() {
        c.push("root");
    }
    c
}

/// What the methods read: the service's shared state and what this agent
/// is.
pub struct Api {
    shared: Arc<Shared>,
    role: Role,
    telemetry: TelemetryLevel,
    capabilities: Vec<&'static str>,
    /// The root helper's socket, where `root` is offered.
    root_socket: Option<std::path::PathBuf>,
    /// `MAX_IN_FLIGHT`, except in the tests of the `busy` answer.
    max_in_flight: usize,
}

impl Api {
    pub fn new(shared: Arc<Shared>, cfg: &Config) -> Self {
        let role = cfg.role();
        Self {
            capabilities: capabilities(cfg, shared.nodes().is_some()),
            shared,
            role,
            telemetry: cfg.telemetry,
            root_socket: cfg.controller.root_socket.clone(),
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

    fn has(&self, capability: &str) -> Result<(), ApiError> {
        if self.capabilities.contains(&capability) {
            Ok(())
        } else {
            Err(ApiError::new(
                code::UNSUPPORTED,
                format!("this agent does not offer `{capability}`"),
            ))
        }
    }

    /// One method, after `hello` (conn.rs handles `hello` and
    /// `events.subscribe`, which belong to the connection).
    pub fn call(&self, method: &str, params: &Value) -> Result<Box<RawValue>, ApiError> {
        let no_params = || match params {
            Value::Null => Ok(()),
            Value::Object(m) if m.is_empty() => Ok(()),
            _ => Err(ApiError::new(
                code::BAD_REQUEST,
                format!("`{method}` takes no parameters"),
            )),
        };
        match method {
            "system.info" => {
                no_params()?;
                to_value(&self.system_info())
            }
            "claude.status" => {
                no_params()?;
                self.has("claude.remote_control")?;
                let report = self.shared.claude_report();
                to_value(&ClaudeStatus {
                    reporting: report.is_some(),
                    wanted: self.shared.policy().claude_remote_control,
                    report,
                })
            }
            "claude.restart" => {
                no_params()?;
                self.has("claude.remote_control")?;
                if !self.shared.policy().claude_remote_control {
                    return Err(ApiError::new(
                        code::UNAVAILABLE,
                        "Claude remote control is off on this machine; there is nothing to restart",
                    ));
                }
                // Queued for nobody, a restart would fire whenever a
                // session next came up — long after anyone asked.
                if self.shared.claude_report().is_none() {
                    return Err(ApiError::new(
                        code::UNAVAILABLE,
                        "no session is reporting on this machine; there is nothing to restart",
                    ));
                }
                self.shared.request_claude_restart();
                to_value(&Queued { queued: true })
            }
            "claude.roster" => {
                no_params()?;
                self.has("claude.sessions")?;
                let roster = self.shared.claude_roster();
                to_value(&wire::ClaudeRosterGet {
                    reporting: roster.is_some(),
                    roster,
                })
            }
            "claude.session" => {
                self.has("claude.sessions")?;
                let s: wire::ClaudeSession = serde_json::from_value(params.clone())
                    .map_err(|e| ApiError::new(code::BAD_REQUEST, format!("`{method}`: {e}")))?;
                crate::claude::sessions::check_selector(s.action, &s.id)
                    .map_err(|e| ApiError::new(code::BAD_REQUEST, e))?;
                if !self.shared.policy().claude_remote_control {
                    return Err(ApiError::new(
                        code::UNAVAILABLE,
                        "Claude is off on this machine; no session verb runs",
                    ));
                }
                if self.shared.claude_report().is_none() {
                    return Err(ApiError::new(
                        code::UNAVAILABLE,
                        "no session is reporting on this machine; there is nobody to run it",
                    ));
                }
                let request = self
                    .shared
                    .queue_claude_session(s.action, s.id)
                    .ok_or_else(|| {
                        ApiError::new(
                            code::BUSY,
                            "the session has requests waiting that it has not taken",
                        )
                    })?;
                to_value(&wire::SessionQueued {
                    queued: true,
                    request,
                })
            }
            "telemetry.get" => {
                no_params()?;
                to_value(&TelemetryGet {
                    level: self.telemetry,
                    telemetry: match self.telemetry {
                        TelemetryLevel::Off => None,
                        _ => self.shared.telemetry(),
                    },
                })
            }
            "controller.rotate" => {
                use crate::link::rotation::{GRACE_DEFAULT, GRACE_MAX, GRACE_MIN};
                let keys = self.shared.controller_keys().ok_or_else(|| {
                    ApiError::new(
                        code::UNSUPPORTED,
                        "this agent is not the controller; it has no key to rotate",
                    )
                })?;
                let p: wire::ControllerRotate = match params {
                    Value::Null => wire::ControllerRotate::default(),
                    p => serde_json::from_value(p.clone()).map_err(|e| {
                        ApiError::new(code::BAD_REQUEST, format!("`{method}`: {e}"))
                    })?,
                };
                let grace = p.grace_secs.map_or(GRACE_DEFAULT, Duration::from_secs);
                if !(GRACE_MIN..=GRACE_MAX).contains(&grace) {
                    return Err(ApiError::new(
                        code::BAD_REQUEST,
                        format!(
                            "`{method}`: grace_secs is {} to {}",
                            GRACE_MIN.as_secs(),
                            GRACE_MAX.as_secs()
                        ),
                    ));
                }
                keys.start(grace)
                    .map_err(|e| ApiError::new(code::UNAVAILABLE, e))?;
                to_value(&self.shared.controller_info())
            }
            "santree.status" => {
                no_params()?;
                let host = self.shared.session_host().ok_or_else(|| {
                    ApiError::new(code::UNAVAILABLE, "no session host on this box")
                })?;
                to_value(&host.status())
            }
            "root.run" => {
                self.has("root")?;
                let p: wire::RootRun = serde_json::from_value(params.clone())
                    .map_err(|e| ApiError::new(code::BAD_REQUEST, format!("`{method}`: {e}")))?;
                to_value(&self.root_run(p)?)
            }
            m if m.starts_with("nodes.") => self.nodes_call(m, params),
            _ => Err(ApiError::new(
                code::UNKNOWN_METHOD,
                format!("no method `{method}`"),
            )),
        }
    }

    /// The `nodes.*` methods (module doc).
    fn nodes_call(&self, method: &str, params: &Value) -> Result<Box<RawValue>, ApiError> {
        let known = [
            "nodes.list",
            "nodes.get",
            "nodes.telemetry",
            "nodes.providers",
            "nodes.claude",
            "nodes.claude_roster",
            "nodes.claude_session",
            "nodes.provider_model",
            "nodes.set_desired",
            "nodes.command",
        ];
        if !known.contains(&method) {
            return Err(ApiError::new(
                code::UNKNOWN_METHOD,
                format!("no method `{method}`"),
            ));
        }
        self.has("nodes")?;
        let nodes = self
            .shared
            .nodes()
            .ok_or_else(|| ApiError::new(code::UNSUPPORTED, "this agent serves no machines"))?;
        fn exact<T: serde::de::DeserializeOwned>(method: &str, p: &Value) -> Result<T, ApiError> {
            serde_json::from_value(p.clone())
                .map_err(|e| ApiError::new(code::BAD_REQUEST, format!("`{method}`: {e}")))
        }
        let id_of = |p: &Value| -> Result<String, ApiError> {
            let w: wire::NodeId = exact(method, p)?;
            checked_id(&w.id)?;
            Ok(w.id)
        };
        match method {
            "nodes.list" => {
                match params {
                    Value::Null => {}
                    Value::Object(m) if m.is_empty() => {}
                    _ => {
                        return Err(ApiError::new(
                            code::BAD_REQUEST,
                            "`nodes.list` takes no parameters",
                        ))
                    }
                }
                to_value(&wire::NodesList {
                    nodes: nodes.list(),
                })
            }
            "nodes.get" => to_value(&nodes.get(&id_of(params)?)?),
            "nodes.telemetry" => to_value(&nodes.telemetry(&id_of(params)?)?),
            "nodes.providers" => to_value(&nodes.providers(&id_of(params)?)?),
            "nodes.claude" => to_value(&nodes.claude(&id_of(params)?)?),
            "nodes.claude_roster" => to_value(&nodes.claude_roster(&id_of(params)?)?),
            "nodes.claude_session" => {
                let c: wire::NodeClaudeSession = exact(method, params)?;
                checked_id(&c.id)?;
                crate::claude::sessions::check_selector(c.action, &c.session)
                    .map_err(|e| ApiError::new(code::BAD_REQUEST, e))?;
                to_value(&nodes.claude_session(&c.id, c.action, &c.session)?)
            }
            "nodes.provider_model" => {
                let c: wire::NodeProviderModel = exact(method, params)?;
                checked_id(&c.id)?;
                let p = crate::providers::ProviderModelParams {
                    kind: c.kind,
                    action: c.action,
                    model: c.model,
                    pinned: c.pinned.unwrap_or(false),
                    replacing: c.replacing,
                    request: crate::claude::sessions::mint_request(),
                };
                p.check().map_err(|e| ApiError::new(code::BAD_REQUEST, e))?;
                to_value(&nodes.provider_model(&c.id, p)?)
            }
            "nodes.set_desired" => {
                let set: wire::SetDesired = exact(method, params)?;
                to_value(&nodes.set_desired(desired_entries(set)?))
            }
            "nodes.command" => {
                let c: wire::NodeCommand = exact(method, params)?;
                checked_id(&c.id)?;
                to_value(&nodes.command(&c.id, c.command)?)
            }
            _ => unreachable!("listed above"),
        }
    }

    /// `root.run`: one verb on the root helper, its unit's lines published
    /// as `root.progress` while it runs, its outcome the answer. The helper
    /// is the authority on what exists; the words are checked here only so
    /// nonsense costs no root process.
    fn root_run(&self, p: wire::RootRun) -> Result<wire::RootRunOk, ApiError> {
        use crate::root::{self, relay::RelayError};
        let socket = self
            .root_socket
            .as_ref()
            .ok_or_else(|| ApiError::new(code::UNSUPPORTED, "no root helper is configured"))?;
        if !root::valid_name(&p.verb) {
            return Err(ApiError::new(
                code::BAD_REQUEST,
                "`root.run`: a verb is [a-z][a-z0-9-]{0,31}",
            ));
        }
        if p.selectors
            .iter()
            .any(|(k, v)| !root::valid_name(k) || !root::valid_free_value(v, root::MAX_PATTERN_LEN))
        {
            return Err(ApiError::new(
                code::BAD_REQUEST,
                "`root.run`: a selector is a name and a value of printable ASCII, at most 256, not starting with -",
            ));
        }
        if p.payload
            .as_ref()
            .is_some_and(|x| x.len() > root::MAX_PAYLOAD)
        {
            return Err(ApiError::new(
                code::BAD_REQUEST,
                format!(
                    "`root.run`: a payload is at most {} bytes",
                    root::MAX_PAYLOAD
                ),
            ));
        }
        let run = crate::claude::sessions::mint_request();
        let request = root::Request {
            verb: p.verb.clone(),
            id: run.clone(),
            selectors: p.selectors,
            payload: p.payload,
        };
        tracing::info!(verb = %p.verb, run = %run, "root: asking the helper");
        let events = self.shared.events();
        let answer = root::relay::run(socket, &request, ROOT_SILENCE, |line| {
            events.publish(
                wire::event::ROOT_PROGRESS,
                &wire::RootProgress {
                    run: run.clone(),
                    verb: p.verb.clone(),
                    line: line.to_string(),
                },
            );
        });
        match answer {
            Ok(a) => {
                tracing::info!(verb = %p.verb, run = %run, outcome = ?a.outcome, detail = %a.detail, "root: answered");
                Ok(wire::RootRunOk {
                    run,
                    verb: p.verb,
                    outcome: a.outcome,
                    detail: a.detail,
                    verbs: a.verbs,
                })
            }
            Err(e) => {
                tracing::warn!(verb = %p.verb, run = %run, error = %e, "root: no answer");
                Err(match &e {
                    RelayError::Refused { code: c, .. }
                        if c == root::code::BAD_REQUEST || c == root::code::UNKNOWN_VERB =>
                    {
                        ApiError::new(code::BAD_REQUEST, e.to_string())
                    }
                    _ => ApiError::new(code::UNAVAILABLE, e.to_string()),
                })
            }
        }
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
                os: f.os,
                name: f.os_name.clone(),
                version: f.os_version.clone(),
                arch: f.arch,
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
    serde_json::value::to_raw_value(v).map_err(|e| ApiError::new(code::INTERNAL, e.to_string()))
}

/// A node id as a selector: sixteen lowercase hex characters.
fn checked_id(id: &str) -> Result<(), ApiError> {
    if wire::valid_node_id(id) {
        Ok(())
    } else {
        Err(ApiError::new(
            code::BAD_REQUEST,
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
        code::BAD_REQUEST,
        format!("{id}: the name {bad}"),
    ))
}

/// The app's set, every entry checked before any is applied: the id is its
/// key's node id, and no id is named twice. An approved entry without a
/// policy gets `Policy::default()`; a revoked one's policy is kept unused.
fn desired_entries(
    set: wire::SetDesired,
) -> Result<Vec<crate::link::controller::DesiredEntry>, ApiError> {
    let mut seen = std::collections::HashSet::new();
    set.nodes
        .into_iter()
        .map(|n| {
            checked_id(&n.id)?;
            let key = crate::identity::parse_public_key(&n.public_key)
                .map_err(|e| ApiError::new(code::BAD_REQUEST, format!("{}: {e}", n.id)))?;
            let of_key = crate::identity::node_id_of(&key);
            if of_key != n.id {
                return Err(ApiError::new(
                    code::BAD_REQUEST,
                    format!(
                        "{} is not the node id of its public_key ({of_key} is)",
                        n.id
                    ),
                ));
            }
            if !seen.insert(n.id.clone()) {
                return Err(ApiError::new(
                    code::BAD_REQUEST,
                    format!("{} is named twice", n.id),
                ));
            }
            if let Some(name) = &n.name {
                checked_name(&n.id, name)?;
            }
            let offered = n
                .policy
                .as_ref()
                .and_then(|p| p.providers.lemonade.as_ref())
                .filter(|l| l.offer == Some(true))
                .map(|_| vec!["lemonade".to_string()])
                .unwrap_or_default();
            Ok(crate::link::controller::DesiredEntry {
                id: n.id,
                public_key: key,
                state: n.state,
                policy: n.policy.map(Into::into).unwrap_or_default(),
                name: n.name,
                offered,
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
        code::FORBIDDEN,
        format!("{who} may not use this socket (the agent's own uid and controller.api_allowed_uids may)"),
    )
}

/// The line a connection past `max` gets before it is closed.
pub fn too_many(max: usize) -> String {
    error_line(
        code::BUSY,
        format!("at most {max} connections at once; closing"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(
            capabilities(&cfg(""), false),
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
            capabilities(&cfg("telemetry = \"off\""), true),
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
            capabilities(&cfg(on), false),
            ["claude.remote_control", "claude.sessions", "telemetry.full"]
        );
        assert_eq!(
            capabilities(&cfg("mode = \"controller\""), false),
            ["telemetry.full"]
        );
        assert_eq!(
            capabilities(&cfg("mode = \"controller\"\ntelemetry = \"minimal\""), true),
            ["telemetry.minimal", "nodes"]
        );
        assert_eq!(
            capabilities(&cfg(&format!("telemetry = \"off\"\n{on}")), false),
            ["claude.remote_control", "claude.sessions"]
        );
        // `root` only on the controller, and only with the helper's socket.
        let root = "mode = \"controller\"\ntelemetry = \"off\"\n[controller]\nroot_socket = \"/run/r.sock\"\n";
        assert_eq!(capabilities(&cfg(root), false), ["root"]);
        let node_root = "telemetry = \"off\"\n[controller]\nroot_socket = \"/run/r.sock\"\n";
        assert!(!capabilities(&cfg(node_root), false).contains(&"root"));
    }

    /// `root.run` through a fake helper: the progress goes out as events
    /// carrying the run's id, the result is the answer, and a helper's
    /// refusal or absence is an error with the helper's words.
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
        let events = api.events().subscribe();

        let ok: Value = serde_json::from_str(
            api.call("root.run", &serde_json::json!({"verb": "reboot"}))
                .unwrap()
                .get(),
        )
        .unwrap();
        assert_eq!(ok["outcome"], "done");
        assert_eq!(ok["detail"], "rebooting");
        assert_eq!(ok["verb"], "reboot");
        let run = ok["run"].as_str().unwrap().to_string();
        let event: Value = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
        assert_eq!(event["e"], "root.progress");
        assert_eq!(event["p"]["run"], run.as_str());
        assert_eq!(event["p"]["line"], "rebooting");

        let e = api
            .call("root.run", &serde_json::json!({"verb": "halt"}))
            .unwrap_err();
        assert_eq!(e.code, code::BAD_REQUEST);
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
                api.call("root.run", &p).unwrap_err().code,
                code::BAD_REQUEST,
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
        let e = api
            .call("root.run", &serde_json::json!({"verb": "reboot"}))
            .unwrap_err();
        assert_eq!(e.code, code::UNAVAILABLE);
        let _ = std::fs::remove_dir_all(dir);

        // No socket configured: not offered at all.
        let plain: Config = toml::from_str("mode = \"controller\"").unwrap();
        let api = Api::new(shared, &plain);
        assert_eq!(
            api.call("root.run", &serde_json::json!({"verb": "status"}))
                .unwrap_err()
                .code,
            code::UNSUPPORTED
        );
    }
}
