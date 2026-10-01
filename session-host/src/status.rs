//! `status.json`: what the controller reads about this host (README.md,
//! "Status file"). Nothing else ever talks to the host to ask.
//!
//! Written atomically (temp file in the same directory + rename, mode 0600) at
//! start, after every change at most once per [`MIN_INTERVAL`], at least once
//! per [`MAX_INTERVAL`] (so a stale file is recognisable by its age), and a
//! last time on shutdown with `"state": "stopped"` — which still names the
//! host key, so the controller can hand it out while the host is down.

use std::io::Write;
use std::net::SocketAddr;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use santree_remote_proto::PROTOCOL_VERSION;
use serde::Serialize;

use crate::allow::AllowList;
use crate::daemon::Daemon;
use crate::util::lock;

/// Never more often than this…
pub const MIN_INTERVAL: Duration = Duration::from_secs(1);
/// …and never less often than this.
pub const MAX_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    schema_version: u32,
    generated_at: String,
    state: &'static str,
    version: String,
    protocol: u32,
    boot_id: String,
    pid: u32,
    started_at: String,
    exe: Option<String>,
    config: Option<String>,
    host_key: String,
    listen: Vec<String>,
    allow_list: AllowListStatus,
    connections: Vec<Connection>,
    sessions: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AllowListStatus {
    /// The nodes the set in force admits.
    nodes: usize,
    /// Why the file on disk is not that set, when it is not (allow.rs).
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    node: String,
    peer: String,
    connected_at: String,
    client: Option<String>,
}

/// Where and what to write; one per `serve`.
pub struct StatusWriter {
    pub path: PathBuf,
    pub started_at: SystemTime,
    /// `/proc/self/exe` at start: the build this process runs, which the
    /// controller compares with the one installed.
    pub exe: Option<String>,
    /// The `--config` file this process was started with: nix writes each
    /// version to a new path, so the controller compares it with the
    /// installed one, as it does `exe`.
    pub config: Option<String>,
    pub host_key: String,
    pub listen: Vec<SocketAddr>,
    pub allow: Arc<AllowList>,
    pub daemon: Arc<Daemon>,
    /// One write at a time, and none after the final one: a periodic write
    /// still running when the host stops must neither tear the file (both
    /// use the same temp name) nor rename `running` over `stopped`.
    pub written: Mutex<Written>,
}

/// What [`StatusWriter::write`] serialises on.
#[derive(Default)]
pub struct Written {
    stopped: bool,
}

impl StatusWriter {
    fn render(&self, running: bool) -> Vec<u8> {
        let daemon = &self.daemon;
        let (connections, sessions) = if running {
            let connections = daemon
                .connections()
                .into_iter()
                .map(|c| Connection {
                    node: c.node,
                    peer: c.peer.to_string(),
                    connected_at: rfc3339(c.connected_at),
                    client: c.client,
                })
                .collect();
            (connections, daemon.live_sessions())
        } else {
            // Stopping: every session has been closed and the process is
            // about to take its connections with it.
            (Vec::new(), 0)
        };
        let status = Status {
            schema_version: 1,
            generated_at: rfc3339(SystemTime::now()),
            state: if running { "running" } else { "stopped" },
            version: daemon.options().version.clone(),
            protocol: PROTOCOL_VERSION,
            boot_id: daemon.boot_id().to_string(),
            pid: std::process::id(),
            started_at: rfc3339(self.started_at),
            exe: self.exe.clone(),
            config: self.config.clone(),
            host_key: self.host_key.clone(),
            listen: self.listen.iter().map(ToString::to_string).collect(),
            allow_list: AllowListStatus {
                nodes: self.allow.current().len(),
                error: self.allow.error(),
            },
            connections,
            sessions,
        };
        let mut bytes = serde_json::to_vec_pretty(&status).expect("status serializes");
        bytes.push(b'\n');
        bytes
    }

    /// Write one snapshot. `running = false` is the final one: nothing is
    /// written after it.
    pub fn write(&self, running: bool) -> std::io::Result<()> {
        let mut written = lock(&self.written);
        if written.stopped {
            return Ok(());
        }
        written.stopped = !running;
        write_atomic(&self.path, &self.render(running))
    }

    /// Write at start, after changes and at least every [`MAX_INTERVAL`].
    /// Runs until aborted.
    pub async fn run(self: Arc<Self>) {
        let mut failing = false;
        loop {
            let this = self.clone();
            let written = tokio::task::spawn_blocking(move || this.write(true))
                .await
                .unwrap_or_else(|e| Err(std::io::Error::other(e.to_string())));
            match written {
                Ok(()) if failing => {
                    log::info!("status file {} written again", self.path.display());
                    failing = false;
                }
                Ok(()) => {}
                Err(e) if !failing => {
                    log::warn!("status file {}: {e}", self.path.display());
                    failing = true;
                }
                Err(_) => {}
            }
            let last = tokio::time::Instant::now();
            tokio::select! {
                _ = self.daemon.changed() => {}
                _ = tokio::time::sleep(MAX_INTERVAL) => {}
            }
            tokio::time::sleep_until(last + MIN_INTERVAL).await;
        }
    }
}

/// Write `bytes` to `path` via a same-directory temp file and a rename, mode
/// 0600.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("status path has no file name"))?;
    let temp = dir.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id()
    ));
    let written = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temp)?;
        // A leftover temp file keeps its old mode through `open`.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

/// `YYYY-MM-DDTHH:MM:SSZ`, UTC.
pub fn rfc3339(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian
/// (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: u64) -> String {
        rfc3339(UNIX_EPOCH + Duration::from_secs(secs))
    }

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(at(1_790_000_000), "2026-09-21T14:13:20Z");
        assert_eq!(at(4_107_542_399), "2100-02-28T23:59:59Z");
    }

    #[test]
    fn atomic_writes_are_private() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        write_atomic(&path, b"{}\n").unwrap();
        write_atomic(&path, b"{\"a\":1}\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"a\":1}\n");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("status.json")]);
    }
}
