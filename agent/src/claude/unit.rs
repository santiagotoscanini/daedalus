//! How the supervisor runs the server: as its own child, or as a transient
//! systemd user unit (config.toml's `claude_rc`; the OS decides when it is
//! absent — `os::CLAUDE_RC`).
//!
//! A child ends with the session. A unit does not: the session starts it
//! with `systemd-run --user`, watches it with `systemctl --user show`,
//! stops it with `systemctl --user stop`, and when the session itself
//! restarts — an agent update, a crash — it finds the unit still running
//! and re-attaches (`Supervisor::new`). So an update never ends a Claude
//! session on a machine whose server is a unit (Linux, and the controller).
//!
//! The unit keeps its exit status (`RemainAfterExit=yes`) until the session
//! has read it and clears it before the next start; `--collect` would
//! unload a failed run before anyone saw why. Its output is appended by
//! systemd to the same `claude-rc.log` a child's goes to, which the report's
//! `log` names; the session reads the banner and the recent lines back from
//! that file (`LogTail`), from the marker line it writes before each start.
//!
//! The command lines and the `show` output are pure and tested on every OS;
//! the calls go through exec.rs with deadlines.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::config::ClaudeRc;
use crate::exec;

/// How this session runs the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Launch {
    /// A child process of the session.
    Child,
    /// A transient systemd user unit of this name (without `.service`).
    Unit(String),
}

impl Launch {
    /// From config.toml: `claude_rc` (defaulted to the OS's), with the unit
    /// `Config::claude_unit` names — the controller's own when nix sets
    /// one, else `config::claude_unit_name`.
    pub fn of(cfg: &crate::config::Config) -> Self {
        match cfg.claude_rc() {
            ClaudeRc::Child => Launch::Child,
            ClaudeRc::Unit => Launch::Unit(cfg.claude_unit()),
        }
    }
}

/// `systemctl` answers at once; `stop` waits for the server to leave, which
/// the unit's own `TimeoutStopSec` bounds.
const SYSTEMCTL: Duration = Duration::from_secs(30);

/// What the log's marker line says before each start; `LogTail::at_last_marker`
/// finds it again.
pub const MARKER: &str = "starting `claude remote-control --verbose`";

/// The unit, as `systemctl --user show` reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnitState {
    /// Starting, running or stopping, with its main pid when it has one,
    /// how long ago it started, and where.
    Running {
        pid: Option<u32>,
        age_secs: Option<u64>,
        workdir: Option<PathBuf>,
    },
    /// The server exited; the unit remains with its status: "N" for an
    /// exit code, "signal" for a kill.
    Exited(String),
    /// No such unit (never started, or cleared).
    Gone,
}

/// The properties `show` is asked for — every one of them in systemd 240,
/// the oldest this supports. The start time is the monotonic stamp, in
/// microseconds, compared with CLOCK_MONOTONIC (`os::monotonic_usec`):
/// `--timestamp=unix` would need systemd 251.
const PROPS: &str = "LoadState,ActiveState,SubState,MainPID,ExecMainCode,ExecMainStatus,\
                     ExecMainStartTimestampMonotonic,WorkingDirectory";

