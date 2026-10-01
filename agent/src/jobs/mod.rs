//! Claude's long-lived processes as jobs of the OS, never children of the
//! agent: the Remote Control server and every session the agent resumed.
//!
//! A job outlives the process that started it — the session, which is the
//! tray on Windows and macOS, a user unit on Linux and a thread of the
//! service on the controller — so restarting or updating the agent ends no
//! Claude session, and the next start finds each job again by its name and
//! re-attaches. What a job is, is the OS's (`os::jobs`, one module per OS
//! with the same names):
//!
//! - Linux and the controller: a transient systemd user unit
//!   (`systemd-run --user`), watched with `systemctl --user show`, kept with
//!   its exit status (`RemainAfterExit=yes`) until read;
//! - macOS: a launchd job in the user's `gui/<uid>` domain, from a plist the
//!   session writes into its own state directory (never `~/Library/
//!   LaunchAgents`, so nothing starts it at a login), bootstrapped with
//!   `launchctl bootstrap`, watched with `launchctl print`, stopped with
//!   `bootout`; a job that exited stays loaded, with its exit code, until
//!   cleared;
//! - Windows: a process started outside the tray's console, process group
//!   and job object (`CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP |
//!   CREATE_BREAKAWAY_FROM_JOB`), recorded by pid AND creation time in the
//!   session's state directory so a restarted tray re-attaches to it and
//!   never adopts a recycled pid; stopped with `taskkill /T`.
//!
//! A resumed session needs a terminal — with pipes the CLI falls back to
//! `--print` and exits — so on unix it runs under `script` (util-linux's on
//! Linux, the BSD one on macOS, whose syntax differs), its output filtered on
//! the way to its log; on Windows under a pseudo-console that the agent's
//! own binary holds in a detached mode (`daedalus-agent claude-holder`,
//! os/windows/holder.rs), filtering the same way (`LineFilter`).
//!
//! Every job's output goes to a log file of its own, which the session
//! tails (`LogTail`) from the marker line it writes before each start.
//! Everything here is pure and tested on every OS; the calls are the OS's.

mod launchd;
mod line_filter;
mod proc;
mod systemd;
mod windows;

pub use launchd::{
    launchctl_says_gone, launchd_label, launchd_plist, macos_session_line, parse_launchctl_list,
    parse_launchctl_print,
};
pub use line_filter::LineFilter;
pub use proc::{
    parse_procargs2, parse_systemd_units, parse_unit_cost, Listed, ProcStats, UnitCost,
};
pub use systemd::{parse_systemd_show, systemd_server_args, systemd_session_args, SYSTEMD_PROPS};
pub use windows::{
    holder_file, stale_holders, windows_absolute, windows_quote, windows_session_command, JobRecord,
};

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// What the log's marker line says before each server start;
/// `LogTail::at_last_marker` finds it again.
pub const MARKER: &str = "starting `claude remote-control --verbose`";

/// A job, as the OS reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobState {
    /// Starting, running or stopping, with its main pid when it has one,
    /// how long ago it started, and where.
    Running {
        pid: Option<u32>,
        age_secs: Option<u64>,
        workdir: Option<PathBuf>,
    },
    /// The process exited; the job remains with its status: "N" for an exit
    /// code, "signal" for a kill.
    Exited(String),
    /// No such job (never started, or cleared).
    Gone,
}

impl JobState {
    pub fn running(&self) -> bool {
        matches!(self, JobState::Running { .. })
    }
}

/// Claude's jobs as the OS keeps them: one implementation per OS
/// (`os::jobs::Os`), which the supervisor and the sessions' thread are
/// handed, and a fake in their tests. What an OS does not have, it does not
/// implement: the defaults say so.
pub trait Jobs: Send {
    /// The job's state now; Err when the OS could not say — never taken for
    /// a job that is gone.
    fn show(&self, name: &str) -> Result<JobState, String>;
    fn start_server(&self, j: &ServerJob) -> Result<(), String>;
    fn start_session(&self, j: &SessionJob) -> Result<(), String>;
    /// End the job, if it runs: its whole tree.
    fn stop(&self, name: &str) -> Result<(), String>;
    /// Stop it and clear what is left of it, so the name is free for the
    /// next start. A job that is not there is not an error.
    fn clear(&self, name: &str);
    /// The jobs starting with `prefix` that run now.
    fn running(&self, prefix: &str) -> Result<Vec<Listed>, String>;
    /// A job's memory and CPU, where the OS accounts for one (a unit's).
    fn cost(&self, _name: &str) -> Option<UnitCost> {
        None
    }
    /// The `claude` a running job runs, where it can be read off the job
    /// (what gcroot.rs pins).
    fn running_cli(&self, _name: &str) -> Option<PathBuf> {
        None
    }
    /// Why a job that runs may not outlive the session, when that is so.
    fn caveat(&self, _name: &str) -> Option<String> {
        None
    }
    /// The SHELL a resumed session's terminal hands it, where a terminal
    /// program (`script`) runs it.
    fn session_shell(&self) -> Option<PathBuf> {
        None
    }
}

