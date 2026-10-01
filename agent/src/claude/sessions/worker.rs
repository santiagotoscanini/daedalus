//! The sessions' thread: the roster read every `REFRESH` and after each
//! request, the requests run one after another (verbs.rs), and what it
//! found published for the session (`Latest`).

use std::collections::VecDeque;
use std::path::Path;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::verbs::{agents, refused, Outcome};
use super::{
    check_selector, mint_request, Context, Latest, Msg, ACTIONS_KEPT, AGENTS_MAX_AGE, LOG_KEEP,
    REFRESH,
};
use crate::claude::cli::find_cli;
use crate::claude::profile::{claude_dir, read_session_files};
use crate::claude::roster::{self, is_uuid, ActionResult, Agent, Managed, Roster, Scanner};
use crate::claude::{gcroot, ActionState, Recovered, SessionAction, SessionRequest};
use crate::jobs::{JobState, Jobs};
use crate::state::now_rfc3339;
use crate::util::LockExt;

/// The profile's `sessions` and `jobs` directories' mtimes: they move when
/// a session or a background agent comes or goes, which is when `claude
/// agents` would say something new.
pub(super) type AgentsStamp = [Option<std::time::SystemTime>; 2];

fn agents_stamp(dir: Option<&Path>) -> AgentsStamp {
    let at = |sub: &str| {
        dir.and_then(|d| std::fs::metadata(d.join(sub)).ok())
            .and_then(|m| m.modified().ok())
    };
    [at("sessions"), at("jobs")]
}

pub(super) struct Worker {
    pub(super) ctx: Context,
    pub(super) jobs: Box<dyn Jobs>,
    pub(super) scanner: Scanner,
    pub(super) actions: VecDeque<ActionResult>,
    pub(super) latest: Arc<Mutex<Latest>>,
    pub(super) last: Option<Arc<Roster>>,
    /// The last `claude agents --json`, when, and the profile's two
    /// directories' mtimes then (`agents_now`).
    pub(super) agents_read: Option<(AgentsStamp, Instant, Option<Vec<Agent>>)>,
}

impl Worker {
    pub(super) fn run(mut self, rx: Receiver<Msg>) {
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
            let _ = crate::claude::logs::rotate_if_larger(
                Path::new(&m.log),
                crate::claude::logs::ROTATE_BYTES,
            );
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
