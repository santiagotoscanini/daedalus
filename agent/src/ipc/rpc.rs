//! The one envelope every door of this agent speaks — the API socket
//! (controller/api/), the link (link/) and the local socket (ipc/local/): one JSON
//! object per line.
//!
//! ```text
//! → {"id":1,"m":"<method>","p":{…}}
//! ← {"id":1,"ok":…}
//! ← {"id":1,"err":{"code":"…","msg":"…"}}
//! ← {"e":"<event>","p":{…}}
//! ```
//!
//! `id` is null in an error only when the line was not a request at all.
//! `Incoming::parse` reads any line of it; a door with typed methods reads a
//! request's `m` and `p` as its own enum (`Request::typed`, the `methods!`
//! macro). The payloads are each door's own (api/wire.rs, link/wire.rs).

use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

use crate::util::LockExt;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

/// Events queued for one subscriber before the rest are dropped.
pub const EVENT_QUEUE: usize = 256;

/// One request. `p` is null for a method that takes nothing; fields beyond
/// these three are ignored (module doc).
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: u64,
    pub m: String,
    pub p: Value,
}

/// A door's methods: an enum read from `{"m","p"}`, whose wire names are
/// `NAMES` — what the `methods!` macro writes from one list.
pub trait Methods: serde::de::DeserializeOwned {
    const NAMES: &'static [&'static str];
}

/// A door's methods as one enum, `#[serde(tag = "m", content = "p")]`: a
/// unit variant takes no parameters, a tuple variant takes its type, exactly.
/// The caller states the derives (Deserialize at least).
///
/// ```ignore
/// methods! {
///     #[derive(Clone, Debug, Deserialize)]
///     pub enum Door {
///         "status" => Status,
///         "settings.set" => SettingsSet(SetParams),
///     }
/// }
/// ```
macro_rules! methods {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $( $(#[$vmeta:meta])* $wire:literal => $variant:ident $(($params:ty))? ),* $(,)?
        }
    ) => {
        $(#[$meta])*
        #[serde(tag = "m", content = "p")]
        $vis enum $name {
            $( $(#[$vmeta])* #[serde(rename = $wire)] $variant $(($params))?, )*
        }

        impl $crate::ipc::rpc::Methods for $name {
            const NAMES: &'static [&'static str] = &[$($wire),*];
        }
    };
}
pub(crate) use methods;

impl Request {
    /// The request as the door's own method enum: `unknown_method` for a name
    /// it does not have, `bad_request` for parameters its variant refuses.
    pub fn typed<M: Methods>(&self) -> Result<M, ApiError> {
        if !M::NAMES.contains(&self.m.as_str()) {
            return Err(ApiError::new(
                ErrorCode::UnknownMethod,
                format!("no method `{}`", self.m),
            ));
        }
        let mut o = serde_json::Map::new();
        o.insert("m".into(), Value::String(self.m.clone()));
        if !self.p.is_null() {
            o.insert("p".into(), self.p.clone());
        }
        serde_json::from_value(Value::Object(o))
            .map_err(|e| ApiError::new(ErrorCode::BadRequest, format!("`{}`: {e}", self.m)))
    }
}

/// Any line, told apart by its fields: a request carries `m`, an event `e`,
/// an answer `ok` or `err`. The one parser of the envelope, for every door.
#[derive(Clone, Debug, PartialEq)]
pub enum Incoming {
    Request(Request),
    Event {
        e: String,
        p: Value,
    },
    Answer {
        id: Option<u64>,
        result: Result<Value, ApiError>,
    },
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
            return Ok(Incoming::Request(Request {
                id,
                m,
                p: o.remove("p").unwrap_or(Value::Null),
            }));
        }
        if let Some(e) = o.get("e").and_then(Value::as_str).map(str::to_string) {
            return Ok(Incoming::Event {
                e,
                p: o.remove("p").unwrap_or(Value::Null),
            });
        }
        let id = o.get("id").and_then(Value::as_u64);
        if let Some(err) = o.remove("err") {
            let err: ApiError = serde_json::from_value(err).map_err(|e| e.to_string())?;
            return Ok(Incoming::Answer {
                id,
                result: Err(err),
            });
        }
        if let Some(ok) = o.remove("ok") {
            return Ok(Incoming::Answer { id, result: Ok(ok) });
        }
        Err("neither a request, an event nor an answer".into())
    }

    /// The line as a request, or why it is not one (a door that serves).
    pub fn request(line: &[u8]) -> Result<Request, String> {
        match Incoming::parse(line)? {
            Incoming::Request(r) => Ok(r),
            _ => Err("a request carries a method, `m`".into()),
        }
    }
}

