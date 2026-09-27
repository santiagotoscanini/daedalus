//! The PowerShell the drives, updates and Store tiers run: one hidden
//! Windows PowerShell through the shared bounded shell-out (exec.rs:
//! killed at its deadline, no console window, stdout read lossily so a
//! stray code-page character cannot throw the whole document away), its
//! stdout parsed as JSON; and the helpers that read that JSON the way
//! `ConvertTo-Json` writes it.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde_json::Value;

use crate::exec::{stdout_or, Text};

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
    let text = stdout_or(cmd, deadline, Text::Lossy).map_err(|e| format!("PowerShell {e}"))?;
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
