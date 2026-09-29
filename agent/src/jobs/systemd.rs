//! systemd (Linux, the controller): a transient user unit per job.

use std::path::{Path, PathBuf};

use super::*;

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
