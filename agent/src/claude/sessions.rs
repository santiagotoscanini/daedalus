//! The three verbs on one Claude Code session — resume, stop, remove — and
//! the thread that runs them and keeps the roster (roster.rs) fresh.
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
//!    and a unit would sit there started and useless.
//!
//! **Resume** starts `claude --resume <uuid> --remote-control <hostname>` as
//! a transient systemd user unit, `claude-session-<uuid>` (a development run
//! with `DAEDALUS_AGENT_DATA_DIR` names its own, config.rs), in that
//! directory, with the environment the Remote Control unit gets — HOME, the
//! session's PATH with `~/.local/bin` first and `/run/wrappers/bin` (sudo,
//! for a session that rebuilds), CLAUDE_CONFIG_DIR — plus TERM. Under a
//! PTY, and that is not optional: with pipes the CLI falls back to --print
//! mode and exits in a second; `script` gives it the terminal, stays its
//! parent, and its output is filtered on the way to the unit's log (ANSI
//! stripped, the status box's once-a-second repaint dropped). The unit is
//! its own cgroup, so the session outlives the agent: a restart or an update
//! of the agent ends nothing, and the next start finds it (`managed`). It is
//! refused when anything already runs that session — its unit, the CLI's
//! agents, a live session file — because `--resume` of a running session
//! starts a copy and two processes would append to one transcript. Five
//! seconds after the start the unit must still run, or the resume failed.
//!
//! The unit is the handle, which is why resume needs one: on Windows and
//! macOS the session is the tray's child and a resumed session would end
//! with it; there `resume` is refused, and the roster says why
//! (`resume_unavailable`).
//!
//! **Stop** of a uuid ends a session this agent resumed: `systemctl --user
//! stop` of its unit, which ends the whole cgroup — no pid to match. A
//! session the Remote Control server spawned has no stop of its own; it ends
//! with its server. Stop of a short id is `claude stop <id>`, the CLI's own
//! verb for a background agent, which keeps the conversation (`claude
//! attach` reopens it); what settles it is no process left behind the id,
//! not the CLI's exit status.
//!
//! **Remove** is `claude rm <short id>`: a background agent's record and its
//! worktree, and settled by the record being gone. Never
//! `--discard-unpushed` — that throws away commits.
//!
//! What a verb did is reported in the roster's `actions` (`ActionResult`) in
//! a sentence of the agent's own; what the CLI printed goes to the agent's
//! log and nowhere else — it is session content.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::cli::find_cli;
use super::profile::{claude_dir, home_dir};
use super::roster::{self, is_short_id, is_uuid, ActionResult, Agent, Managed, Roster, Scanner};
use super::unit::{self, Launch, UnitState};
use super::workdir::trusted_projects;
use super::{ActionState, SessionAction, SessionRequest};
use crate::state::now_rfc3339;

/// How often the roster is read when nothing asks.
pub const REFRESH: Duration = Duration::from_secs(60);
/// How long a resumed session must stay up to count as started.
const SETTLE: Duration = Duration::from_secs(5);
/// `claude agents --json`.
const AGENTS_TIMEOUT: Duration = Duration::from_secs(10);
/// `claude stop` and `claude rm`.
const VERB_TIMEOUT: Duration = Duration::from_secs(30);
/// Results kept in the roster.
const ACTIONS_KEPT: usize = 8;
/// A resumed session's log, gone this long with its unit, is removed.
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

/// Why resume is not offered where the server is the session's child.
pub const NO_UNIT: &str = "resuming a session needs a transient systemd user unit to hold it, \
     so it outlives the agent; on this machine Claude runs as the session's child \
     (claude_rc = \"child\"), and a resumed session would end with the tray";

