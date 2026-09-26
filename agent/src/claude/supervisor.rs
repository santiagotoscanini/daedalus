//! The supervisor: one `claude remote-control` kept running while the box
//! wants it, restarted with backoff, its output logged and its banner
//! read, and the report the tray sends the service.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::cli::{cli_version, find_cli, hidden, install_method, last_meaningful, run};
#[cfg(target_os = "macos")]
use super::profile::home_dir;
use super::profile::{claude_dir, read_credentials, read_sessions, read_settings};
use super::workdir::pick_workdir;
use super::{Banner, Credentials, Report, Settings, UpdateResult};
use crate::state::now_rfc3339;

/// A run shorter than this counts as a failure and grows the backoff.
const QUICK_EXIT: Duration = Duration::from_secs(60);
/// The backoff ladder's ceiling.
const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);
/// The server log is rotated once when it passes this, at the next start.
const LOG_ROTATE_BYTES: u64 = 20 * 1024 * 1024;

struct Running {
    child: Child,
    since: Instant,
    started_at: String,
    banner: Arc<Mutex<Banner>>,
}

/// Keeps one `claude remote-control` running while it is wanted.
///
/// Driven by `tick` from the tray's loop: it reaps an exit, waits out the
/// backoff, and starts the next one. Nothing blocks — the tray's message
/// pump is on the same thread.
pub struct Supervisor {
    cli: Option<PathBuf>,
    cli_version: Option<String>,
    /// The directory the policy names; None means pick one.
    named_workdir: Option<String>,
    /// What the running (or next) server uses, and how it was chosen.
    workdir: PathBuf,
    workdir_via: &'static str,
    log_path: PathBuf,
    wanted: bool,
    running: Option<Running>,
    /// Kept from the last run, so the page still names the environment a
    /// moment after an exit.
    last_banner: Banner,
    restarts: u32,
    failures: u32,
    next_start: Option<Instant>,
    last_exit: Option<String>,
    recent_lines: Arc<Mutex<VecDeque<String>>>,
    /// What the last `claude update` did, kept for the report.
    last_update: Option<UpdateResult>,
    /// An update is running on its own thread right now.
    updating: bool,
    /// Where that thread leaves its result for `tick` to collect.
    update_slot: Arc<Mutex<Option<UpdateResult>>>,
}

impl Supervisor {
    pub fn new(named_workdir: Option<String>, log_path: PathBuf, wanted: bool) -> Self {
        let cli = find_cli();
        let cli_version = cli.as_deref().and_then(cli_version);
        let (workdir, workdir_via) = pick_workdir(named_workdir.as_deref());
        Self {
            cli,
            cli_version,
            named_workdir,
            workdir,
            workdir_via,
            log_path,
            wanted,
            running: None,
            last_banner: Banner::default(),
            restarts: 0,
            failures: 0,
            next_start: None,
            last_exit: None,
            recent_lines: Arc::new(Mutex::new(VecDeque::new())),
            last_update: None,
            updating: false,
            update_slot: Arc::new(Mutex::new(None)),
        }
    }

    pub fn wanted(&self) -> bool {
        self.wanted
    }

    /// Look for the command again — for a machine where Claude Code was
    /// installed after the tray came up.
    pub fn rescan(&mut self) {
        if self.cli.is_none() {
            self.cli = find_cli();
            self.cli_version = self.cli.as_deref().and_then(cli_version);
        }
    }

    pub fn set_wanted(&mut self, wanted: bool) {
        if wanted == self.wanted {
            return;
        }
        self.wanted = wanted;
        if !wanted {
            self.stop("not wanted");
        } else {
            self.failures = 0;
            self.next_start = Some(Instant::now());
        }
    }

    /// The directory the box names. A change restarts the
    /// server there; None goes back to picking the most recent trusted
    /// project.
    pub fn set_named_workdir(&mut self, named: Option<String>) {
        let named = named
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if named == self.named_workdir {
            return;
        }
        self.named_workdir = named;
        let (dir, via) = pick_workdir(self.named_workdir.as_deref());
        if dir != self.workdir {
            self.workdir = dir;
            self.workdir_via = via;
            if self.running.is_some() {
                self.restart();
            }
        }
    }

    /// Stop and start again now, forgetting any backoff.
    pub fn restart(&mut self) {
        self.stop("restart asked");
        self.failures = 0;
        self.next_start = Some(Instant::now());
    }

