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

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::roster::is_uuid;

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
/// package-manager auto-update switch (supervisor.rs `update_claude` says
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

// ── systemd (Linux, the controller) ───────────────────────────────────────

/// The properties `show` is asked for — every one of them in systemd 240,
/// the oldest this supports. The start time is the monotonic stamp, in
/// microseconds, compared with CLOCK_MONOTONIC (`os::monotonic_usec`):
/// `--timestamp=unix` would need systemd 251.
pub const SYSTEMD_PROPS: &str =
    "LoadState,ActiveState,SubState,MainPID,ExecMainCode,ExecMainStatus,\
                                 ExecMainStartTimestampMonotonic,WorkingDirectory";

/// `systemctl --user show -p …`: `Key=value` lines. `now_mono_usec`, the
/// monotonic clock now, turns the start stamp into an age.
pub fn parse_systemd_show(text: &str, now_mono_usec: Option<u64>) -> JobState {
    let get = |k: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(k).and_then(|r| r.strip_prefix('=')))
            .map(str::trim)
            .unwrap_or("")
    };
    if get("LoadState") == "not-found" {
        return JobState::Gone;
    }
    let active = get("ActiveState");
    let sub = get("SubState");
    if active == "failed" || (active == "active" && sub == "exited") {
        // ExecMainCode is the waitid code: 1 exited, 2 killed, 3 dumped.
        return JobState::Exited(match get("ExecMainCode") {
            "1" => get("ExecMainStatus").to_string(),
            _ => "signal".to_string(),
        });
    }
    if matches!(
        active,
        "active" | "activating" | "deactivating" | "reloading"
    ) {
        let pid = get("MainPID").parse::<u32>().ok().filter(|p| *p > 0);
        let age_secs = get("ExecMainStartTimestampMonotonic")
            .parse::<u64>()
            .ok()
            .filter(|start| *start > 0)
            .zip(now_mono_usec)
            .map(|(start, now)| now.saturating_sub(start) / 1_000_000);
        let workdir = Some(get("WorkingDirectory"))
            .filter(|w| !w.is_empty() && w.starts_with('/'))
            .map(PathBuf::from);
        return JobState::Running {
            pid,
            age_secs,
            workdir,
        };
    }
    JobState::Gone
}

fn systemd_common(name: &str, description: &str, workdir: &Path, log: &Path) -> Vec<String> {
    vec![
        "--user".to_string(),
        format!("--unit={name}"),
        format!("--description={description}"),
        "--property=TimeoutStopSec=15".into(),
        format!("--property=StandardOutput=append:{}", log.display()),
        format!("--property=StandardError=append:{}", log.display()),
        format!("--working-directory={}", workdir.display()),
    ]
}

/// `systemd-run`'s arguments for the server.
pub fn systemd_server_args(job: &ServerJob) -> Vec<String> {
    let mut a = systemd_common(
        job.name,
        "Claude Code remote control (daedalus-agent)",
        job.workdir,
        job.log,
    );
    a.insert(3, "--property=RemainAfterExit=yes".into());
    a.extend(job.env.iter().map(|(k, v)| format!("--setenv={k}={v}")));
    a.push("--".into());
    a.push(job.cli.display().to_string());
    a.push("remote-control".into());
    a.push("--verbose".into());
    a
}

/// The log filter for util-linux: ANSI escapes and hyperlinks stripped,
/// empty lines dropped. No `$` and no `%` in any of it: systemd expands both
/// in a unit's command line.
const GNU_SED_EXPR: &str = r"s/\x1b\[[0-9;]*[A-Za-z]//g; s/\x1b\]8;;[^\x07]*\x07//g; /./!d";

