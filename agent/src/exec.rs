//! Running a command with a deadline and capturing its output: the shared
//! bounded shell-out of the telemetry tiers (PowerShell on Windows, Apple's
//! tools on macOS, systemctl, smartctl and the package managers on Linux)
//! and of Claude Code's version probe and `claude update`.
//! One deadline command stays outside it: launchd.rs's `launchctl_timeout`,
//! which polls the child and reads its output only once it has exited.
//!
//! Every command starts with a closed stdin, no console window on Windows
//! (`os::hide_console`), and its output pipes drained on threads of their
//! own — a child that fills one pipe while nobody reads the other blocks
//! forever. At the deadline it is killed and reaped. Four shapes over that
//! one core, each what its caller has always had:
//!
//! - `stdout_or`: the whole stdout, or why not (`Failed`: not started, no
//!   answer in time, or a non-zero exit with the first line of stderr).
//!   Bytes become text strictly (invalid UTF-8 reads as empty, as
//!   `read_to_string` leaves it) or lossily (a stray code-page character
//!   cannot throw a whole PowerShell document away) — `Text` says which.
//! - `both`: stdout and stderr joined in the order each finished, and
//!   whether it exited 0; `claude update` answers on either stream.
//! - `first_line`: the first line of stdout, stderr discarded; a version
//!   probe.
//! - `stdout_any`: the whole stdout and the exit code, whatever the code —
//!   for the tools that answer with it (`dnf check-update`, `pacman -Qu`).
//!
//! `locate` finds a program on PATH or in the usual unix directories, so a
//! reader tells "not installed" from "failed".

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

/// How a stream's bytes become text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Text {
    /// `read_to_string`: output that is not UTF-8 reads as empty.
    Strict,
    /// Every byte kept, invalid sequences replaced.
    Lossy,
}

/// Why a command gave nothing, for the error line.
#[derive(Debug, PartialEq)]
pub enum Failed {
    /// It could not be started at all.
    Spawn(String),
    /// It did not finish within the deadline and was killed.
    Timeout,
    /// It finished with a non-zero status; the first line of stderr, if any.
    Exit(i32, String),
}

impl std::fmt::Display for Failed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failed::Spawn(e) => write!(f, "not started: {e}"),
            Failed::Timeout => write!(f, "no answer in time"),
            Failed::Exit(code, line) if line.is_empty() => write!(f, "exit {code}"),
            Failed::Exit(code, line) => write!(f, "exit {code}: {line}"),
        }
    }
}

