//! A client of the local socket: one request, its answer as the type
//! asked for — what the tray, the session and the verbs call.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;

use super::{LocalRequest, CLIENT_DEADLINE};
use crate::ipc::door::MAX_LINE;
use crate::ipc::jsonl::LineReader;
use crate::ipc::rpc::{line_of, ErrorCode, Incoming};

/// Why a call to the service failed: it could not be reached or read
/// (`Transport`), it answered an error (`Remote`, with its code), or its
/// answer is not the type asked for (`Decode`).
#[derive(Clone, Debug, PartialEq)]
pub enum CallError {
    Transport(String),
    Remote { code: ErrorCode, msg: String },
    Decode(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Transport(s) | CallError::Decode(s) => f.write_str(s),
            CallError::Remote { msg, .. } => f.write_str(msg),
        }
    }
}

impl std::error::Error for CallError {}

/// Ask the service: one method, its answer as `T` or why not.
pub fn call<T: DeserializeOwned>(req: &LocalRequest) -> Result<T, CallError> {
    call_at(&crate::core::paths::local_socket(), req)
}

/// `call` for a method that takes longer than `CLIENT_DEADLINE`, from a
/// thread that may wait.
pub fn call_within<T: DeserializeOwned>(
    req: &LocalRequest,
    deadline: Duration,
) -> Result<T, CallError> {
    call_at_within(&crate::core::paths::local_socket(), req, deadline)
}

/// The request line a client sends: one request, id 1.
pub(super) fn request_line(req: &LocalRequest) -> String {
    #[derive(Serialize)]
    struct Out<'a> {
        id: u64,
        #[serde(flatten)]
        req: &'a LocalRequest,
    }
    line_of(&Out { id: 1, req })
}

/// The same, at `path`.
pub fn call_at<T: DeserializeOwned>(path: &Path, req: &LocalRequest) -> Result<T, CallError> {
    call_at_within(path, req, CLIENT_DEADLINE)
}

fn call_at_within<T: DeserializeOwned>(
    path: &Path,
    req: &LocalRequest,
    deadline: Duration,
) -> Result<T, CallError> {
    let transport = CallError::Transport;
    let c = crate::os::connect_local(path, deadline).map_err(|e| {
        transport(format!(
            "the agent did not answer at {} ({e})",
            path.display()
        ))
    })?;
    let mut w = c.writer;
    // A refusal is written before the request is read: a failed write is
    // only an error when no answer came either.
    let sent = w
        .write_all(request_line(req).as_bytes())
        .and_then(|()| w.flush())
        .map_err(|e| transport(format!("sending to the agent: {e}")));
    let read = LineReader::new(c.reader, MAX_LINE).next_line();
    (c.close)();
    let line = match read {
        Ok(Some(line)) => line,
        Ok(None) => {
            sent?;
            return Err(transport("the agent closed without answering".into()));
        }
        Err(e) => {
            sent?;
            return Err(transport(format!("reading the agent's answer: {e}")));
        }
    };
    match Incoming::parse(&line) {
        Ok(Incoming::Answer { result: Ok(v), .. }) => serde_json::from_value(v)
            .map_err(|e| CallError::Decode(format!("the agent's answer: {e}"))),
        Ok(Incoming::Answer { result: Err(e), .. }) => Err(CallError::Remote {
            code: e.code,
            msg: e.msg,
        }),
        Ok(_) => Err(CallError::Decode(
            "the agent wrote something other than an answer".into(),
        )),
        Err(e) => Err(CallError::Decode(format!(
            "the agent's answer did not parse: {e}"
        ))),
    }
}
