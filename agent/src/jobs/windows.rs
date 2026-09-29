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

/// A Windows path that names its drive or share: never searched for, so a
/// file of the same name in the working directory cannot stand in for it.
pub fn windows_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || p.starts_with("\\\\")
}

/// The holder's command line for the CLI: `claude.exe …` as it is, and a
/// `.cmd` or `.bat` shim (npm's) through `cmd.exe /d /s /c`, which is the
/// only way such a file runs — the `cmd.exe` in `system_dir`
/// (`GetSystemDirectoryW`), named whole, since a bare `cmd.exe` is looked
/// for in the session's working directory first. The CLI's path is always
/// quoted, so `&`, `|`, `<`, `>`, `^` and parentheses in it stay part of
/// the path; the words were checked (`check_cli`, `check_label`, a uuid),
/// so none carries a quote or a `%`.
pub fn windows_session_command(
    system_dir: &str,
    cli: &str,
    id: &str,
    label: &str,
) -> Result<String, String> {
    if !is_uuid(id) {
        return Err(format!("not a session id: {id:?}"));
    }
    check_label(label)?;
    for (what, p) in [
        ("the claude path", cli),
        ("the system directory", system_dir),
    ] {
        if !windows_absolute(p) || p.contains('"') {
            return Err(format!("{what} {p:?} is not an absolute path"));
        }
    }
    let lower = cli.to_ascii_lowercase();
    let words = format!("\"{cli}\" --resume {id} --remote-control {label}");
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let cmd = format!("{}\\cmd.exe", system_dir.trim_end_matches(['\\', '/']));
        Ok(format!("\"{cmd}\" /d /s /c \"{words}\""))
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