/// The Remote Control server's job.
#[derive(Clone, Debug)]
pub struct ServerJob<'a> {
    pub name: &'a str,
    pub cli: &'a Path,
    pub workdir: &'a Path,
    pub log: &'a Path,
    pub env: &'a [(String, String)],
}

/// One resumed session's job: `claude --resume <id> --remote-control
/// <label>` under a terminal, in `cwd`.
#[derive(Clone, Debug)]
pub struct SessionJob<'a> {
    pub name: &'a str,
    pub id: &'a str,
    pub cli: &'a Path,
    pub label: &'a str,
    pub cwd: &'a Path,
    pub log: &'a Path,
    pub env: &'a [(String, String)],
}

// ── the environment ───────────────────────────────────────────────────────

/// The environment a job gets besides what the OS hands every job: the
/// session's PATH with `~/.local/bin` first (a user manager's or launchd's
/// PATH is the system's), HOME and CLAUDE_CONFIG_DIR — the profile the
/// session reads is the one the server uses — and Claude's own
/// package-manager auto-update switch (claude/supervisor/update.rs says
/// why). `extra_path` is what the OS adds after the session's own PATH
/// (Homebrew's two prefixes on macOS).
pub fn job_env(
    home: Option<&Path>,
    path: Option<&str>,
    config_dir: Option<&str>,
    extra_path: &[&str],
) -> Vec<(String, String)> {
    let mut env = vec![(
        "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE".to_string(),
        "1".to_string(),
    )];
    if let Some(h) = home {
        env.push(("HOME".into(), h.display().to_string()));
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut parts: Vec<String> = Vec::new();
    if let Some(h) = home {
        parts.push(h.join(".local").join("bin").display().to_string());
    }
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        parts.push(p.to_string());
    }
    for e in extra_path {
        if !parts.iter().any(|p| p.split(sep).any(|d| d == *e)) {
            parts.push((*e).to_string());
        }
    }
    if !parts.is_empty() {
        env.push(("PATH".into(), parts.join(&sep.to_string())));
    }
    if let Some(d) = config_dir.filter(|d| !d.is_empty()) {
        env.push(("CLAUDE_CONFIG_DIR".into(), d.to_string()));
    }
    env
}

/// A resumed session's: the server's (`job_env`), with `/run/wrappers/bin`
/// in front of PATH where it exists (NixOS's sudo, for a session that
/// rebuilds), TERM for the TUI, and — where `script` runs it — SHELL.
pub fn session_env(
    base: Vec<(String, String)>,
    wrappers: bool,
    shell: Option<&Path>,
) -> Vec<(String, String)> {
    let mut env = base;
    if wrappers {
        match env.iter_mut().find(|(k, _)| k == "PATH") {
            Some((_, p)) if !p.split(':').any(|d| d == "/run/wrappers/bin") => {
                let rest = std::mem::take(p);
                // After ~/.local/bin, which stays first.
                *p = match rest.split_once(':') {
                    Some((first, tail)) if first.ends_with("/.local/bin") => {
                        format!("{first}:/run/wrappers/bin:{tail}")
                    }
                    _ => format!("/run/wrappers/bin:{rest}"),
                };
            }
            Some(_) => {}
            None => env.push(("PATH".into(), "/run/wrappers/bin".into())),
        }
    }
    env.push(("TERM".into(), "xterm-256color".into()));
    if let Some(sh) = shell {
        env.push(("SHELL".into(), sh.display().to_string()));
    }
    env
}

/// One variable of `systemctl --user show-environment`: the user manager's
/// environment, which carries the login's SHELL and profile PATH that the
/// agent's own (a unit's, sandboxed, on the controller) does not. An empty
/// value is none.
pub fn manager_env_value(text: &str, key: &str) -> Option<String> {
    text.lines()
        .find_map(|l| l.strip_prefix(key)?.strip_prefix('='))
        .map(|v| v.trim().trim_matches('\'').to_string())
        .filter(|v| !v.is_empty())
}

/// The login shell `/etc/passwd` gives the account whose home is `home`.
pub fn login_shell(passwd: &str, home: &Path) -> Option<PathBuf> {
    let home = home.to_str()?;
    passwd.lines().find_map(|l| {
        let f: Vec<&str> = l.split(':').collect();
        (f.len() == 7 && f[5] == home && !f[6].is_empty()).then(|| PathBuf::from(f[6]))
    })
}

/// What a session's SHELL may be: Claude Code runs its commands through bash
/// or zsh only, and with any other SHELL it looks for one on PATH — which on
/// NixOS has neither in /bin. So a shell that is not one of the two is no
/// answer, and the caller goes on to the next candidate.
pub fn runs_commands(shell: &Path) -> bool {
    matches!(
        shell.file_name().and_then(|n| n.to_str()),
        Some("bash" | "zsh")
    )
}

// ── what a command line may carry ─────────────────────────────────────────

