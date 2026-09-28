//! The session: Claude Code supervised in the user's session and reported
//! to the service, with no UI.
//!
//! This process is the one with the user's Claude login, so it runs
//! `claude remote-control` (claude/) — never as its child: as a job of the
//! OS it starts and watches (a systemd user unit, a launchd job, a detached
//! process; claude/job.rs), which outlives it. Every `POLL` it reads the
//! service's status page on loopback, sends the service a report of the
//! supervisor (`POST /claude/report`), and applies the `ReportAnswer` —
//! run it or not, where, and the one-shot update and restart. The service
//! (session 0 on Windows, root on macOS and Linux) could do neither.
//!
//! Beside the server it keeps the roster of Claude sessions and runs the
//! three verbs on them (claude/sessions.rs), on a thread of their own: the
//! requests arrive with the report's answer, and the roster goes to the
//! service when it changes and every minute (`POST /claude/roster`, or
//! straight into the shared state on the controller). And it keeps the set
//! of sessions that are open, so that after it starts the server again —
//! the restart verb, a new directory, the server dying, the machine
//! coming back — it resumes them by itself (claude/recovery.rs; `recover`).
//!
//! It also notices an update of its own: when the page reports a version
//! other than its own, the binaries were swapped under it, and it says so
//! (`Tick::VersionChanged`) so its runner can leave for the new one.
//!
//! Two runners drive the same `tick`: the tray on Windows and macOS
//! (tray.rs), which draws what each poll returns, and `daedalus-agent
//! session` (`run` below), headless — the Linux user unit, which runs with
//! nobody logged in. A Linux tray does not own a session: it shows the one
//! the unit runs, through the service (`Watcher`). On the controller the
//! session is a thread of the service itself (`run_in_service`), and it
//! reports straight into the service's shared state instead of over
//! loopback (`Link::InProcess`).

use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::claude::roster::is_uuid;
use crate::claude::sessions::Context as SessionsContext;
use crate::claude::{Recovery, Report, ReportAnswer, Roster, SessionAction, Sessions, Supervisor};
use crate::config;
use crate::link::wire::Policy;
use crate::status::Shared;
use crate::VERSION;

/// How often the page is read and the report sent.
pub const POLL: Duration = Duration::from_secs(5);

/// The part of the status page the session and its UI read. Everything
/// else is ignored.
#[derive(Deserialize, Default)]
pub struct Page {
    pub version: String,
    pub awake_hold: bool,
    pub hold_error: Option<String>,
    pub update_available: Option<String>,
    pub restart_pending: bool,
    pub last_update_check: Option<String>,
    pub last_update_result: Option<String>,
    #[serde(default)]
    pub policy: Policy,
    /// The link to the controller (link/), when the page carries one.
    #[serde(default)]
    pub controller: Option<LinkPage>,
}

/// The link, as the page reports it (`link::LinkStatus`).
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct LinkPage {
    pub address: Option<String>,
    pub state: Option<String>,
    pub connected: bool,
    pub fingerprint: String,
    pub controller_fingerprint: Option<String>,
    pub pinned_via: Option<String>,
    pub unconfirmed: bool,
    pub error: Option<String>,
}

/// What one `tick` did.
pub enum Tick {
    /// Not due: the supervisor advanced and nothing was read.
    Idle,
    /// A poll: what was read and sent.
    Polled(Box<Poll>),
    /// The service runs another version: an update swapped the binaries,
    /// and this process should leave for the new one.
    VersionChanged,
}

/// One poll: the page (None when the service did not answer) and the
/// report that was sent.
pub struct Poll {
    pub page: Option<Page>,
    pub report: Report,
}

fn read_page(port: u16) -> Option<Page> {
    ureq::get(&format!("http://127.0.0.1:{port}/status"))
        .timeout(Duration::from_secs(2))
        .call()
        .ok()?
        .into_json()
        .ok()
}

fn request_check(port: u16) {
    let _ = ureq::post(&format!("http://127.0.0.1:{port}/update/check"))
        .timeout(Duration::from_secs(2))
        .call();
}

/// Send the supervisor's report to the service; its answer says whether the
/// box wants the server running, where, and whether to update or restart
/// it now.
fn send_report(port: u16, report: &Report) -> Option<ReportAnswer> {
    ureq::post(&format!("http://127.0.0.1:{port}/claude/report"))
        .timeout(Duration::from_secs(2))
        .send_json(serde_json::to_value(report).ok()?)
        .ok()?
        .into_json()
        .ok()
}