/// One answer: `{"id":…,"ok":…}` or `{"id":…,"err":{…}}`. `id` is null
/// only when the line was not a request at all (not JSON, no id, too long).
/// The `ok` payload is kept as the JSON its type wrote, so the bytes on
/// the socket are the ones the golden tests pin, field order and all.
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

/// Why a request failed: `code` for a program, `msg` for a person.
/// `supported` rides only a `version` error: the API version this agent
/// speaks.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApiError {
    pub code: ErrorCode,
    #[serde(default)]
    pub msg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub supported: Option<u32>,
}

/// The error codes, all of them.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Not a request, a malformed one, bad parameters, or anything before
    /// `hello`.
    BadRequest,
    /// `hello` asked for an API version this agent does not speak.
    Version,
    /// No such method.
    UnknownMethod,
    /// The method exists, but this agent's role or config does not offer it
    /// (its capability is absent).
    Unsupported,
    /// Offered, but not possible right now (Claude remote control is off).
    Unavailable,
    /// Too many requests in flight on this connection.
    Busy,
    /// A line longer than the door's `MAX_LINE`; the connection is closed
    /// after it.
    TooLarge,
    /// The peer may not use this door; the connection is closed after it.
    Forbidden,
    /// The link: the box revoked this machine's key.
    Revoked,
    /// The agent could not write its own answer.
    Internal,
    /// No machine (or run) by that id is known to the controller.
    NotFound,
    /// The santree socket: this machine's policy keeps santree off.
    SantreeOff,
    /// The santree socket: the session host proved another key than the
    /// one the box named for it.
    HostKeyChanged,
    /// A code this agent does not know — a newer peer's, read on the link,
    /// whose two ends are released apart.
    #[serde(other)]
    Unknown,
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        crate::util::wire_name(self, f)
    }
}