/// `systemctl --user show -p …`: `Key=value` lines. `now_mono_usec`, the
/// monotonic clock now, turns the start stamp into an age.
pub fn parse_show(text: &str, now_mono_usec: Option<u64>) -> UnitState {
    let get = |k: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(k).and_then(|r| r.strip_prefix('=')))
            .map(str::trim)
            .unwrap_or("")
    };
    if get("LoadState") == "not-found" {
        return UnitState::Gone;
    }
    let active = get("ActiveState");
    let sub = get("SubState");
    let exited = active == "failed" || (active == "active" && sub == "exited");
    if exited {
        // ExecMainCode is the waitid code: 1 exited, 2 killed, 3 dumped.
        return UnitState::Exited(match get("ExecMainCode") {
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
        return UnitState::Running {
            pid,
            age_secs,
            workdir,
        };
    }
    UnitState::Gone
}

/// The environment the unit gets besides the user manager's own: the
/// session's PATH with `~/.local/bin` first (the manager's PATH is the
/// system's), its HOME and CLAUDE_CONFIG_DIR — the profile the session
/// reads is the one the server uses — and Claude's own package-manager
/// auto-update switch (supervisor.rs `build_command` says why).
pub fn unit_env(
    home: Option<&Path>,
    path: Option<&str>,
    config_dir: Option<&str>,
) -> Vec<(String, String)> {
    let mut env = vec![(
        "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE".to_string(),
        "1".to_string(),
    )];
    if let Some(h) = home {
        env.push(("HOME".into(), h.display().to_string()));
    }
    let local = home.map(|h| h.join(".local/bin").display().to_string());
    let path = match (local, path.filter(|p| !p.is_empty())) {
        (Some(l), Some(p)) => format!("{l}:{p}"),
        (Some(l), None) => l,
        (None, Some(p)) => p.to_string(),
        (None, None) => String::new(),
    };
    if !path.is_empty() {
        env.push(("PATH".into(), path));
    }
    if let Some(d) = config_dir.filter(|d| !d.is_empty()) {
        env.push(("CLAUDE_CONFIG_DIR".into(), d.to_string()));
    }
    env
}

/// `systemd-run`'s arguments for one start.
pub fn run_args(
    unit: &str,
    cli: &Path,
    workdir: &Path,
    log: &Path,
    env: &[(String, String)],
) -> Vec<String> {
    let mut a = vec![
        "--user".to_string(),
        format!("--unit={unit}"),
        "--description=Claude Code remote control (daedalus-agent)".into(),
        "--property=RemainAfterExit=yes".into(),
        "--property=TimeoutStopSec=15".into(),
        format!("--property=StandardOutput=append:{}", log.display()),
        format!("--property=StandardError=append:{}", log.display()),
        format!("--working-directory={}", workdir.display()),
    ];
    a.extend(env.iter().map(|(k, v)| format!("--setenv={k}={v}")));
    a.push("--".into());
    a.push(cli.display().to_string());
    a.push("remote-control".into());
    a.push("--verbose".into());
    a
}

fn command(tool: &str, args: &[String]) -> Result<String, String> {
    let path = exec::locate(tool).ok_or_else(|| format!("no `{tool}` on this machine"))?;
    let mut cmd = Command::new(path);
    cmd.args(args).env("SYSTEMD_PAGER", "");
    exec::stdout_or(cmd, SYSTEMCTL, exec::Text::Lossy).map_err(|e| format!("{tool}: {e}"))
}

fn systemctl(args: &[&str]) -> Result<String, String> {
    let mut a = vec!["--user".to_string()];
    a.extend(args.iter().map(|s| s.to_string()));
    command("systemctl", &a)
}

/// Start the unit.
pub fn start(
    unit: &str,
    cli: &Path,
    workdir: &Path,
    log: &Path,
    env: &[(String, String)],
) -> Result<(), String> {
    command("systemd-run", &run_args(unit, cli, workdir, log, env)).map(|_| ())
}

/// The unit's state now.
pub fn show(unit: &str) -> Result<UnitState, String> {
    let name = format!("{unit}.service");
    let text = systemctl(&["show", "-p", PROPS, &name])?;
    Ok(parse_show(&text, crate::os::monotonic_usec()))
}

/// Stop the server and clear the unit, so the name is free for the next
/// start. Stopping a unit that is not there is not an error here.
pub fn clear(unit: &str) {
    let name = format!("{unit}.service");
    let _ = systemctl(&["stop", &name]);
    let _ = systemctl(&["reset-failed", &name]);
}

/// The server's output as systemd appends it to the log: whatever arrived
/// since the last look, as whole lines.
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
            .map(|l| String::from_utf8_lossy(l).into_owned())
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

    #[test]
    fn show_reads_running_exited_and_gone() {
        let running = "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\n\
                       ExecMainCode=0\nExecMainStatus=0\nExecMainStartTimestampMonotonic=1000000\n\
                       WorkingDirectory=/home/ana/projects/x\n";
        assert_eq!(
            parse_show(running, Some(91_000_000)),
            UnitState::Running {
                pid: Some(4242),
                age_secs: Some(90),
                workdir: Some(PathBuf::from("/home/ana/projects/x"))
            }
        );
        let exited = "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\n\
                      ExecMainCode=1\nExecMainStatus=3\n";
        assert_eq!(parse_show(exited, None), UnitState::Exited("3".into()));
        let clean = "LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\n\
                     ExecMainCode=1\nExecMainStatus=0\n";
        assert_eq!(parse_show(clean, None), UnitState::Exited("0".into()));
        let killed = "LoadState=loaded\nActiveState=failed\nSubState=failed\nExecMainCode=2\nExecMainStatus=9\n";
        assert_eq!(parse_show(killed, None), UnitState::Exited("signal".into()));
        let starting = "LoadState=loaded\nActiveState=activating\nSubState=start\nMainPID=0\n\
                        ExecMainStartTimestampMonotonic=0\nWorkingDirectory=\n";
        assert_eq!(
            parse_show(starting, Some(5)),
            UnitState::Running {
                pid: None,
                age_secs: None,
                workdir: None
            }
        );
        assert_eq!(
            parse_show("LoadState=not-found\nActiveState=inactive\n", None),
            UnitState::Gone
        );
        assert_eq!(
            parse_show(
                "LoadState=loaded\nActiveState=inactive\nSubState=dead\n",
                None
            ),
            UnitState::Gone
        );
    }

    // Unix paths: the unit exists only where systemd does.
    #[cfg(unix)]
    #[test]
    fn systemd_run_gets_the_unit_the_log_and_the_environment() {
        let env = unit_env(Some(Path::new("/home/ana")), Some("/usr/bin:/bin"), None);
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
        let a = run_args(
            "daedalus-claude-rc",
            Path::new("/home/ana/.local/bin/claude"),
            Path::new("/home/ana/p"),
            Path::new("/home/ana/.local/state/daedalus-agent/claude-rc.log"),
            &env,
        );
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
        let with_dir = unit_env(None, None, Some("/srv/claude"));
        assert_eq!(with_dir.last().unwrap().0, "CLAUDE_CONFIG_DIR");
    }

    #[test]
    fn the_tail_reads_whole_lines_from_the_last_marker() {
        let dir = std::env::temp_dir().join(format!("daedalus-unit-tail-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let log = dir.join("claude-rc.log");
        std::fs::write(
            &log,
            format!(
                "── t0 x {MARKER} in /a ──\nRemote Control v1.0.0\nold line\n\
                 ── t1 daedalus-agent session {MARKER} in /b (unit u) ──\nRemote Control v2.1.0\nEnvironment ID: env_1\npart"
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
        let child = crate::config::Config {
            claude_rc: Some(ClaudeRc::Child),
            ..Default::default()
        };
        assert_eq!(Launch::of(&child), Launch::Child);
    }
}
