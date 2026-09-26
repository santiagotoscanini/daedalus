//! The bounded shell-out the drives, updates and Store tiers use: one
//! hidden Windows PowerShell with a deadline, killed when it passes, its
//! stdout parsed as JSON; and the helpers that read that JSON the way
//! `ConvertTo-Json` writes it.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

/// `CREATE_NO_WINDOW`: the shell-outs run from a service, but the flag
/// costs nothing and keeps a console from flashing should the tray ever
/// share this code path.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Why a command gave nothing, for the error line.
#[derive(Debug, PartialEq)]
enum Failed {
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

/// A command's whole stdout, or why not; killed at the deadline. Bytes are
/// read and converted lossily, so a stray code-page character cannot
/// throw the whole document away.
fn output_or(mut cmd: Command, deadline: Duration) -> Result<String, Failed> {
    let started = Instant::now();
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Failed::Spawn(e.to_string()))?;
    let mut out = child
        .stdout
        .take()
        .ok_or_else(|| Failed::Spawn("no stdout".into()))?;
    let mut err = child.stderr.take();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        let _ = tx.send(String::from_utf8_lossy(&b).into_owned());
    });
    let (etx, erx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_end(&mut b);
        }
        let _ = etx.send(String::from_utf8_lossy(&b).into_owned());
    });
    let text = match rx.recv_timeout(deadline) {
        Ok(t) => t,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failed::Timeout);
        }
    };
    // stdout is closed; the process is exiting. Give it the rest of the
    // deadline rather than a blocking wait.
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(text);
                }
                let stderr = erx
                    .recv_timeout(Duration::from_millis(200))
                    .unwrap_or_default();
                let first = stderr
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("")
                    .trim();
                return Err(Failed::Exit(status.code().unwrap_or(-1), first.to_string()));
            }
            Ok(None) if started.elapsed() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failed::Timeout);
            }
        }
    }
}

/// Windows PowerShell, by its full path (the service's PATH is minimal),
/// running one script with no profile, no prompt and no window; its
/// stdout parsed as JSON.
pub(super) fn powershell_json(script: &str, deadline: Duration) -> Result<Value, String> {
    let exe = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("powershell.exe"));
    let mut cmd = Command::new(exe);
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-NoLogo",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let text = output_or(cmd, deadline).map_err(|e| format!("PowerShell {e}"))?;
    let text = text.trim();
    if text.is_empty() {
        return Err("PowerShell printed nothing".into());
    }
    serde_json::from_str(text).map_err(|e| format!("PowerShell output is not JSON: {e}"))
}

// ------------------------------------------------------------- JSON bits

/// A property as a trimmed, non-empty string.
pub(super) fn j_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A property as an unsigned integer: a JSON number, a float that is one,
/// or a numeric string (COM decimals reach JSON either way).
pub(super) fn j_u64(v: &Value, key: &str) -> Option<u64> {
    let x = v.get(key)?;
    x.as_u64()
        .or_else(|| x.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64))
        .or_else(|| x.as_str()?.trim().parse().ok())
}

/// A property that identifies (a disk number, a KB number), whether it
/// came as a number or a string.
pub(super) fn j_id(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// A property that is a list: `ConvertTo-Json` unwraps a single element,
/// so one object counts as a list of one.
pub(super) fn j_list(v: &Value, key: &str) -> Vec<Value> {
    match v.get(key) {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::Null) | None => Vec::new(),
        Some(x) => vec![x.clone()],
    }
}

/// The script's own `name|message` error lines, prefixed for the page.
pub(super) fn script_errors(v: &Value, label: impl Fn(&str) -> String) -> Vec<String> {
    j_list(v, "errors")
        .iter()
        .filter_map(Value::as_str)
        .map(|line| {
            let (what, msg) = line.split_once('|').unwrap_or((line, ""));
            let msg = msg.lines().next().unwrap_or("").trim();
            if msg.is_empty() {
                format!("{}: {what} refused", label(what))
            } else {
                format!("{}: {what} refused: {msg}", label(what))
            }
        })
        .collect()
}
