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
use serde_json::value::RawValue;
use serde_json::Value;

use crate::claude::Report;
use crate::config::{Mode, TelemetryLevel};
use crate::role::Role;
use crate::telemetry::Telemetry;

/// One request. `p` may be absent for a method that takes nothing; fields
/// beyond these three are ignored (module doc).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Request {
    pub id: u64,
    pub m: String,
    #[serde(default)]
    pub p: Value,
}

impl Request {
    /// One line as a request: a JSON object carrying the fields above
    /// (serde would take a struct from an array too; the wire does not).
    pub fn parse(line: &[u8]) -> Result<Request, String> {
        match serde_json::from_slice::<Value>(line).map_err(|e| e.to_string())? {
            v @ Value::Object(_) => serde_json::from_value(v).map_err(|e| e.to_string()),
            _ => Err("a request is a JSON object".into()),
        }
    }
}

/// One answer: `{"id":…,"ok":…}` or `{"id":…,"err":{…}}`. `id` is null
/// only when the line was not a request at all (not JSON, no id, too long).
/// The `ok` payload is kept as the JSON its type wrote, so the bytes on
/// the socket are the ones the golden tests below pin, field order and all.
#[derive(Clone, Debug)]
pub struct Response {
    pub id: Option<u64>,
    pub body: Body,
}

#[derive(Clone, Debug)]
pub enum Body {
    Ok(Box<RawValue>),
    Err(ApiError),
}

impl Serialize for Response {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(2))?;
        m.serialize_entry("id", &self.id)?;
        match &self.body {
            Body::Ok(v) => m.serialize_entry("ok", v)?,
            Body::Err(e) => m.serialize_entry("err", e)?,
        }
        m.end()
    }
}

/// Why a request failed. `code` is one of the `code::` constants; `msg` is
/// for a person. `supported` rides only a `version` error: the API version
/// this agent speaks.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<u32>,
}

/// The error codes, all of them.
pub mod code {
    /// Not a request, a malformed one, bad parameters, or anything before
    /// `hello`.
    pub const BAD_REQUEST: &str = "bad_request";
    /// `hello` asked for an API version this agent does not speak.
    pub const VERSION: &str = "version";
    /// No such method.
    pub const UNKNOWN_METHOD: &str = "unknown_method";
    /// The method exists, but this agent's role or config does not offer it
    /// (its capability is absent).
    pub const UNSUPPORTED: &str = "unsupported";
    /// Offered, but not possible right now (Claude remote control is off).
    pub const UNAVAILABLE: &str = "unavailable";
    /// Too many requests in flight on this connection.
    pub const BUSY: &str = "busy";
    /// A line longer than `MAX_LINE`; the connection is closed after it.
    pub const TOO_LARGE: &str = "too_large";
    /// The peer is not this agent's user; the connection is closed after it.
    pub const FORBIDDEN: &str = "forbidden";
    /// The agent could not write its own answer.
    pub const INTERNAL: &str = "internal";
}

impl ApiError {
    pub fn new(code: &'static str, msg: impl Into<String>) -> Self {
        Self {
            code,
            msg: msg.into(),
            supported: None,
        }
    }
}

impl Response {
    /// `v` as the answer to `id`; an answer that does not serialise is
    /// an `internal` error instead.
    pub fn ok<T: Serialize>(id: u64, v: &T) -> Self {
        match serde_json::value::to_raw_value(v) {
            Ok(raw) => Self::raw(id, raw),
            Err(e) => Self::err(Some(id), ApiError::new(code::INTERNAL, e.to_string())),
        }
    }

    /// An answer already written as JSON.
    pub fn raw(id: u64, raw: Box<RawValue>) -> Self {
        Self {
            id: Some(id),
            body: Body::Ok(raw),
        }
    }

    pub fn err(id: Option<u64>, e: ApiError) -> Self {
        Self {
            id,
            body: Body::Err(e),
        }
    }
}