/// `systemd-run`'s arguments for one resume — pure, and the whole of what a
/// resumed session is started with: the argv fixed here, the selector and
/// the directory checked before it is called. util-linux's `script -qfec
/// '<cmd>' /dev/null` gives the CLI its terminal and stays its parent.
pub fn systemd_session_args(job: &SessionJob, tools: &Tools) -> Result<Vec<String>, String> {
    if !is_uuid(job.id) {
        return Err(format!("not a session id: {:?}", job.id));
    }
    let cli = check_cli(job.cli)?;
    check_label(job.label)?;
    tools.check()?;
    let inner = format!(
        "\"{cli}\" --resume {} --remote-control {}",
        job.id, job.label
    );
    let line = format!(
        "{} -qfec {} /dev/null | {} -u -E {} | {{ {} --line-buffered -Ev {} || true; }}",
        sq(&tools.script.display().to_string()),
        sq(&inner),
        sq(&tools.sed.display().to_string()),
        sq(GNU_SED_EXPR),
        sq(&tools.grep.display().to_string()),
        sq(GREP_EXPR),
    );
    let mut a = systemd_common(
        job.name,
        &format!("Claude Code session {}, resumed by daedalus-agent", job.id),
        job.cwd,
        job.log,
    );
    // A stop is a requested end: SIGTERM's exit is a success.
    a.insert(4, "--property=SuccessExitStatus=143".into());
    a.extend(job.env.iter().map(|(k, v)| format!("--setenv={k}={v}")));
    a.push("--".into());
    a.push(tools.sh.display().to_string());
    a.push("-c".into());
    a.push(line);
    Ok(a)
}

// ── launchd (macOS) ───────────────────────────────────────────────────────

/// A job's launchd label: the agent's reverse-DNS name, then the job's.
pub fn launchd_label(name: &str) -> String {
    format!("me.toscanini.daedalus-agent.{name}")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The plist a job is bootstrapped from: run once at load, never kept
/// alive (the supervisor decides what runs again), its output appended to
/// the log, its process group ended with it — the sessions the server
/// spawned go when it goes, as a unit's cgroup does on Linux.
pub fn launchd_plist(
    label: &str,
    program: &[String],
    workdir: &Path,
    log: &Path,
    env: &[(String, String)],
) -> String {
    let s = |v: &str| format!("<string>{}</string>", xml_escape(v));
    let args: String = program.iter().map(|a| format!("\n    {}", s(a))).collect();
    let envs: String = env
        .iter()
        .map(|(k, v)| format!("\n    <key>{}</key>{}", xml_escape(k), s(v)))
        .collect();
    let log = log.display().to_string();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>{label}
  <key>ProgramArguments</key>
  <array>{args}
  </array>
  <key>WorkingDirectory</key>{workdir}
  <key>EnvironmentVariables</key>
  <dict>{envs}
  </dict>
  <key>StandardOutPath</key>{log}
  <key>StandardErrorPath</key>{log}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
        label = s(label),
        workdir = s(&workdir.display().to_string()),
        log = s(&log),
    )
}

/// The resume line on macOS, for `sh -c`: the BSD `script -q /dev/null
/// <command…>` (a command as separate words, no `-c`), BSD `sed -l` (line
/// buffered; its regex has no `\x` escapes, so ESC and BEL come from
/// `printf`), then the same grep.
pub fn macos_session_line(job: &SessionJob, tools: &Tools) -> Result<String, String> {
    if !is_uuid(job.id) {
        return Err(format!("not a session id: {:?}", job.id));
    }
    let cli = check_cli(job.cli)?;
    check_label(job.label)?;
    tools.check()?;
    Ok(format!(
        "e=$(printf '\\033'); b=$(printf '\\007'); \
         {} -q /dev/null {} --resume {} --remote-control {} \
         | {} -l -E \"s/${{e}}\\[[0-9;]*[A-Za-z]//g; s/${{e}}]8;;[^${{b}}]*${{b}}//g; /./!d\" \
         | {{ {} --line-buffered -Ev {} || true; }}",
        sq(&tools.script.display().to_string()),
        sq(&cli),
        job.id,
        job.label,
        sq(&tools.sed.display().to_string()),
        sq(&tools.grep.display().to_string()),
        sq(GREP_EXPR),
    ))
}

