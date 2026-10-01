//! The supervisor: one `claude remote-control` kept running while the box
//! wants it, restarted with backoff, its output logged and its banner
//! read, and the report the session (session.rs) sends the service. The
//! server is always a job of the OS (jobs/, `os::jobs`), never the
//! session's child: the session starts it, watches it, stops it, and when
//! the session itself restarts — an agent update, a crash, the tray quit —
//! it finds the job still running and re-attaches (`Supervisor::new`).

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::cli::{cli_version, find_cli, install_method};
use super::profile::{
    claude_dir, forget_keychain, home_dir, read_credentials, read_session_files, read_sessions,
    read_settings,
};
use super::workdir::pick_workdir;
use super::{gcroot, Banner, Credentials, Report, Settings, UpdateResult};
use crate::jobs::{self as job, JobState, Jobs, LogTail, ServerJob};
use crate::os::jobs;
use crate::state::{now_rfc3339, rfc3339_ago};

mod update;

use update::Updater;

/// A run shorter than this counts as a failure and grows the backoff.
const QUICK_EXIT: Duration = Duration::from_secs(60);
/// The backoff ladder's ceiling.
const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);
/// How often the server log is looked at for rotation while it runs
/// (logs.rs: copy, then truncate, so the job's descriptor keeps working).
const ROTATE_CHECK: Duration = Duration::from_secs(60);
/// How often a running job's state is asked of the OS (its log is read
/// every tick, which is where a change shows first).
const JOB_POLL: Duration = Duration::from_secs(10);
/// How often while it changes: just started, not yet with a pid, or the OS
/// not answering.
const JOB_POLL_CHANGING: Duration = Duration::from_secs(2);
/// A server that printed no environment id counts as registered after this.
const REGISTER_WAIT: Duration = Duration::from_secs(30);
/// How soon an attach whose job state could not be read is tried again.
const ATTACH_RETRY: Duration = Duration::from_secs(3);

/// Where the supervisor reads the time: the monotonic clock, or a test's.
type Clock = Box<dyn Fn() -> Instant + Send>;

/// The server, as this session holds it: the job it started or found
/// running, and what it has read of it.
struct Running {
    pid: Option<u32>,
    tail: LogTail,
    next_poll: Instant,
    /// The OS is not answering (logged once per streak): the state is
    /// unknown, which is never taken for a server gone.
    unanswered: bool,
    since: Instant,
    started_at: String,
    banner: Banner,
}

/// Note one output line: into the banner, and among the recent lines.
fn note_line(banner: &mut Banner, recent: &mut VecDeque<String>, line: String) {
    banner.note(&line);
    if recent.len() >= 20 {
        recent.pop_front();
    }
    recent.push_back(line);
}

impl Running {
    /// Read what the server printed since the last tick, and — every
    /// `JOB_POLL`, or `JOB_POLL_CHANGING` while it settles — ask the OS
    /// whether it still runs: None while it does (or while the OS cannot
    /// say), Some(Ok(code)) once it exited, Some(Err(why)) when the job is
    /// gone.
    fn poll(
        &mut self,
        name: &str,
        recent: &mut VecDeque<String>,
        jobs: &dyn Jobs,
        now: Instant,
    ) -> Option<Result<String, String>> {
        for line in self.tail.read_new() {
            note_line(&mut self.banner, recent, line);
        }
        if now < self.next_poll {
            return None;
        }
        let (next, ended) = match jobs.show(name) {
            Ok(JobState::Running { pid, .. }) => {
                self.unanswered = false;
                self.pid = pid;
                let settled = if pid.is_some() {
                    JOB_POLL
                } else {
                    JOB_POLL_CHANGING
                };
                (settled, None)
            }
            Ok(JobState::Exited(code)) => (JOB_POLL_CHANGING, Some(Ok(code))),
            Ok(JobState::Gone) => (
                JOB_POLL_CHANGING,
                Some(Err(format!("the job {name} is gone"))),
            ),
            Err(e) => {
                if !self.unanswered {
                    tracing::warn!(job = name, error = %e, "the Claude job's state is unknown; still watching");
                }
                self.unanswered = true;
                (JOB_POLL_CHANGING, None)
            }
        };
        self.next_poll = now + next;
        ended
    }
}

