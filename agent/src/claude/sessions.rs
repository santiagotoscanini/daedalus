//! The three verbs on one Claude Code session — resume, stop, remove — the
//! automatic recovery that resumes what a server restart ended, and the
//! thread that runs them and keeps the roster (roster.rs) fresh.
//!
//! This replaces the box's `claude-session` bridge verb and its
//! `claude-session@` template, and keeps their rules. The caller supplies a
//! SELECTOR and nothing else: never a path, a flag or a directory. Three
//! layers, in the order they run:
//!
//! 1. SYNTAX (`check_selector`): a canonical lowercase uuid, or eight
//!    lowercase hex digits (a background agent's short id), before the value
//!    is used anywhere — checked where a request is accepted and again here.
//! 2. EXISTENCE: `resume` needs `<uuid>.jsonl` as a regular file (never a
//!    link) in a real directory under `~/.claude/projects`, found by walking
//!    the tree; `stop` and `remove` of a short id need the CLI's own
//!    `claude agents --json` to list a background agent by it.
//! 3. A TRUSTED CWD: a resumed session runs only in a project directory
//!    whose workspace trust was accepted (`~/.claude.json`), and only the one
//!    the transcript's project slug names. Anywhere else an interactive
//!    `claude` stops on "Is this a project you created or one you trust?"
//!    and a job would sit there started and useless.
//!
//! **Resume** starts `claude --resume <uuid> --remote-control <hostname>` as
//! a job of its own, `claude-session-<uuid>` (a development run with
//! `DAEDALUS_AGENT_DATA_DIR` names its own, config.rs), in that directory,
//! with the environment the server's job gets plus TERM (and on NixOS
//! `/run/wrappers/bin`, for sudo) — under a terminal, which is not optional:
//! with pipes the CLI falls back to --print mode and exits in a second. What
//! the terminal is, is the OS's (job.rs): `script` on Linux and macOS, with
//! the output filtered on the way to the job's log; a pseudo-console the
//! agent's own binary holds on Windows. The job outlives the agent: a
//! restart or an update of the agent ends nothing, and the next start finds
//! it (`managed`). It is refused when anything already runs that session —
//! its job, the CLI's agents, a live session file — because `--resume` of a
//! running session starts a copy and two processes would append to one
//! transcript. Five seconds after the start the job must still run, or the
//! resume failed. The `claude` it runs is pinned from the nix garbage
//! collector while it runs, where it is a store path (gcroot.rs).
//!
//! **Stop** of a uuid ends a session this agent resumed: its job, with the
//! OS ending the whole tree — no pid to match. A session the Remote Control
//! server spawned has no stop of its own; it ends with its server. Stop of a
//! short id is `claude stop <id>`, the CLI's own verb for a background
//! agent, which keeps the conversation (`claude attach` reopens it); what
//! settles it is no process left behind the id, not the CLI's exit status.
//!
//! **Remove** is `claude rm <short id>`: a background agent's record and its
//! worktree, and settled by the record being gone. Never
//! `--discard-unpushed` — that throws away commits.
//!
//! **Recovery** (recovery.rs says when) is `resume` of each session id the
//! session hands over, one after the other, with every check above; each is
//! a row in `actions` like an operator's request, and the whole run is the
//! report's `recovered`.
//!
//! What a verb did is reported in the roster's `actions` (`ActionResult`) in
//! a sentence of the agent's own; what the CLI printed goes to the agent's
//! log and nowhere else — it is session content.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::cli::find_cli;
use super::profile::{claude_dir, home_dir, read_session_files};
use super::roster::{self, is_short_id, is_uuid, ActionResult, Agent, Managed, Roster, Scanner};
use super::workdir::trusted_projects;
use super::{gcroot, ActionState, Recovered, SessionAction, SessionRequest};
use crate::jobs::{self as job, JobState, Jobs, SessionJob};
use crate::os::jobs;
use crate::state::now_rfc3339;
use crate::util::LockExt;

