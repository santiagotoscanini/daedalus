//! Claude's jobs on Windows: processes started outside the tray, so the
//! tray can leave, update or crash and they run on (jobs/ has what
//! they are).
//!
//! Each starts with `CREATE_NO_WINDOW` (a hidden console its children
//! inherit, so a shell the server runs flashes no window),
//! `CREATE_NEW_PROCESS_GROUP` (no Ctrl-C of the tray's reaches it) and
//! `CREATE_BREAKAWAY_FROM_JOB` (outside any job object the tray was put in;
//! a job that forbids breaking away refuses it, and the start is tried
//! again without). Windows does not end a process with its parent, so that
//! is all "detached" takes.
//!
//! The session records each job — its pid and its creation time — in
//! `jobs\<name>.json` under its state directory (`paths::user_state_dir`,
//! `%LOCALAPPDATA%\daedalus-agent`). A later tray finds the process again
//! by that pair: a pid alone could be a later process that got the number.
//! While this tray is the one that started it, the process handle is kept,
//! so an exit code stays readable after the process leaves; a job found
//! after a restart that has gone reads as gone, its exit status unknown.
//! A stop is `taskkill /T /F`: the whole tree, the server's sessions with it.
//!
//! A resumed session needs a terminal: its job is this agent's own binary in
//! holder mode (`daedalus-agent claude-holder <command line>`, holder.rs),
//! which owns a pseudo-console, runs the CLI in it and writes what it shows
//! to the job's log.

use std::collections::HashMap;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, CREATE_BREAKAWAY_FROM_JOB,
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::jobs::UnitCost;
use crate::jobs::{self, JobRecord, JobState, ServerJob, SessionJob};
use crate::state::now_rfc3339;

pub const JOB_KIND: &str = "a process detached from the tray";

const STILL_ACTIVE: u32 = 259;
const ERROR_ACCESS_DENIED: i32 = 5;

/// The processes this tray started, kept so their exit codes stay readable.
fn spawned() -> &'static Mutex<HashMap<String, Child>> {
    static M: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn jobs_dir() -> PathBuf {
    crate::paths::user_state_dir().join("jobs")
}

fn record_path(name: &str) -> PathBuf {
    jobs_dir().join(format!("{name}.json"))
}

fn read_record(name: &str) -> Option<JobRecord> {
    let text = std::fs::read_to_string(record_path(name)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_record(name: &str, r: &JobRecord) -> Result<(), String> {
    let dir = jobs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = record_path(name);
    let text = serde_json::to_string(r).map_err(|e| e.to_string())?;
    crate::util::write_atomic(&path, text.as_bytes(), crate::util::Access::Inherit)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn filetime(f: FILETIME) -> u64 {
    (u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)
}

/// When a process was created, as a FILETIME.
fn created_of(h: HANDLE) -> Option<u64> {
    let (mut c, mut e, mut k, mut u) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    // SAFETY: four out-structs for a handle the caller holds open.
    unsafe { GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) }.ok()?;
    Some(filetime(c))
}

/// The recorded process, if it is still that one: its exit code, or
/// `STILL_ACTIVE` while it runs. None when it is gone or is another process.
fn probe(r: &JobRecord) -> Option<u32> {
    // SAFETY: a query handle, read and closed here.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, r.pid).ok()?;
        let same = created_of(h) == Some(r.created);
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code).is_ok();
        let _ = CloseHandle(h);
        (same && ok).then_some(code)
    }
}

/// What the report should say about a job beyond its state: one started
/// inside the tray's job object after all (`caveat`).
fn caveats() -> &'static Mutex<HashMap<String, String>> {
    static M: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Why a job that runs may not outlive the tray, when that is so.
pub fn caveat(name: &str) -> Option<String> {
    caveats().lock().ok()?.get(name).cloned()
}

/// End a process this tray just started and could not account for, so an
/// unrecorded job never runs on beside the next start.
fn abandon(mut child: Child, name: &str, why: String) -> String {
    let _ = child.kill();
    let _ = child.wait();
    tracing::error!(
        job = name,
        pid = child.id(),
        why,
        "a Claude job was ended: it could not be recorded"
    );
    format!("{name} was started and ended again: {why}")
}