/// Keeps one `claude remote-control` running while it is wanted.
///
/// Driven by `tick` from the session's loop (session.rs): it reaps an exit,
/// waits out the backoff, and starts the next one. The jobs it asks are the
/// OS's (`os::jobs::Os`) and its clock the monotonic one, both handed in so
/// its tests run it against a fake of each.
pub struct Supervisor {
    jobs: Box<dyn Jobs>,
    clock: Clock,
    /// The server's job name (config.rs `Config::claude_unit`).
    job: String,
    /// Where the running `claude` is pinned from the garbage collector.
    roots: PathBuf,
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
    /// Starts this supervisor performed (never a re-attach): what the
    /// session's recovery waits on (recovery.rs).
    starts: u64,
    failures: u32,
    next_start: Option<Instant>,
    last_exit: Option<String>,
    recent_lines: VecDeque<String>,
    /// What the last `claude update` did, kept for the report.
    last_update: Option<UpdateResult>,
    /// The update running on its own thread, if one is (update.rs).
    update: Updater,
    /// Why the server is off when it is not wanted, as the report words it:
    /// the box's policy on a node, config.toml on the controller.
    off_reason: &'static str,
    /// While not wanted: a job of this supervisor's name that is running
    /// anyway, which it neither adopted nor stops (`look_for_foreign`).
    foreign: Option<String>,
    foreign_checked: Option<Instant>,
    /// When the log was last looked at for rotation.
    rotate_checked: Instant,
    /// The job's state could not be read at attach: when to ask again
    /// (never a start meanwhile — `attach`).
    attach_retry: Option<Instant>,
}

impl Supervisor {
    /// A supervisor that starts nothing before its first `tick`. Wanted, it
    /// first looks for a job this session's predecessor left running, and
    /// takes it over (`attach`). Not wanted, it adopts nothing: a job of
    /// that name running then is left alone and named in the report as
    /// unmanaged (`look_for_foreign`), so the report never calls a running
    /// Claude "off" without saying so. It is adopted if the server becomes
    /// wanted (`set_wanted`).
    pub fn new(
        named_workdir: Option<String>,
        log_path: PathBuf,
        wanted: bool,
        job: String,
        roots: PathBuf,
    ) -> Self {
        let cli = find_cli();
        Self::with(
            Box::new(jobs::Os),
            Box::new(Instant::now),
            cli,
            named_workdir,
            log_path,
            wanted,
            job,
            roots,
        )
    }

    /// `new`, with the jobs, the clock and the `claude` it is handed.
    #[allow(clippy::too_many_arguments)]
    fn with(
        jobs: Box<dyn Jobs>,
        clock: Clock,
        cli: Option<PathBuf>,
        named_workdir: Option<String>,
        log_path: PathBuf,
        wanted: bool,
        job: String,
        roots: PathBuf,
    ) -> Self {
        let cli_version = cli.as_deref().and_then(cli_version);
        let (workdir, workdir_via) = pick_workdir(named_workdir.as_deref());
        let now = clock();
        let mut sup = Self {
            jobs,
            clock,
            job,
            roots,
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
            starts: 0,
            failures: 0,
            next_start: None,
            last_exit: None,
            recent_lines: VecDeque::new(),
            last_update: None,
            update: Updater::default(),
            off_reason: "the box's policy for this machine",
            foreign: None,
            foreign_checked: None,
            rotate_checked: now,
            attach_retry: None,
        };
        if sup.wanted {
            sup.attach();
        } else {
            sup.look_for_foreign();
        }
        sup
    }

    fn now(&self) -> Instant {
        (self.clock)()
    }

    /// How the report words why the server is off (the controller's comes
    /// from config.toml, not from the box).
    pub fn set_off_reason(&mut self, why: &'static str) {
        self.off_reason = why;
    }

    /// The server's job name.
    pub fn job(&self) -> &str {
        &self.job
    }

    /// The server's pid while its job runs.
    pub fn server_pid(&self) -> Option<u32> {
        self.running.as_ref().and_then(|r| r.pid)
    }

    /// How many times this supervisor started the server (re-attaches do
    /// not count).
    pub fn starts(&self) -> u64 {
        self.starts
    }

    /// The server runs and has registered with claude.ai: it printed its
    /// environment id, or has run `REGISTER_WAIT` without dying.
    pub fn registered(&self) -> bool {
        self.running.as_ref().is_some_and(|r| {
            r.pid.is_some()
                && (r.banner.environment_id.is_some()
                    || self.now().saturating_duration_since(r.since) > REGISTER_WAIT)
        })
    }