impl ApiError {
    pub fn new(code: ErrorCode, msg: impl Into<String>) -> Self {
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
            Err(e) => Self::err(Some(id), ApiError::new(ErrorCode::Internal, e.to_string())),
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

/// The `id` of something that is not a valid request, when it has one, so
/// the error can still be matched to it.
pub fn salvage_id(text: &[u8]) -> Option<u64> {
    serde_json::from_slice::<Value>(text)
        .ok()?
        .get("id")?
        .as_u64()
}

/// A value as one line, newline included.
pub fn line_of<T: Serialize>(v: &T) -> String {
    let mut line = serde_json::to_string(v).unwrap_or_default();
    line.push('\n');
    line
}

/// An error that is not an answer to any request, as one line: what a
/// connection gets before it is closed.
pub fn error_line(code: ErrorCode, msg: impl Into<String>) -> String {
    line_of(&Response::err(None, ApiError::new(code, msg)))
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
    /// one whose queue is full misses this event. Answers how many queues
    /// took it — subscribers with room, which is not the same as one that
    /// will act on it: a caller that needs the app to have heard still
    /// waits for the effect. The event is its own `{"e","p"}` (api/wire.rs
    /// `Event`).
    pub fn publish<E: Serialize>(&self, event: &E) -> usize {
        let mut subs = self.lock();
        if subs.is_empty() {
            return 0;
        }
        let Ok(line) = serde_json::to_string(event) else {
            return 0;
        };
        let line: Arc<str> = line.into();
        let mut queued = 0;
        subs.retain(|tx| match tx.try_send(Arc::clone(&line)) {
            Ok(()) => {
                queued += 1;
                true
            }
            Err(TrySendError::Full(_)) => true,
            Err(TrySendError::Disconnected(_)) => false,
        });
        queued
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<SyncSender<Arc<str>>>> {
        self.subscribers.lock_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::wire::{ApiEvent, NodeLeft};
    use serde_json::json;

    #[test]
    fn events_reach_live_subscribers_and_forget_gone_ones() {
        let events = Events::default();
        let rx = events.subscribe();
        let gone = events.subscribe();
        drop(gone);
        let left = |id: &str| ApiEvent::NodesLeft(NodeLeft { id: id.into() });
        let told = events.publish(&left("0123456789abcdef"));
        // The live one took it; the gone one is not counted.
        assert_eq!(told, 1);
        assert_eq!(
            &*rx.try_recv().unwrap(),
            r#"{"e":"nodes.left","p":{"id":"0123456789abcdef"}}"#
        );
        assert_eq!(events.lock().len(), 1);
        // A subscriber that does not read loses events, not its place.
        let mut took = 0;
        for _ in 0..EVENT_QUEUE + 5 {
            took += events.publish(&left("0123456789abcdef"));
        }
        assert_eq!(rx.try_iter().count(), EVENT_QUEUE);
        assert_eq!(events.lock().len(), 1);
        // A full queue is not counted as told.
        assert_eq!(took, EVENT_QUEUE);
        assert_eq!(Events::default().publish(&left("x")), 0);
    }

    methods! {
        #[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
        enum Door {
            "status" => Status,
            "set" => Set(Params),
        }
    }

    #[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Params {
        key: String,
    }

    #[test]
    fn a_request_is_read_as_its_door_s_method() {
        let req = |line: &str| Incoming::request(line.as_bytes()).unwrap();
        assert_eq!(
            req(r#"{"id":1,"m":"status"}"#).typed::<Door>(),
            Ok(Door::Status)
        );
        assert_eq!(
            req(r#"{"id":1,"m":"status","p":null}"#).typed::<Door>(),
            Ok(Door::Status)
        );
        assert_eq!(
            req(r#"{"id":2,"m":"set","p":{"key":"k"}}"#).typed::<Door>(),
            Ok(Door::Set(Params { key: "k".into() }))
        );
        // No such method, whatever its parameters.
        for line in [
            r#"{"id":3,"m":"nope"}"#,
            r#"{"id":3,"m":"pair","p":{"pin":"x"}}"#,
        ] {
            assert_eq!(
                req(line).typed::<Door>().unwrap_err().code,
                ErrorCode::UnknownMethod,
                "{line}"
            );
        }
        // A method's parameters are exact: none where it takes none, its own
        // where it takes some.
        for line in [
            r#"{"id":4,"m":"status","p":{"x":1}}"#,
            r#"{"id":4,"m":"set"}"#,
            r#"{"id":4,"m":"set","p":{"key":"k","x":1}}"#,
        ] {
            assert_eq!(
                req(line).typed::<Door>().unwrap_err().code,
                ErrorCode::BadRequest,
                "{line}"
            );
        }
        // A client writes the same envelope: a unit variant carries no `p`.
        assert_eq!(
            serde_json::to_value(Door::Status).unwrap(),
            json!({"m":"status"})
        );
    }

    #[test]
    fn any_line_is_told_apart() {
        assert_eq!(
            Incoming::parse(br#"{"id":3,"m":"command","p":{"command":"check_update"}}"#).unwrap(),
            Incoming::Request(Request {
                id: 3,
                m: "command".into(),
                p: json!({"command":"check_update"})
            })
        );
        assert_eq!(
            Incoming::parse(br#"{"e":"hb"}"#).unwrap(),
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
        assert_eq!(
            Incoming::parse(br#"{"id":1,"ok":null}"#).unwrap(),
            Incoming::Answer {
                id: Some(1),
                result: Ok(Value::Null)
            }
        );
        let v = ApiError {
            supported: Some(1),
            ..ApiError::new(ErrorCode::Version, "speaks 1")
        };
        let line = serde_json::to_string(&Response::err(Some(1), v.clone())).unwrap();
        assert_eq!(
            Incoming::parse(line.as_bytes()).unwrap(),
            Incoming::Answer {
                id: Some(1),
                result: Err(v)
            }
        );
        // A code from a newer peer is read, as one this agent does not know.
        assert_eq!(
            Incoming::parse(br#"{"id":1,"err":{"code":"later","msg":"m"}}"#).unwrap(),
            Incoming::Answer {
                id: Some(1),
                result: Err(ApiError::new(ErrorCode::Unknown, "m"))
            }
        );
        for bad in [
            &b"[1]"[..],
            b"{}",
            br#"{"m":"x"}"#,
            br#"{"id":-1,"m":"x"}"#,
            br#"{"id":1}"#,
            b"nope",
        ] {
            assert!(
                Incoming::parse(bad).is_err(),
                "{:?}",
                std::str::from_utf8(bad)
            );
        }
        assert!(Incoming::request(br#"{"id":1,"ok":1}"#).is_err());
    }
}