/// `launchctl print gui/<uid>/<label>`, read tolerantly: the `key = value`
/// lines at the service's own level — one `{` deep, whatever the
/// indentation — with nested blocks (`arguments = {`, `environment = {`, …)
/// skipped by their depth. None when the text is not a service's print at
/// all: the service is there but unreadable, which the caller takes as
/// unknown — never as gone (only launchctl's "no such service" is that). The
/// pid's age comes from `ps` (`parse_etime`), since launchd does not print a
/// start time.
pub fn parse_launchctl_print(text: &str) -> Option<JobState> {
    let mut depth = 0usize;
    let mut top: Vec<(&str, &str)> = Vec::new();
    let mut opened = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('}') {
            depth = depth.saturating_sub(1);
            continue;
        }
        let opens = line.ends_with('{');
        if depth == 1 && !opens {
            if let Some((k, v)) = line.split_once(" = ") {
                top.push((k.trim(), v.trim()));
            }
        }
        if opens {
            depth += 1;
            opened = true;
        }
    }
    if !opened {
        return None;
    }
    let get = |k: &str| top.iter().find(|(key, _)| *key == k).map(|(_, v)| *v);
    let workdir = get("working directory")
        .filter(|w| w.starts_with('/'))
        .map(PathBuf::from);
    let pid = get("pid")
        .and_then(|p| p.parse::<u32>().ok())
        .filter(|p| *p > 0);
    let state = get("state")?;
    if matches!(state, "running" | "spawn scheduled" | "spawning") || pid.is_some() {
        return Some(JobState::Running {
            pid,
            age_secs: None,
            workdir,
        });
    }
    if get("last terminating signal").is_some() {
        return Some(JobState::Exited("signal".into()));
    }
    Some(match get("last exit code") {
        Some(c) => {
            let code = c.split(':').next().unwrap_or(c).trim();
            if code.parse::<i64>().is_ok() {
                JobState::Exited(code.to_string())
            } else {
                // "(never exited)" with no process: loaded, not run.
                JobState::Exited("never ran".into())
            }
        }
        None => JobState::Exited("unknown".into()),
    })
}

/// Whether a failed `launchctl print` says the service does not exist:
/// exit 113 ("Could not find service …"), the one answer that means gone.
pub fn launchctl_says_gone(code: i32, output: &str) -> bool {
    code == 113 || output.contains("Could not find service")
}

/// `launchctl list`: `PID\tStatus\tLabel` lines; the labels that start with
/// `prefix` and have a process now.
pub fn parse_launchctl_list(text: &str, prefix: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let (pid, _status, label) = (f.next()?, f.next()?, f.next()?.trim());
            (pid.trim().parse::<u32>().is_ok() && label.starts_with(prefix))
                .then(|| label.to_string())
        })
        .collect()
}

/// `ps -o etime=`: `[[dd-]hh:]mm:ss`, in seconds.
pub fn parse_etime(s: &str) -> Option<u64> {
    let s = s.trim();
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, s),
    };
    let parts: Vec<u64> = rest
        .split(':')
        .map(|p| p.parse::<u64>().ok())
        .collect::<Option<_>>()?;
    let (h, m, sec) = match parts.as_slice() {
        [m, s] => (0, *m, *s),
        [h, m, s] => (*h, *m, *s),
        _ => return None,
    };
    Some(days * 86_400 + h * 3600 + m * 60 + sec)
}

// ── Windows ───────────────────────────────────────────────────────────────

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