/// The `claude` path, as a command line carries it: refused when it holds a
/// quote, a `$`, a backtick, a backslash on unix, a `%`, or a control
/// character — none of which the resume line could carry safely.
pub fn check_cli(cli: &Path) -> Result<String, String> {
    let s = cli.display().to_string();
    let bad = |c: char| {
        c.is_control() || matches!(c, '"' | '$' | '`' | '%') || (!cfg!(windows) && c == '\\')
    };
    if s.chars().any(bad) {
        return Err(format!(
            "the claude path {s:?} has characters a command line cannot carry safely"
        ));
    }
    Ok(s)
}

/// `--remote-control <label>`: a token of letters, digits, `.`, `_`, `-`.
pub fn check_label(label: &str) -> Result<(), String> {
    if label.is_empty()
        || label
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
    {
        return Err(format!("the label {label:?} is not a token"));
    }
    Ok(())
}

/// A word for `sh`, single-quoted.
pub fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The tools a resumed session's command line runs through on unix.
#[derive(Clone, Debug)]
pub struct Tools {
    pub sh: PathBuf,
    pub script: PathBuf,
    pub sed: PathBuf,
    pub grep: PathBuf,
}

impl Tools {
    pub fn locate() -> Result<Self, String> {
        let find = |t: &str, why: &str| {
            crate::exec::locate(t).ok_or_else(|| format!("no `{t}` on this machine ({why})"))
        };
        Ok(Self {
            sh: find("sh", "the session's command line")?,
            script: find("script", "the terminal the session needs")?,
            sed: find("sed", "the log filter")?,
            grep: find("grep", "the log filter")?,
        })
    }

    fn check(&self) -> Result<(), String> {
        for p in [&self.sh, &self.script, &self.sed, &self.grep] {
            if p.display().to_string().contains(['$', '%', '\'']) {
                return Err(format!("the tool path {} cannot be carried", p.display()));
            }
        }
        Ok(())
    }
}

/// The status box's lines, dropped from a session's log: they open with `·`
/// or whitespace (grep -E).
const GREP_EXPR: &str = "^·|^[[:space:]]";

/// A canonical lowercase uuid: what `--resume` takes.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => matches!(c, b'0'..=b'9' | b'a'..=b'f'),
        })
}

// ── what a job runs ───────────────────────────────────────────────────────

/// The `claude` a job's command line names: the first word, once quotes
/// and the separators systemd and launchd print (`=`, `;`, braces, pipes)
/// are taken off, that is an absolute path whose file is `claude`. What the
/// session pins from the garbage collector when it re-attaches to a job an
/// earlier agent started (gcroot.rs).
pub fn claude_in_command(text: &str) -> Option<PathBuf> {
    text.split(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '\'' | '=' | ';' | '{' | '}' | '|' | '<' | '>')
    })
    .filter(|w| w.starts_with('/'))
    .map(Path::new)
    .find(|p| p.file_name().is_some_and(|n| n == "claude"))
    .map(Path::to_path_buf)
}

// ── the log ───────────────────────────────────────────────────────────────

/// A job's output as the OS appends it to the log: whatever arrived since
/// the last look, as whole lines.
pub struct LogTail {
    path: PathBuf,
    offset: u64,
    /// The bytes after the last newline read: a line (or a UTF-8 sequence)
    /// the server is still writing.
    partial: Vec<u8>,
}

/// At most this much is read per look, so a runaway log never stalls a tick.
const TAIL_CHUNK: u64 = 256 * 1024;

impl LogTail {
    /// From `offset` on: the end of the marker line just written.
    pub fn at(path: PathBuf, offset: u64) -> Self {
        Self {
            path,
            offset,
            partial: Vec::new(),
        }
    }

    /// From the line after the last marker in the log's last megabyte — the
    /// run a re-attaching session finds still going.
    pub fn at_last_marker(path: PathBuf) -> Self {
        let offset = last_marker_end(&path).unwrap_or(0);
        Self::at(path, offset)
    }

    /// The whole lines written since the last call.
    pub fn read_new(&mut self) -> Vec<String> {
        let Ok(mut f) = File::open(&self.path) else {
            return Vec::new();
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            // Rotated or truncated under us: start over.
            self.offset = 0;
            self.partial.clear();
        }
        if len == self.offset || f.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let n = f
            .take(TAIL_CHUNK)
            .read_to_end(&mut self.partial)
            .unwrap_or(0) as u64;
        self.offset += n;
        let Some(last_nl) = self.partial.iter().rposition(|&b| b == b'\n') else {
            return Vec::new();
        };
        let rest = self.partial.split_off(last_nl + 1);
        let lines = self.partial[..last_nl]
            .split(|&b| b == b'\n')
            .map(|l| {
                String::from_utf8_lossy(l)
                    .trim_end_matches('\r')
                    .to_string()
            })
            .collect();
        self.partial = rest;
        lines
    }
}

/// Where the line after the last marker starts, in the last megabyte —
/// found in the raw bytes, so the offset is a byte offset whatever the log
/// holds.
fn last_marker_end(path: &Path) -> Option<u64> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let from = len.saturating_sub(1 << 20);
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let marker = MARKER.as_bytes();
    let at = buf.windows(marker.len()).rposition(|w| w == marker)?;
    let end = buf[at..].iter().position(|&b| b == b'\n')? + at + 1;
    Some(from + end as u64)
}

#[cfg(test)]
mod tests;
