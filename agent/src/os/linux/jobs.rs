//! Claude's jobs on Linux (and the controller): transient systemd user
//! units of the user's own manager (jobs/ has what they are and the
//! pure command lines). `systemd-run --user` starts one, `systemctl --user
//! show` watches it, `stop` ends its whole cgroup — the sessions the server
//! spawned with it — and `reset-failed` frees the name.

use std::process::Command;
use std::time::Duration;

use crate::exec;
use crate::jobs::UnitCost;
use crate::jobs::{self, JobState, ServerJob, SessionJob, Tools};

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
pub fn start_server(j: &ServerJob) -> Result<(), String> {
    command("systemd-run", &jobs::systemd_server_args(j)).map(|_| ())
}

/// A resumed session's unit, started — `script` found first, since the
/// session needs its terminal.
pub fn start_session(j: &SessionJob) -> Result<(), String> {
    let tools = Tools::locate()?;
    let args = jobs::systemd_session_args(j, &tools)?;
    // A previous run that failed leaves the name taken.
    let _ = systemctl(&["reset-failed", &service(j.name)]);
    command("systemd-run", &args).map(|_| ())
}

/// The shell `script` hands the session, for its SHELL.
pub fn session_shell() -> Option<std::path::PathBuf> {
    exec::locate("sh")
}

/// The unit's state now.
pub fn show(name: &str) -> Result<JobState, String> {
    let text = systemctl(&["show", "-p", jobs::SYSTEMD_PROPS, &service(name)])?;
    Ok(jobs::parse_systemd_show(&text, super::monotonic_usec()))
}

/// End the job, if it runs.
pub fn stop(name: &str) -> Result<(), String> {
    systemctl(&["stop", &service(name)]).map(|_| ())
}

/// Stop it and clear the unit, so the name is free for the next start.
/// Stopping a unit that is not there is not an error here.
pub fn clear(name: &str) {
    let _ = stop(name);
    let _ = systemctl(&["reset-failed", &service(name)]);
}

/// The names of the jobs starting with `prefix` that run now.
pub fn running(prefix: &str) -> Result<Vec<String>, String> {
    let pattern = format!("{prefix}*.service");
    let text = systemctl(&[
        "list-units",
        "--type=service",
        "--all",
        "--no-legend",
        "--plain",
        &pattern,
    ])?;
    Ok(crate::jobs::parse_running_units(&text, prefix))
}

/// A unit's memory and CPU from the user manager.
pub fn cost(name: &str) -> Option<UnitCost> {
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
/// `job_env`).
pub fn server_env(
    home: Option<&std::path::Path>,
    path: Option<&str>,
    config_dir: Option<&str>,
) -> Vec<(String, String)> {
    jobs::job_env(home, path, config_dir, &[])
}

/// The `claude` a running unit runs, from its ExecStart (what the session
/// pins when it re-attaches to a unit an earlier agent started).
pub fn running_cli(name: &str) -> Option<std::path::PathBuf> {
    let text = systemctl(&["show", "-p", "ExecStart", &service(name)]).ok()?;
    jobs::claude_in_command(&text)
}

/// Nothing to add about a unit beyond its state.
pub fn caveat(name: &str) -> Option<String> {
    let _ = name;
    None
}