/// How often the roster is read when nothing asks.
pub const REFRESH: Duration = Duration::from_secs(60);
/// How long a resumed session must stay up to count as started.
const SETTLE: Duration = Duration::from_secs(5);
/// `claude agents --json`.
const AGENTS_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest an unchanged profile keeps the last `claude agents` answer.
const AGENTS_MAX_AGE: Duration = Duration::from_secs(10 * 60);
/// `claude stop` and `claude rm`.
const VERB_TIMEOUT: Duration = Duration::from_secs(30);
/// Results kept in the roster: room for a whole recovery and the requests
/// around it.
const ACTIONS_KEPT: usize = 24;
/// A resumed session's log, gone this long with its job, is removed.
const LOG_KEEP: Duration = Duration::from_secs(14 * 24 * 3600);

/// The selector each verb takes (module doc, layer 1).
pub fn check_selector(action: SessionAction, id: &str) -> Result<(), String> {
    let ok = match action {
        SessionAction::Resume => is_uuid(id),
        SessionAction::Stop => is_uuid(id) || is_short_id(id),
        SessionAction::Remove => is_short_id(id),
    };
    if ok {
        return Ok(());
    }
    Err(match action {
        SessionAction::Resume => "resume takes a session id: a canonical lowercase uuid".into(),
        SessionAction::Stop => {
            "stop takes a session id (a lowercase uuid) or a background agent's eight-digit id"
                .into()
        }
        SessionAction::Remove => "remove takes a background agent's eight-digit id".into(),
    })
}

/// A request id: sixteen hex characters from the OS's randomness.
pub fn mint_request() -> String {
    let mut b = [0u8; 8];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut b);
    hex::encode(b)
}

/// What the verbs and the roster need to know about this session.
#[derive(Clone, Debug)]
pub struct Context {
    /// The Remote Control server's job, for its accounting and its pin.
    pub server: String,
    /// The resumed sessions' job names start with this; the uuid follows.
    pub prefix: String,
    /// Where each resumed session's log goes (beside claude-rc.log).
    pub log_dir: PathBuf,
    /// `--remote-control <label>`: this machine's name, as a token.
    pub label: String,
    /// Where the running `claude`s are pinned (gcroot.rs).
    pub roots: PathBuf,
}

/// The hostname as a `--remote-control` label: letters, digits, `.`, `_`
/// and `-`, anything else a dash, at most 63.
pub fn label_of(hostname: &str) -> String {
    let l: String = hostname
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .take(63)
        .collect();
    if l.is_empty() {
        "daedalus".into()
    } else {
        l
    }
}

// ── the CLI ───────────────────────────────────────────────────────────────

/// `claude agents --json`, or None when it did not answer with an array.
fn agents(cli: Option<&Path>) -> Option<Vec<Agent>> {
    let mut cmd = Command::new(cli?);
    cmd.args(["agents", "--json"]);
    let out = crate::exec::stdout_or(cmd, AGENTS_TIMEOUT, crate::exec::Text::Lossy).ok()?;
    roster::parse_agents(&out)
}

/// `claude <verb> <id>`; its output goes to the agent's log alone.
fn claude_verb(cli: &Path, verb: &str, id: &str) {
    let mut cmd = Command::new(cli);
    cmd.args([verb, id]);
    match crate::exec::both(cmd, VERB_TIMEOUT) {
        Some(r) => tracing::info!(
            verb,
            id,
            ok = r.ok,
            output = %r.output.chars().take(400).collect::<String>(),
            "claude {verb} ran"
        ),
        None => tracing::warn!(
            verb,
            id,
            "claude {verb} did not finish in time and was killed"
        ),
    }
}

/// The profile's `sessions` and `jobs` directories' mtimes: they move when
/// a session or a background agent comes or goes, which is when `claude
/// agents` would say something new.
type AgentsStamp = [Option<std::time::SystemTime>; 2];

fn agents_stamp(dir: Option<&Path>) -> AgentsStamp {
    let at = |sub: &str| {
        dir.and_then(|d| std::fs::metadata(d.join(sub)).ok())
            .and_then(|m| m.modified().ok())
    };
    [at("sessions"), at("jobs")]
}

