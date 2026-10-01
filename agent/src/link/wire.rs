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
//! ctl  ← {"id":10,"m":"rotate","p":{"new_public_key":"<64 hex>","signature":"<128 hex>"}}
//! node → {"id":10,"ok":{"accepted":true}}      (re-pinned; it reconnects under the new key)
//! node → {"id":2,"m":"leave","p":{}}              (logging out; enroll.rs)
//! ctl  ← {"id":2,"ok":{}}                        (the app hears nodes.left; the node closes)
//! node → {"id":3,"m":"policy_request","p":{"awake_hold":false}}   (settings.rs)
//! ctl  ← {"id":3,"ok":{"accepted":true}}         (the app hears nodes.policy_request)
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

use crate::claude::SessionAction;
use crate::core::config::TelemetryLevel;

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
    /// node → controller: the status document (`shared::StatusDocument`).
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
    /// the outcome rides the next `providers` document (providers/).
    pub const PROVIDER_MODEL: &str = "provider_model";
    /// controller → node: where the machine stands.
    pub const STATE: &str = "state";
    /// controller → node: its key hands over to a new one — the statement
    /// signed by the key the node trusts (rotation.rs), acknowledged once
    /// the node has re-pinned.
    pub const ROTATE: &str = "rotate";
    /// controller → node: the box's policy for it.
    pub const POLICY: &str = "policy";
    /// node → controller: this machine logs out (enroll.rs) and asks to be
    /// forgotten; acknowledged, then the app hears `nodes.left`.
    pub const LEAVE: &str = "leave";
    /// node → controller: the machine's user asks the box to change one of
    /// its settings (`PolicyRequest`); acknowledged once the app was told
    /// (`nodes.policy_request`). The change is real only when the box's
    /// next `policy` carries it.
    pub const POLICY_REQUEST: &str = "policy_request";
}

/// `policy_request`'s parameters: the settings a machine's own user may ask
/// the box to change, each an absolute value, so a retry or a replay changes
/// nothing twice. Nothing else of the policy is the machine's to ask for:
/// its names, its providers and its address are grants to it, and santree
/// may only be turned OFF here — turning it on grants a shell on the box,
/// which an admin does in the browser (settings.rs). Exact: an unknown key
/// is refused.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub awake_hold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub claude_remote_control: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub santree: Option<bool>,
}

impl PolicyRequest {
    /// At least one setting, and santree only ever off.
    pub fn check(&self) -> Result<(), String> {
        if self.awake_hold.is_none()
            && self.claude_remote_control.is_none()
            && self.santree.is_none()
        {
            return Err("a policy request names at least one setting".into());
        }
        if self.santree == Some(true) {
            return Err("santree is turned on from Daedalus, not from the machine".into());
        }
        Ok(())
    }
}

/// Where a machine stands with the box: what the app decided, or pending
/// while it has decided nothing. `Unknown` is the controller's word, in its
/// own API, for a key it has seen but that is neither connected nor in the
/// app's set (controller/link/); a machine is never told it.
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
    pub capabilities: Vec<crate::api::wire::Capability>,
    /// How much telemetry it reads.
    pub telemetry: TelemetryLevel,
}

/// The longest `hello` line the controller reads before a key is admitted.
pub const MAX_HELLO_LINE: usize = 16 * 1024;
/// The longest hostname a `hello` may carry, in bytes.
pub const MAX_HOSTNAME: usize = 253;

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
    /// 1123 label: at most `MAX_HOSTNAME` bytes, trimmed, without control
    /// characters.
    pub fn check(&self) -> Result<(), String> {
        if self.node_id.len() != 16 || !self.node_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("node_id is not sixteen hex characters".into());
        }
        text("hostname", &self.hostname, MAX_HOSTNAME)?;
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
    /// santree on this machine may open its projects on the box: the
    /// agent's santree socket pipes it to the session host (santree.rs).
    /// The app's toggle; absent means off.
    #[serde(default, skip_serializing_if = "is_false")]
    pub santree: bool,
    /// Where the session host is and the key it proves: the controller's to
    /// fill, and only while `santree` is on (registry.rs `effective`).
    /// Strings, checked where they are used (`SessionHost::checked`), so a
    /// kept policy with a bad one still parses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_host: Option<SessionHost>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// The session host as a machine is told it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionHost {
    /// `host:port`.
    pub address: String,
    /// Its raw ed25519 key, 64 hex characters: what the agent pins.
    pub public_key: String,
}

impl SessionHost {
    /// The address and the key, checked: `host:port` of at most 255 bytes,
    /// and 32 bytes of hex.
    pub fn checked(&self) -> Result<(&str, [u8; 32]), String> {
        if self.address.len() > 255 || !crate::core::config::valid_host_port(&self.address) {
            return Err(format!(
                "the session host's address {:?} is not host:port",
                self.address
            ));
        }
        let key = crate::identity::parse_public_key(&self.public_key)
            .map_err(|e| format!("the session host's key: {e}"))?;
        Ok((&self.address, key))
    }
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
            santree: false,
            session_host: None,
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

/// `rotate`'s parameters: the controller's new key, and the key the node
/// trusts vouching for it (identity.rs `sign_rotation`), both hex. Exact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RotateParams {
    pub new_public_key: String,
    pub signature: String,
}

