//! The link's wire types: every message between a machine and the
//! controller, as serde writes them, with golden tests pinning each one's
//! exact JSON — the same contract discipline as the local API's wire.rs,
//! whose envelope this reuses: a request `{"id","m","p"}`, an answer
//! `{"id","ok"}` or `{"id","err":{"code","msg"}}`, an event `{"e","p"}`,
//! one per line, at most `MAX_LINE` bytes.
//!
//! ```text
//! node → {"id":1,"m":"hello","p":{"proto":1,"node_id":"…","agent_version":"0.14.0",…}}
//! ctl  ← {"id":1,"ok":{"proto":1,"node_id":"…","state":"pending","controller":{…},"policy":null}}
//! ctl  ← {"e":"state","p":{"state":"approved"}}
//! ctl  ← {"e":"policy","p":{"awake_hold":true,"claude_remote_control":true}}
//! node → {"e":"status","p":{…}}   {"e":"telemetry","p":{…}}   {"e":"claude","p":{…}}
//! ctl  ← {"id":7,"m":"command","p":{"command":"claude_restart"}}
//! node → {"id":7,"ok":{"accepted":true}}
//! node → {"e":"claude_roster","p":{…}}
//! ctl  ← {"id":8,"m":"claude_session","p":{"action":"resume","id":"<uuid>","request":"<16 hex>"}}
//! node → {"id":8,"ok":{"accepted":true}}
//! ctl  ← {"id":9,"m":"provider_model","p":{"kind":"lemonade","action":"load","model":"…","pinned":false,"replacing":null,"request":"<16 hex>"}}
//! node → {"id":9,"ok":{"accepted":true}}
//! both → {"e":"hb"}
//! ```
//!
//! The protocol version (`PROTO`) rides the first request, `hello`; a
//! controller that speaks another answers `version` with the one it does,
//! and the machine says so on its status page and retries at the slowest
//! step. Fields a side does not know are ignored everywhere on this link:
//! the two ends are released separately (the box's with the lock bump, a
//! machine's when it updates), so an addition must never break the other.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::claude::{Report, Roster, SessionAction};
use crate::config::TelemetryLevel;
use crate::providers::ProviderReport;
use crate::telemetry::Telemetry;

/// The link protocol this agent speaks.
pub const PROTO: u32 = 1;

/// The methods and events, all of them.
pub mod name {
    /// node → controller, the first request.
    pub const HELLO: &str = "hello";
    /// controller → node: a one-shot instruction, acknowledged.
    pub const COMMAND: &str = "command";
    /// both ways, every `HEARTBEAT`.
    pub const HB: &str = "hb";
    /// node → controller: the status document (`status::Shared::status_value`).
    pub const STATUS: &str = "status";
    /// node → controller: the full telemetry document.
    pub const TELEMETRY: &str = "telemetry";
    /// node → controller: the session's full Claude report, or null.
    pub const CLAUDE: &str = "claude";
    /// node → controller: the providers on the machine.
    pub const PROVIDERS: &str = "providers";
    /// node → controller: the session's roster of Claude sessions, or null.
    pub const CLAUDE_ROSTER: &str = "claude_roster";
    /// controller → node: one verb on one Claude session, acknowledged.
    pub const CLAUDE_SESSION: &str = "claude_session";
    /// controller → node: one residency verb on one model, acknowledged;
    /// the outcome rides the next `providers` document (providers.rs).
    pub const PROVIDER_MODEL: &str = "provider_model";
    /// controller → node: where the machine stands.
    pub const STATE: &str = "state";
    /// controller → node: the box's policy for it.
    pub const POLICY: &str = "policy";
}

/// Where a machine stands with the box: what the app decided, or pending
/// while it has decided nothing. `Unknown` is the controller's word, in its
/// own API, for a key it has seen but that is neither connected nor in the
/// app's set (link/controller.rs); a machine is never told it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeState {
    Pending,
    Approved,
    Revoked,
    Unknown,
}

