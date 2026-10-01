//! Claude Code on this machine as the session reports it: its last report
//! and roster, and the instructions waiting for its next poll.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::claude::{Report, ReportAnswer, Roster, SessionAction, SessionRequest};
use crate::link::wire::Policy;
use crate::util::LockExt;

/// A report older than this means the tray is gone (logged off, or no
/// desktop session at all), and the page says so instead of repeating it.
const REPORT_FRESH: Duration = Duration::from_secs(30);
/// A roster older than this is not served: the session sends one at least
/// every `sessions::REFRESH`.
const ROSTER_FRESH: Duration = Duration::from_secs(180);
/// Session verb requests waiting for the session, at most.
pub const MAX_QUEUED_SESSIONS: usize = 8;

#[derive(Default)]
pub struct ClaudeHub(Mutex<Live>);

#[derive(Default)]
struct Live {
    /// The session's last report and when it landed.
    report: Option<(Report, Instant)>,
    /// Moves when a report says something the last did not (its clock
    /// aside): what the link compares to push on change (link/node.rs).
    report_generation: u64,
    /// Raised by the controller's command or the local socket's
    /// `claude.update`; the session takes it with its next report. Separate
    /// from the restart below (claude/mod.rs says why).
    update_requested: bool,
    /// Raised by the controller's command or the local socket's
    /// `claude.restart`; the session takes it with its next report.
    restart_requested: bool,
    /// Verb requests for the sessions (claude/sessions/), accepted by the
    /// API or the link and handed to the session with its next report.
    sessions: Vec<SessionRequest>,
    /// The session's last roster (claude/roster/) and when it landed,
    /// shared rather than copied: it runs to `roster::MAX_BYTES`.
    roster: Option<(Arc<Roster>, Instant)>,
    /// Moves when a roster says something the last did not (`Roster::moved`).
    roster_generation: u64,
}

impl Live {
    fn fresh(&self) -> Option<&Report> {
        self.report
            .as_ref()
            .filter(|(_, at)| at.elapsed() < REPORT_FRESH)
            .map(|(r, _)| r)
    }
}

impl ClaudeHub {
    /// The session's report; answers with `policy`'s word and takes the
    /// pending instructions. `mem::take` on each, so an instruction is
    /// handed out exactly once — a session that reports every five seconds
    /// must not be told to update five seconds later all over again.
    pub fn take_report(&self, r: Report, policy: &Policy) -> ReportAnswer {
        let mut l = self.0.lock_ok();
        // The clock aside: the previous report is replaced just below.
        let says_more = match l.report.as_mut() {
            Some((prev, _)) => {
                prev.reported_at.clone_from(&r.reported_at);
                *prev != r
            }
            None => true,
        };
        if says_more {
            l.report_generation += 1;
        }
        l.report = Some((r, Instant::now()));
        ReportAnswer {
            wanted: policy.claude_remote_control,
            update: std::mem::take(&mut l.update_requested),
            restart: std::mem::take(&mut l.restart_requested),
            workdir: policy.claude_workdir.clone(),
            sessions: std::mem::take(&mut l.sessions),
        }
    }

    /// The session's last report while it is fresh; None when no session
    /// has reported within `REPORT_FRESH`.
    pub fn report(&self) -> Option<Report> {
        self.0.lock_ok().fresh().cloned()
    }

    /// Whether the session has reported within the freshness window.
    pub fn reporting(&self) -> bool {
        self.0.lock_ok().fresh().is_some()
    }

    /// The generation of the session's report (`take_report`), and whether
    /// one is fresh: what the link compares before it copies the report.
    pub fn report_generation(&self) -> (u64, bool) {
        let l = self.0.lock_ok();
        (l.report_generation, l.fresh().is_some())
    }

    /// The status page's view of the session: its summary while fresh,
    /// whether it reports, when it last did, and the two instructions
    /// waiting.
    pub fn view(&self) -> View {
        let l = self.0.lock_ok();
        View {
            summary: l.fresh().map(Report::summary),
            last_report: l.report.as_ref().map(|(r, _)| r.reported_at.clone()),
            update_requested: l.update_requested,
            restart_requested: l.restart_requested,
        }
    }

    /// Whether an update, a restart or a session verb waits for the
    /// session's next report.
    pub fn instruction_waiting(&self) -> bool {
        let l = self.0.lock_ok();
        l.update_requested || l.restart_requested || !l.sessions.is_empty()
    }

    pub fn request_update(&self) {
        self.0.lock_ok().update_requested = true;
    }

    pub fn request_restart(&self) {
        self.0.lock_ok().restart_requested = true;
    }

    /// A verb request for the session, taken with its next report. None
    /// when `MAX_QUEUED_SESSIONS` already wait: a session that is not
    /// taking them is not one to pile more on.
    pub fn queue_session(&self, action: SessionAction, id: String) -> Option<String> {
        let request = crate::claude::sessions::mint_request();
        self.queue_session_as(request.clone(), action, id)
            .then_some(request)
    }

    /// The same, under a request id minted elsewhere (the controller's, for
    /// a verb it forwards over the link); false when the queue is full.
    pub fn queue_session_as(&self, request: String, action: SessionAction, id: String) -> bool {
        let mut l = self.0.lock_ok();
        if l.sessions.len() >= MAX_QUEUED_SESSIONS {
            return false;
        }
        l.sessions.push(SessionRequest {
            request,
            action,
            id,
        });
        true
    }

    /// The session's roster; its generation moves when it says something
    /// the last one did not (`Roster::moved`).
    pub fn set_roster(&self, r: impl Into<Arc<Roster>>) {
        let r = r.into();
        let mut l = self.0.lock_ok();
        if l.roster.as_ref().is_none_or(|(prev, _)| r.moved(prev)) {
            l.roster_generation += 1;
        }
        l.roster = Some((r, Instant::now()));
    }

    /// The session's last roster, while it is fresh.
    pub fn roster(&self) -> Option<Roster> {
        self.roster_shared().map(|(r, _)| (*r).clone())
    }

    /// The same, shared rather than copied, with its generation: what the
    /// link compares, and sends only when it moved.
    pub fn roster_shared(&self) -> Option<(Arc<Roster>, u64)> {
        let l = self.0.lock_ok();
        l.roster
            .as_ref()
            .filter(|(_, at)| at.elapsed() < ROSTER_FRESH)
            .map(|(r, _)| (Arc::clone(r), l.roster_generation))
    }
}

/// `ClaudeHub::view`.
pub struct View {
    pub summary: Option<crate::claude::Summary>,
    pub last_report: Option<String>,
    pub update_requested: bool,
    pub restart_requested: bool,
}
