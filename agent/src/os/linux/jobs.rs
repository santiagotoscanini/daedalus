//! Claude's jobs on Linux (and the controller): transient systemd user
//! units of the user's own manager (jobs/ has what they are and the
//! pure command lines). `systemd-run --user` starts one, `systemctl --user
//! show` watches it, `stop` ends its whole cgroup — the sessions the server
//! spawned with it — and `reset-failed` frees the name.

use std::process::Command;
use std::time::Duration;

use crate::exec;
use crate::jobs::{self, JobState, Jobs, ServerJob, SessionJob, Tools};
use crate::jobs::{Listed, UnitCost};

/// What the jobs are here, for the logs and the report.
pub const JOB_KIND: &str = "a transient systemd user unit";

/// `systemctl` answers at once; `stop` waits for the process to leave, which
/// the unit's own `TimeoutStopSec` bounds.
const SYSTEMCTL: Duration = Duration::from_secs(30);

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

fn service(name: &str) -> String {
    format!("{name}.service")
}

/// The server's unit, started.
fn start_server(j: &ServerJob) -> Result<(), String> {
    command("systemd-run", &jobs::systemd_server_args(j)).map(|_| ())
}

/// A resumed session's unit, started — `script` found first, since the
/// session needs its terminal.
fn start_session(j: &SessionJob) -> Result<(), String> {
    let tools = Tools::locate()?;
    let args = jobs::systemd_session_args(j, &tools)?;
    command("systemd-run", &args).map(|_| ())
}

/// The user manager's environment (`jobs::manager_env_value` reads it).
fn manager_env() -> String {
    systemctl(&["show-environment"]).unwrap_or_default()
}

/// The shell `script` hands the session, for its SHELL: the user manager's,
/// then the login shell passwd names, then any bash or zsh on this machine —
/// one Claude Code runs commands with (`jobs::runs_commands`). Never `sh`: on
/// NixOS that left every resumed session with "No suitable shell found".
fn session_shell() -> Option<std::path::PathBuf> {
    let manager = jobs::manager_env_value(&manager_env(), "SHELL").map(Into::into);
    let passwd = std::env::var_os("HOME").and_then(|h| {
        jobs::login_shell(
            &std::fs::read_to_string("/etc/passwd").ok()?,
            std::path::Path::new(&h),
        )
    });
    manager
        .into_iter()
        .chain(passwd)
        .filter(|s: &std::path::PathBuf| jobs::runs_commands(s) && s.is_file())
        .chain(["bash", "zsh"].into_iter().filter_map(exec::locate))
        .next()
}

/// The unit's state now.
fn show(name: &str) -> Result<JobState, String> {
    let text = systemctl(&["show", "-p", jobs::SYSTEMD_PROPS, &service(name)])?;
    Ok(jobs::parse_systemd_show(&text, super::monotonic_usec()))
}

/// End the job, if it runs.
fn stop(name: &str) -> Result<(), String> {
    systemctl(&["stop", &service(name)]).map(|_| ())
}

/// Stop it and clear the unit, so the name is free for the next start.
/// Stopping a unit that is not there is not an error here.
fn clear(name: &str) {
    let _ = stop(name);
    let _ = systemctl(&["reset-failed", &service(name)]);
}

/// The jobs starting with `prefix` that run now, each with its pid and
/// cost: one `systemctl show` over the pattern.
fn running(prefix: &str) -> Result<Vec<Listed>, String> {
    let pattern = format!("{prefix}*.service");
    let text = systemctl(&[
        "show",
        "-p",
        "Id,ActiveState,MainPID,MemoryCurrent,CPUUsageNSec",
        &pattern,
    ])?;
    Ok(crate::jobs::parse_systemd_units(&text, prefix))
}

/// A unit's memory and CPU from the user manager.
fn cost(name: &str) -> Option<UnitCost> {
    systemctl(&[
        "show",
        &service(name),
        "-p",
        "MemoryCurrent",
        "-p",
        "CPUUsageNSec",
    ])
    .ok()
    .map(|t| crate::jobs::parse_unit_cost(&t))
}

/// The environment a job gets besides the user manager's own (jobs/
/// `job_env`). The PATH a job's `--setenv` sets replaces the manager's, so
/// the manager's goes after the agent's: on the controller the agent's is
/// its unit's few store paths, and without the login's profile (NixOS's
/// `/run/current-system/sw/bin`, the per-user profile) a session has no
/// bash, git or ssh.
pub fn server_env(
    home: Option<&std::path::Path>,
    path: Option<&str>,
    config_dir: Option<&str>,
) -> Vec<(String, String)> {
    let manager = jobs::manager_env_value(&manager_env(), "PATH").unwrap_or_default();
    let extra: Vec<&str> = manager.split(':').filter(|d| !d.is_empty()).collect();
    jobs::job_env(home, path, config_dir, &extra)
}

/// The `claude` a running unit runs, from its ExecStart (what the session
/// pins when it re-attaches to a unit an earlier agent started).
fn running_cli(name: &str) -> Option<std::path::PathBuf> {
    let text = systemctl(&["show", "-p", "ExecStart", &service(name)]).ok()?;
    jobs::claude_in_command(&text)
}

/// The transient user units, as `Jobs`.
pub struct Os;

impl Jobs for Os {
    fn show(&self, name: &str) -> Result<JobState, String> {
        show(name)
    }
    fn start_server(&self, j: &ServerJob) -> Result<(), String> {
        start_server(j)
    }
    fn start_session(&self, j: &SessionJob) -> Result<(), String> {
        start_session(j)
    }
    fn stop(&self, name: &str) -> Result<(), String> {
        stop(name)
    }
    fn clear(&self, name: &str) {
        clear(name)
    }
    fn running(&self, prefix: &str) -> Result<Vec<Listed>, String> {
        running(prefix)
    }
    fn cost(&self, name: &str) -> Option<UnitCost> {
        cost(name)
    }
    fn running_cli(&self, name: &str) -> Option<std::path::PathBuf> {
        running_cli(name)
    }
    fn session_shell(&self) -> Option<std::path::PathBuf> {
        session_shell()
    }
}