fn background<'a>(agents: &'a [Agent], id: &str) -> Option<&'a Agent> {
    agents
        .iter()
        .find(|a| a.id.as_deref() == Some(id) && a.kind.as_deref() == Some("background"))
}

// ── the thread ────────────────────────────────────────────────────────────

enum Msg {
    Request(SessionRequest, bool),
    /// The sessions to resume after a server restart, and whether Claude
    /// may run here at all.
    Recover(Vec<String>, bool),
}

#[derive(Default)]
struct Latest {
    generation: u64,
    roster: Option<Arc<Roster>>,
    /// The ids of the sessions it lists as managed, for the recovery set
    /// (session.rs), read every poll without the roster.
    managed: Vec<String>,
    /// The last recovery's rows.
    recovered: Vec<Recovered>,
    /// A recovery is queued or running.
    recovering: bool,
}

/// The roster and the verbs, on a thread of their own: a scan or a resume
/// takes seconds, and the session's loop — which the tray drives — must not
/// wait on either. Dropping this ends the thread after what it is doing.
pub struct Sessions {
    tx: Sender<Msg>,
    latest: Arc<Mutex<Latest>>,
}

impl Sessions {
    /// The thread, over this OS's jobs (`os::jobs::Os`) or a test's.
    pub fn start(ctx: Context, jobs: Box<dyn Jobs>) -> Self {
        let (tx, rx) = mpsc::channel();
        let latest = Arc::new(Mutex::new(Latest::default()));
        let worker = Worker {
            ctx,
            jobs,
            scanner: Scanner::default(),
            actions: VecDeque::new(),
            latest: Arc::clone(&latest),
            last: None,
            agents_read: None,
        };
        if let Err(e) = std::thread::Builder::new()
            .name("claude-sessions".into())
            .spawn(move || worker.run(rx))
        {
            tracing::error!(error = %e, "no thread for the Claude sessions; no roster will be read");
        }
        Self { tx, latest }
    }

    /// Hand one request to the thread; `wanted` is whether Claude may run
    /// here at all (the policy), which refuses every verb when off.
    pub fn submit(&self, req: SessionRequest, wanted: bool) {
        let _ = self.tx.send(Msg::Request(req, wanted));
    }