    /// While the server is not wanted: whether a job of its name runs
    /// anyway (one left by an earlier configuration, or another process's
    /// of the same name). It is not adopted and not stopped — stopping a
    /// Claude this agent did not start could end someone's sessions — but
    /// the report says it is there.
    fn look_for_foreign(&mut self) {
        self.foreign_checked = Some(self.now());
        let name = &self.job;
        self.foreign = match self.jobs.show(name) {
            Ok(JobState::Running { pid, .. }) => Some(format!(
                "a job named {name} is running{} and is not managed by this agent while \
                 remote control is off",
                pid.map(|p| format!(" (pid {p})")).unwrap_or_default()
            )),
            _ => None,
        };
    }

    /// A job that outlived the previous session: running, it is taken over
    /// where it runs — its banner read back from the log, its age from the
    /// OS — so the new session restarts nothing; exited, its status is the
    /// last exit and the next start is due now.
    fn attach(&mut self) {
        let name = self.job.clone();
        match self.jobs.show(&name) {
            Ok(JobState::Running {
                pid,
                age_secs,
                workdir,
            }) => {
                let age = Duration::from_secs(age_secs.unwrap_or(0));
                let mut banner = Banner::default();
                let mut tail = LogTail::at_last_marker(self.log_path.clone());
                for line in tail.read_new() {
                    note_line(&mut banner, &mut self.recent_lines, line);
                }
                if let Some(w) = workdir {
                    self.workdir = w;
                    self.workdir_via = "where the running server was found";
                }
                tracing::info!(job = name, pid, "re-attached to Claude remote control");
                // An earlier agent may have started it: its claude is pinned
                // now, not only at a start this agent performs.
                if let Some(cli) = self.jobs.running_cli(&name) {
                    gcroot::pin(&self.roots, &name, &cli);
                }
                self.running = Some(Running {
                    pid,
                    tail,
                    next_poll: self.now() + JOB_POLL,
                    unanswered: false,
                    since: self.now().checked_sub(age).unwrap_or(self.now()),
                    started_at: rfc3339_ago(age.as_secs()),
                    banner,
                });
            }
            Ok(JobState::Exited(code)) => {
                self.last_exit = Some(format!(
                    "exit {code} while no session watched, found at {}",
                    now_rfc3339()
                ));
                self.next_start = Some(self.now());
            }
            Ok(JobState::Gone) => {}
            Err(e) => {
                // Not knowing is never taken for gone: a start would clear
                // the job first, and that could end a live server. Look
                // again shortly instead.
                tracing::warn!(job = name, error = %e, "the Claude job's state is unknown; asking again");
                self.last_exit = Some(format!(
                    "the state of {name} could not be read ({e}); asking again"
                ));
                self.attach_retry = Some(self.now() + ATTACH_RETRY);
                self.next_start = None;
            }
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
            self.attach_retry = None;
            self.look_for_foreign();
        } else {
            self.failures = 0;
            self.next_start = Some(self.now());
            self.foreign = None;
            // A job of this name already running is taken over now it is
            // wanted, not started a second time over it.
            if self.running.is_none() {
                self.attach();
            }
        }
    }