impl NodeState {
    pub fn as_str(self) -> &'static str {
        match self {
            NodeState::Pending => "pending",
            NodeState::Approved => "approved",
            NodeState::Revoked => "revoked",
            NodeState::Unknown => "unknown",
        }
    }
}

/// What a machine is, in `hello`'s facts.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HelloFacts {
    pub os_name: String,
    pub os_version: String,
    pub cpu: String,
    pub memory_bytes: Option<u64>,
}

/// `hello`: who the machine is. Its key is the TLS client certificate's;
/// `node_id` must be that key's, or the controller refuses the connection.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Hello {
    pub proto: u32,
    pub node_id: String,
    pub agent_version: String,
    /// "windows", "macos", "linux".
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub mac: Option<String>,
    pub lan_ip: Option<String>,
    pub facts: HelloFacts,
    /// What the agent offers (`api::capabilities` for its role).
    pub capabilities: Vec<String>,
    /// How much telemetry it reads.
    pub telemetry: TelemetryLevel,
}

/// The longest `hello` line the controller reads before a key is admitted.
pub const MAX_HELLO_LINE: usize = 16 * 1024;

/// A token: letters, digits and `.`, `_`, `+`, `-`, at most `max` bytes.
fn token(what: &str, s: &str, max: usize) -> Result<(), String> {
    if s.is_empty()
        || s.len() > max
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
    {
        return Err(format!("{what} is not a short token"));
    }
    Ok(())
}

/// Text a person reads: no control characters, at most `max` bytes.
fn text(what: &str, s: &str, max: usize) -> Result<(), String> {
    if s.len() > max || s.chars().any(char::is_control) {
        return Err(format!(
            "{what} is longer than {max} bytes or has control characters"
        ));
    }
    Ok(())
}

/// `aa:bb:cc:dd:ee:ff`, either case.
fn mac_ok(s: &str) -> bool {
    let parts: Vec<&str> = s.split(':').collect();
    parts.len() == 6
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

impl Hello {
    /// The bounds the controller holds an unauthenticated `hello` to — what
    /// it keeps in memory and what the app renders. A hostname may be a
    /// Mac's own name ("Santiago’s MacBook Pro"), so it is text, not an RFC
    /// 1123 label: at most 253 bytes, trimmed, without control characters.
    pub fn check(&self) -> Result<(), String> {
        if self.node_id.len() != 16 || !self.node_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("node_id is not sixteen hex characters".into());
        }
        text("hostname", &self.hostname, 253)?;
        if self.hostname.trim().is_empty() || self.hostname.trim() != self.hostname {
            return Err("hostname is empty or padded".into());
        }
        token("agent_version", &self.agent_version, 64)?;
        token("os", &self.os, 64)?;
        token("arch", &self.arch, 64)?;
        if let Some(m) = &self.mac {
            if !mac_ok(m) {
                return Err("mac is not six hex pairs joined by `:`".into());
            }
        }
        if let Some(ip) = &self.lan_ip {
            if ip.parse::<std::net::Ipv4Addr>().is_err() {
                return Err("lan_ip is not an IPv4 address".into());
            }
        }
        if self.capabilities.len() > 32 {
            return Err("more than 32 capabilities".into());
        }
        for c in &self.capabilities {
            token("a capability", c, 64)?;
        }
        text("facts.os_name", &self.facts.os_name, 256)?;
        text("facts.os_version", &self.facts.os_version, 256)?;
        text("facts.cpu", &self.facts.cpu, 256)?;
        Ok(())
    }
}

/// The controller as a machine is told it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ControllerId {
    pub version: String,
    pub hostname: String,
    pub fingerprint: String,
}

/// `hello`'s answer. `policy` is the app's for an approved machine and null
/// otherwise.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Welcome {
    pub proto: u32,
    pub node_id: String,
    pub state: NodeState,
    pub controller: ControllerId,
    #[serde(default)]
    pub policy: Option<Policy>,
}