    /// Update Claude Code on this machine, and record what happened.
    ///
    /// Nothing is stopped; the server keeps the binary it has until
    /// `restart` moves it (the module doc, claude/mod.rs, says why the two
    /// are separate).
    ///
    /// `claude update` for every install: it is the supported verb for a
    /// native or npm one, and for a package-manager one it is a documented
    /// no-op that reports "Claude is up to date!" rather than doing
    /// something surprising. Those upgrade themselves through
    /// CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE, which `start` sets on the
    /// server. Run as the tray, i.e. the logged-in user, which is right for
    /// a per-user install and is all the privilege there is here — a
    /// machine-wide install under an administrator's path is the case this
    /// cannot serve, and the report's install_method is what says so.
    ///
    /// Ten minutes, because this downloads ~80 MB over whatever line the
    /// machine has. Slow is not stuck; a hung process is killed at the end
    /// of it and reported as one.
    ///
    /// ON ITS OWN THREAD, and that is not an optimisation. This is called
    /// from the tray's loop, the only thing that reports to the service,
    /// restarts the server and drains the menu. Running the download inline
    /// would freeze all of it for up to ten minutes — the service would see
    /// the tray stop reporting and the box would say "nobody logged on",
    /// the opposite of what just happened. `tick` collects the result
    /// through `update_slot`.
    pub fn update_claude(&mut self) {
        if self.updating {
            tracing::info!("a claude update is already running; ignoring the request");
            return;
        }
        let Some(cli) = self.cli.clone() else {
            self.last_update = Some(UpdateResult {
                at: now_rfc3339(),
                ok: false,
                from: None,
                to: None,
                detail: "no `claude` command on this machine to update".into(),
            });
            return;
        };
        let before = self.cli_version.clone();
        let slot = Arc::clone(&self.update_slot);
        self.updating = true;
        std::thread::spawn(move || {
            let mut cmd = Command::new(&cli);
            cmd.arg("update");
            let ran = run(cmd, Duration::from_secs(600));
            // Re-probed either way: an update that reported failure may
            // still have moved the binary, and the version on disk is the
            // fact — not the command's account of itself.
            let after = cli_version(&cli);
            let result = match ran {
                Some(r) => UpdateResult {
                    at: now_rfc3339(),
                    ok: r.ok,
                    from: before,
                    to: after,
                    detail: last_meaningful(&r.output),
                },
                None => UpdateResult {
                    at: now_rfc3339(),
                    ok: false,
                    from: before,
                    to: after,
                    detail: "`claude update` did not finish within ten minutes and was killed"
                        .into(),
                },
            };
            tracing::info!(detail = %result.detail, ok = result.ok, "claude update finished");
            if let Ok(mut s) = slot.lock() {
                *s = Some(result);
            }
        });
    }

    /// Take a finished update off the slot, if one landed since the last
    /// tick. Called from `tick`; cheap and lock-free in the common case.
    fn collect_update(&mut self) {
        if !self.updating {
            return;
        }
        let done = self.update_slot.lock().ok().and_then(|mut s| s.take());
        if let Some(r) = done {
            self.cli_version = r.to.clone();
            self.last_update = Some(r);
            self.updating = false;
        }
    }

    /// Advance: reap, wait, start. Cheap; call it often.
    pub fn tick(&mut self) {
        self.collect_update();
        if let Some(r) = self.running.as_mut() {
            match r.child.try_wait() {
                Ok(Some(status)) => {
                    let ran = r.since.elapsed();
                    self.last_banner = r.banner.lock().map(|b| b.clone()).unwrap_or_default();
                    self.running = None;
                    let code = status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "signal".into());
                    self.last_exit = Some(format!(
                        "exit {code} after {} at {}",
                        short_duration(ran),
                        now_rfc3339()
                    ));
                    if ran < QUICK_EXIT {
                        self.failures = self.failures.saturating_add(1);
                    } else {
                        self.failures = 0;
                    }
                    if self.wanted {
                        self.next_start = Some(Instant::now() + self.backoff());
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    self.last_exit = Some(format!("lost: {e}"));
                    self.running = None;
                    if self.wanted {
                        self.next_start = Some(Instant::now() + self.backoff());
                    }
                }
            }
        }
        if self.running.is_none() && self.wanted {
            if let Some(at) = self.next_start {
                if Instant::now() >= at {
                    self.next_start = None;
                    self.start();
                }
            } else if self.restarts == 0 && self.last_exit.is_none() {
                // First tick: start at once.
                self.start();
            }
        }
    }