/// What the verbs and the roster need to know about this session.
#[derive(Clone, Debug)]
pub struct Context {
    /// How the Remote Control server runs: its unit's accounting when a unit.
    pub launch: Launch,
    /// The resumed sessions' unit names start with this; None where the
    /// server is a child and no unit is made (`NO_UNIT`).
    pub unit_prefix: Option<String>,
    /// Where each resumed session's log goes (beside claude-rc.log).
    pub log_dir: PathBuf,
    /// `--remote-control <label>`: this machine's name, as a token.
    pub label: String,
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

/// The tools a resumed session's command line runs through.
#[derive(Clone, Debug)]
pub struct Tools {
    pub sh: PathBuf,
    pub script: PathBuf,
    pub sed: PathBuf,
    pub grep: PathBuf,
}

impl Tools {
    fn locate() -> Result<Self, String> {
        let find = |t: &str, why: &str| {
            crate::exec::locate(t).ok_or_else(|| format!("no `{t}` on this machine ({why})"))
        };
        Ok(Self {
            sh: find("sh", "the session's command line")?,
            script: find("script", "util-linux: the terminal the session needs")?,
            sed: find("sed", "the log filter")?,
            grep: find("grep", "the log filter")?,
        })
    }
}

/// A word for `sh`, single-quoted.
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The log filter: ANSI escapes and hyperlinks stripped, empty lines and
/// the status box (lines opening with `·` or whitespace) dropped. No `$` and
/// no `%` in any of it: systemd expands both in a unit's command line.
const SED_EXPR: &str = r"s/\x1b\[[0-9;]*[A-Za-z]//g; s/\x1b\]8;;[^\x07]*\x07//g; /./!d";
const GREP_EXPR: &str = "^·|^[[:space:]]";

/// `systemd-run`'s arguments for one resume — pure, and the whole of what a
/// resumed session is started with: the argv fixed here, the selector and
/// the directory checked before it is called.
#[allow(clippy::too_many_arguments)]
pub fn resume_args(
    unit: &str,
    id: &str,
    cli: &Path,
    label: &str,
    cwd: &Path,
    log: &Path,
    env: &[(String, String)],
    tools: &Tools,
) -> Result<Vec<String>, String> {
    if !is_uuid(id) {
        return Err(format!("not a session id: {id:?}"));
    }
    let cli_s = cli.display().to_string();
    if cli_s
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '$' | '`' | '\\' | '%'))
    {
        return Err(format!(
            "the claude path {cli_s:?} has characters a command line cannot carry safely"
        ));
    }
    if label
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
    {
        return Err(format!("the label {label:?} is not a token"));
    }
    for p in [&tools.sh, &tools.script, &tools.sed, &tools.grep] {
        if p.display().to_string().contains(['$', '%']) {
            return Err(format!("the tool path {} cannot be carried", p.display()));
        }
    }
    let inner = format!("\"{cli_s}\" --resume {id} --remote-control {label}");
    let line = format!(
        "{} -qfec {} /dev/null | {} -u -E {} | {{ {} --line-buffered -Ev {} || true; }}",
        sq(&tools.script.display().to_string()),
        sq(&inner),
        sq(&tools.sed.display().to_string()),
        sq(SED_EXPR),
        sq(&tools.grep.display().to_string()),
        sq(GREP_EXPR),
    );
    let mut a = vec![
        "--user".to_string(),
        format!("--unit={unit}"),
        format!("--description=Claude Code session {id}, resumed by daedalus-agent"),
        "--property=TimeoutStopSec=15".into(),
        // A stop is a requested end: SIGTERM's exit is a success.
        "--property=SuccessExitStatus=143".into(),
        format!("--property=StandardOutput=append:{}", log.display()),
        format!("--property=StandardError=append:{}", log.display()),
        format!("--working-directory={}", cwd.display()),
    ];
    a.extend(env.iter().map(|(k, v)| format!("--setenv={k}={v}")));
    a.push("--".into());
    a.push(tools.sh.display().to_string());
    a.push("-c".into());
    a.push(line);
    Ok(a)
}

/// The environment of a resumed session: the Remote Control unit's
/// (`unit::unit_env`), with `/run/wrappers/bin` on PATH where it exists,
/// TERM for the TUI, and SHELL for `script`.
pub fn resume_env(
    home: Option<&Path>,
    path: Option<&str>,
    config_dir: Option<&str>,
    wrappers: bool,
    sh: &Path,
) -> Vec<(String, String)> {
    let path = match (wrappers, path) {
        (true, Some(p)) if !p.split(':').any(|d| d == "/run/wrappers/bin") => {
            Some(format!("/run/wrappers/bin:{p}"))
        }
        (true, None) => Some("/run/wrappers/bin".to_string()),
        (_, p) => p.map(str::to_string),
    };
    let mut env = unit::unit_env(home, path.as_deref(), config_dir);
    env.push(("TERM".into(), "xterm-256color".into()));
    env.push(("SHELL".into(), sh.display().to_string()));
    env
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

fn background<'a>(agents: &'a [Agent], id: &str) -> Option<&'a Agent> {
    agents
        .iter()
        .find(|a| a.id.as_deref() == Some(id) && a.kind.as_deref() == Some("background"))
}

// ── the thread ────────────────────────────────────────────────────────────

enum Msg {
    Request(SessionRequest, bool),
}