/// What a command did: its status and everything it printed. A refusal
/// ("Updates are disabled by your administrator") arrives on one stream or
/// the other depending on the version, so both are captured and joined.
pub struct Ran {
    pub ok: bool,
    /// stdout and stderr, in the order each thread finished reading them.
    pub output: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stream {
    Out,
    Err,
}

/// A started command whose pipes are being drained: each reader thread
/// sends its whole stream, once, when the stream closes.
struct Running {
    child: Child,
    rx: Receiver<(Stream, String)>,
}

fn drain(
    mut pipe: impl Read + Send + 'static,
    which: Stream,
    text: Text,
    tx: Sender<(Stream, String)>,
) {
    std::thread::spawn(move || {
        let s = match text {
            Text::Strict => {
                let mut s = String::new();
                let _ = pipe.read_to_string(&mut s);
                s
            }
            Text::Lossy => {
                let mut b = Vec::new();
                let _ = pipe.read_to_end(&mut b);
                String::from_utf8_lossy(&b).into_owned()
            }
        };
        let _ = tx.send((which, s));
    });
}

impl Running {
    /// Start hidden, stdin closed, stdout piped, stderr piped or discarded.
    fn start(cmd: &mut Command, stderr: bool, text: Text) -> std::io::Result<Self> {
        let mut child = crate::os::hide_console(cmd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(if stderr {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .spawn()?;
        let (tx, rx) = mpsc::channel();
        if let Some(out) = child.stdout.take() {
            drain(out, Stream::Out, text, tx.clone());
        }
        if let Some(err) = child.stderr.take() {
            drain(err, Stream::Err, text, tx);
        }
        Ok(Self { child, rx })
    }

    /// The next stream to close, or None when `until` passes first.
    fn recv(&self, until: Instant) -> Option<(Stream, String)> {
        self.rx
            .recv_timeout(until.saturating_duration_since(Instant::now()))
            .ok()
    }

    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A command's whole stdout, or why not; killed at the deadline.
pub fn stdout_or(cmd: Command, deadline: Duration, text: Text) -> Result<String, Failed> {
    match stdout_with_status(cmd, deadline, text)? {
        (0, stdout, _) => Ok(stdout),
        (code, _, first) => Err(Failed::Exit(code, first)),
    }
}

/// A command's whole stdout and its exit code, whatever the code — for the
/// tools that answer with it (`dnf check-update` exits 100 when there are
/// updates, `pacman -Qu` 1 when there are none, `rpm -qf` 1 for a file no
/// package owns). Err only when it did not start or did not finish.
pub fn stdout_any(cmd: Command, deadline: Duration, text: Text) -> Result<(i32, String), Failed> {
    stdout_with_status(cmd, deadline, text).map(|(code, out, _)| (code, out))
}

/// The one core of `stdout_or` and `stdout_any`: the exit code (-1 for a
/// signal), stdout, and — on a non-zero exit — the first line of stderr.
fn stdout_with_status(
    mut cmd: Command,
    deadline: Duration,
    text: Text,
) -> Result<(i32, String, String), Failed> {
    let started = Instant::now();
    let mut r = Running::start(&mut cmd, true, text).map_err(|e| Failed::Spawn(e.to_string()))?;
    let until = Instant::now() + deadline;
    let mut stderr: Option<String> = None;
    let stdout = loop {
        match r.recv(until) {
            Some((Stream::Out, s)) => break s,
            Some((Stream::Err, s)) => stderr = Some(s),
            None => {
                r.kill();
                return Err(Failed::Timeout);
            }
        }
    };
    // stdout is closed; the process is exiting. Give it the rest of the
    // deadline rather than a blocking wait.
    loop {
        match r.child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok((0, stdout, String::new()));
                }
                let stderr = stderr
                    .or_else(|| {
                        r.recv(Instant::now() + Duration::from_millis(200))
                            .map(|(_, s)| s)
                    })
                    .unwrap_or_default();
                let first = stderr
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("")
                    .trim();
                return Ok((status.code().unwrap_or(-1), stdout, first.to_string()));
            }
            Ok(None) if started.elapsed() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                r.kill();
                return Err(Failed::Timeout);
            }
        }
    }
}

/// Run to completion, or kill it and give up after `timeout`: both streams,
/// trimmed and joined, and whether it exited 0. None when it could not be
/// started or did not finish.
pub fn both(mut cmd: Command, timeout: Duration) -> Option<Ran> {
    let mut r = Running::start(&mut cmd, true, Text::Strict).ok()?;
    let until = Instant::now() + timeout;
    let mut text = String::new();
    for _ in 0..2 {
        match r.recv(until) {
            Some((_, s)) => {
                if !s.trim().is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(s.trim());
                }
            }
            None => {
                r.kill();
                return None;
            }
        }
    }
    let status = r.child.wait().ok()?;
    Some(Ran {
        ok: status.success(),
        output: text,
    })
}