/// Send the roster of Claude sessions to the service.
fn send_roster(port: u16, roster: &Roster) -> bool {
    serde_json::to_value(roster).ok().is_some_and(|v| {
        ureq::post(&format!("http://127.0.0.1:{port}/claude/roster"))
            .timeout(Duration::from_secs(2))
            .send_json(v)
            .is_ok()
    })
}

/// How the session reaches the service it reports to.
pub enum Link {
    /// The service in another process, through its loopback page (a tray,
    /// the Linux session unit).
    Http(u16),
    /// The service in this process (the controller): the report lands in
    /// its shared state directly, and there is no page to read.
    InProcess(Arc<Shared>),
}

impl Link {
    fn page(&self) -> Option<Page> {
        match self {
            Link::Http(port) => read_page(*port),
            Link::InProcess(_) => None,
        }
    }

    fn report(&self, report: &Report) -> Option<ReportAnswer> {
        match self {
            Link::Http(port) => send_report(*port, report),
            Link::InProcess(shared) => Some(shared.set_claude(report.clone())),
        }
    }

    /// Hand the service the roster; whether it took it.
    fn roster(&self, roster: &Roster) -> bool {
        match self {
            Link::Http(port) => send_roster(*port, roster),
            Link::InProcess(shared) => {
                shared.set_claude_roster(roster.clone());
                true
            }
        }
    }

    /// An instruction waits that the next report would carry: the
    /// in-process session reports at once rather than at the next `POLL`.
    fn instruction_waiting(&self) -> bool {
        match self {
            Link::Http(_) => false,
            Link::InProcess(shared) => shared.claude_instruction_waiting(),
        }
    }
}

/// The supervisor, the sessions' thread, the recovery set, and when to look
/// at the page next. Dropping it leaves Claude running in its jobs and
/// releases the lock.
pub struct Session {
    port: u16,
    link: Link,
    sup: Supervisor,
    /// The roster and the session verbs, on a thread of their own.
    sessions: Sessions,
    /// The sessions open now, to resume after a server restart.
    recovery: Recovery,
    /// The supervisor's start count the last recovery answered
    /// (`Supervisor::starts`): a start past it wants one.
    recovered_for: u64,
    /// The roster generation last handed to the service, and when.
    roster_sent: Option<(u64, Instant)>,
    next_poll: Instant,
    /// One session per user: two would supervise one server against each
    /// other. Held for the session's life.
    _lock: std::fs::File,
}

/// How long a new session waits for the lock: a tray that relaunches for an
/// update, or a unit systemd restarts, starts while the old one is leaving.
const LOCK_WAIT: Duration = Duration::from_secs(10);

