//! launchd (macOS): a job in the user's `gui/<uid>` domain per job.

use std::path::{Path, PathBuf};

use super::*;

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
/// `prefix` and have a process now, with its pid.
pub fn parse_launchctl_list(text: &str, prefix: &str) -> Vec<(String, u32)> {
    text.lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let (pid, _status, label) = (f.next()?, f.next()?, f.next()?.trim());
            let pid = pid.trim().parse::<u32>().ok()?;
            label.starts_with(prefix).then(|| (label.to_string(), pid))
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
