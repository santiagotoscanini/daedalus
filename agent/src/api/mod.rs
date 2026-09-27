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
//! | `claude.update`    | `Queued`; the session runs `claude update`             | `claude.update`         |
//! | `telemetry.get`    | `TelemetryGet`: the document at the configured level   | —                       |
//! | `events.subscribe` | `{}`, then `claude.changed` and `telemetry.updated`    | —                       |
//!
//! **Capabilities** come from the role table and the config, never from
//! the OS (`capabilities`): `claude.remote_control` where a session runs;
//! `claude.update` where the role lets the agent update Claude Code —
//! never on the controller, whose Claude nix pins; `telemetry.full` or
//! `telemetry.minimal` as `telemetry` says (nothing at `off`). A method
//! whose capability is absent answers `unsupported`.
//!
//! **Events** are best effort: a subscriber that does not read fills its
//! queue (`EVENT_QUEUE`) and loses the events after that, never the
//! connection; an event says what moved, and the method that reads the
//! whole picture is the source of truth. `claude.changed` goes out when a
//! session starts reporting, when a report's state or pid differs from the
//! previous report's, and when the session stops reporting (no report for
//! 30 s); `telemetry.updated` with every sample.

pub mod conn;
pub mod wire;

use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::Value;

use crate::config::{Config, TelemetryLevel};
use crate::role::Role;
use crate::status::Shared;
use wire::{code, ApiError, ClaudeStatus, Event, OsInfo, Queued, SystemInfo, TelemetryGet};

/// The API version this agent speaks.
pub const API_VERSION: u32 = 1;
/// The longest line read or accepted, request or otherwise.
pub const MAX_LINE: usize = 1 << 20;
/// Requests one connection may have in flight before `busy`.
pub const MAX_IN_FLIGHT: usize = 32;
/// Events queued for one subscriber before the rest are dropped.
pub const EVENT_QUEUE: usize = 256;
/// Connections served at once.
pub const MAX_CONNECTIONS: usize = 16;
/// How long a new connection has to send `hello`.
pub const HELLO_DEADLINE: Duration = Duration::from_secs(10);
/// How long one write may block before the peer is taken for gone.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

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
}

/// The one check on who may talk to the API: the peer's uid, as the kernel
/// states it, is this agent's own or one config.toml lists. A peer whose
/// credentials could not be read is refused.
pub fn peer_allowed(peer_uid: Option<u32>, own_uid: u32, listed: &[u32]) -> bool {
    peer_uid.is_some_and(|p| p == own_uid || listed.contains(&p))
}

/// What this agent offers the app, from its role and config (module doc).
pub fn capabilities(role: &Role, telemetry: TelemetryLevel) -> Vec<&'static str> {
    let mut c = Vec::new();
    if role.session {
        c.push("claude.remote_control");
        if role.claude_update {
            c.push("claude.update");
        }
    }
    match telemetry {
        TelemetryLevel::Full => c.push("telemetry.full"),
        TelemetryLevel::Minimal => c.push("telemetry.minimal"),
        TelemetryLevel::Off => {}
    }
    c
}

/// The subscribers to events: one bounded queue each, of lines ready to
/// write.
#[derive(Default)]
pub struct Events {
    subscribers: Mutex<Vec<SyncSender<Arc<str>>>>,
}

impl Events {
    pub fn subscribe(&self) -> Receiver<Arc<str>> {
        let (tx, rx) = mpsc::sync_channel(EVENT_QUEUE);
        self.lock().push(tx);
        rx
    }