    /// The directory the box names. A change restarts the server there;
    /// None goes back to picking the most recent trusted project.
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
        self.next_start = Some(self.now());
    }

    /// Update Claude Code on this machine, on a thread of its own, and
    /// record what happened (update.rs says how and why). `tick` collects
    /// the result when the thread ends (`collect_update`).
    pub fn update_claude(&mut self) {
        if self.update.running() {
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
        self.update.start(cli, self.cli_version.clone());
    }

    /// A finished update's result, into the report.
    fn collect_update(&mut self) {
        if let Some(r) = self.update.collect(&self.cli_version) {
            self.cli_version = r.to.clone();
            self.last_update = Some(r);
        }
    }

    /// Advance: reap, wait, start. Cheap; call it often.
    pub fn tick(&mut self) {
        self.collect_update();
        let now = self.now();
        if now.saturating_duration_since(self.rotate_checked) >= ROTATE_CHECK {
            self.rotate_checked = now;
            rotate(&self.log_path);
        }
        if !self.wanted
            && self
                .foreign_checked
                .is_none_or(|at| now.saturating_duration_since(at) > JOB_POLL)
        {
            self.look_for_foreign();
        }
        if let Some(r) = self.running.as_mut() {
            // Some(Ok(code)): it exited ("N", or "signal"); Some(Err): lost.
            match r.poll(&self.job, &mut self.recent_lines, &*self.jobs, now) {
                Some(Ok(code)) => {
                    let ran = now.saturating_duration_since(r.since);
                    self.last_banner = r.banner.clone();
                    self.running = None;
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
                        self.next_start = Some(now + self.backoff());
                    }
                }
                None => {}
                Some(Err(e)) => {
                    self.last_banner = r.banner.clone();
                    self.last_exit = Some(format!("lost: {e}"));
                    self.running = None;
                    if self.wanted {
                        self.next_start = Some(now + self.backoff());
                    }
                }
            }
        }
        if let Some(at) = self.attach_retry {
            if self.running.is_none() && self.wanted && self.now() >= at {
                self.attach_retry = None;
                self.attach();
                // Read at last, and nothing runs: start as a first start would.
                if self.running.is_none()
                    && self.attach_retry.is_none()
                    && self.next_start.is_none()
                {
                    self.next_start = Some(self.now());
                }
            }
            if self.attach_retry.is_some() {
                return;
            }
        }
        if self.running.is_none() && self.wanted {
            if let Some(at) = self.next_start {
                if self.now() >= at {
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

    /// The server as a job: whatever is left of a previous run cleared, the
    /// marker line into the log (the job's output is appended after it),
    /// then the OS's start. A failure is recorded as an exit and backed off
    /// like one.
    fn start(&mut self) {
        if self.cli.is_none() {
            self.rescan();
        }
        let Some(cli) = self.cli.clone() else {
            // Look again in a minute, not on every tick.
            self.next_start = Some(self.now() + Duration::from_secs(60));
            return;
        };
        // A log-in made since the last look shows in the next report.
        forget_keychain();
        // A trust accepted since the last look is honoured on the next start.
        let (dir, via) = pick_workdir(self.named_workdir.as_deref());
        self.workdir = dir;
        self.workdir_via = via;
        let name = self.job.clone();
        // Whatever is left of the previous run goes first, so nothing it
        // still prints lands after the marker of this one.
        self.jobs.clear(&name);
        let offset = match open_log(&self.log_path).and_then(|mut log| {
            writeln!(
                log,
                "── {} daedalus-agent session {} in {} (job {name}) ──",
                now_rfc3339(),
                job::MARKER,
                self.workdir.display()
            )?;
            log.metadata().map(|m| m.len())
        }) {
            Ok(o) => o,
            Err(e) => {
                self.last_exit = Some(format!("log not opened: {e}"));
                self.next_start = Some(self.now() + MAX_BACKOFF);
                return;
            }
        };
        let path = std::env::var("PATH").ok();
        let config_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
        let env = jobs::server_env(
            home_dir().as_deref(),
            path.as_deref(),
            config_dir.as_deref(),
        );
        let started = self.jobs.start_server(&ServerJob {
            name: &name,
            cli: &cli,
            workdir: &self.workdir,
            log: &self.log_path,
            env: &env,
        });
        if let Err(e) = started {
            self.last_exit = Some(format!("not started: {e} at {}", now_rfc3339()));
            self.failures = self.failures.saturating_add(1);
            self.next_start = Some(self.now() + self.backoff());
            return;
        }
        tracing::info!(
            job = name,
            kind = jobs::JOB_KIND,
            "Claude remote control started"
        );
        gcroot::pin(&self.roots, &name, &cli);
        if self.last_exit.is_some() || self.restarts > 0 {
            self.restarts = self.restarts.saturating_add(1);
        }
        self.starts += 1;
        self.running = Some(Running {
            pid: None,
            tail: LogTail::at(self.log_path.clone(), offset),
            next_poll: self.now() + Duration::from_secs(1),
            unanswered: false,
            since: self.now(),
            started_at: now_rfc3339(),
            banner: Banner::default(),
        });
    }

    /// End the server and every session under it (the OS ends the job's
    /// whole tree), and clear the job.
    pub fn stop(&mut self, why: &str) {
        let Some(r) = self.running.take() else {
            return;
        };
        self.last_banner = r.banner;
        self.jobs.clear(&self.job);
        self.last_exit = Some(format!("stopped ({why}) at {}", now_rfc3339()));
        self.next_start = None;
    }

    /// The current picture, with the profile read fresh.
    pub fn report(&self) -> Report {
        let dir = claude_dir();
        let (sessions, credentials, settings) = match dir.as_deref() {
            Some(d) => (
                read_sessions(&read_session_files(d)),
                read_credentials(d),
                read_settings(d),
            ),
            None => (Vec::new(), Credentials::default(), Settings::default()),
        };
        let (state, detail) = self.state();
        // While it waits to start again, what it said last is the why.
        let last_line = (state == "waiting")
            .then(|| self.recent_lines.back().cloned())
            .flatten()
            .filter(|l| !l.is_empty());
        let server = match &self.running {
            Some(r) => r.banner.clone(),
            None => self.last_banner.clone(),
        };
        Report {
            path: self.cli.as_ref().map(|p| p.display().to_string()),
            install_method: self.cli.as_deref().map(|p| install_method(p).to_string()),
            cli_version: self.cli_version.clone(),
            last_update: self.last_update.clone(),
            state,
            detail,
            last_line,
            pid: self.server_pid(),
            started_at: self.running.as_ref().map(|r| r.started_at.clone()),
            restarts: self.restarts,
            last_exit: self.last_exit.clone(),
            server,
            sessions,
            recovered: Vec::new(),
            credentials,
            settings,
            user: std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .ok(),
            home: dir.map(|d| d.display().to_string()),
            workdir: Some(self.workdir.display().to_string()),
            workdir_via: Some(self.workdir_via.to_string()),
            log: Some(self.log_path.display().to_string()),
            job: Some(self.job.clone()),
            reported_at: now_rfc3339(),
        }
    }

    /// The report's state: `off` whenever the server is not wanted (with
    /// the reason, and any job of its name running unmanaged), then
    /// `not-installed` when it is wanted and there is no `claude`, then
    /// how the job stands.
    fn state(&self) -> (String, Option<String>) {
        let facts = StateFacts {
            wanted: self.wanted,
            installed: self.cli.is_some(),
            foreign: self.foreign.as_deref(),
            off_reason: self.off_reason,
        };
        if let Some(s) = facts.settled() {
            return s;
        }
        if let Some(r) = &self.running {
            if r.banner.environment_id.is_some()
                || self.now().saturating_duration_since(r.since) > REGISTER_WAIT
            {
                // Windows: a job the tray's job object kept (os/windows/jobs.rs).
                return ("running".into(), self.jobs.caveat(&self.job));
            }
            return ("starting".into(), None);
        }
        if let Some(at) = self.next_start {
            let left = at.saturating_duration_since(self.now());
            return (
                "waiting".into(),
                Some(format!("retrying in {}", short_duration(left))),
            );
        }
        ("stopped".into(), self.last_exit.clone())
    }
}

/// The part of the state decided before the job is looked at — pure, so the
/// order is tested: not wanted is `off` whatever else is true, and only a
/// wanted server with no `claude` is `not-installed`.
struct StateFacts<'a> {
    wanted: bool,
    installed: bool,
    foreign: Option<&'a str>,
    off_reason: &'a str,
}

impl StateFacts<'_> {
    fn settled(&self) -> Option<(String, Option<String>)> {
        if !self.wanted {
            let detail = match self.foreign {
                Some(f) => format!("{} — but {f}", self.off_reason),
                None => self.off_reason.to_string(),
            };
            return Some(("off".into(), Some(detail)));
        }
        if !self.installed {
            return Some((
                "not-installed".into(),
                Some("no `claude` command in ~/.local/bin, npm's bin, Homebrew's or PATH".into()),
            ));
        }
        None
    }
}

impl Drop for Supervisor {
    /// The job is left running for the next session to re-attach to — that
    /// is what it is a job for.
    fn drop(&mut self) {
        if self.running.is_some() {
            tracing::info!(
                job = self.job,
                "leaving Claude remote control running in its job"
            );
        }
    }
}

fn open_log(path: &Path) -> std::io::Result<File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    rotate(path);
    OpenOptions::new().create(true).append(true).open(path)
}

/// Rotate the log when it is past `logs::ROTATE_BYTES`, whoever holds it
/// open (logs.rs).
fn rotate(path: &Path) {
    match super::logs::rotate_if_larger(path, super::logs::ROTATE_BYTES) {
        Ok(true) => tracing::info!(log = %path.display(), "rotated the Claude log"),
        Ok(false) => {}
        Err(e) => {
            tracing::warn!(log = %path.display(), error = %e, "the Claude log was not rotated")
        }
    }
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
mod tests;
