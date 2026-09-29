//! Windows: a detached process per job, recorded by pid and creation time,
//! and the holder that gives a resumed session its pseudo-console.

use serde::{Deserialize, Serialize};

use super::*;

/// A detached process as the session records it (os/windows/jobs.rs): its
/// pid and its creation time (a FILETIME, 100 ns since 1601), which is what
/// tells it from a later process that got the same pid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobRecord {
    pub pid: u32,
    pub created: u64,
    pub workdir: String,
    pub started_at: String,
}

/// One argument as `CommandLineToArgvW` reads it back (the MSVC rules):
/// quoted when it has a space, a tab or a quote, backslashes doubled before
/// a quote.
pub fn windows_quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

/// The holder's command line for the CLI: `claude.exe …` as it is, and a
/// `.cmd` or `.bat` shim (npm's) through `cmd.exe /d /s /c`, which is the
/// only way such a file runs. The words were checked (`check_cli`,
/// `check_label`, a uuid), so none carries a quote or a `%`.
pub fn windows_session_command(cli: &str, id: &str, label: &str) -> Result<String, String> {
    if !is_uuid(id) {
        return Err(format!("not a session id: {id:?}"));
    }
    check_label(label)?;
    let lower = cli.to_ascii_lowercase();
    let words = format!(
        "{} --resume {id} --remote-control {label}",
        windows_quote(cli)
    );
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        Ok(format!("cmd.exe /d /s /c \"{words}\""))
    } else {
        Ok(words)
    }
}

/// The holder's per-version copy (os/windows/jobs.rs `holder_exe`).
pub fn holder_file(version: &str) -> String {
    format!("daedalus-agent-{version}.exe")
}

/// The holder copies in `names` of other versions than `version`: what a
/// sweep tries to delete (one still running a session stays).
pub fn stale_holders<'a>(names: &'a [String], version: &str) -> Vec<&'a str> {
    let current = holder_file(version);
    names
        .iter()
        .map(String::as_str)
        .filter(|n| *n != current)
        .filter(|n| {
            n.starts_with("daedalus-agent-") && (n.ends_with(".exe") || n.ends_with(".exe.new"))
        })
        .collect()
}