/// What the box wants of a machine: the app's decision, sent by the
/// controller with `hello`'s answer and as the `policy` event. The defaults
/// stand until the controller has approved the machine; there is no local
/// copy.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Policy {
    /// Hold the machine awake (the agent's first job; off means the box
    /// decided this machine may sleep).
    pub awake_hold: bool,
    /// Run `claude remote-control` in the user's session.
    pub claude_remote_control: bool,
    /// The directory the server runs in; empty means the session picks the
    /// most recently used trusted project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_workdir: Option<String>,
    /// What the box knows about the providers on this machine — for now,
    /// the port to look for each on. Absent when it names none.
    #[serde(default, skip_serializing_if = "ProvidersPolicy::is_empty")]
    pub providers: ProvidersPolicy,
}

/// The providers half of the policy, one optional entry per kind.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ProvidersPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lemonade: Option<ProviderPolicy>,
}

impl ProvidersPolicy {
    pub fn is_empty(&self) -> bool {
        self.lemonade.is_none()
    }
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ProviderPolicy {
    /// The port the provider answers on; None means the kind's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            awake_hold: true,
            claude_remote_control: true,
            claude_workdir: None,
            providers: ProvidersPolicy::default(),
        }
    }
}

/// The `state` event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StateEvent {
    pub state: NodeState,
}

/// The one-shot instructions the controller sends a machine.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Command {
    /// The updater looks for a newer release now.
    CheckUpdate,
    /// The session updates Claude Code (interrupts nothing).
    ClaudeUpdate,
    /// The session restarts `claude remote-control` (ends its sessions).
    ClaudeRestart,
}

/// `command`'s parameters.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandParams {
    pub command: Command,
}

/// `claude_session`'s parameters: the verb, its selector (`id`: a session
/// uuid or a background agent's short id) and the request id the
/// controller minted, under which the machine's roster reports the outcome
/// (`actions`). Exact: nothing else rides it, least of all a path or a flag.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeSessionParams {
    pub action: SessionAction,
    pub id: String,
    pub request: String,
}

/// `command`'s answer: the machine took the instruction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Accepted {
    pub accepted: bool,
}

/// Any line, told apart by its fields: a request carries `m`, an event
/// `e`, an answer `ok` or `err`.
#[derive(Clone, Debug, PartialEq)]
pub enum Incoming {
    Request {
        id: u64,
        m: String,
        p: Value,
    },
    Event {
        e: String,
        p: Value,
    },
    Answer {
        id: Option<u64>,
        result: Result<Value, AnswerError>,
    },
}

/// An `err` as read back.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct AnswerError {
    pub code: String,
    pub msg: String,
    pub supported: Option<u32>,
}

impl Incoming {
    pub fn parse(line: &[u8]) -> Result<Incoming, String> {
        let v: Value = serde_json::from_slice(line).map_err(|e| e.to_string())?;
        let Value::Object(mut o) = v else {
            return Err("a line is a JSON object".into());
        };
        if let Some(m) = o.get("m").and_then(Value::as_str).map(str::to_string) {
            let id = o
                .get("id")
                .and_then(Value::as_u64)
                .ok_or("a request has a numeric id")?;
            return Ok(Incoming::Request {
                id,
                m,
                p: o.remove("p").unwrap_or(Value::Null),
            });
        }
        if let Some(e) = o.get("e").and_then(Value::as_str).map(str::to_string) {
            return Ok(Incoming::Event {
                e,
                p: o.remove("p").unwrap_or(Value::Null),
            });
        }
        let id = o.get("id").and_then(Value::as_u64);
        if let Some(ok) = o.remove("ok") {
            return Ok(Incoming::Answer { id, result: Ok(ok) });
        }
        if let Some(err) = o.remove("err") {
            let err: AnswerError = serde_json::from_value(err).map_err(|e| e.to_string())?;
            return Ok(Incoming::Answer {
                id,
                result: Err(err),
            });
        }
        Err("neither a request, an event nor an answer".into())
    }
}