    /// Tell every subscriber; one whose connection is gone is forgotten,
    /// one whose queue is full misses this event.
    pub fn publish<P: Serialize>(&self, name: &'static str, payload: &P) {
        let mut subs = self.lock();
        if subs.is_empty() {
            return;
        }
        let Ok(line) = serde_json::to_string(&Event {
            e: name,
            p: payload,
        }) else {
            return;
        };
        let line: Arc<str> = line.into();
        subs.retain(|tx| match tx.try_send(Arc::clone(&line)) {
            Ok(()) | Err(TrySendError::Full(_)) => true,
            Err(TrySendError::Disconnected(_)) => false,
        });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<SyncSender<Arc<str>>>> {
        self.subscribers.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// What the methods read: the service's shared state and what this agent
/// is.
pub struct Api {
    shared: Arc<Shared>,
    role: Role,
    telemetry: TelemetryLevel,
    capabilities: Vec<&'static str>,
    /// `MAX_IN_FLIGHT`, except in the tests of the `busy` answer.
    max_in_flight: usize,
}

impl Api {
    pub fn new(shared: Arc<Shared>, cfg: &Config) -> Self {
        let role = cfg.role();
        Self {
            shared,
            role,
            telemetry: cfg.telemetry,
            capabilities: capabilities(&role, cfg.telemetry),
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
            "claude.update" => {
                no_params()?;
                self.has("claude.update")?;
                self.shared.request_claude_update();
                to_value(&Queued { queued: true })
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
            _ => Err(ApiError::new(
                code::UNKNOWN_METHOD,
                format!("no method `{method}`"),
            )),
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
        }
    }
}

fn to_value<T: Serialize>(v: &T) -> Result<Box<RawValue>, ApiError> {
    serde_json::value::to_raw_value(v).map_err(|e| ApiError::new(code::INTERNAL, e.to_string()))
}

/// Serve the API on the socket config.toml names (`Config::api_socket`)
/// until the returned handle is dropped, which removes the socket.
pub fn serve(cfg: &Config, shared: Arc<Shared>) -> Result<crate::os::LocalSocket> {
    let path = cfg.api_socket();
    let api = Arc::new(Api::new(shared, cfg));
    let limits = Limits::of(cfg);
    let socket = crate::os::serve_local_socket(&path, &limits, move |c| {
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

/// An error that is not an answer to any request, as one line: what a
/// connection gets before it is closed.
pub fn error_line(code: &'static str, msg: impl Into<String>) -> String {
    let mut line = serde_json::to_string(&wire::Response::err(None, ApiError::new(code, msg)))
        .unwrap_or_default();
    line.push('\n');
    line
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
    use crate::config::Mode;

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
        let node = Role::of(Mode::Node);
        let ctl = Role::of(Mode::Controller);
        assert_eq!(
            capabilities(&node, TelemetryLevel::Full),
            ["claude.remote_control", "claude.update", "telemetry.full"]
        );
        // The controller never offers `claude.update`: nix pins Claude there.
        assert_eq!(
            capabilities(&ctl, TelemetryLevel::Full),
            ["claude.remote_control", "telemetry.full"]
        );
        assert_eq!(
            capabilities(&ctl, TelemetryLevel::Minimal),
            ["claude.remote_control", "telemetry.minimal"]
        );
        assert_eq!(
            capabilities(&ctl, TelemetryLevel::Off),
            ["claude.remote_control"]
        );
    }

    #[test]
    fn events_reach_live_subscribers_and_forget_gone_ones() {
        let events = Events::default();
        let rx = events.subscribe();
        let gone = events.subscribe();
        drop(gone);
        events.publish(
            wire::event::CLAUDE_CHANGED,
            &wire::ClaudeChanged {
                reporting: true,
                state: Some("running".into()),
                pid: Some(1),
            },
        );
        assert_eq!(
            &*rx.try_recv().unwrap(),
            r#"{"e":"claude.changed","p":{"reporting":true,"state":"running","pid":1}}"#
        );
        assert_eq!(events.lock().len(), 1);
        // A subscriber that does not read loses events, not its place.
        for _ in 0..EVENT_QUEUE + 5 {
            events.publish(
                wire::event::TELEMETRY_UPDATED,
                &wire::TelemetryUpdated {
                    sampled_at: "t".into(),
                },
            );
        }
        assert_eq!(rx.try_iter().count(), EVENT_QUEUE);
        assert_eq!(events.lock().len(), 1);
    }
}
