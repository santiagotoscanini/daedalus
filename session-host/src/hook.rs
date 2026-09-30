//! `daedalus-session-host hook [--socket P] <args…>`: relay one agent hook to
//! the session host's queue, over the local hook socket.
//!
//! Agents run this synchronously on every hook, so it is built to cost the
//! agent nothing: a hard overall deadline, no output on stdout (Claude reads a
//! hook's stdout) or stderr, and exit 0 whatever happens. A failure leaves one
//! line in `$HOME/.local/state/daedalus-session-host/hook-errors.log` — a time
//! and a reason, never the payload or the environment.

use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime};

use santree_remote_proto::{
    decode_server_frame, encode_request, m, HookPushParams, Method, ServerFrame,
};

use crate::daemon::MAX_REQUEST_LINE;
use crate::status::rfc3339;

/// The hook socket the unit serves: in its RuntimeDirectory
/// (nix/stacks/daedalus/session-host.nix).
pub const DEFAULT_SOCKET: &str = "/run/daedalus-session-host/hook.sock";

/// `$HOME/.local/state/daedalus-session-host`, where failures are noted.
fn error_log_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join(".local/state/daedalus-session-host"))
}

/// Everything, stdin included, must be done by then.
const DEADLINE: Duration = Duration::from_millis(200);
/// How long stdin may take to close. The rest of [`DEADLINE`] is the push's.
const STDIN_BUDGET: Duration = Duration::from_millis(120);

/// Run the subcommand. Always 0.
pub fn run(args: &[String]) -> i32 {
    let started = Instant::now();
    // A panic must not print either.
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::panic::catch_unwind(|| relay(args, started + DEADLINE))
        .unwrap_or_else(|_| Err("internal error".into()));
    let note = match outcome {
        Ok(None) => return 0,
        Ok(Some(note)) => note,
        Err(reason) => reason,
    };
    log_failure(&note);
    0
}

/// `Ok(None)`: pushed. `Ok(Some(note))`: pushed, with something worth
/// recording. `Err`: not pushed.
fn relay(args: &[String], deadline: Instant) -> Result<Option<String>, String> {
    let (socket, event) = match args {
        [flag, path, rest @ ..] if flag == "--socket" => (PathBuf::from(path), rest),
        [flag, rest @ ..] if flag.starts_with("--socket=") => {
            (PathBuf::from(&flag["--socket=".len()..]), rest)
        }
        rest => (PathBuf::from(DEFAULT_SOCKET), rest),
    };
    let event = event.join(" ");
    if event.is_empty() {
        return Err("no hook event given".into());
    }

    let (stdin, open) = read_stdin(Instant::now() + STDIN_BUDGET);
    let note = open.then(|| {
        format!(
            "stdin still open after {}ms; pushed the {} byte(s) read by then",
            STDIN_BUDGET.as_millis(),
            stdin.len()
        )
    });
    let env: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .filter(|(k, _)| k.starts_with("SANTREE_") || k == "CLAUDE_PROJECT_DIR")
        .collect();

    let mut line = encode_request(1, m::HooksPush::NAME, &HookPushParams { event, env, stdin })
        .map_err(|e| format!("encoding the push: {e}"))?;
    if line.len() > MAX_REQUEST_LINE {
        return Err(format!(
            "payload over {MAX_REQUEST_LINE} bytes once encoded"
        ));
    }
    line.push('\n');
    push(&socket, line.as_bytes(), deadline)?;
    Ok(note)
}

/// Read stdin until EOF or `until`. A terminal is never read (nothing is
/// coming). Returns the bytes and whether stdin was still open at `until`.
fn read_stdin(until: Instant) -> (Vec<u8>, bool) {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return (Vec::new(), false);
    }
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    // Detached: if stdin never closes, the process exits around it.
    let spawned = std::thread::Builder::new()
        .name("hook-stdin".into())
        .spawn(move || {
            let mut stdin = stdin.lock();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
    if spawned.is_err() {
        return (Vec::new(), false);
    }
    let mut data = Vec::new();
    loop {
        let left = until.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(chunk) => data.extend_from_slice(&chunk),
            Err(mpsc::RecvTimeoutError::Disconnected) => return (data, false),
            Err(mpsc::RecvTimeoutError::Timeout) => return (data, true),
        }
    }
}

fn remaining(deadline: Instant) -> Result<Duration, String> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        Err(format!("gave up after {}ms", DEADLINE.as_millis()))
    } else {
        Ok(left)
    }
}

/// Send one request line and wait for its answer.
fn push(socket: &Path, line: &[u8], deadline: Instant) -> Result<(), String> {
    let stream =
        UnixStream::connect(socket).map_err(|e| format!("connect {}: {e}", socket.display()))?;
    stream
        .set_write_timeout(Some(remaining(deadline)?))
        .map_err(|e| format!("socket: {e}"))?;
    (&stream)
        .write_all(line)
        .map_err(|e| format!("sending the push: {e}"))?;
    let mut reader = BufReader::new(&stream);
    let mut answer = String::new();
    loop {
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|e| format!("socket: {e}"))?;
        answer.clear();
        match reader.read_line(&mut answer) {
            Ok(0) => return Err("the host closed the connection without answering".into()),
            Ok(_) => {}
            Err(e) => return Err(format!("waiting for the answer: {e}")),
        }
        match decode_server_frame(answer.trim_end()) {
            Ok(ServerFrame::Response { id: 1, result }) => {
                return result
                    .map(|_| ())
                    .map_err(|e| format!("the host refused: {e}"));
            }
            // A ping (or anything else) is not the answer; keep waiting.
            Ok(_) => {}
            Err(e) => return Err(format!("unreadable answer: {e}")),
        }
    }
}

/// Append one line to `hook-errors.log`, making the directory 0700 and the
/// file 0600 when this creates them. Failing to log is not reported.
fn log_failure(reason: &str) {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let Some(dir) = error_log_dir() else {
        return;
    };
    if std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .is_err()
    {
        return;
    }
    let line = format!("{} {reason}\n", rfc3339(SystemTime::now()));
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(dir.join("hook-errors.log"))
        .and_then(|mut f| f.write_all(line.as_bytes()));
}