/// Run to completion, or give up after `timeout`; the first line of its
/// stdout, trimmed. stderr is discarded and the exit code ignored.
pub fn first_line(mut cmd: Command, timeout: Duration) -> Option<String> {
    let mut r = Running::start(&mut cmd, false, Text::Strict).ok()?;
    let text = match r.recv(Instant::now() + timeout) {
        Some((_, t)) => t,
        None => {
            r.kill();
            return None;
        }
    };
    let _ = r.child.wait();
    text.lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// Where the unix tools live besides PATH: a service's PATH is systemd's
/// or launchd's default, and on NixOS the tools are under the profile, not
/// /usr.
const UNIX_TOOL_DIRS: &[&str] = &[
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
    "/run/wrappers/bin",
    "/run/current-system/sw/bin",
];

/// A program by name: the first match on PATH, then in the usual unix
/// directories. None when it is not on this machine — which is how a
/// reader tells "not installed" from "failed".
pub fn locate(name: &str) -> Option<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(UNIX_TOOL_DIRS.iter().map(std::path::PathBuf::from));
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

// The shapes are exercised through `sh`, which the Windows runner lacks.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut c = Command::new("sh");
        c.args(["-c", script]);
        c
    }

    const LONG: Duration = Duration::from_secs(10);

    #[test]
    fn stdout_or_returns_stdout_and_explains_a_failure() {
        assert_eq!(
            stdout_or(sh("echo out; echo err >&2"), LONG, Text::Strict).as_deref(),
            Ok("out\n")
        );
        assert_eq!(
            stdout_or(
                sh("echo half; echo '' >&2; echo why >&2; exit 3"),
                LONG,
                Text::Strict
            ),
            Err(Failed::Exit(3, "why".into()))
        );
        assert_eq!(
            stdout_or(sh("exit 4"), LONG, Text::Lossy),
            Err(Failed::Exit(4, String::new()))
        );
        assert!(matches!(
            stdout_or(
                Command::new("/nonexistent/daedalus-exec-test"),
                LONG,
                Text::Strict
            ),
            Err(Failed::Spawn(_))
        ));
        assert_eq!(Failed::Timeout.to_string(), "no answer in time");
        assert_eq!(Failed::Exit(1, String::new()).to_string(), "exit 1");
        assert_eq!(Failed::Exit(1, "x".into()).to_string(), "exit 1: x");
    }

    #[test]
    fn stdout_or_kills_at_the_deadline() {
        let t = Instant::now();
        assert_eq!(
            stdout_or(sh("sleep 5"), Duration::from_millis(300), Text::Strict),
            Err(Failed::Timeout)
        );
        assert!(t.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn stdout_any_keeps_the_output_of_a_non_zero_exit() {
        assert_eq!(
            stdout_any(
                sh("echo pkg.x86_64 1.2 updates; exit 100"),
                LONG,
                Text::Strict
            ),
            Ok((100, "pkg.x86_64 1.2 updates\n".to_string()))
        );
        assert_eq!(
            stdout_any(sh("echo ok"), LONG, Text::Strict),
            Ok((0, "ok\n".to_string()))
        );
        assert_eq!(
            stdout_any(sh("sleep 5"), Duration::from_millis(300), Text::Strict),
            Err(Failed::Timeout)
        );
        assert!(locate("sh").is_some());
        assert!(locate("daedalus-no-such-tool").is_none());
    }

    #[test]
    fn strict_and_lossy_text() {
        let bad = r"printf 'a\377b'";
        assert_eq!(stdout_or(sh(bad), LONG, Text::Strict).as_deref(), Ok(""));
        assert_eq!(
            stdout_or(sh(bad), LONG, Text::Lossy).as_deref(),
            Ok("a\u{fffd}b")
        );
    }

    #[test]
    fn both_joins_the_streams_and_first_line_reads_one() {
        let r = both(sh("echo one; echo two >&2; exit 1"), LONG).expect("ran");
        assert!(!r.ok);
        let mut lines: Vec<&str> = r.output.lines().collect();
        lines.sort_unstable();
        assert_eq!(lines, ["one", "two"]);
        assert!(both(sh("sleep 5"), Duration::from_millis(300)).is_none());
        assert_eq!(
            first_line(sh("echo '  2.1.0 (x)  '; echo more; echo e >&2"), LONG).as_deref(),
            Some("2.1.0 (x)")
        );
        assert_eq!(first_line(sh("true"), LONG), None);
        assert_eq!(first_line(sh("sleep 5"), Duration::from_millis(300)), None);
    }
}

// The same cases through `cmd /c`, for the Windows CI leg. The script goes
// in as one raw argument so cmd, not Rust's quoting, parses it.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::os::windows::process::CommandExt;

    fn cmd(script: &str) -> Command {
        let mut c = Command::new("cmd");
        c.raw_arg(format!("/c {script}"));
        c
    }

    const LONG: Duration = Duration::from_secs(10);

    #[test]
    fn stdout_or_returns_stdout_and_explains_a_failure() {
        assert_eq!(
            stdout_or(cmd("echo out"), LONG, Text::Lossy)
                .map(|s| s.trim().to_string())
                .as_deref(),
            Ok("out")
        );
        assert_eq!(
            stdout_or(
                cmd("echo half & echo why 1>&2 & exit /b 3"),
                LONG,
                Text::Lossy
            ),
            Err(Failed::Exit(3, "why".into()))
        );
        assert!(matches!(
            stdout_or(
                Command::new("C:\\nonexistent\\daedalus-exec-test.exe"),
                LONG,
                Text::Strict
            ),
            Err(Failed::Spawn(_))
        ));
    }

    #[test]
    fn stdout_or_kills_at_the_deadline() {
        let t = Instant::now();
        assert_eq!(
            stdout_or(
                cmd("ping -n 6 127.0.0.1"),
                Duration::from_millis(300),
                Text::Lossy
            ),
            Err(Failed::Timeout)
        );
        assert!(t.elapsed() < Duration::from_secs(4));
        assert!(both(cmd("ping -n 6 127.0.0.1"), Duration::from_millis(300)).is_none());
    }
}