    fn backoff(&self) -> Duration {
        if self.failures == 0 {
            return Duration::from_secs(2);
        }
        let secs = 5u64.saturating_mul(1u64 << self.failures.min(10));
        Duration::from_secs(secs).min(MAX_BACKOFF)
    }

    fn start(&mut self) {
        if self.cli.is_none() {
            self.rescan();
        }
        let Some(cli) = self.cli.clone() else {
            // Look again in a minute, not on every tick.
            self.next_start = Some(Instant::now() + Duration::from_secs(60));
            return;
        };
        // A trust accepted since the last look is honoured on the next start.
        let (dir, via) = pick_workdir(self.named_workdir.as_deref());
        self.workdir = dir;
        self.workdir_via = via;
        let log = match open_log(&self.log_path) {
            Ok(f) => f,
            Err(e) => {
                self.last_exit = Some(format!("log not opened: {e}"));
                self.next_start = Some(Instant::now() + MAX_BACKOFF);
                return;
            }
        };
        let log = Arc::new(Mutex::new(log));
        {
            let mut f = log.lock().unwrap_or_else(|p| p.into_inner());
            let _ = writeln!(
                f,
                "── {} daedalus-agent-tray starting `claude remote-control --verbose` in {} ──",
                now_rfc3339(),
                self.workdir.display()
            );
        }
        let mut cmd = self.build_command(&cli);
        let Some(mut child) = self.spawn(&mut cmd) else {
            return;
        };
        let banner = self.attach_log_and_banner(&mut child, &log);
        if self.last_exit.is_some() || self.restarts > 0 {
            self.restarts = self.restarts.saturating_add(1);
        }
        self.running = Some(Running {
            child,
            since: Instant::now(),
            started_at: now_rfc3339(),
            banner,
        });
    }

    /// `claude remote-control --verbose` in the chosen directory, with the
    /// environment the server needs and both output streams piped.
    fn build_command(&self, cli: &Path) -> Command {
        let mut cmd = Command::new(cli);
        cmd.arg("remote-control")
            .arg("--verbose")
            .current_dir(&self.workdir)
            // Let Claude Code upgrade a package-manager install by itself.
            // A native or npm install auto-updates already and `claude
            // update` drives it on demand; a Homebrew or WinGet one does
            // neither, and this is upstream's own mechanism for it — the
            // server runs `brew upgrade` / `winget upgrade` in the
            // background when a release lands. Set here rather than
            // globally because this is the process that acts on it, and
            // because it must not reach anything else the tray spawns.
            //
            // Known limit, stated so a failure is not a mystery: on WinGet
            // the upgrade can fail while Claude Code is running, because
            // Windows locks the executable. It then shows the manual
            // command and nothing breaks.
            .env("CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            // Its own process group, so a stop can reach the sessions it
            // spawned and not only the server.
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(target_os = "macos")]
        {
            // The LaunchAgent's PATH is the system's; the server spawns git
            // and shells from wherever the user installed them.
            let path = std::env::var("PATH").unwrap_or_default();
            let local = home_dir().map(|h| h.join(".local/bin").display().to_string());
            cmd.env(
                "PATH",
                format!(
                    "{}:/opt/homebrew/bin:/usr/local/bin:{path}",
                    local.unwrap_or_default()
                ),
            );
        }
        cmd
    }

    /// Start the server, hidden; a failure is recorded as an exit and
    /// backed off like one.
    fn spawn(&mut self, cmd: &mut Command) -> Option<Child> {
        match hidden(cmd).spawn() {
            Ok(c) => Some(c),
            Err(e) => {
                self.last_exit = Some(format!("not started: {e} at {}", now_rfc3339()));
                self.failures = self.failures.saturating_add(1);
                self.next_start = Some(Instant::now() + self.backoff());
                None
            }
        }
    }