#[derive(Default)]
struct Latest {
    generation: u64,
    roster: Option<Roster>,
}

/// The roster and the verbs, on a thread of their own: a scan or a resume
/// takes seconds, and the session's loop — which the tray drives — must not
/// wait on either. Dropping this ends the thread after what it is doing.
pub struct Sessions {
    tx: Sender<Msg>,
    latest: Arc<Mutex<Latest>>,
}

impl Sessions {
    pub fn start(ctx: Context) -> Self {
        let (tx, rx) = mpsc::channel();
        let latest = Arc::new(Mutex::new(Latest::default()));
        let worker = Worker {
            ctx,
            scanner: Scanner::default(),
            actions: VecDeque::new(),
            latest: Arc::clone(&latest),
            last: None,
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

    /// The newest roster and its generation, which moves with each one.
    pub fn latest(&self) -> Option<(u64, Roster)> {
        let l = self.latest.lock().unwrap_or_else(|p| p.into_inner());
        l.roster.clone().map(|r| (l.generation, r))
    }
}

struct Worker {
    ctx: Context,
    scanner: Scanner,
    actions: VecDeque<ActionResult>,
    latest: Arc<Mutex<Latest>>,
    last: Option<Roster>,
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
        self.refresh();
        loop {
            match rx.recv_timeout(REFRESH) {
                Ok(Msg::Request(r, wanted)) => {
                    self.handle(r, wanted);
                    self.refresh();
                }
                Err(RecvTimeoutError::Timeout) => self.refresh(),
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn publish(&mut self, mut r: Roster) {
        r.actions = self.actions.iter().cloned().collect();
        r.fit(roster::MAX_BYTES);
        self.last = Some(r.clone());
        let mut l = self.latest.lock().unwrap_or_else(|p| p.into_inner());
        l.generation += 1;
        l.roster = Some(r);
    }

    fn handle(&mut self, req: SessionRequest, wanted: bool) {
        tracing::info!(request = %req.request, action = req.action.as_str(), id = %req.id, "Claude session request");
        self.actions.push_front(ActionResult {
            request: req.request.clone(),
            action: req.action,
            id: req.id.clone(),
            state: ActionState::Running,
            detail: format!("{} {}", req.action.as_str(), req.id),
            started_at: now_rfc3339(),
            finished_at: None,
        });
        self.actions.truncate(ACTIONS_KEPT);
        // The running state, at once, on the roster already read.
        if let Some(r) = self.last.clone() {
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
            a.detail = detail;
            a.finished_at = Some(now_rfc3339());
        }
    }

    fn unit_of(&self, id: &str) -> Option<String> {
        self.ctx.unit_prefix.as_ref().map(|p| format!("{p}{id}"))
    }

    fn resume(&self, id: &str) -> Outcome {
        let Some(unit) = self.unit_of(id) else {
            return refused(NO_UNIT);
        };
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
        if let Ok(UnitState::Running { .. }) = unit::show(&unit) {
            return refused(format!(
                "{id} is already running as {unit}: resuming it again would start a second process on the same transcript"
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
        if roster::session_live(&dir, id) {
            return refused(format!(
                "{id} already has a live process behind it: a resume would start a copy, not attach"
            ));
        }
        let Some(cli) = cli else {
            return failed("no `claude` command on this machine");
        };
        let tools = match Tools::locate() {
            Ok(t) => t,
            Err(e) => return failed(e),
        };
        let log = self.ctx.log_dir.join(format!("{unit}.log"));
        if let Err(e) = std::fs::create_dir_all(&self.ctx.log_dir).and_then(|()| {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log)?;
            writeln!(
                f,
                "── {} daedalus-agent resuming {id} in {} (unit {unit}) ──",
                now_rfc3339(),
                cwd.display()
            )
        }) {
            return failed(format!("the log {} was not opened: {e}", log.display()));
        }
        let path = std::env::var("PATH").ok();
        let config_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
        let env = resume_env(
            home_dir().as_deref(),
            path.as_deref(),
            config_dir.as_deref(),
            Path::new("/run/wrappers/bin").is_dir(),
            &tools.sh,
        );
        let args = match resume_args(&unit, id, &cli, &self.ctx.label, &cwd, &log, &env, &tools) {
            Ok(a) => a,
            Err(e) => return failed(e),
        };
        // A previous run that failed leaves the name taken.
        let name = format!("{unit}.service");
        let _ = unit::systemctl(&["reset-failed", &name]);
        if let Err(e) = unit::command("systemd-run", &args) {
            return failed(format!("{unit} was not started: {e}"));
        }
        // "Started" is only "exec'd": the failure worth catching is the CLI
        // leaving at once (a transcript it will not open, a login that
        // expired, a prompt nobody predicted).
        std::thread::sleep(SETTLE);
        match unit::show(&unit) {
            Ok(UnitState::Running { .. }) => done(format!(
                "resumed {id} in {} as {unit}; it appears on claude.ai within a few seconds",
                cwd.display()
            )),
            Ok(other) => failed(format!(
                "{unit} is {} five seconds after starting: the session did not come up; see {}",
                match other {
                    UnitState::Exited(code) => format!("exited ({code})"),
                    _ => "gone".into(),
                },
                log.display()
            )),
            Err(e) => failed(format!("{unit}'s state is unknown after starting it: {e}")),
        }
    }

    fn stop(&self, id: &str) -> Outcome {
        if is_uuid(id) {
            let Some(unit) = self.unit_of(id) else {
                return refused(format!(
                    "{id} was not resumed by this agent (nothing is resumed here: {NO_UNIT}), and a \
                     Remote Control session has no stop of its own: it ends with its server"
                ));
            };
            if !matches!(unit::show(&unit), Ok(UnitState::Running { .. })) {
                return refused(format!(
                    "{id} is not running as {unit}, and a session this agent did not resume has \
                     no stop of its own: a Remote Control session ends with its server"
                ));
            }
            let name = format!("{unit}.service");
            if let Err(e) = unit::systemctl(&["stop", &name]) {
                return failed(format!("{unit} was not stopped: {e}"));
            }
            return match unit::show(&unit) {
                Ok(UnitState::Running { .. }) => {
                    failed(format!("{unit} still runs after the stop"))
                }
                _ => {
                    let _ = unit::systemctl(&["reset-failed", &name]);
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
        let Some(prefix) = &self.ctx.unit_prefix else {
            return Vec::new();
        };
        let pattern = format!("{prefix}*.service");
        let text = match unit::systemctl(&[
            "list-units",
            "--type=service",
            "--all",
            "--no-legend",
            "--plain",
            &pattern,
        ]) {
            Ok(t) => t,
            Err(e) => {
                errors.push(format!(
                    "the resumed sessions' units could not be listed: {e}"
                ));
                return Vec::new();
            }
        };
        roster::parse_managed_units(&text, prefix)
            .into_iter()
            .map(|id| {
                let unit = format!("{prefix}{id}");
                let cost = unit_cost(&unit);
                let pid = match unit::show(&unit) {
                    Ok(UnitState::Running { pid, .. }) => pid,
                    _ => None,
                };
                let log = self.ctx.log_dir.join(format!("{unit}.log"));
                Managed {
                    log_bytes: std::fs::metadata(&log).ok().map(|m| m.len()),
                    log: log.display().to_string(),
                    pid,
                    memory_bytes: cost.memory_bytes,
                    cpu_nsec: cost.cpu_nsec,
                    unit,
                    id,
                }
            })
            .collect()
    }

    /// The resumed sessions' logs: rotated while their unit runs, removed a
    /// while after it is gone.
    fn tend_logs(&self, managed: &[Managed]) {
        let Some(prefix) = &self.ctx.unit_prefix else {
            return;
        };
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

    fn refresh(&mut self) {
        let mut errors = Vec::new();
        let dir = claude_dir();
        let cli = find_cli();
        let listed = agents(cli.as_deref());
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
        let managed = self.managed(&mut errors);
        self.tend_logs(&managed);
        let session_stats = match (&dir, crate::os::PROCESS_STATS) {
            (Some(d), true) => roster::session_stats(d, roster::bridge_dir().as_deref()),
            (_, false) => {
                errors.push(format!(
                    "per-session CPU, memory and bridge logs are read on Linux only, not on {}",
                    std::env::consts::OS
                ));
                Vec::new()
            }
            (None, true) => Vec::new(),
        };
        let server = match &self.ctx.launch {
            Launch::Unit(name) => Some(unit_cost(name)),
            Launch::Child => None,
        };
        let r = Roster {
            reported_at: now_rfc3339(),
            agents_available: listed.is_some(),
            agents: listed.unwrap_or_default(),
            transcripts: found.transcripts,
            transcript_total: found.total,
            empty_count: found.empty,
            truncated: false,
            managed,
            resume_unavailable: self.ctx.unit_prefix.is_none().then(|| NO_UNIT.to_string()),
            session_stats,
            server,
            actions: Vec::new(),
            errors,
        };
        self.publish(r);
    }
}

/// A unit's memory and CPU from the user manager.
fn unit_cost(unit: &str) -> roster::UnitCost {
    let name = format!("{unit}.service");
    unit::systemctl(&["show", &name, "-p", "MemoryCurrent", "-p", "CPUUsageNSec"])
        .map(|t| roster::parse_unit_cost(&t))
        .unwrap_or_default()
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

    #[cfg(unix)]
    #[test]
    fn a_resume_is_one_fixed_command_line() {
        let tools = Tools {
            sh: "/bin/sh".into(),
            script: "/usr/bin/script".into(),
            sed: "/usr/bin/sed".into(),
            grep: "/usr/bin/grep".into(),
        };
        let env = resume_env(
            Some(Path::new("/home/ana")),
            Some("/usr/bin:/bin"),
            None,
            true,
            &tools.sh,
        );
        assert_eq!(
            env,
            [
                ("CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE", "1"),
                ("HOME", "/home/ana"),
                (
                    "PATH",
                    "/home/ana/.local/bin:/run/wrappers/bin:/usr/bin:/bin"
                ),
                ("TERM", "xterm-256color"),
                ("SHELL", "/bin/sh"),
            ]
            .map(|(k, v)| (k.to_string(), v.to_string()))
        );
        let a = resume_args(
            &format!("claude-session-{ID}"),
            ID,
            Path::new("/home/ana/.local/bin/claude"),
            "s2-server",
            Path::new("/etc/nixos"),
            Path::new("/logs/claude-session.log"),
            &env[..1],
            &tools,
        )
        .unwrap();
        assert_eq!(
            a,
            [
                "--user".to_string(),
                format!("--unit=claude-session-{ID}"),
                format!("--description=Claude Code session {ID}, resumed by daedalus-agent"),
                "--property=TimeoutStopSec=15".into(),
                "--property=SuccessExitStatus=143".into(),
                "--property=StandardOutput=append:/logs/claude-session.log".into(),
                "--property=StandardError=append:/logs/claude-session.log".into(),
                "--working-directory=/etc/nixos".into(),
                "--setenv=CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=1".into(),
                "--".into(),
                "/bin/sh".into(),
                "-c".into(),
                format!(
                    "'/usr/bin/script' -qfec '\"/home/ana/.local/bin/claude\" --resume {ID} --remote-control s2-server' /dev/null \
                     | '/usr/bin/sed' -u -E 's/\\x1b\\[[0-9;]*[A-Za-z]//g; s/\\x1b\\]8;;[^\\x07]*\\x07//g; /./!d' \
                     | {{ '/usr/bin/grep' --line-buffered -Ev '^·|^[[:space:]]' || true; }}"
                ),
            ]
        );
        assert!(!a.last().unwrap().contains(['$', '%']));
        // Nothing from outside the checks reaches it.
        let bad = |id: &str, cli: &str, label: &str| {
            resume_args(
                "u",
                id,
                Path::new(cli),
                label,
                Path::new("/p"),
                Path::new("/l"),
                &[],
                &tools,
            )
            .is_err()
        };
        assert!(bad("0a1b2c3d", "/c", "l"));
        assert!(bad(ID, "/home/$USER/claude", "l"));
        assert!(bad(ID, "/home/a\"b/claude", "l"));
        assert!(bad(ID, "/c", "a b"));
        assert!(bad(ID, "/c", "x;rm"));
        // PATH already carrying the wrappers is left as it is.
        let env = resume_env(None, Some("/run/wrappers/bin:/bin"), None, true, &tools.sh);
        assert_eq!(env[1], ("PATH".into(), "/run/wrappers/bin:/bin".into()));
    }

    /// The thread, end to end, with no `claude` and no units: a roster
    /// comes, a verb with the policy off is refused, a malformed selector
    /// is refused, and a resume where no unit runs says why.
    #[test]
    fn the_thread_reads_a_roster_and_refuses_what_it_must() {
        let s = Sessions::start(Context {
            launch: Launch::Child,
            unit_prefix: None,
            log_dir: std::env::temp_dir(),
            label: "test".into(),
        });
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
        let r = wait_for(&|_| true);
        assert_eq!(r.resume_unavailable.as_deref(), Some(NO_UNIT));
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
        assert_eq!(by("0000000000000003").state, ActionState::Refused);
        assert_eq!(by("0000000000000003").detail, NO_UNIT);
        assert_eq!(r.actions[0].request, "0000000000000003", "newest first");
    }
}