fn spawn(
    name: &str,
    program: &Path,
    args: &[String],
    workdir: &Path,
    log: &Path,
    env: &[(String, String)],
) -> Result<(), String> {
    clear(name);
    let out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| format!("{}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(workdir)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    let detached = CREATE_NO_WINDOW.0 | CREATE_NEW_PROCESS_GROUP.0;
    cmd.creation_flags(detached | CREATE_BREAKAWAY_FROM_JOB.0);
    let mut in_tray_job = false;
    let child = match cmd.spawn() {
        Err(e) if e.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
            // In a job that forbids breaking away: started all the same,
            // and said, since it then ends if that job is closed.
            in_tray_job = true;
            cmd.creation_flags(detached);
            cmd.spawn()
        }
        other => other,
    }
    .map_err(|e| format!("{} was not started: {e}", program.display()))?;
    let Some(created) = created_of(HANDLE(child.as_raw_handle())) else {
        return Err(abandon(
            child,
            name,
            "its creation time could not be read, so no later tray could tell it from a reused pid"
                .into(),
        ));
    };
    let record = JobRecord {
        pid: child.id(),
        created,
        workdir: workdir.display().to_string(),
        started_at: now_rfc3339(),
    };
    if let Err(e) = write_record(name, &record) {
        return Err(abandon(
            child,
            name,
            format!(
                "its record {} was not written ({e}), so no later tray could find it",
                record_path(name).display()
            ),
        ));
    }
    if let Ok(mut c) = caveats().lock() {
        if in_tray_job {
            let note = "not broken away from the tray's job: the tray's job object forbids it, \
                        so this ends if that job is closed"
                .to_string();
            tracing::warn!(job = name, "{note}");
            c.insert(name.to_string(), note);
        } else {
            c.remove(name);
        }
    }
    if let Ok(mut m) = spawned().lock() {
        m.insert(name.to_string(), child);
    }
    Ok(())
}

pub fn start_server(j: &ServerJob) -> Result<(), String> {
    spawn(
        j.name,
        j.cli,
        &["remote-control".into(), "--verbose".into()],
        j.workdir,
        j.log,
        j.env,
    )
}

/// The holder: a copy of `daedalus-agent.exe` of this version in
/// `%LOCALAPPDATA%\daedalus-agent\holder\` (made on demand), never the
/// installed binary — a holder runs for as long as its session, and a
/// running exe cannot be deleted, so holding the installed one would stop
/// the next update from retiring it. Copies of other versions go when
/// nothing runs them any more (the delete fails while one does).
fn holder_exe() -> Result<PathBuf, String> {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = me.parent().map(Path::to_path_buf).unwrap_or_default();
    let installed = dir.join("daedalus-agent.exe");
    if !installed.is_file() {
        return Err(format!(
            "no {} to hold the session's terminal",
            installed.display()
        ));
    }
    let holders = crate::paths::user_state_dir().join("holder");
    std::fs::create_dir_all(&holders).map_err(|e| format!("{}: {e}", holders.display()))?;
    let copy = holders.join(jobs::holder_file(crate::VERSION));
    let same = |a: &Path, b: &Path| {
        let len = |p: &Path| std::fs::metadata(p).map(|m| m.len()).ok();
        len(a).is_some() && len(a) == len(b)
    };
    if !same(&copy, &installed) {
        let tmp = copy.with_extension("exe.new");
        std::fs::copy(&installed, &tmp)
            .and_then(|_| std::fs::rename(&tmp, &copy))
            .map_err(|e| format!("the holder {} was not made: {e}", copy.display()))?;
    }
    if let Ok(entries) = std::fs::read_dir(&holders) {
        let names: Vec<String> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        for stale in jobs::stale_holders(&names, crate::VERSION) {
            // In use by a session from before the update: it stays.
            let _ = std::fs::remove_file(holders.join(stale));
        }
    }
    Ok(copy)
}

/// `C:\Windows\system32`, as the OS names it (never `%PATH%` or the
/// working directory): where the `cmd.exe` that runs a `.cmd` shim is.
fn system_dir() -> Result<String, String> {
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    let mut buf = [0u16; 260];
    // SAFETY: the buffer and its length.
    let n = unsafe { GetSystemDirectoryW(Some(&mut buf)) } as usize;
    if n == 0 || n >= buf.len() {
        return Err("the system directory could not be read".into());
    }
    Ok(String::from_utf16_lossy(&buf[..n]))
}

pub fn start_session(j: &SessionJob) -> Result<(), String> {
    let cli = jobs::check_cli(j.cli)?;
    let line = jobs::windows_session_command(&system_dir()?, &cli, j.id, j.label)?;
    let holder = holder_exe()?;
    spawn(
        j.name,
        &holder,
        &["claude-holder".into(), line],
        j.cwd,
        j.log,
        j.env,
    )
}

