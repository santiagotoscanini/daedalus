//! Claude's jobs on macOS: launchd jobs in the user's `gui/<uid>` domain
//! (claude/job.rs has what they are and the pure plist and command line).
//!
//! The session writes each job's plist into its own state directory
//! (`jobs/<label>.plist` under `config::user_state_dir`) — never into
//! `~/Library/LaunchAgents`, so no login starts one — and bootstraps it:
//! `RunAtLoad` starts it at once, `KeepAlive` is off (the supervisor
//! decides what runs again), and a job that exited stays loaded with its
//! exit code until `bootout` clears it, as a unit's `RemainAfterExit` does
//! on Linux. `bootout` also ends the job's process group, the sessions the
//! server spawned with it. The menu bar app can leave, update or crash:
//! the jobs are launchd's, and the next one re-attaches to them by label.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::claude::job::{self, JobState, ServerJob, SessionJob, Tools};
use crate::claude::roster::UnitCost;
use crate::exec;

pub const JOB_KIND: &str = "a launchd job in the user's gui domain";

const LAUNCHCTL: Duration = Duration::from_secs(20);

fn uid() -> u32 {
    // SAFETY: no arguments.
    unsafe { libc::getuid() }
}

fn domain() -> String {
    format!("gui/{}", uid())
}

fn target(name: &str) -> String {
    format!("{}/{}", domain(), job::launchd_label(name))
}

fn launchctl(args: &[&str]) -> Result<(i32, String), String> {
    let mut cmd = Command::new("/bin/launchctl");
    cmd.args(args);
    exec::stdout_any(cmd, LAUNCHCTL, exec::Text::Lossy).map_err(|e| format!("launchctl: {e}"))
}

fn plist_path(name: &str) -> PathBuf {
    crate::config::user_state_dir()
        .join("jobs")
        .join(format!("{}.plist", job::launchd_label(name)))
}

/// Write the plist (0600 in a 0700 directory: it carries the environment)
/// and bootstrap it; whatever is loaded under the label goes first.
fn bootstrap(
    name: &str,
    program: &[String],
    workdir: &Path,
    log: &Path,
    env: &[(String, String)],
) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let path = plist_path(name);
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    let text = job::launchd_plist(&job::launchd_label(name), program, workdir, log, env);
    let tmp = path.with_extension("plist.new");
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("{}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    clear(name);
    let p = path.display().to_string();
    match launchctl(&["bootstrap", &domain(), &p])? {
        (0, _) => Ok(()),
        (code, out) => Err(format!(
            "launchctl bootstrap {} exited {code}: {}",
            domain(),
            out.trim()
        )),
    }
}

pub fn start_server(j: &ServerJob) -> Result<(), String> {
    let program = vec![
        j.cli.display().to_string(),
        "remote-control".into(),
        "--verbose".into(),
    ];
    bootstrap(j.name, &program, j.workdir, j.log, j.env)
}

pub fn start_session(j: &SessionJob) -> Result<(), String> {
    let tools = Tools::locate()?;
    let line = job::macos_session_line(j, &tools)?;
    let program = vec![tools.sh.display().to_string(), "-c".into(), line];
    bootstrap(j.name, &program, j.cwd, j.log, j.env)
}

/// The shell `script` hands the session, for its SHELL.
pub fn session_shell() -> Option<PathBuf> {
    Some(PathBuf::from("/bin/sh"))
}

/// How long the job's process has run: `ps -o etime=`.
fn age_of(pid: u32) -> Option<u64> {
    let mut cmd = Command::new("/bin/ps");
    cmd.args(["-o", "etime=", "-p", &pid.to_string()]);
    let out = exec::stdout_or(cmd, Duration::from_secs(5), exec::Text::Lossy).ok()?;
    job::parse_etime(&out)
}

pub fn show(name: &str) -> Result<JobState, String> {
    let (code, text) = launchctl(&["print", &target(name)])?;
    if code != 0 {
        // "Could not find service … in domain": not loaded.
        return Ok(JobState::Gone);
    }
    Ok(match job::parse_launchctl_print(&text) {
        JobState::Running {
            pid,
            age_secs: _,
            workdir,
        } => JobState::Running {
            pid,
            age_secs: pid.and_then(age_of),
            workdir,
        },
        other => other,
    })
}

/// `bootout`: SIGTERM to the job, its process group with it, then unloaded.
pub fn stop(name: &str) -> Result<(), String> {
    match launchctl(&["bootout", &target(name)])? {
        (0, _) => Ok(()),
        // Not loaded: nothing to stop.
        (_, _) if show(name) == Ok(JobState::Gone) => Ok(()),
        (code, out) => Err(format!("launchctl bootout exited {code}: {}", out.trim())),
    }
}

pub fn clear(name: &str) {
    let _ = launchctl(&["bootout", &target(name)]);
}

/// The jobs starting with `prefix` that have a process now (`launchctl
/// list` shows the caller's own domain).
pub fn running(prefix: &str) -> Result<Vec<String>, String> {
    let label_prefix = job::launchd_label(prefix);
    let (code, text) = launchctl(&["list"])?;
    if code != 0 {
        return Err(format!("launchctl list exited {code}"));
    }
    let strip = job::launchd_label("");
    Ok(job::parse_launchctl_list(&text, &label_prefix)
        .into_iter()
        .filter_map(|l| l.strip_prefix(&strip).map(str::to_string))
        .collect())
}

/// launchd keeps no accounting of a job's memory and CPU.
pub fn cost(name: &str) -> Option<UnitCost> {
    let _ = name;
    None
}

/// launchd hands a job the system's four directories as PATH: the
/// session's own goes along, with Homebrew's two prefixes after it — the
/// server spawns git and shells from wherever the user installed them.
pub fn server_env(
    home: Option<&Path>,
    path: Option<&str>,
    config_dir: Option<&str>,
) -> Vec<(String, String)> {
    job::job_env(
        home,
        path,
        config_dir,
        &["/opt/homebrew/bin", "/usr/local/bin"],
    )
}