    /// Resume each of `ids`, after a server restart (recovery.rs).
    pub fn recover(&self, ids: Vec<String>, wanted: bool) {
        self.lock().recovering = true;
        if self.tx.send(Msg::Recover(ids, wanted)).is_err() {
            self.lock().recovering = false;
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Latest> {
        self.latest.lock_ok()
    }

    /// The newest roster and its generation, which moves with each one.
    pub fn latest(&self) -> Option<(u64, Arc<Roster>)> {
        let l = self.lock();
        l.roster.clone().map(|r| (l.generation, r))
    }

    /// The newest roster's generation alone.
    pub fn generation(&self) -> u64 {
        self.lock().generation
    }

    /// The sessions the newest roster lists as managed (resumed by this
    /// agent, running as their own jobs).
    pub fn managed_ids(&self) -> Vec<String> {
        self.lock().managed.clone()
    }

    /// The last recovery's rows, for the report.
    pub fn recovered(&self) -> Vec<Recovered> {
        self.lock().recovered.clone()
    }

    /// A recovery is queued or running.
    pub fn recovering(&self) -> bool {
        self.lock().recovering
    }
}

struct Worker {
    ctx: Context,
    jobs: Box<dyn Jobs>,
    scanner: Scanner,
    actions: VecDeque<ActionResult>,
    latest: Arc<Mutex<Latest>>,
    last: Option<Arc<Roster>>,
    /// The last `claude agents --json`, when, and the profile's two
    /// directories' mtimes then (`agents_now`).
    agents_read: Option<(AgentsStamp, Instant, Option<Vec<Agent>>)>,
}

/// A verb's outcome before it is recorded.
struct Outcome(ActionState, String);

fn refused(why: impl Into<String>) -> Outcome {
    Outcome(ActionState::Refused, why.into())
}

fn failed(why: impl Into<String>) -> Outcome {
    Outcome(ActionState::Failed, why.into())
}

fn done(what: impl Into<String>) -> Outcome {
    Outcome(ActionState::Done, what.into())
}

impl Worker {
    fn run(mut self, rx: Receiver<Msg>) {
        self.refresh(true);
        loop {
            match rx.recv_timeout(REFRESH) {
                Ok(Msg::Request(r, wanted)) => {
                    self.handle(r, wanted);
                    self.refresh(true);
                }
                Ok(Msg::Recover(ids, wanted)) => {
                    self.recover(&ids, wanted);
                    self.refresh(true);
                }
                Err(RecvTimeoutError::Timeout) => self.refresh(false),
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn latest(&self) -> std::sync::MutexGuard<'_, Latest> {
        self.latest.lock_ok()
    }

    fn publish(&mut self, mut r: Roster) {
        r.actions = self.actions.iter().cloned().collect();
        r.fit(roster::MAX_BYTES);
        let r = Arc::new(r);
        self.last = Some(Arc::clone(&r));
        let mut l = self.latest();
        l.generation += 1;
        l.managed = r.managed.iter().map(|m| m.id.clone()).collect();
        l.roster = Some(r);
    }

    /// One request: recorded as running at once, carried out, recorded as
    /// it ended.
    fn run_one(&mut self, req: &SessionRequest, wanted: bool, what: &str) -> Outcome {
        self.actions.push_front(ActionResult {
            request: req.request.clone(),
            action: req.action,
            id: req.id.clone(),
            state: ActionState::Running,
            detail: what.to_string(),
            started_at: now_rfc3339(),
            finished_at: None,
        });
        self.actions.truncate(ACTIONS_KEPT);
        // The running state, at once, on the roster already read.
        if let Some(r) = self.last.as_deref().cloned() {
            self.publish(r);
        }
        let Outcome(state, detail) = if !wanted {
            refused("Claude is off on this machine (its policy); no session verb runs")
        } else {
            match check_selector(req.action, &req.id) {
                Err(e) => refused(e),
                Ok(()) => match req.action {
                    SessionAction::Resume => self.resume(&req.id),
                    SessionAction::Stop => self.stop(&req.id),
                    SessionAction::Remove => self.remove(&req.id),
                },
            }
        };
        tracing::info!(request = %req.request, state = ?state, detail, "Claude session request finished");
        if let Some(a) = self.actions.iter_mut().find(|a| a.request == req.request) {
            a.state = state;
            a.detail = detail.clone();
            a.finished_at = Some(now_rfc3339());
        }
        Outcome(state, detail)
    }

    fn handle(&mut self, req: SessionRequest, wanted: bool) {
        tracing::info!(request = %req.request, action = req.action.as_str(), id = %req.id, "Claude session request");
        let what = format!("{} {}", req.action.as_str(), req.id);
        self.run_one(&req, wanted, &what);
    }

    /// Resume each session a server restart ended, one after the other.
    fn recover(&mut self, ids: &[String], wanted: bool) {
        tracing::info!(
            sessions = ids.len(),
            "recovering the Claude sessions a Remote Control restart ended"
        );
        let mut rows = Vec::new();
        for id in ids {
            let req = SessionRequest {
                request: mint_request(),
                action: SessionAction::Resume,
                id: id.clone(),
            };
            let what = format!("recovering {id} after Remote Control restarted");
            let Outcome(state, detail) = self.run_one(&req, wanted, &what);
            // The row says it was the recovery's, not an operator's request.
            if let Some(a) = self.actions.iter_mut().find(|a| a.request == req.request) {
                a.detail = format!("recovery after a Remote Control restart: {detail}");
            }
            rows.push(Recovered {
                id: id.clone(),
                result: state,
                detail,
                at: now_rfc3339(),
            });
            self.latest().recovered = rows.clone();
        }
        let mut l = self.latest();
        l.recovered = rows;
        l.recovering = false;
    }

    fn job_of(&self, id: &str) -> String {
        format!("{}{id}", self.ctx.prefix)
    }

    fn resume(&self, id: &str) -> Outcome {
        let name = self.job_of(id);
        let Some(dir) = claude_dir() else {
            return failed("no Claude profile directory (no HOME)");
        };
        // Layer 2: the tree answers for the uuid, by the directory's name.
        let Some(project) = roster::find_transcript(&dir.join("projects"), id) else {
            return refused(format!(
                "no transcript for {id} under ~/.claude/projects: there is nothing to resume"
            ));
        };
        // Layer 3: that name must be the slug of a trusted directory, which
        // is where the session runs — composed from the trusted list, never
        // from the tree.
        let Some(cwd) = trusted_projects()
            .into_iter()
            .find(|d| roster::slug(&d.display().to_string()) == project)
        else {
            return refused(format!(
                "that session ran in {}, whose workspace trust has never been accepted: \
                 a resumed session would stop on the trust prompt with nobody to answer it",
                roster::unslug(&project)
            ));
        };
        if let Ok(JobState::Running { .. }) = self.jobs.show(&name) {
            return refused(format!(
                "{id} is already running as {name}: resuming it again would start a second process on the same transcript"
            ));
        }
        let cli = find_cli();
        let Some(listed) = agents(cli.as_deref()) else {
            return refused(
                "claude agents --json did not answer, so whether this session already runs cannot be told",
            );
        };
        if listed.iter().any(|a| a.session_id.as_deref() == Some(id)) {
            return refused(format!(
                "{id} is already running (claude agents reports it): a resume would start a copy, not attach"
            ));
        }
        if roster::session_live(&read_session_files(&dir), id) {
            return refused(format!(
                "{id} already has a live process behind it: a resume would start a copy, not attach"
            ));
        }
        let Some(cli) = cli else {
            return failed("no `claude` command on this machine");
        };
        let log = self.ctx.log_dir.join(format!("{name}.log"));
        if let Err(e) = std::fs::create_dir_all(&self.ctx.log_dir).and_then(|()| {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log)?;
            writeln!(
                f,
                "── {} daedalus-agent resuming {id} in {} (job {name}) ──",
                now_rfc3339(),
                cwd.display()
            )
        }) {
            return failed(format!("the log {} was not opened: {e}", log.display()));
        }
        let path = std::env::var("PATH").ok();
        let config_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
        let env = job::session_env(
            jobs::server_env(
                home_dir().as_deref(),
                path.as_deref(),
                config_dir.as_deref(),
            ),
            Path::new("/run/wrappers/bin").is_dir(),
            self.jobs.session_shell().as_deref(),
        );
        let started = self.jobs.start_session(&SessionJob {
            name: &name,
            id,
            cli: &cli,
            label: &self.ctx.label,
            cwd: &cwd,
            log: &log,
            env: &env,
        });
        if let Err(e) = started {
            return failed(format!("{name} was not started: {e}"));
        }
        gcroot::pin(&self.ctx.roots, &name, &cli);
        // "Started" is only "exec'd": the failure worth catching is the CLI
        // leaving at once (a transcript it will not open, a login that
        // expired, a prompt nobody predicted).
        std::thread::sleep(SETTLE);
        match self.jobs.show(&name) {
            Ok(JobState::Running { .. }) => done(format!(
                "resumed {id} in {} as {name}; it appears on claude.ai within a few seconds",
                cwd.display()
            )),
            Ok(other) => failed(format!(
                "{name} is {} five seconds after starting: the session did not come up; see {}",
                match other {
                    JobState::Exited(code) => format!("exited ({code})"),
                    _ => "gone".into(),
                },
                log.display()
            )),
            Err(e) => failed(format!("{name}'s state is unknown after starting it: {e}")),
        }
    }

    fn stop(&self, id: &str) -> Outcome {
        if is_uuid(id) {
            let name = self.job_of(id);
            if !matches!(self.jobs.show(&name), Ok(JobState::Running { .. })) {
                return refused(format!(
                    "{id} is not running as {name}, and a session this agent did not resume has \
                     no stop of its own: a Remote Control session ends with its server"
                ));
            }
            if let Err(e) = self.jobs.stop(&name) {
                return failed(format!("{name} was not stopped: {e}"));
            }
            return match self.jobs.show(&name) {
                Ok(JobState::Running { .. }) => failed(format!("{name} still runs after the stop")),
                _ => {
                    self.jobs.clear(&name);
                    done(format!(
                        "stopped {id}; its transcript is intact and it can be resumed again"
                    ))
                }
            };
        }
        // A background agent: the CLI's own list is the allowlist.
        let cli = find_cli();
        let Some(listed) = agents(cli.as_deref()) else {
            return refused(
                "claude agents --json did not answer; there is no list to find the agent in",
            );
        };
        if background(&listed, id).is_none() {
            return refused(format!(
                "no background agent {id}: claude agents does not list one, so there is nothing for claude stop to end"
            ));
        }
        let Some(cli) = cli else {
            return failed("no `claude` command on this machine");
        };
        claude_verb(&cli, "stop", id);
        // What settles it is the process, not the record (the record stays
        // on purpose) and not the CLI's exit status.
        let after = agents(Some(&cli)).unwrap_or_default();
        match background(&after, id).and_then(|a| a.pid) {
            Some(pid) if crate::os::pid_alive(pid) => failed(format!(
                "background agent {id} still has a live process (pid {pid}) after claude stop"
            )),
            _ => done(format!(
                "stopped background agent {id}; nothing runs behind it. Its conversation is kept: \
                 claude attach reopens it, and remove deletes the record"
            )),
        }
    }

    fn remove(&self, id: &str) -> Outcome {
        let cli = find_cli();
        let Some(listed) = agents(cli.as_deref()) else {
            return refused(
                "claude agents --json did not answer; there is no list to find the record in",
            );
        };
        if background(&listed, id).is_none() {
            return refused(format!(
                "no background agent {id}: claude agents does not list one, so there is no record to remove"
            ));
        }
        let Some(cli) = cli else {
            return failed("no `claude` command on this machine");
        };
        claude_verb(&cli, "rm", id);
        match agents(Some(&cli)) {
            None => failed(format!(
                "claude agents --json did not answer after claude rm; whether {id} is gone cannot be told"
            )),
            Some(after) if background(&after, id).is_some() => failed(format!(
                "claude agents still lists background agent {id} after claude rm: the record was not deleted"
            )),
            Some(_) => done(format!(
                "removed background agent {id}; its record and worktree are gone"
            )),
        }
    }

    /// The sessions this agent resumed that run now, with their costs.
    fn managed(&self, errors: &mut Vec<String>) -> Vec<Managed> {
        let prefix = &self.ctx.prefix;
        let names = match self.jobs.running(prefix) {
            Ok(n) => n,
            Err(e) => {
                errors.push(format!(
                    "the resumed sessions' jobs could not be listed: {e}"
                ));
                return Vec::new();
            }
        };
        names
            .into_iter()
            .filter_map(|j| {
                let id = j.name.strip_prefix(prefix.as_str())?.to_string();
                is_uuid(&id).then_some((j, id))
            })
            .map(|(j, id)| {
                let log = self.ctx.log_dir.join(format!("{}.log", j.name));
                Managed {
                    log_bytes: std::fs::metadata(&log).ok().map(|m| m.len()),
                    log: log.display().to_string(),
                    pid: j.pid,
                    memory_bytes: j.cost.memory_bytes,
                    cpu_nsec: j.cost.cpu_nsec,
                    job: j.name,
                    id,
                }
            })
            .collect()
    }

    /// The resumed sessions' logs: rotated while their job runs, removed a
    /// while after it is gone.
    fn tend_logs(&self, managed: &[Managed]) {
        let prefix = &self.ctx.prefix;
        for m in managed {
            let _ = super::logs::rotate_if_larger(Path::new(&m.log), super::logs::ROTATE_BYTES);
        }
        let Ok(entries) = std::fs::read_dir(&self.ctx.log_dir) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix(prefix.as_str()) else {
                continue;
            };
            let id = rest
                .strip_suffix(".log")
                .or_else(|| rest.strip_suffix(".log.1"))
                .unwrap_or_default();
            if !is_uuid(id) || managed.iter().any(|m| m.id == id) {
                continue;
            }
            let old = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > LOG_KEEP);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }

    /// The pins (gcroot.rs): each managed session's made where missing, and
    /// those of jobs that are gone removed — the server's while it
    /// runs, and each resumed session's while it is managed.
    fn tend_pins(&self, managed: &[Managed], listed: bool) {
        // Only a job known to be gone loses its pin: not knowing keeps it.
        let server_runs = || {
            !matches!(
                self.jobs.show(&self.ctx.server),
                Ok(JobState::Gone | JobState::Exited(_))
            )
        };
        gcroot::sweep(&self.ctx.roots, |name| {
            if name == self.ctx.server {
                server_runs()
            } else if name.starts_with(self.ctx.prefix.as_str()) {
                !listed || managed.iter().any(|m| m.job == name)
            } else {
                // Not one of this session's names: left alone.
                true
            }
        });
        // A session resumed by an earlier agent (or before its pin was
        // made) is pinned now, from the claude its job runs.
        for m in managed {
            if std::fs::symlink_metadata(self.ctx.roots.join(&m.job)).is_err() {
                if let Some(cli) = self.jobs.running_cli(&m.job) {
                    gcroot::pin(&self.ctx.roots, &m.job, &cli);
                }
            }
        }
    }

    /// `claude agents --json` — a Node start, the heaviest thing a refresh
    /// does — or what it last said, while `~/.claude/sessions` and
    /// `~/.claude/jobs` have not moved since and it is younger than
    /// `AGENTS_MAX_AGE`. A verb's refresh (`fresh`) always asks.
    fn agents_now(&mut self, dir: Option<&Path>, fresh: bool) -> Option<Vec<Agent>> {
        let stamp = agents_stamp(dir);
        if let Some((s, at, listed)) = &self.agents_read {
            if !fresh && *s == stamp && at.elapsed() < AGENTS_MAX_AGE {
                return listed.clone();
            }
        }
        let listed = agents(find_cli().as_deref());
        self.agents_read = Some((stamp, Instant::now(), listed.clone()));
        listed
    }

    fn refresh(&mut self, fresh_agents: bool) {
        let mut errors = Vec::new();
        let dir = claude_dir();
        let listed = self.agents_now(dir.as_deref(), fresh_agents);
        let found = match &dir {
            Some(d) => self.scanner.transcripts(&d.join("projects"), &mut errors),
            None => {
                errors.push("no Claude profile directory (no HOME)".into());
                roster::Found {
                    transcripts: Vec::new(),
                    total: 0,
                    empty: 0,
                }
            }
        };
        let before = errors.len();
        let managed = self.managed(&mut errors);
        // The listing failed when it added an error: nothing is unpinned then.
        let jobs_listed = errors.len() == before;
        self.tend_logs(&managed);
        self.tend_pins(&managed, jobs_listed);
        let session_stats = dir
            .as_deref()
            .map(|d| roster::session_stats(&read_session_files(d), roster::bridge_dir().as_deref()))
            .unwrap_or_default();
        let r = Roster {
            reported_at: now_rfc3339(),
            agents_available: listed.is_some(),
            agents: listed.unwrap_or_default(),
            transcripts: found.transcripts,
            transcript_total: found.total,
            empty_count: found.empty,
            truncated: false,
            managed,
            session_stats,
            server: self.jobs.cost(&self.ctx.server),
            actions: Vec::new(),
            errors,
        };
        self.publish(r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "abdda3a9-0cb2-43f1-b13e-37f25a755fce";

    #[test]
    fn each_verb_takes_its_own_selector() {
        use SessionAction::*;
        assert!(check_selector(Resume, ID).is_ok());
        assert!(check_selector(Resume, "0a1b2c3d").is_err());
        assert!(check_selector(Stop, ID).is_ok());
        assert!(check_selector(Stop, "0a1b2c3d").is_ok());
        assert!(check_selector(Remove, "0a1b2c3d").is_ok());
        assert!(check_selector(Remove, ID).is_err());
        for bad in [
            "",
            "../x",
            "0a1b2c3d;rm",
            "--discard-unpushed",
            &ID.to_uppercase(),
        ] {
            for a in [Resume, Stop, Remove] {
                assert!(check_selector(a, bad).is_err(), "{a:?} {bad}");
            }
        }
        let r = mint_request();
        assert_eq!(r.len(), 16);
        assert!(r.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(r, mint_request());
        assert_eq!(label_of("s2-server"), "s2-server");
        assert_eq!(label_of("Santiago’s MacBook Pro"), "Santiago-s-MacBook-Pro");
        assert_eq!(label_of(""), "daedalus");
    }

    /// The thread, end to end, with no `claude` and a HOME of its own: a
    /// roster comes, a verb with the policy off is refused, a malformed
    /// selector is refused, a resume with no transcript is refused, and a
    /// recovery reports each session it tried.
    #[test]
    fn the_thread_reads_a_roster_and_refuses_what_it_must() {
        let tag = std::process::id();
        let s = Sessions::start(
            Context {
                server: format!("daedalus-agent-test-rc-{tag}"),
                prefix: format!("daedalus-agent-test-session-{tag}-"),
                log_dir: std::env::temp_dir(),
                label: "test".into(),
                roots: std::env::temp_dir().join(format!("daedalus-test-roots-{tag}")),
            },
            Box::new(crate::os::jobs::Os),
        );
        let wait_for = |pred: &dyn Fn(&Roster) -> bool| {
            let until = std::time::Instant::now() + Duration::from_secs(20);
            loop {
                if let Some((_, r)) = s.latest() {
                    if pred(&r) {
                        return r;
                    }
                }
                assert!(std::time::Instant::now() < until, "no such roster");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        wait_for(&|_| true);
        let req = |request: &str, action, id: &str| SessionRequest {
            request: request.into(),
            action,
            id: id.into(),
        };
        s.submit(req("0000000000000001", SessionAction::Resume, ID), false);
        s.submit(
            req("0000000000000002", SessionAction::Remove, "../etc"),
            true,
        );
        s.submit(req("0000000000000003", SessionAction::Resume, ID), true);
        let r = wait_for(&|r| {
            r.actions.len() == 3 && r.actions.iter().all(|a| a.finished_at.is_some())
        });
        let by = |q: &str| r.actions.iter().find(|a| a.request == q).unwrap();
        assert_eq!(by("0000000000000001").state, ActionState::Refused);
        assert!(by("0000000000000001").detail.contains("policy"));
        assert_eq!(by("0000000000000002").state, ActionState::Refused);
        assert!(by("0000000000000002").detail.contains("eight-digit"));
        // No transcript (or no profile at all) for this uuid on a test
        // machine: refused or failed before anything starts, never done.
        assert_ne!(by("0000000000000003").state, ActionState::Done);
        assert_eq!(r.actions[0].request, "0000000000000003", "newest first");
        // A recovery: one row per session, in the actions and the report.
        s.recover(vec![ID.to_string()], false);
        let until = std::time::Instant::now() + Duration::from_secs(20);
        while s.recovering() {
            assert!(
                std::time::Instant::now() < until,
                "the recovery never ended"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let rows = s.recovered();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (rows[0].id.as_str(), rows[0].result),
            (ID, ActionState::Refused)
        );
        let r = wait_for(&|r| {
            r.actions.len() == 4 && r.actions[0].detail.starts_with("recovery after")
        });
        assert!(r.actions[0].detail.contains("policy"));
        assert_eq!(r.actions[0].action, SessionAction::Resume);
    }
}