/// `command`'s answer: the machine took the instruction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Accepted {
    pub accepted: bool,
}

pub use crate::ipc::rpc::Incoming;

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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::claude::Roster;
    use crate::ipc::rpc::Response;
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
            capabilities: vec![
                crate::api::wire::Capability::ClaudeRemoteControl,
                crate::api::wire::Capability::TelemetryFull,
            ],
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
            Box::new(|h| h.capabilities = vec![crate::api::wire::Capability::Root; 33]),
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
                ..Default::default()
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
        let load = crate::node::providers::ProviderModelParams {
            kind: crate::node::providers::ProviderKind::Lemonade,
            action: crate::node::providers::ModelAction::Load,
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
                serde_json::from_value::<crate::node::providers::ProviderModelParams>(bad.clone())
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
            let p: crate::node::providers::ProviderModelParams =
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
    fn a_policy_request_on_the_wire_names_settings_and_never_grants_santree() {
        let off = PolicyRequest {
            awake_hold: Some(false),
            ..Default::default()
        };
        assert_eq!(
            request(3, name::POLICY_REQUEST, &off),
            r#"{"id":3,"m":"policy_request","p":{"awake_hold":false}}"#
        );
        let all = PolicyRequest {
            awake_hold: Some(true),
            claude_remote_control: Some(false),
            santree: Some(false),
        };
        assert_eq!(
            wire(&all),
            r#"{"awake_hold":true,"claude_remote_control":false,"santree":false}"#
        );
        assert!(off.check().is_ok() && all.check().is_ok());
        // Nothing asked, santree granted: refused.
        assert!(PolicyRequest::default().check().is_err());
        let grant = PolicyRequest {
            santree: Some(true),
            ..Default::default()
        };
        assert!(grant.check().unwrap_err().contains("from Daedalus"));
        // Exact: a key the machine may not ask for does not parse.
        for bad in [
            json!({"awake_hold": false, "providers": {}}),
            json!({"name": "evil"}),
            json!({"santree": "yes"}),
        ] {
            assert!(
                serde_json::from_value::<PolicyRequest>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_rotation_on_the_wire() {
        let p = RotateParams {
            new_public_key: "ab".repeat(32),
            signature: "cd".repeat(64),
        };
        assert_eq!(
            request(10, name::ROTATE, &p),
            format!(
                r#"{{"id":10,"m":"rotate","p":{{"new_public_key":"{}","signature":"{}"}}}}"#,
                "ab".repeat(32),
                "cd".repeat(64)
            )
        );
        // Exact: nothing else rides it.
        assert!(serde_json::from_value::<RotateParams>(
            json!({"new_public_key":"x","signature":"y","grace":1})
        )
        .is_err());
        assert!(serde_json::from_value::<RotateParams>(json!({"new_public_key":"x"})).is_err());
    }
    #[test]
    fn santree_rides_the_policy_and_either_side_may_be_older() {
        let host = SessionHost {
            address: "box.example.org:7789".into(),
            public_key: "ab".repeat(32),
        };
        let on = Policy {
            santree: true,
            session_host: Some(host.clone()),
            ..Policy::default()
        };
        assert_eq!(
            event(name::POLICY, &on),
            format!(
                r#"{{"e":"policy","p":{{"awake_hold":true,"claude_remote_control":true,"santree":true,"session_host":{{"address":"box.example.org:7789","public_key":"{}"}}}}}}"#,
                "ab".repeat(32)
            )
        );
        // Off is absent: what a 0.21 controller sent, and a 0.21 kept
        // policy.json, parse to santree off.
        assert_eq!(
            wire(&Policy::default()),
            r#"{"awake_hold":true,"claude_remote_control":true}"#
        );
        let old: Policy =
            serde_json::from_str(r#"{"awake_hold":false,"claude_remote_control":true}"#).unwrap();
        assert!(!old.santree && old.session_host.is_none());
        // A 0.21 agent reads a new controller's policy: its Policy had no
        // such fields, and the link ignores what it does not know.
        #[derive(Deserialize)]
        #[allow(dead_code)]
        struct Policy021 {
            awake_hold: bool,
            claude_remote_control: bool,
        }
        let read: Policy021 = serde_json::from_str(&wire(&on)).unwrap();
        assert!(read.awake_hold);
        // A newer controller's further fields are ignored here too.
        let mut v = serde_json::to_value(&on).unwrap();
        v["future"] = json!({"x": 1});
        v["session_host"]["future"] = json!(1);
        assert_eq!(serde_json::from_value::<Policy>(v).unwrap(), on);

        // Checked where it is used; a bad one still parses.
        assert_eq!(
            host.checked().unwrap(),
            ("box.example.org:7789", [0xab; 32])
        );
        for bad in [
            SessionHost {
                address: "box.example.org".into(),
                ..host.clone()
            },
            SessionHost {
                address: format!("{}:7789", "a".repeat(252)),
                ..host.clone()
            },
            SessionHost {
                public_key: "ab".into(),
                ..host.clone()
            },
        ] {
            assert!(bad.checked().is_err(), "{bad:?}");
            let kept = Policy {
                santree: true,
                session_host: Some(bad),
                ..Policy::default()
            };
            assert_eq!(serde_json::from_str::<Policy>(&wire(&kept)).unwrap(), kept);
        }
    }
}
