//! The live sessions: their costs and whether one runs, from the session
//! files and the OS's process table.

use std::path::{Path, PathBuf};

use super::tree::mtime_ms;
use super::SessionStat;
use crate::claude::profile::SessionFile;

/// The live session files' costs: each file whose pid still runs the
/// process that wrote it (`procStart` against the OS's start time — a
/// recycled pid is not the session), with the bridge log beside it.
pub fn session_stats(files: &[SessionFile], bridge_dir: Option<&Path>) -> Vec<SessionStat> {
    let mut out = Vec::new();
    for f in files {
        let pid = f.pid;
        let Some(st) = crate::os::process_stats(pid) else {
            continue;
        };
        if f.proc_start
            .zip(st.start_ticks)
            .is_some_and(|(r, s)| r != s)
        {
            continue;
        }
        let remote = st.args.iter().find(|a| {
            a.starts_with("cse_") && a.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        });
        let log = remote
            .zip(bridge_dir)
            .map(|(r, d)| d.join(format!("bridge-session-{r}.log")))
            .and_then(|l| std::fs::metadata(l).ok());
        out.push(SessionStat {
            pid,
            cpu_ms: Some(st.cpu_ms),
            rss_bytes: Some(st.rss_bytes),
            log_bytes: log.as_ref().map(std::fs::Metadata::len),
            bridge_at: log.as_ref().map(mtime_ms),
        });
    }
    out.sort_by_key(|s| s.pid);
    out
}

/// A session process alive on `id` right now, from the session files
/// (resume's idempotence check): the pid runs, and — where the OS says
/// when a process started — it is still the one that wrote the file.
pub fn session_live(files: &[SessionFile], id: &str) -> bool {
    files
        .iter()
        .any(|f| f.session_id.as_deref() == Some(id) && f.alive())
}

/// Where the Remote Control bridge writes its per-session debug logs: the
/// CLI's `claude-<uid>` directory under the temporary directory, on unix.
pub fn bridge_dir() -> Option<PathBuf> {
    crate::os::own_uid().map(|uid| std::env::temp_dir().join(format!("claude-{uid}")))
}