    /// One thread per output stream: every line goes to the log, is read for
    /// the banner, and is kept among the recent lines the state shows.
    fn attach_log_and_banner(
        &self,
        child: &mut Child,
        log: &Arc<Mutex<File>>,
    ) -> Arc<Mutex<Banner>> {
        let banner = Arc::new(Mutex::new(Banner::default()));
        for pipe in [
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let log = Arc::clone(log);
            let banner = Arc::clone(&banner);
            let recent = Arc::clone(&self.recent_lines);
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    banner.lock().unwrap_or_else(|p| p.into_inner()).note(&line);
                    if let Ok(mut f) = log.lock() {
                        let _ = writeln!(f, "{line}");
                    }
                    if let Ok(mut r) = recent.lock() {
                        if r.len() >= 20 {
                            r.pop_front();
                        }
                        r.push_back(line);
                    }
                }
            });
        }
        banner
    }

    /// End the server and every session under it.
    pub fn stop(&mut self, why: &str) {
        let Some(mut r) = self.running.take() else {
            return;
        };
        self.last_banner = r.banner.lock().map(|b| b.clone()).unwrap_or_default();
        let pid = r.child.id();
        #[cfg(windows)]
        {
            // The whole tree: a `.cmd` launcher's node, and the sessions the
            // server spawned. `kill` alone would orphan them.
            let mut cmd = Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
            let _ = hidden(&mut cmd)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(unix)]
        {
            // SAFETY: a signal to the group the child leads; nothing else is
            // in it.
            unsafe {
                let _ = libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
            }
            // A moment to leave on its own before the hard kill below.
            for _ in 0..20 {
                if matches!(r.child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let _ = r.child.kill();
        let _ = r.child.wait();
        self.last_exit = Some(format!("stopped ({why}) at {}", now_rfc3339()));
        self.next_start = None;
        let _ = pid;
    }

    /// The current picture, with the profile read fresh.
    pub fn report(&self) -> Report {
        let dir = claude_dir();
        let (sessions, credentials, settings) = match dir.as_deref() {
            Some(d) => (read_sessions(d), read_credentials(d), read_settings(d)),
            None => (Vec::new(), Credentials::default(), Settings::default()),
        };
        let (state, detail) = self.state();
        let server = match &self.running {
            Some(r) => r.banner.lock().map(|b| b.clone()).unwrap_or_default(),
            None => self.last_banner.clone(),
        };
        Report {
            path: self.cli.as_ref().map(|p| p.display().to_string()),
            install_method: self.cli.as_deref().map(|p| install_method(p).to_string()),
            cli_version: self.cli_version.clone(),
            last_update: self.last_update.clone(),
            state,
            detail,
            pid: self.running.as_ref().map(|r| r.child.id()),
            started_at: self.running.as_ref().map(|r| r.started_at.clone()),
            restarts: self.restarts,
            last_exit: self.last_exit.clone(),
            server,
            sessions,
            credentials,
            settings,
            user: std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .ok(),
            home: dir.map(|d| d.display().to_string()),
            workdir: Some(self.workdir.display().to_string()),
            workdir_via: Some(self.workdir_via.to_string()),
            log: Some(self.log_path.display().to_string()),
            reported_at: now_rfc3339(),
        }
    }

    fn state(&self) -> (String, Option<String>) {
        if self.cli.is_none() {
            return (
                "not-installed".into(),
                Some("no `claude` command in ~/.local/bin, npm's bin, Homebrew's or PATH".into()),
            );
        }
        if !self.wanted {
            return (
                "off".into(),
                Some("the box's policy for this machine".into()),
            );
        }
        if let Some(r) = &self.running {
            let has_banner = r
                .banner
                .lock()
                .map(|b| b.environment_id.is_some())
                .unwrap_or(false);
            if has_banner || r.since.elapsed() > Duration::from_secs(30) {
                return ("running".into(), None);
            }
            return ("starting".into(), None);
        }
        if let Some(at) = self.next_start {
            let left = at.saturating_duration_since(Instant::now());
            let last = self
                .recent_lines
                .lock()
                .ok()
                .and_then(|r| r.back().cloned())
                .unwrap_or_default();
            let detail = if last.is_empty() {
                format!("retrying in {}", short_duration(left))
            } else {
                format!("retrying in {} · last line: {last}", short_duration(left))
            };
            return ("waiting".into(), Some(detail));
        }
        ("stopped".into(), self.last_exit.clone())
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop("tray leaving");
    }
}

fn open_log(path: &Path) -> std::io::Result<File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() > LOG_ROTATE_BYTES) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    OpenOptions::new().create(true).append(true).open(path)
}

fn short_duration(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 {
        format!("{s} s")
    } else if s < 3600 {
        format!("{} min", s / 60)
    } else {
        format!("{} h {} min", s / 3600, (s % 3600) / 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_without_a_cli_reports_it() {
        // No `claude` on the test machine's PATH is the common case; when
        // there is one, the state is whatever it is and this test says so.
        let sup = Supervisor::new(
            Some(std::env::temp_dir().display().to_string()),
            std::env::temp_dir().join("daedalus-claude-test.log"),
            false,
        );
        let r = sup.report();
        assert!(r.state == "not-installed" || r.state == "off");
        assert_eq!(
            r.summary().sessions,
            r.sessions.iter().filter(|s| s.alive).count()
        );
    }
}