/// A request as a line (no newline).
pub fn request<P: Serialize>(id: u64, m: &str, p: &P) -> String {
    #[derive(Serialize)]
    struct R<'a, P> {
        id: u64,
        m: &'a str,
        p: &'a P,
    }
    serde_json::to_string(&R { id, m, p }).expect("a request serialises")
}

/// An event as a line (no newline).
pub fn event<P: Serialize>(e: &str, p: &P) -> String {
    #[derive(Serialize)]
    struct E<'a, P> {
        e: &'a str,
        p: &'a P,
    }
    serde_json::to_string(&E { e, p }).expect("an event serialises")
}

/// The heartbeat line.
pub const HB_LINE: &str = r#"{"e":"hb"}"#;

/// The payloads a machine pushes, typed for the controller that reads them.
pub type StatusPayload = Value;
pub type TelemetryPayload = Telemetry;
pub type ClaudePayload = Option<Report>;
pub type ClaudeRosterPayload = Option<Roster>;
pub type ProvidersPayload = Vec<ProviderReport>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::wire::{code, ApiError, Response};
    use serde_json::json;

    fn wire<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).unwrap()
    }

    pub fn hello() -> Hello {
        Hello {
            proto: 1,
            node_id: "0123456789abcdef".into(),
            agent_version: "0.14.0".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            hostname: "PC".into(),
            mac: Some("aa:bb:cc:dd:ee:ff".into()),
            lan_ip: Some("192.168.0.120".into()),
            facts: HelloFacts {
                os_name: "Windows 11 Pro".into(),
                os_version: "24H2".into(),
                cpu: "AMD Ryzen 9".into(),
                memory_bytes: Some(64),
            },
            capabilities: vec!["claude.remote_control".into(), "telemetry.full".into()],
            telemetry: TelemetryLevel::Full,
        }
    }

    #[test]
    fn a_hello_is_held_to_its_bounds() {
        assert!(hello().check().is_ok());
        let mac_name = Hello {
            hostname: "Santiago’s MacBook Pro".into(),
            mac: Some("A4:83:E7:00:11:22".into()),
            ..hello()
        };
        assert!(mac_name.check().is_ok());
        type Edit = Box<dyn Fn(&mut Hello)>;
        let bad: Vec<Edit> = vec![
            Box::new(|h| h.hostname = "x".repeat(254)),
            Box::new(|h| h.hostname = "pc\nevil".into()),
            Box::new(|h| h.hostname = " pc".into()),
            Box::new(|h| h.hostname = String::new()),
            Box::new(|h| h.os = "win dows".into()),
            Box::new(|h| h.arch = "a".repeat(65)),
            Box::new(|h| h.agent_version = "1.0\u{1b}".into()),
            Box::new(|h| h.mac = Some("aa:bb:cc:dd:ee".into())),
            Box::new(|h| h.mac = Some("aa-bb-cc-dd-ee-ff".into())),
            Box::new(|h| h.lan_ip = Some("192.168.0.300".into())),
            Box::new(|h| h.lan_ip = Some("fe80::1".into())),
            Box::new(|h| h.capabilities = vec!["x".into(); 33]),
            Box::new(|h| h.capabilities = vec!["a b".into()]),
            Box::new(|h| h.facts.cpu = "c".repeat(257)),
            Box::new(|h| h.node_id = "xyz".into()),
        ];
        for (i, f) in bad.iter().enumerate() {
            let mut h = hello();
            f(&mut h);
            assert!(h.check().is_err(), "case {i}");
        }
    }

    #[test]
    fn hello_and_welcome_on_the_wire() {
        assert_eq!(
            request(1, name::HELLO, &hello()),
            concat!(
                r#"{"id":1,"m":"hello","p":{"proto":1,"node_id":"0123456789abcdef","#,
                r#""agent_version":"0.14.0","os":"windows","arch":"x86_64","hostname":"PC","#,
                r#""mac":"aa:bb:cc:dd:ee:ff","lan_ip":"192.168.0.120","#,
                r#""facts":{"os_name":"Windows 11 Pro","os_version":"24H2","cpu":"AMD Ryzen 9","memory_bytes":64},"#,
                r#""capabilities":["claude.remote_control","telemetry.full"],"telemetry":"full"}}"#
            )
        );
        let welcome = Welcome {
            proto: 1,
            node_id: "0123456789abcdef".into(),
            state: NodeState::Approved,
            controller: ControllerId {
                version: "0.14.0".into(),
                hostname: "box".into(),
                fingerprint: "3f2a:…".into(),
            },
            policy: Some(Policy {
                awake_hold: false,
                claude_remote_control: true,
                claude_workdir: Some("C:/p".into()),
                providers: Default::default(),
            }),
        };
        assert_eq!(
            wire(&Response::ok(1, &welcome)),
            concat!(
                r#"{"id":1,"ok":{"proto":1,"node_id":"0123456789abcdef","state":"approved","#,
                r#""controller":{"version":"0.14.0","hostname":"box","fingerprint":"3f2a:…"},"#,
                r#""policy":{"awake_hold":false,"claude_remote_control":true,"claude_workdir":"C:/p"}}}"#
            )
        );
        let pending = Welcome {
            state: NodeState::Pending,
            policy: None,
            ..welcome
        };
        assert!(wire(&pending).ends_with(r#""state":"pending","controller":{"version":"0.14.0","hostname":"box","fingerprint":"3f2a:…"},"policy":null}"#));
        // A newer peer's extra fields are ignored both ways.
        let mut v = serde_json::to_value(hello()).unwrap();
        v["future"] = json!(1);
        assert_eq!(serde_json::from_value::<Hello>(v).unwrap(), hello());
    }

    #[test]
    fn events_commands_and_answers_on_the_wire() {
        assert_eq!(
            event(
                name::STATE,
                &StateEvent {
                    state: NodeState::Revoked
                }
            ),
            r#"{"e":"state","p":{"state":"revoked"}}"#
        );
        assert_eq!(
            request(
                7,
                name::COMMAND,
                &CommandParams {
                    command: Command::ClaudeRestart
                }
            ),
            r#"{"id":7,"m":"command","p":{"command":"claude_restart"}}"#
        );
        for (c, w) in [
            (Command::CheckUpdate, "check_update"),
            (Command::ClaudeUpdate, "claude_update"),
        ] {
            assert_eq!(wire(&c), format!("\"{w}\""));
        }
        assert_eq!(
            wire(&Response::ok(7, &Accepted { accepted: true })),
            r#"{"id":7,"ok":{"accepted":true}}"#
        );
        assert_eq!(
            HB_LINE,
            event(name::HB, &json!(null)).replace(r#","p":null"#, "")
        );
        let session = ClaudeSessionParams {
            action: SessionAction::Resume,
            id: "abdda3a9-0cb2-43f1-b13e-37f25a755fce".into(),
            request: "00112233445566ff".into(),
        };
        assert_eq!(
            request(8, name::CLAUDE_SESSION, &session),
            concat!(
                r#"{"id":8,"m":"claude_session","p":{"action":"resume","#,
                r#""id":"abdda3a9-0cb2-43f1-b13e-37f25a755fce","request":"00112233445566ff"}}"#
            )
        );
        for bad in [
            json!({"action":"resume","id":"x","request":"r","flags":["--dangerously-skip-permissions"]}),
            json!({"action":"attach","id":"x","request":"r"}),
            json!({"action":"stop","id":"x"}),
        ] {
            assert!(
                serde_json::from_value::<ClaudeSessionParams>(bad.clone()).is_err(),
                "{bad}"
            );
        }
        let load = crate::providers::ProviderModelParams {
            kind: "lemonade".into(),
            action: crate::providers::ModelAction::Load,
            model: "Gemma-4".into(),
            pinned: true,
            replacing: Some("Qwen3".into()),
            request: "00112233445566ff".into(),
        };
        assert_eq!(
            request(9, name::PROVIDER_MODEL, &load),
            concat!(
                r#"{"id":9,"m":"provider_model","p":{"kind":"lemonade","action":"load","#,
                r#""model":"Gemma-4","pinned":true,"replacing":"Qwen3","request":"00112233445566ff"}}"#
            )
        );
        assert!(load.check().is_ok());
        for bad in [
            json!({"kind":"lemonade","action":"load","model":"m","request":"00112233445566ff","url":"http://x"}),
            json!({"kind":"lemonade","action":"delete","model":"m","request":"00112233445566ff"}),
        ] {
            assert!(
                serde_json::from_value::<crate::providers::ProviderModelParams>(bad.clone())
                    .is_err(),
                "{bad}"
            );
        }
        for bad in [
            json!({"kind":"ollama","action":"load","model":"m","request":"00112233445566ff"}),
            json!({"kind":"lemonade","action":"load","model":" ","request":"00112233445566ff"}),
            json!({"kind":"lemonade","action":"unload","model":"m","replacing":"n","request":"00112233445566ff"}),
            json!({"kind":"lemonade","action":"load","model":"m","request":"short"}),
        ] {
            let p: crate::providers::ProviderModelParams =
                serde_json::from_value(bad.clone()).unwrap();
            assert!(p.check().is_err(), "{bad}");
        }
        let roster = Roster {
            reported_at: "t".into(),
            ..Default::default()
        };
        assert_eq!(
            event(name::CLAUDE_ROSTER, &Some(roster)),
            concat!(
                r#"{"e":"claude_roster","p":{"reported_at":"t","agents_available":false,"agents":[],"#,
                r#""transcripts":[],"transcript_total":0,"empty_count":0,"truncated":false,"managed":[],"#,
                r#""session_stats":[],"server":null,"actions":[],"errors":[]}}"#
            )
        );
        assert!(serde_json::from_value::<CommandParams>(json!({"command":"reboot"})).is_err());
        assert!(
            serde_json::from_value::<CommandParams>(json!({"command":"check_update","x":1}))
                .is_err()
        );
    }

    #[test]
    fn incoming_lines_are_told_apart() {
        assert_eq!(
            Incoming::parse(br#"{"id":3,"m":"command","p":{"command":"check_update"}}"#).unwrap(),
            Incoming::Request {
                id: 3,
                m: "command".into(),
                p: json!({"command":"check_update"})
            }
        );
        assert_eq!(
            Incoming::parse(HB_LINE.as_bytes()).unwrap(),
            Incoming::Event {
                e: "hb".into(),
                p: Value::Null
            }
        );
        assert_eq!(
            Incoming::parse(br#"{"id":1,"ok":{"x":1}}"#).unwrap(),
            Incoming::Answer {
                id: Some(1),
                result: Ok(json!({"x":1}))
            }
        );
        let v = ApiError {
            supported: Some(1),
            ..ApiError::new(code::VERSION, "speaks 1")
        };
        let line = wire(&Response::err(Some(1), v));
        assert_eq!(
            Incoming::parse(line.as_bytes()).unwrap(),
            Incoming::Answer {
                id: Some(1),
                result: Err(AnswerError {
                    code: "version".into(),
                    msg: "speaks 1".into(),
                    supported: Some(1)
                })
            }
        );
        for bad in [&b"[1]"[..], b"{}", br#"{"m":"x"}"#, b"nope"] {
            assert!(
                Incoming::parse(bad).is_err(),
                "{:?}",
                std::str::from_utf8(bad)
            );
        }
    }
}
