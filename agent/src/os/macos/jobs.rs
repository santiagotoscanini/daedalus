//! Claude's jobs on macOS: launchd jobs in the user's `gui/<uid>` domain
//! (jobs/ has what they are and the pure plist and command line).
//!
//! The session writes each job's plist into its own state directory
//! (`jobs/<label>.plist` under `paths::user_state_dir`) — never into
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

use crate::exec;
use crate::jobs::{self, JobState, Jobs, ServerJob, SessionJob, Tools};
use crate::jobs::{Listed, UnitCost};

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
    format!("{}/{}", domain(), jobs::launchd_label(name))
}

/// launchctl's exit code, its stdout, and the first line of its stderr
/// (where "Could not find service" is said).
fn launchctl(args: &[&str]) -> Result<(i32, String), String> {
    let mut cmd = Command::new("/bin/launchctl");
    cmd.args(args);
    exec::stdout_with_status(cmd, LAUNCHCTL, exec::Text::Lossy)
        .map(|(code, out, err)| (code, format!("{out}\n{err}")))
        .map_err(|e| format!("launchctl: {e}"))
}

fn plist_path(name: &str) -> PathBuf {
    crate::core::paths::user_state_dir()
        .join("jobs")
        .join(format!("{}.plist", jobs::launchd_label(name)))
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
    use std::os::unix::fs::PermissionsExt;
    let path = plist_path(name);
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    let text = jobs::launchd_plist(&jobs::launchd_label(name), program, workdir, log, env);
    crate::util::write_atomic(&path, text.as_bytes(), crate::util::Access::Mode(0o600))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    clear(name);
    // bootout returns before launchd has let the label go; a bootstrap
    // under it meanwhile fails ("service already loaded").
    wait_gone(name)?;
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

fn start_server(j: &ServerJob) -> Result<(), String> {
    let program = vec![
        j.cli.display().to_string(),
        "remote-control".into(),
        "--verbose".into(),
    ];
    bootstrap(j.name, &program, j.workdir, j.log, j.env)
}

fn start_session(j: &SessionJob) -> Result<(), String> {
    let tools = Tools::locate()?;
    let line = jobs::macos_session_line(j, &tools)?;
    let program = vec![tools.sh.display().to_string(), "-c".into(), line];
    bootstrap(j.name, &program, j.cwd, j.log, j.env)
}

/// The shell `script` hands the session, for its SHELL: the account's login
/// shell when Claude Code runs commands with it (`jobs::runs_commands`),
/// zsh — every Mac's default — when not. Never `sh`, which Claude Code
/// does not run commands with.
fn session_shell() -> Option<PathBuf> {
    let login =
        super::super::unix::login_shell(uid()).filter(|s| jobs::runs_commands(s) && s.is_file());
    Some(login.unwrap_or_else(|| PathBuf::from("/bin/zsh")))
}

/// How long the job's process has run, from its start in the kernel's
/// table (libproc; no `ps`).
fn age_of(pid: u32) -> Option<u64> {
    let info = super::pidinfo::<libc::proc_bsdinfo>(pid, libc::PROC_PIDTBSDINFO)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(now.saturating_sub(info.pbi_start_tvsec))
}

fn show(name: &str) -> Result<JobState, String> {
    let (code, text) = launchctl(&["print", &target(name)])?;
    if code != 0 {
        // Only launchd's "no such service" is gone; any other failure is
        // not knowing, which the supervisor never takes for gone.
        if jobs::launchctl_says_gone(code, &text) {
            return Ok(JobState::Gone);
        }
        return Err(format!(
            "launchctl print {} exited {code}: {}",
            target(name),
            text.trim()
        ));
    }
    match jobs::parse_launchctl_print(&text) {
        Some(JobState::Running { pid, workdir, .. }) => Ok(JobState::Running {
            pid,
            age_secs: pid.and_then(age_of),
            workdir,
        }),
        Some(other) => Ok(other),
        None => Err(format!(
            "launchctl print {} answered in a form this agent does not read",
            target(name)
        )),
    }
}

/// Until launchd says the label is gone, at most five seconds.
fn wait_gone(name: &str) -> Result<(), String> {
    let until = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if matches!(show(name), Ok(JobState::Gone)) {
            return Ok(());
        }
        if std::time::Instant::now() > until {
            return Err(format!(
                "{} is still loaded five seconds after its bootout",
                target(name)
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// `bootout`: SIGTERM to the job, its process group with it, then unloaded.
fn stop(name: &str) -> Result<(), String> {
    match launchctl(&["bootout", &target(name)])? {
        (0, _) => wait_gone(name),
        // Not loaded: nothing to stop.
        (code, out) if jobs::launchctl_says_gone(code, &out) => Ok(()),
        (code, out) => Err(format!("launchctl bootout exited {code}: {}", out.trim())),
    }
}

fn clear(name: &str) {
    let _ = stop(name);
}

/// The jobs starting with `prefix` that have a process now, with its pid
/// (`launchctl list` shows the caller's own domain); launchd keeps no cost.
fn running(prefix: &str) -> Result<Vec<Listed>, String> {
    let label_prefix = jobs::launchd_label(prefix);
    let (code, text) = launchctl(&["list"])?;
    if code != 0 {
        return Err(format!("launchctl list exited {code}"));
    }
    let strip = jobs::launchd_label("");
    Ok(jobs::parse_launchctl_list(&text, &label_prefix)
        .into_iter()
        .filter_map(|(label, pid)| {
            Some(Listed {
                name: label.strip_prefix(&strip)?.to_string(),
                pid: Some(pid),
                cost: UnitCost::default(),
            })
        })
        .collect())
}

/// launchd hands a job the system's four directories as PATH: the
/// session's own goes along, with Homebrew's two prefixes after it — the
/// server spawns git and shells from wherever the user installed them.
pub fn server_env(
    home: Option<&Path>,
    path: Option<&str>,
    config_dir: Option<&str>,
) -> Vec<(String, String)> {
    jobs::job_env(
        home,
        path,
        config_dir,
        &["/opt/homebrew/bin", "/usr/local/bin"],
    )
}

/// The `claude` a job runs, from the plist it was bootstrapped from.
fn running_cli(name: &str) -> Option<PathBuf> {
    jobs::claude_in_command(&std::fs::read_to_string(plist_path(name)).ok()?)
}

/// The launchd jobs, as `Jobs`. launchd keeps no accounting of a job's
/// memory and CPU.
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
    fn running_cli(&self, name: &str) -> Option<PathBuf> {
        running_cli(name)
    }
    fn session_shell(&self) -> Option<PathBuf> {
        session_shell()
    }
}