/// The session's lock, in the directory its Claude log lives in, named for
/// the user (on Windows that directory is shared by every user's tray).
fn claim_lock(claude_log: &std::path::Path) -> anyhow::Result<std::fs::File> {
    let dir = claude_log
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default();
    std::fs::create_dir_all(&dir)?;
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    let path = if user.is_empty() {
        dir.join("session.lock")
    } else {
        dir.join(format!("session-{user}.lock"))
    };
    let until = Instant::now() + LOCK_WAIT;
    loop {
        if let Some(f) = crate::os::lock_exclusive(&path) {
            return Ok(f);
        }
        if Instant::now() > until {
            anyhow::bail!(
                "another session already runs for this user ({} is held)",
                path.display()
            );
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Where a session keeps what it needs: the server's log (and its
/// resumed sessions' beside it), its job's name, and its own state
/// directory (the recovery set, the gcroots, the jobs' records).
pub struct Places {
    pub claude_log: PathBuf,
    pub job: String,
    pub state_dir: PathBuf,
}

impl Places {
    /// A tray's or the Linux session unit's: the user's own directories.
    pub fn of_user(cfg: &config::Config) -> Self {
        Self {
            claude_log: config::user_log_dir().join("claude-rc.log"),
            job: cfg.claude_unit(),
            state_dir: config::user_state_dir(),
        }
    }
}

impl Session {
    /// The Claude server, in this session with this user's login, reporting
    /// to the service on `port`. Wanted (as `Policy::default()` has it)
    /// until the service relays the box's policy, in the most recent trusted
    /// project until it names one. Nothing starts before the first `tick` (a
    /// job left running by a previous session is taken over, not
    /// restarted). Err when another session of this user holds the lock.
    pub fn new(port: u16, places: Places) -> anyhow::Result<Self> {
        let lock = claim_lock(&places.claude_log)?;
        let sessions = start_sessions(&places);
        let sup = Supervisor::new(
            None,
            places.claude_log,
            Policy::default().claude_remote_control,
            places.job,
            places.state_dir.join("gcroots"),
        );
        Ok(Self {
            port,
            link: Link::Http(port),
            sessions,
            recovery: Recovery::load(places.state_dir.join("claude-recovery.json")),
            recovered_for: 0,
            roster_sent: None,
            sup,
            next_poll: Instant::now(),
            _lock: lock,
        })
    }

    /// The controller's session, inside the service: it reports into
    /// `shared` and starts from the policy already there (config.toml's
    /// `[controller]`), so nothing runs that the config did not ask for —
    /// not even for the moment before the first report.
    pub fn in_process(shared: Arc<Shared>, port: u16, places: Places) -> anyhow::Result<Self> {
        let lock = claim_lock(&places.claude_log)?;
        let policy = shared.policy();
        let sessions = start_sessions(&places);
        let mut sup = Supervisor::new(
            policy.claude_workdir,
            places.claude_log,
            policy.claude_remote_control,
            places.job,
            places.state_dir.join("gcroots"),
        );
        sup.set_off_reason("config.toml's [controller] claude_remote_control is off");
        Ok(Self {
            port,
            link: Link::InProcess(shared),
            sup,
            sessions,
            recovery: Recovery::load(places.state_dir.join("claude-recovery.json")),
            recovered_for: 0,
            roster_sent: None,
            next_poll: Instant::now(),
            _lock: lock,
        })
    }

    /// The service's port, for a UI that links to its page.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Whether the box wants the server running.
    pub fn claude_wanted(&self) -> bool {
        self.sup.wanted()
    }

    /// Ask the service's updater to look now, and poll soon after.
    pub fn check_updates_now(&mut self) {
        request_check(self.port);
        self.next_poll = Instant::now() + Duration::from_secs(2);
    }

    /// Restart the Claude server now, and poll soon after.
    pub fn restart_claude(&mut self) {
        self.sup.restart();
        self.next_poll = Instant::now() + Duration::from_secs(1);
    }

    /// Advance the supervisor and, when due, read the page, report, and
    /// apply the answer. Cheap when not due; call it often.
    pub fn tick(&mut self) -> Tick {
        self.sup.tick();
        if Instant::now() < self.next_poll && !self.link.instruction_waiting() {
            return Tick::Idle;
        }
        let page = self.link.page();
        if let Some(p) = &page {
            if p.version != VERSION && !p.restart_pending {
                return Tick::VersionChanged;
            }
        }
        self.sup.tick();
        let mut report = self.sup.report();
        self.recover(&report);
        report.recovered = self.sessions.recovered();
        if let Some(answer) = self.link.report(&report) {
            self.sup.set_named_workdir(answer.workdir);
            self.sup.set_wanted(answer.wanted);
            // The update only starts here: it runs on its own thread
            // (`Supervisor::update_claude` says why), so a restart in the
            // same answer does not wait for it and comes back up on the
            // binary that was already installed.
            if answer.update {
                self.sup.update_claude();
            }
            if answer.restart {
                self.sup.restart();
            }
            // Each verb request goes to the sessions' thread, which refuses
            // them all while Claude is off here. A session the operator
            // stops is not one to bring back.
            for req in answer.sessions {
                if req.action == SessionAction::Stop && is_uuid(&req.id) {
                    self.recovery.forget(&req.id);
                }
                self.sessions.submit(req, self.sup.wanted());
            }
        }
        self.send_roster();
        self.next_poll = Instant::now() + POLL;
        Tick::Polled(Box::new(Poll { page, report }))
    }

    /// Keep the set of open sessions, and after a start of the server this
    /// session performed — once the server has registered — resume the
    /// ones it ended (claude/recovery.rs).
    fn recover(&mut self, report: &Report) {
        let server = self.sup.server_pid();
        let managed: Vec<String> = self
            .sessions
            .latest()
            .map(|(_, r)| r.managed.into_iter().map(|m| m.id).collect())
            .unwrap_or_default();
        let open = open_sessions(report, server, &managed, crate::os::parent_pid);
        let due = self.sup.starts() != self.recovered_for;
        self.recovery.freeze(due || self.sessions.recovering());
        self.recovery.observe(server, &open, Instant::now());
        if due && self.sup.registered() {
            self.recovered_for = self.sup.starts();
            let ids = self.recovery.due(&open);
            if !ids.is_empty() && self.sup.wanted() {
                tracing::info!(
                    sessions = ids.len(),
                    "Remote Control is back; resuming the sessions it ended"
                );
                self.sessions.recover(ids, true);
            }
        }
    }

    /// Hand the service the roster when the thread has a new one, and at
    /// least every `ROSTER_RESEND` so the service knows it is fresh.
    fn send_roster(&mut self) {
        let Some((generation, roster)) = self.sessions.latest() else {
            return;
        };
        let due = self
            .roster_sent
            .is_none_or(|(g, at)| g != generation || at.elapsed() >= ROSTER_RESEND);
        if due && self.link.roster(&roster) {
            self.roster_sent = Some((generation, Instant::now()));
        }
    }
}

/// How often an unchanged roster is sent again.
const ROSTER_RESEND: Duration = Duration::from_secs(60);

/// How far up the process tree a session may be from its server: the CLI
/// itself, or a `.cmd` shim's node under `cmd.exe` on Windows.
const SERVER_DEPTH: usize = 4;

/// The sessions open now (claude/recovery.rs): each live session file whose
/// process descends from the server's `server` (the ones it spawned), and
/// each session this agent resumed that runs (`managed`). `parent` is the
/// OS's parent-of-a-pid.
pub fn open_sessions(
    report: &Report,
    server: Option<u32>,
    managed: &[String],
    parent: impl Fn(u32) -> Option<u32>,
) -> Vec<String> {
    let under = |pid: u32| {
        let Some(root) = server else {
            return false;
        };
        let mut p = pid;
        for _ in 0..SERVER_DEPTH {
            match parent(p) {
                Some(pp) if pp == root => return true,
                Some(pp) if pp > 1 && pp != p => p = pp,
                _ => return false,
            }
        }
        false
    };
    let mut open: Vec<String> = report
        .sessions
        .iter()
        .filter(|s| s.alive)
        .filter_map(|s| {
            s.transcript_id
                .clone()
                .filter(|t| is_uuid(t))
                .map(|t| (s.pid, t))
        })
        .filter(|(pid, _)| under(*pid))
        .map(|(_, t)| t)
        .collect();
    for m in managed {
        if !open.contains(m) {
            open.push(m.clone());
        }
    }
    open
}

/// The roster and verbs' thread for this session: resumed sessions' jobs
/// get the session prefix's names (config.rs), their logs go beside the
/// server's, and their pins beside the session's state.
fn start_sessions(places: &Places) -> Sessions {
    Sessions::start(SessionsContext {
        server: places.job.clone(),
        prefix: config::claude_session_prefix(),
        log_dir: places
            .claude_log
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_default(),
        label: crate::claude::sessions::label_of(&crate::facts::hostname()),
        roots: places.state_dir.join("gcroots"),
    })
}

/// The full report the session last sent the service, which the service
/// answers on loopback (`GET /claude`); None when no session reported
/// lately.
fn read_report(port: u16) -> Option<Report> {
    ureq::get(&format!("http://127.0.0.1:{port}/claude"))
        .timeout(Duration::from_secs(2))
        .call()
        .ok()?
        .into_json::<Option<Report>>()
        .ok()?
}

/// A session that runs in another process — the Linux session unit —
/// seen through the service: its page, and the full report the session
/// last sent. A restart is asked of the service (`POST /claude/restart`),
/// which hands it to the session with its next report. It supervises
/// nothing; dropping it stops nothing.
pub struct Watcher {
    port: u16,
    wanted: bool,
    next_poll: Instant,
}

impl Watcher {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            wanted: Policy::default().claude_remote_control,
            next_poll: Instant::now(),
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Whether the box wants the server running, as the page last said.
    pub fn claude_wanted(&self) -> bool {
        self.wanted
    }

    pub fn check_updates_now(&mut self) {
        request_check(self.port);
        self.next_poll = Instant::now() + Duration::from_secs(2);
    }

    /// Ask the session, through the service, to restart the server.
    pub fn restart_claude(&mut self) {
        let _ = ureq::post(&format!("http://127.0.0.1:{}/claude/restart", self.port))
            .timeout(Duration::from_secs(2))
            .call();
        self.next_poll = Instant::now() + POLL;
    }

    /// When due, read the page and the session's report.
    pub fn tick(&mut self) -> Tick {
        if Instant::now() < self.next_poll {
            return Tick::Idle;
        }
        self.next_poll = Instant::now() + POLL;
        let page = read_page(self.port);
        if let Some(p) = &page {
            // Only a NEWER service means this binary was replaced; an older
            // one (mid-update, or a service not yet restarted) is shown, not
            // chased — leaving for it would start this same binary again.
            if !p.restart_pending && newer_than_this(&p.version) {
                return Tick::VersionChanged;
            }
            self.wanted = p.policy.claude_remote_control;
        }
        let report = read_report(self.port).unwrap_or_else(|| Report {
            state: "no-session".into(),
            detail: Some("the session unit is not reporting".into()),
            ..Default::default()
        });
        Tick::Polled(Box::new(Poll { page, report }))
    }
}

/// Whether `version` is a release above this binary's own.
fn newer_than_this(version: &str) -> bool {
    match (
        semver::Version::parse(version),
        semver::Version::parse(VERSION),
    ) {
        (Ok(theirs), Ok(ours)) => theirs > ours,
        _ => false,
    }
}

/// `daedalus-agent session`: the session with no UI, until SIGTERM or
/// Ctrl-C, or until the service runs another version (an update swapped
/// the binary) — then it leaves, and systemd starts the new one. Its log is
/// `session.log` in `config::user_log_dir`, beside `claude-rc.log`; in a
/// terminal it also goes to stderr. The server's job is left running when
/// it leaves, and the next session re-attaches to it.
pub fn run() -> anyhow::Result<()> {
    if crate::os::TRAY_OWNS_SESSION {
        anyhow::bail!(
            "on this OS the tray runs the session; `session` is the Linux user unit's entry point"
        );
    }
    let cfg = config::load_or_default()?;
    if !cfg.role().session {
        anyhow::bail!("this machine's role runs no session");
    }
    if cfg.role().session_in_service {
        anyhow::bail!(
            "in controller mode the session runs inside the service (`run` or `serve`), not on its own"
        );
    }
    let dir = config::user_log_dir();
    let _log = config::init_logging_to(&cfg, &dir, "session.log", std::io::stderr().is_terminal())?;
    let places = Places::of_user(&cfg);
    tracing::info!(
        version = VERSION,
        port = cfg.port,
        job = places.job,
        "session starting"
    );
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = Arc::clone(&stop);
        crate::os::on_interrupt(move || stop.store(true, Ordering::Relaxed));
    }
    let mut session = Session::new(cfg.port, places)?;
    let mut last: Option<(String, bool)> = None;
    while !stop.load(Ordering::Relaxed) {
        match session.tick() {
            Tick::Idle => {}
            Tick::VersionChanged => {
                tracing::info!("the service runs another version; leaving for the new binary");
                break;
            }
            Tick::Polled(poll) => {
                let now = (poll.report.state.clone(), poll.page.is_some());
                if last.as_ref() != Some(&now) {
                    tracing::info!(
                        claude = %poll.report.state,
                        detail = poll.report.detail.as_deref().unwrap_or(""),
                        service_answering = now.1,
                        "session state"
                    );
                    last = Some(now);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    tracing::info!("session stopping");
    drop(session);
    Ok(())
}

/// The controller's session: a thread of the service (role.rs
/// `session_in_service`), reporting into `shared` until `stop` is raised.
/// Its Claude log is `claude-rc.log` beside the service's own, and its state
/// (the recovery set, the gcroots) in the data directory (the controller's
/// data directory is its user's, so there is no second one to keep). The
/// server's job is left running when it leaves, and the next start
/// re-attaches to it, as the session unit's does.
pub fn run_in_service(
    cfg: &config::Config,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    let places = Places {
        claude_log: config::log_dir().join("claude-rc.log"),
        job: cfg.claude_unit(),
        state_dir: config::data_dir(),
    };
    tracing::info!(job = places.job, "session starting inside the service");
    let mut session = Session::in_process(shared, cfg.port, places)?;
    let mut last: Option<String> = None;
    while !stop.load(Ordering::Relaxed) {
        if let Tick::Polled(poll) = session.tick() {
            if last.as_deref() != Some(poll.report.state.as_str()) {
                tracing::info!(
                    claude = %poll.report.state,
                    detail = poll.report.detail.as_deref().unwrap_or(""),
                    "session state"
                );
                last = Some(poll.report.state.clone());
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    tracing::info!("session stopping");
    drop(session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_newer_service_makes_a_watcher_leave() {
        assert!(newer_than_this("999.0.0"));
        assert!(!newer_than_this(VERSION));
        assert!(!newer_than_this("0.0.1"));
        assert!(!newer_than_this("not a version"));
    }

    #[test]
    fn one_session_per_user_holds_the_lock() {
        let dir =
            std::env::temp_dir().join(format!("daedalus-session-lock-{}", std::process::id()));
        let log = dir.join("claude-rc.log");
        let first = claim_lock(&log).expect("the first session takes the lock");
        // A second claim waits LOCK_WAIT, then refuses; not waited out here:
        // the OS lock itself is what is checked.
        let held = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .find(|e| e.file_name().to_string_lossy().ends_with(".lock"))
            .unwrap()
            .path();
        assert!(crate::os::lock_exclusive(&held).is_none());
        drop(first);
        // Other tests spawn processes; a child forked while the lock was
        // held shares it until it execs, so the release is waited for.
        let until = Instant::now() + Duration::from_secs(5);
        let mut again = crate::os::lock_exclusive(&held);
        while again.is_none() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
            again = crate::os::lock_exclusive(&held);
        }
        assert!(again.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_page_reads_what_the_status_page_writes() {
        let p: Page = serde_json::from_str(
            r#"{"agent":"daedalus-agent","version":"0.14.0","awake_hold":true,
                "hold_error":null,"update_available":"0.15.0","restart_pending":false,
                "last_update_check":"2026-09-27T10:00:00Z","last_update_result":"x",
                "policy":{"awake_hold":false,"claude_remote_control":true},
                "controller":{"address":"box.lan:7788","found_via":"config","state":"approved",
                  "connected":true,"since":null,"fingerprint":"aa","controller_fingerprint":"bb",
                  "pinned_via":"tofu","unconfirmed":true,"error":null},
                "telemetry":null}"#,
        )
        .unwrap();
        assert_eq!(p.version, "0.14.0");
        assert_eq!(p.update_available.as_deref(), Some("0.15.0"));
        assert!(!p.policy.awake_hold);
        let l = p.controller.unwrap();
        assert_eq!(l.state.as_deref(), Some("approved"));
        assert!(l.connected && l.unconfirmed);
    }

    #[test]
    fn the_open_sessions_are_the_servers_children_and_the_managed() {
        use crate::claude::Session as File;
        let a = "aaaaaaaa-0000-4000-8000-000000000001";
        let b = "aaaaaaaa-0000-4000-8000-000000000002";
        let c = "aaaaaaaa-0000-4000-8000-000000000003";
        let m = "aaaaaaaa-0000-4000-8000-000000000004";
        let file = |pid, id: &str, alive| File {
            pid,
            transcript_id: Some(id.to_string()),
            alive,
            ..Default::default()
        };
        let report = Report {
            sessions: vec![
                // The server's own child.
                file(11, a, true),
                // Under a shim: a grandchild.
                file(12, b, true),
                // Somebody's terminal, not under the server.
                file(13, c, true),
                // Dead.
                file(14, "aaaaaaaa-0000-4000-8000-000000000005", false),
            ],
            ..Default::default()
        };
        // 10 is the server; 12's parent is 20, whose parent is 10; 13's is init.
        let parent = |pid: u32| match pid {
            11 => Some(10),
            12 => Some(20),
            20 => Some(10),
            13 => Some(1),
            _ => None,
        };
        let managed = vec![m.to_string(), a.to_string()];
        assert_eq!(
            open_sessions(&report, Some(10), &managed, parent),
            [a, b, m]
        );
        // No server: only what runs as its own job.
        assert_eq!(open_sessions(&report, None, &managed, parent), [m, a]);
    }
}