/// What a terminal writes, as log lines: escape sequences removed (CSI,
/// OSC up to BEL or ST, and two-byte escapes), carriage returns taken as
/// line ends (a pseudo-console repaints in place), and the lines the unix
/// filter drops dropped here too — empty ones, and the status box's
/// (opening with `·` or whitespace).
#[derive(Default)]
pub struct LineFilter {
    line: Vec<u8>,
    esc: Esc,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum Esc {
    #[default]
    None,
    /// After ESC.
    Start,
    /// Inside `ESC [ …`, until a final byte.
    Csi,
    /// Inside `ESC ] …`, until BEL or ESC \.
    Osc,
    /// ESC inside an OSC: `\` ends it.
    OscEnd,
}

impl LineFilter {
    /// Feed bytes; the whole lines they complete, kept.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            match self.esc {
                Esc::None => match b {
                    0x1b => self.esc = Esc::Start,
                    b'\n' | b'\r' => self.end_line(&mut out),
                    0x07 | 0x08 => {}
                    _ => self.line.push(b),
                },
                Esc::Start => {
                    self.esc = match b {
                        b'[' => Esc::Csi,
                        b']' => Esc::Osc,
                        _ => Esc::None,
                    }
                }
                Esc::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.esc = Esc::None;
                    }
                }
                Esc::Osc => match b {
                    0x07 => self.esc = Esc::None,
                    0x1b => self.esc = Esc::OscEnd,
                    _ => {}
                },
                Esc::OscEnd => self.esc = if b == b'\\' { Esc::None } else { Esc::Osc },
            }
            if self.line.len() > 64 * 1024 {
                self.end_line(&mut out);
            }
        }
        out
    }

    /// What is left when the stream ends.
    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        self.end_line(&mut out);
        out
    }

    fn end_line(&mut self, out: &mut Vec<String>) {
        let line = String::from_utf8_lossy(&self.line).into_owned();
        self.line.clear();
        let keep = !line.trim().is_empty()
            && !line.starts_with('·')
            && !line.starts_with(|c: char| c.is_whitespace());
        if keep {
            out.push(line);
        }
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
mod tests {
    use super::*;

    const ID: &str = "abdda3a9-0cb2-43f1-b13e-37f25a755fce";

    fn tools() -> Tools {
        Tools {
            sh: "/bin/sh".into(),
            script: "/usr/bin/script".into(),
            sed: "/usr/bin/sed".into(),
            grep: "/usr/bin/grep".into(),
        }
    }

    #[test]
    fn systemd_show_reads_running_exited_and_gone() {
        let running = "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\n\
                       ExecMainCode=0\nExecMainStatus=0\nExecMainStartTimestampMonotonic=1000000\n\
                       WorkingDirectory=/home/ana/projects/x\n";
        assert_eq!(
            parse_systemd_show(running, Some(91_000_000)),
            JobState::Running {
                pid: Some(4242),
                age_secs: Some(90),
                workdir: Some(PathBuf::from("/home/ana/projects/x"))
            }
        );
        let exited = "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\n\
                      ExecMainCode=1\nExecMainStatus=3\n";
        assert_eq!(
            parse_systemd_show(exited, None),
            JobState::Exited("3".into())
        );
        let clean = "LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\n\
                     ExecMainCode=1\nExecMainStatus=0\n";
        assert_eq!(
            parse_systemd_show(clean, None),
            JobState::Exited("0".into())
        );
        let killed = "LoadState=loaded\nActiveState=failed\nSubState=failed\nExecMainCode=2\nExecMainStatus=9\n";
        assert_eq!(
            parse_systemd_show(killed, None),
            JobState::Exited("signal".into())
        );
        let starting = "LoadState=loaded\nActiveState=activating\nSubState=start\nMainPID=0\n\
                        ExecMainStartTimestampMonotonic=0\nWorkingDirectory=\n";
        assert_eq!(
            parse_systemd_show(starting, Some(5)),
            JobState::Running {
                pid: None,
                age_secs: None,
                workdir: None
            }
        );
        assert_eq!(
            parse_systemd_show("LoadState=not-found\nActiveState=inactive\n", None),
            JobState::Gone
        );
        assert_eq!(
            parse_systemd_show(
                "LoadState=loaded\nActiveState=inactive\nSubState=dead\n",
                None
            ),
            JobState::Gone
        );
    }

    #[cfg(unix)]
    #[test]
    fn systemd_run_gets_the_unit_the_log_and_the_environment() {
        let env = job_env(
            Some(Path::new("/home/ana")),
            Some("/usr/bin:/bin"),
            None,
            &[],
        );
        assert_eq!(
            env,
            vec![
                (
                    "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE".to_string(),
                    "1".to_string()
                ),
                ("HOME".into(), "/home/ana".into()),
                ("PATH".into(), "/home/ana/.local/bin:/usr/bin:/bin".into()),
            ]
        );
        let a = systemd_server_args(&ServerJob {
            name: "daedalus-claude-rc",
            cli: Path::new("/home/ana/.local/bin/claude"),
            workdir: Path::new("/home/ana/p"),
            log: Path::new("/home/ana/.local/state/daedalus-agent/claude-rc.log"),
            env: &env,
        });
        assert_eq!(
            a,
            [
                "--user",
                "--unit=daedalus-claude-rc",
                "--description=Claude Code remote control (daedalus-agent)",
                "--property=RemainAfterExit=yes",
                "--property=TimeoutStopSec=15",
                "--property=StandardOutput=append:/home/ana/.local/state/daedalus-agent/claude-rc.log",
                "--property=StandardError=append:/home/ana/.local/state/daedalus-agent/claude-rc.log",
                "--working-directory=/home/ana/p",
                "--setenv=CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=1",
                "--setenv=HOME=/home/ana",
                "--setenv=PATH=/home/ana/.local/bin:/usr/bin:/bin",
                "--",
                "/home/ana/.local/bin/claude",
                "remote-control",
                "--verbose",
            ]
        );
        let with_dir = job_env(None, None, Some("/srv/claude"), &[]);
        assert_eq!(with_dir.last().unwrap().0, "CLAUDE_CONFIG_DIR");
        // macOS adds Homebrew after the session's PATH, once.
        let mac = job_env(
            None,
            Some("/usr/bin:/opt/homebrew/bin"),
            None,
            &["/opt/homebrew/bin", "/usr/local/bin"],
        );
        assert_eq!(
            mac[1],
            (
                "PATH".into(),
                "/usr/bin:/opt/homebrew/bin:/usr/local/bin".into()
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_systemd_resume_is_one_fixed_command_line() {
        let base = job_env(
            Some(Path::new("/home/ana")),
            Some("/usr/bin:/bin"),
            None,
            &[],
        );
        let env = session_env(base, true, Some(Path::new("/bin/sh")));
        assert_eq!(
            env,
            [
                ("CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE", "1"),
                ("HOME", "/home/ana"),
                (
                    "PATH",
                    "/home/ana/.local/bin:/run/wrappers/bin:/usr/bin:/bin"
                ),
                ("TERM", "xterm-256color"),
                ("SHELL", "/bin/sh"),
            ]
            .map(|(k, v)| (k.to_string(), v.to_string()))
        );
        let name = format!("claude-session-{ID}");
        let job = SessionJob {
            name: &name,
            id: ID,
            cli: Path::new("/home/ana/.local/bin/claude"),
            label: "s2-server",
            cwd: Path::new("/etc/nixos"),
            log: Path::new("/logs/claude-session.log"),
            env: &env[..1],
        };
        let a = systemd_session_args(&job, &tools()).unwrap();
        assert_eq!(
            a,
            [
                "--user".to_string(),
                format!("--unit=claude-session-{ID}"),
                format!("--description=Claude Code session {ID}, resumed by daedalus-agent"),
                "--property=TimeoutStopSec=15".into(),
                "--property=SuccessExitStatus=143".into(),
                "--property=StandardOutput=append:/logs/claude-session.log".into(),
                "--property=StandardError=append:/logs/claude-session.log".into(),
                "--working-directory=/etc/nixos".into(),
                "--setenv=CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=1".into(),
                "--".into(),
                "/bin/sh".into(),
                "-c".into(),
                format!(
                    "'/usr/bin/script' -qfec '\"/home/ana/.local/bin/claude\" --resume {ID} --remote-control s2-server' /dev/null \
                     | '/usr/bin/sed' -u -E 's/\\x1b\\[[0-9;]*[A-Za-z]//g; s/\\x1b\\]8;;[^\\x07]*\\x07//g; /./!d' \
                     | {{ '/usr/bin/grep' --line-buffered -Ev '^·|^[[:space:]]' || true; }}"
                ),
            ]
        );
        assert!(!a.last().unwrap().contains(['$', '%']));
        // Nothing from outside the checks reaches it.
        let bad = |id: &str, cli: &str, label: &str| {
            let j = SessionJob {
                name: "u",
                id,
                cli: Path::new(cli),
                label,
                cwd: Path::new("/p"),
                log: Path::new("/l"),
                env: &[],
            };
            systemd_session_args(&j, &tools()).is_err() && macos_session_line(&j, &tools()).is_err()
        };
        assert!(bad("0a1b2c3d", "/c", "l"));
        assert!(bad(ID, "/home/$USER/claude", "l"));
        assert!(bad(ID, "/home/a\"b/claude", "l"));
        assert!(bad(ID, "/c", "a b"));
        assert!(bad(ID, "/c", "x;rm"));
        assert!(bad(ID, "/c", ""));
        // PATH already carrying the wrappers is left as it is.
        let env = session_env(
            vec![("PATH".into(), "/run/wrappers/bin:/bin".into())],
            true,
            None,
        );
        assert_eq!(env[0], ("PATH".into(), "/run/wrappers/bin:/bin".into()));
    }

    #[test]
    fn a_launchd_job_is_a_plist_and_a_bsd_script_line() {
        let env = vec![("HOME".to_string(), "/Users/ana".to_string())];
        let p = launchd_plist(
            &launchd_label("daedalus-claude-rc"),
            &[
                "/Users/ana/.local/bin/claude".into(),
                "remote-control".into(),
                "--verbose".into(),
            ],
            Path::new("/Users/ana/p & q"),
            Path::new("/Users/ana/Library/Logs/daedalus-agent/claude-rc.log"),
            &env,
        );
        assert!(p.contains(
            "<key>Label</key><string>me.toscanini.daedalus-agent.daedalus-claude-rc</string>"
        ));
        assert!(p.contains("<string>remote-control</string>"));
        assert!(p.contains("<key>WorkingDirectory</key><string>/Users/ana/p &amp; q</string>"));
        assert!(p.contains("<key>HOME</key><string>/Users/ana</string>"));
        assert!(p.contains("<key>KeepAlive</key><false/>"));
        assert!(p.contains("<key>RunAtLoad</key><true/>"));
        assert!(!p.bytes().any(|b| b < 0x20 && b != b'\n'));
        let name = format!("claude-session-{ID}");
        let line = macos_session_line(
            &SessionJob {
                name: &name,
                id: ID,
                cli: Path::new("/Users/ana/.local/bin/claude"),
                label: "Anas-MacBook",
                cwd: Path::new("/Users/ana/p"),
                log: Path::new("/l"),
                env: &[],
            },
            &tools(),
        )
        .unwrap();
        assert_eq!(
            line,
            format!(
                "e=$(printf '\\033'); b=$(printf '\\007'); '/usr/bin/script' -q /dev/null \
                 '/Users/ana/.local/bin/claude' --resume {ID} --remote-control Anas-MacBook \
                 | '/usr/bin/sed' -l -E \"s/${{e}}\\[[0-9;]*[A-Za-z]//g; s/${{e}}]8;;[^${{b}}]*${{b}}//g; /./!d\" \
                 | {{ '/usr/bin/grep' --line-buffered -Ev '^·|^[[:space:]]' || true; }}"
            )
        );
    }

    #[test]
    fn launchctl_print_and_list_read_as_job_states() {
        let running = "gui/501/me.toscanini.daedalus-agent.daedalus-claude-rc = {\n\
                       \tactive count = 1\n\tpath = /x.plist\n\tstate = running\n\n\
                       \tprogram = /bin/sh\n\targuments = {\n\t\tstate = nested\n\t\tpid = 1\n\t}\n\n\
                       \tworking directory = /Users/ana/p\n\tpid = 4242\n\
                       \tlast exit code = (never exited)\n}\n";
        let want = Some(JobState::Running {
            pid: Some(4242),
            age_secs: None,
            workdir: Some("/Users/ana/p".into()),
        });
        assert_eq!(parse_launchctl_print(running), want);
        // Another indentation (spaces, none at all) reads the same: the
        // service's level is found by its braces.
        let spaces = running.replace('\t', "    ");
        assert_eq!(parse_launchctl_print(&spaces), want);
        let flat = running.replace('\t', "");
        assert_eq!(parse_launchctl_print(&flat), want);
        // A pid alone says it runs, whatever `state` says.
        let pid_only = "x = {\n  state = waiting\n  pid = 77\n}\n";
        assert!(matches!(
            parse_launchctl_print(pid_only),
            Some(JobState::Running { pid: Some(77), .. })
        ));
        let exited = "x = {\n\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n}\n";
        assert_eq!(
            parse_launchctl_print(exited),
            Some(JobState::Exited("78".into()))
        );
        let killed =
            "x = {\n\tstate = not running\n\tlast terminating signal = Terminated: 15\n}\n";
        assert_eq!(
            parse_launchctl_print(killed),
            Some(JobState::Exited("signal".into()))
        );
        // Unreadable is unknown (None), never gone: a nested `state` does
        // not count, and neither does text that is no service at all.
        assert_eq!(parse_launchctl_print(""), None);
        assert_eq!(parse_launchctl_print("some new format\n"), None);
        assert_eq!(
            parse_launchctl_print("x = {\n  arguments = {\n    state = running\n  }\n}\n"),
            None
        );
        assert!(launchctl_says_gone(113, ""));
        assert!(launchctl_says_gone(
            1,
            "Could not find service \"x\" in domain for user gui: 501"
        ));
        assert!(!launchctl_says_gone(5, "Input/output error"));
        let list = "PID\tStatus\tLabel\n4242\t0\tme.toscanini.daedalus-agent.claude-session-a\n\
                    -\t0\tme.toscanini.daedalus-agent.claude-session-b\n\
                    17\t0\tcom.apple.x\n";
        assert_eq!(
            parse_launchctl_list(list, "me.toscanini.daedalus-agent.claude-session-"),
            ["me.toscanini.daedalus-agent.claude-session-a"]
        );
        assert_eq!(parse_etime("05:07"), Some(307));
        assert_eq!(parse_etime(" 1:00:00"), Some(3600));
        assert_eq!(parse_etime("2-00:00:01"), Some(172_801));
        assert_eq!(parse_etime("x"), None);
    }

    #[test]
    fn the_claude_a_job_runs_is_read_off_its_command_line() {
        let h = "/nix/store/406b184jzwfcj0gwscggw3p72l65qdyp-claude-code-2.1.281";
        // systemd's ExecStart, the server's and a resumed session's.
        let server = format!(
            "ExecStart={{ path={h}/bin/claude ; argv[]={h}/bin/claude remote-control --verbose ; ignore_errors=no }}"
        );
        assert_eq!(
            claude_in_command(&server),
            Some(PathBuf::from(format!("{h}/bin/claude")))
        );
        let session = format!(
            "ExecStart={{ path=/bin/sh ; argv[]=/bin/sh -c '/usr/bin/script' -qfec '\"{h}/bin/claude\" --resume x' /dev/null | '/usr/bin/sed' ; }}"
        );
        assert_eq!(
            claude_in_command(&session),
            Some(PathBuf::from(format!("{h}/bin/claude")))
        );
        // A launchd plist's arguments.
        let plist = "<string>/bin/sh</string>\n<string>'/usr/bin/script' -q /dev/null '/Users/a/.local/bin/claude' --resume x</string>";
        assert_eq!(
            claude_in_command(plist),
            Some(PathBuf::from("/Users/a/.local/bin/claude"))
        );
        assert_eq!(claude_in_command("/usr/bin/claudette run"), None);
        // The holder's copies: this version's is kept, the others swept.
        let names: Vec<String> = [
            "daedalus-agent-0.17.0.exe",
            "daedalus-agent-0.16.0.exe",
            "daedalus-agent-0.17.1.exe.new",
            "notes.txt",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(holder_file("0.17.0"), "daedalus-agent-0.17.0.exe");
        assert_eq!(
            stale_holders(&names, "0.17.0"),
            ["daedalus-agent-0.16.0.exe", "daedalus-agent-0.17.1.exe.new"]
        );
    }

    #[test]
    fn windows_words_are_quoted_and_shims_go_through_cmd() {
        assert_eq!(windows_quote("plain"), "plain");
        assert_eq!(
            windows_quote("C:\\Program Files\\x"),
            "\"C:\\Program Files\\x\""
        );
        assert_eq!(windows_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(windows_quote("end\\ "), "\"end\\ \"");
        assert_eq!(windows_quote("trail\\"), "trail\\");
        assert_eq!(windows_quote("sp trail\\"), "\"sp trail\\\\\"");
        assert_eq!(windows_quote(""), "\"\"");
        assert_eq!(
            windows_session_command("C:\\Users\\ana\\.local\\bin\\claude.exe", ID, "pc").unwrap(),
            format!("C:\\Users\\ana\\.local\\bin\\claude.exe --resume {ID} --remote-control pc")
        );
        assert_eq!(
            windows_session_command("C:\\Users\\a b\\npm\\claude.cmd", ID, "pc").unwrap(),
            format!(
                "cmd.exe /d /s /c \"\"C:\\Users\\a b\\npm\\claude.cmd\" --resume {ID} --remote-control pc\""
            )
        );
        assert!(windows_session_command("c.exe", "0a1b2c3d", "pc").is_err());
        assert!(windows_session_command("c.exe", ID, "a&b").is_err());
        let r = JobRecord {
            pid: 42,
            created: 133_000_000_000_000_000,
            workdir: "C:\\p".into(),
            started_at: "2026-09-28T00:00:00Z".into(),
        };
        let back: JobRecord = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn the_line_filter_strips_what_a_terminal_writes() {
        let mut f = LineFilter::default();
        let mut out = f.feed(b"\x1b[?25l\x1b[2J\x1b[HHello \x1b[1mworld\x1b[0m\r\n");
        out.extend(f.feed(b"\x1b]8;;https://x\x07link\x1b]8;;\x07 text\r\n"));
        out.extend(f.feed(b"\xc2\xb7 status box\r\n   indented\r\n\r\n"));
        out.extend(f.feed(b"\x1b]0;title\x1b\\tail with no end"));
        assert_eq!(out, ["Hello world", "link text"]);
        assert_eq!(f.finish(), ["tail with no end"]);
        // A character split across two reads is kept whole.
        let mut g = LineFilter::default();
        assert!(g.feed(&[b'a', 0xC3]).is_empty());
        assert_eq!(g.feed(&[0xA9, b'\n']), ["aé"]);
    }

    #[test]
    fn the_tail_reads_whole_lines_from_the_last_marker() {
        let dir = std::env::temp_dir().join(format!("daedalus-job-tail-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let log = dir.join("claude-rc.log");
        std::fs::write(
            &log,
            format!(
                "── t0 x {MARKER} in /a ──\nRemote Control v1.0.0\nold line\n\
                 ── t1 daedalus-agent session {MARKER} in /b (job u) ──\nRemote Control v2.1.0\r\nEnvironment ID: env_1\npart"
            ),
        )
        .unwrap();
        let mut t = LogTail::at_last_marker(log.clone());
        assert_eq!(
            t.read_new(),
            ["Remote Control v2.1.0", "Environment ID: env_1"]
        );
        assert!(t.read_new().is_empty());
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        write!(f, "ial\nnext\n").unwrap();
        assert_eq!(t.read_new(), ["partial", "next"]);
        // Truncated under it: from the start again.
        std::fs::write(&log, "fresh\n").unwrap();
        assert_eq!(t.read_new(), ["fresh"]);
        // A character split across two writes is read whole.
        let mut f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        f.write_all(&[b'a', 0xC3]).unwrap();
        assert!(t.read_new().is_empty());
        f.write_all(&[0xA9, b'\n']).unwrap();
        assert_eq!(t.read_new(), ["aé"]);
        // Bytes that are not UTF-8 before the marker do not move the offset.
        let mut raw = vec![0xFF, 0xFE, b'\n'];
        raw.extend_from_slice(format!("── t2 {MARKER} ──\nafter\n").as_bytes());
        std::fs::write(&log, &raw).unwrap();
        assert_eq!(LogTail::at_last_marker(log.clone()).read_new(), ["after"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
