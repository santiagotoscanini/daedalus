//! The controller's side of the root helper: one connection per run, the
//! request written, the start and the progress handed to a callback as they
//! come, the result returned (root/mod.rs has the protocol). `api` calls it
//! for `root.run`; nothing else does.

use std::path::Path;
use std::time::Duration;

use super::{Outcome, Request, VerbState};

/// How the helper answered, when it did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub outcome: Outcome,
    pub detail: String,
    pub verbs: Option<Vec<VerbState>>,
}

/// What the helper says before its answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relayed<'a> {
    /// The unit's start was asked for.
    Started,
    /// One line the unit wrote.
    Progress(&'a str),
}

/// Why there is no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RelayError {
    /// Nothing to connect to, or the connection was refused.
    Unreachable(String),
    /// The helper answered with an error line (its code, its words).
    Refused { code: String, msg: String },
    /// The connection ended, or a line was not the protocol's, before a
    /// result.
    Broken(String),
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelayError::Unreachable(e) => write!(f, "the root helper is not reachable: {e}"),
            RelayError::Refused { code, msg } => {
                write!(f, "the root helper refused ({code}): {msg}")
            }
            RelayError::Broken(e) => write!(f, "the root helper's answer broke off: {e}"),
        }
    }
}

/// Run one request on the helper at `socket`. `silence` bounds the wait
/// for any one line — the helper's own deadline per verb is the real one.
#[cfg(unix)]
pub fn run(
    socket: &Path,
    request: &Request,
    silence: Duration,
    mut on: impl FnMut(Relayed<'_>),
) -> Result<Answer, RelayError> {
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    use super::Line;

    /// How long a write to the helper may block.
    const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

    let mut stream = UnixStream::connect(socket)
        .map_err(|e| RelayError::Unreachable(format!("{}: {e}", socket.display())))?;
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));

    let mut line = serde_json::to_string(request).map_err(|e| RelayError::Broken(e.to_string()))?;
    line.push('\n');
    stream
        .write_all(line.as_bytes())
        .map_err(|e| RelayError::Broken(format!("sending the request: {e}")))?;
    let mut reader = crate::jsonl::LineReader::new(stream, super::MAX_ANSWER);
    loop {
        // `silence` for each line, however it trickles in.
        let by = crate::deadline::Deadline::after(silence);
        // macOS refuses the timeout (EINVAL) once the helper has closed its
        // end; what it sent is still buffered and the read then ends at EOF
        // without blocking, so that refusal is not a broken relay.
        let set = |s: &UnixStream, d| match s.set_read_timeout(Some(d)) {
            Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => Ok(()),
            r => r,
        };
        let text = match super::read_line(&mut reader, by, set) {
            Ok(Some(t)) => t,
            Ok(None) => {
                return Err(RelayError::Broken(
                    "the connection closed without a result".into(),
                ))
            }
            Err(e) => return Err(RelayError::Broken(e.to_string())),
        };
        match serde_json::from_str::<Line>(&text) {
            Ok(Line::Started { .. }) => on(Relayed::Started),
            Ok(Line::Progress { line }) => on(Relayed::Progress(&line)),
            Ok(Line::Result {
                outcome,
                detail,
                verbs,
            }) => {
                return Ok(Answer {
                    outcome,
                    detail,
                    verbs,
                })
            }
            Ok(Line::Error { code, msg }) => return Err(RelayError::Refused { code, msg }),
            Err(e) => {
                return Err(RelayError::Broken(format!(
                    "a line that is not the protocol's: {e}"
                )))
            }
        }
    }
}

/// No root helper off unix: the controller is the box, and the box is
/// NixOS.
#[cfg(not(unix))]
pub fn run(
    socket: &Path,
    _request: &Request,
    _silence: Duration,
    _on: impl FnMut(Relayed<'_>),
) -> Result<Answer, RelayError> {
    Err(RelayError::Unreachable(format!(
        "{}: no root helper on this OS",
        socket.display()
    )))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;

    /// A helper that reads one request and writes `lines`, on a socket in
    /// a temp dir; the request it read comes back through the handle.
    fn fake_helper(
        name: &str,
        lines: &'static [&'static str],
    ) -> (std::path::PathBuf, std::thread::JoinHandle<String>) {
        let dir =
            std::env::temp_dir().join(format!("daedalus-relay-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("root.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let h = std::thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut req = String::new();
            r.read_line(&mut req).unwrap();
            let mut w = s;
            for l in lines {
                w.write_all(l.as_bytes()).unwrap();
                w.write_all(b"\n").unwrap();
            }
            req
        });
        (path, h)
    }

    fn request() -> Request {
        Request {
            verb: "reboot".into(),
            id: "abc".into(),
            selectors: Default::default(),
            payload: None,
        }
    }

    #[test]
    fn progress_is_relayed_and_the_result_returned() {
        let (path, h) = fake_helper(
            "ok",
            &[
                r#"{"t":"started","unit":"daedalus-power.service"}"#,
                r#"{"t":"progress","line":"checking"}"#,
                r#"{"t":"progress","line":"rebooting"}"#,
                r#"{"t":"result","outcome":"done","detail":"rebooting"}"#,
            ],
        );
        let mut seen = Vec::new();
        let a = run(&path, &request(), Duration::from_secs(5), |l| {
            seen.push(match l {
                Relayed::Started => "(started)".to_string(),
                Relayed::Progress(p) => p.to_string(),
            })
        })
        .unwrap();
        assert_eq!(seen, ["(started)", "checking", "rebooting"]);
        assert_eq!(a.outcome, Outcome::Done);
        assert_eq!(a.detail, "rebooting");
        assert_eq!(
            h.join().unwrap(),
            "{\"verb\":\"reboot\",\"id\":\"abc\",\"selectors\":{}}\n"
        );
    }

    #[test]
    fn an_error_line_a_broken_answer_and_no_helper() {
        let (path, _h) = fake_helper(
            "err",
            &[r#"{"t":"error","code":"unknown_verb","msg":"no verb"}"#],
        );
        assert_eq!(
            run(&path, &request(), Duration::from_secs(5), |_| {}).unwrap_err(),
            RelayError::Refused {
                code: "unknown_verb".into(),
                msg: "no verb".into()
            }
        );
        let (path, _h) = fake_helper("cut", &[r#"{"t":"progress","line":"half"}"#]);
        assert!(matches!(
            run(&path, &request(), Duration::from_secs(5), |_| {}),
            Err(RelayError::Broken(_))
        ));
        let (path, _h) = fake_helper("junk", &["{\"t\":\"shell\",\"cmd\":\"rm\"}"]);
        assert!(matches!(
            run(&path, &request(), Duration::from_secs(5), |_| {}),
            Err(RelayError::Broken(_))
        ));
        assert!(matches!(
            run(
                Path::new("/nonexistent/root.sock"),
                &request(),
                Duration::from_secs(1),
                |_| {}
            ),
            Err(RelayError::Unreachable(_))
        ));
    }
}
