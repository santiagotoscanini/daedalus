//! The one envelope every door of this agent speaks — the API socket
//! (api/), the link (link/) and the local socket (local.rs): one JSON
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
//! The payloads are each door's own (api/wire.rs, link/wire.rs).

use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

use crate::util::LockExt;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

/// Events queued for one subscriber before the rest are dropped.
pub const EVENT_QUEUE: usize = 256;

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
#[cfg_attr(test, derive(ts_rs::TS))]
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
    /// No machine by that id is known to the controller.
    pub const NOT_FOUND: &str = "not_found";
    /// The santree socket: this machine's policy keeps santree off.
    pub const SANTREE_OFF: &str = "santree_off";
    /// The santree socket: the session host proved another key than the
    /// one the box named for it.
    pub const HOST_KEY_CHANGED: &str = "host_key_changed";
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

/// An answer as a client reads it: the value, or the error's code and
/// message.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    Ok(Value),
    Err { code: String, msg: String },
}

impl Answer {
    /// One answer line; an error when it is neither `ok` nor `err`.
    pub fn parse(line: &[u8]) -> Result<Answer, String> {
        #[derive(Deserialize)]
        struct Failure {
            code: String,
            msg: String,
        }
        #[derive(Deserialize)]
        struct Line {
            #[serde(default)]
            ok: Option<Value>,
            #[serde(default)]
            err: Option<Failure>,
        }
        let l: Line = serde_json::from_slice(line).map_err(|e| e.to_string())?;
        match (l.ok, l.err) {
            (_, Some(f)) => Ok(Answer::Err {
                code: f.code,
                msg: f.msg,
            }),
            (Some(v), None) => Ok(Answer::Ok(v)),
            // `"ok":null` deserialises as None: a null answer.
            (None, None) if has_ok(line) => Ok(Answer::Ok(Value::Null)),
            (None, None) => Err("neither `ok` nor `err`".into()),
        }
    }
}

fn has_ok(line: &[u8]) -> bool {
    serde_json::from_slice::<Value>(line)
        .ok()
        .and_then(|v| v.as_object().map(|o| o.contains_key("ok")))
        .unwrap_or(false)
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
pub fn error_line(code: &'static str, msg: impl Into<String>) -> String {
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
        self.subscribers.lock_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::wire;

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