/// `uninstall`: end every Claude job recorded under each user profile —
/// Remote Control and the sessions' holders — while it is still the
/// recorded process. Run as an administrator, which may read and end
/// them.
pub fn stop_every_users_jobs() {
    let Some(users) = std::env::var_os("SystemDrive")
        .map(|d| PathBuf::from(format!("{}\\Users", d.to_string_lossy())))
    else {
        return;
    };
    let Ok(profiles) = std::fs::read_dir(users) else {
        return;
    };
    for p in profiles.flatten() {
        let jobs = p
            .path()
            .join("AppData")
            .join("Local")
            .join(crate::SERVICE_NAME)
            .join("jobs");
        let Ok(entries) = std::fs::read_dir(&jobs) else {
            continue;
        };
        for e in entries.flatten() {
            let Some(r) = std::fs::read_to_string(e.path())
                .ok()
                .and_then(|t| serde_json::from_str::<JobRecord>(&t).ok())
            else {
                continue;
            };
            if kill_recorded(&r) {
                println!(
                    "stopped Claude job {} (pid {})",
                    e.file_name().to_string_lossy(),
                    r.pid
                );
            }
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// `script` has no counterpart here; the holder is the terminal.
pub fn session_shell() -> Option<PathBuf> {
    None
}

pub fn show(name: &str) -> Result<JobState, String> {
    // A process this tray started: its handle answers even after it left.
    if let Ok(mut m) = spawned().lock() {
        if let Some(child) = m.get_mut(name) {
            if let Ok(Some(status)) = child.try_wait() {
                return Ok(JobState::Exited(
                    status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "signal".into()),
                ));
            }
        }
    }
    let Some(r) = read_record(name) else {
        return Ok(JobState::Gone);
    };
    match probe(&r) {
        Some(STILL_ACTIVE) => {
            // SAFETY: returns the time by value.
            let now = filetime(unsafe { GetSystemTimeAsFileTime() });
            Ok(JobState::Running {
                pid: Some(r.pid),
                age_secs: Some(now.saturating_sub(r.created) / 10_000_000),
                workdir: Some(PathBuf::from(r.workdir)),
            })
        }
        Some(code) => Ok(JobState::Exited(code.to_string())),
        None => Ok(JobState::Gone),
    }
}

/// `taskkill /T /F` on the recorded process — only while it is still that
/// process — then a moment for it to leave.
/// `taskkill /T /F` on a recorded process — only while it is still that
/// process — then a moment for it to leave; whether it is gone.
fn kill_recorded(r: &JobRecord) -> bool {
    if probe(r) != Some(STILL_ACTIVE) {
        return true;
    }
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &r.pid.to_string(), "/T", "/F"]);
    let _ = crate::os::hide_console(&mut cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    for _ in 0..50 {
        if probe(r) != Some(STILL_ACTIVE) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

pub fn stop(name: &str) -> Result<(), String> {
    let Some(r) = read_record(name) else {
        return Ok(());
    };
    if kill_recorded(&r) {
        Ok(())
    } else {
        Err(format!("pid {} still runs after taskkill", r.pid))
    }
}

pub fn clear(name: &str) {
    let _ = stop(name);
    let _ = std::fs::remove_file(record_path(name));
    if let Ok(mut c) = caveats().lock() {
        c.remove(name);
    }
    if let Ok(mut m) = spawned().lock() {
        if let Some(mut c) = m.remove(name) {
            let _ = c.try_wait();
        }
    }
}

pub fn running(prefix: &str) -> Result<Vec<String>, String> {
    let Ok(entries) = std::fs::read_dir(jobs_dir()) else {
        return Ok(Vec::new());
    };
    Ok(entries
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.strip_suffix(".json")
                .filter(|s| s.starts_with(prefix))
                .map(str::to_string)
        })
        .filter(|n| show(n).is_ok_and(|s| s.running()))
        .collect())
}

/// No accounting of a detached process's memory and CPU is read here.
pub fn cost(name: &str) -> Option<UnitCost> {
    let _ = name;
    None
}

/// A job inherits the tray's environment, the user's; this adds Claude's
/// own switch, `.local\bin` on PATH and CLAUDE_CONFIG_DIR — never HOME,
/// which Git for Windows would then read instead of the profile.
pub fn server_env(
    home: Option<&Path>,
    path: Option<&str>,
    config_dir: Option<&str>,
) -> Vec<(String, String)> {
    jobs::job_env(home, path, config_dir, &[])
        .into_iter()
        .filter(|(k, _)| k != "HOME")
        .collect()
}

/// A `claude` on Windows is never a nix store path: nothing to pin.
pub fn running_cli(name: &str) -> Option<PathBuf> {
    let _ = name;
    None
}