/// An event, pushed to a connection that asked for them
/// (`events.subscribe`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Event<P: Serialize> {
    pub e: &'static str,
    pub p: P,
}

/// The event names, all of them.
pub mod event {
    /// Claude remote control's state or pid moved (`ClaudeChanged`).
    pub const CLAUDE_CHANGED: &str = "claude.changed";
    /// A new telemetry sample is in (`TelemetryUpdated`).
    pub const TELEMETRY_UPDATED: &str = "telemetry.updated";
}

// ── the methods ───────────────────────────────────────────────────────────

/// `hello`'s parameters: the version the client speaks, and who it is (for
/// the log). Other fields are ignored, and the version is read before
/// anything else (`hello_api`), so a newer client is always told which
/// version this agent speaks.
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
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HelloOk {
    pub api: u32,
    pub version: String,
    pub mode: Mode,
    pub hostname: String,
    pub capabilities: Vec<&'static str>,
}

/// The operating system and the machine, as `system.info` states them.
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
}

/// `claude.status`'s answer. `reporting` false means no session has
/// reported within the freshness window (the session thread is gone, or
/// has not reported yet), and `report` is null.
#[derive(Clone, Debug, Serialize)]
pub struct ClaudeStatus {
    pub reporting: bool,
    /// Whether this machine's policy wants the server running.
    pub wanted: bool,
    pub report: Option<Report>,
}

/// `claude.restart`'s and `claude.update`'s answer: the instruction is
/// queued for the session, which takes it with its next report.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Queued {
    pub queued: bool,
}

/// `telemetry.get`'s answer: the level config.toml sets, and the latest
/// document at that level — null when the level is `off`, or before the
/// first sample.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TelemetryGet {
    pub level: TelemetryLevel,
    pub telemetry: Option<Telemetry>,
}

/// `events.subscribe`'s answer; the events follow on the same connection.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Subscribed {}

/// `claude.changed`'s payload. Sent when a session starts reporting, when
/// its report's state or pid moves, and when it stops reporting (nothing
/// within the freshness window) — then `reporting` is false and the state
/// and pid are null.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ClaudeChanged {
    pub reporting: bool,
    pub state: Option<String>,
    pub pid: Option<u32>,
}

/// `telemetry.updated`'s payload: when the new sample was taken; read it
/// with `telemetry.get`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TelemetryUpdated {
    pub sampled_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
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
            capabilities: vec!["claude.remote_control", "telemetry.minimal"],
        };
        assert_eq!(
            wire(&info),
            concat!(
                r#"{"api":1,"version":"0.13.0","mode":"controller","hostname":"box","#,
                r#""os":{"os":"linux","name":"NixOS","version":"25.11","arch":"x86_64","cpu":"AMD Ryzen 7","memory_bytes":64},"#,
                r#""uptime_secs":5,"os_uptime_secs":100,"booted_at":"2026-09-27T10:00:00Z","#,
                r#""role":{"mode":"controller","hello":false,"self_update":false,"keep_awake":false,"#,
                r#""installer":false,"session":true,"session_in_service":true,"claude_update":false,"#,
                r#""tray":false,"status_on_lan":false,"api_socket":true},"#,
                r#""telemetry":"minimal","capabilities":["claude.remote_control","telemetry.minimal"]}"#
            )
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
                r#""sessions":[],"#,
                r#""credentials":{"present":false,"store":null,"subscription_type":null,"#,
                r#""rate_limit_tier":null,"expires_at":null,"refresh_expires_at":null},"#,
                r#""settings":{"model":null,"effort_level":null},"#,
                r#""user":null,"home":null,"workdir":null,"workdir_via":null,"log":null,"#,
                r#""reported_at":"2026-09-27T10:00:00Z"}}"#
            )
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
                r#""browsers":[],"apps":[],"app_count":null,"updates":null,"providers":[],"errors":[]}}"#
            )
        );
    }
}
