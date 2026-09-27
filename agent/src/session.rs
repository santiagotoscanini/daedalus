//! The session: Claude Code supervised in the user's session and reported
//! to the service, with no UI.
//!
//! This process is the one with the user's Claude login, so `claude
//! remote-control` runs as its child (claude/). Every `POLL` it reads the
//! service's status page on loopback, sends the service a report of the
//! supervisor (`POST /claude/report`), and applies the `ReportAnswer` —
//! run it or not, where, and the one-shot update and restart. The service
//! (session 0 on Windows, root on macOS) could do neither.
//!
//! It also notices an update of its own: when the page reports a version
//! other than its own, the binaries were swapped under it, and it says so
//! (`Tick::VersionChanged`) so its runner can leave for the new one.
//!
//! Today the tray (tray.rs) is the runner: it calls `tick` from its
//! platform loop and draws what each poll returns. Nothing in it needs a
//! UI, so a runner without one can drive the same `tick`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::claude::{Report, ReportAnswer, Supervisor};
use crate::hello::Policy;
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
    pub control_plane: BoxState,
    #[serde(default)]
    pub policy: Policy,
}

/// The box, as the page reports it.
#[derive(Deserialize, Default)]
pub struct BoxState {
    pub url: Option<String>,
    pub state: Option<String>,
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

/// The supervisor and when to look at the page next. Dropping it stops the
/// Claude server (the supervisor's `Drop`).
pub struct Session {
    port: u16,
    sup: Supervisor,
    next_poll: Instant,
}

impl Session {
    /// The Claude server, in this session with this user's login, reporting
    /// to the service on `port`. Wanted (as `Policy::default()` has it)
    /// until the service relays the box's policy, in the most recent trusted
    /// project until it names one; its output goes to `claude_log`. Nothing
    /// starts before the first `tick`.
    pub fn new(port: u16, claude_log: PathBuf) -> Self {
        Self {
            port,
            sup: Supervisor::new(None, claude_log, true),
            next_poll: Instant::now(),
        }
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
        if Instant::now() < self.next_poll {
            return Tick::Idle;
        }
        let page = read_page(self.port);
        if let Some(p) = &page {
            if p.version != VERSION && !p.restart_pending {
                return Tick::VersionChanged;
            }
        }
        self.sup.tick();
        let report = self.sup.report();
        if let Some(answer) = send_report(self.port, &report) {
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
        }
        self.next_poll = Instant::now() + POLL;
        Tick::Polled(Box::new(Poll { page, report }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_reads_what_the_status_page_writes() {
        let p: Page = serde_json::from_str(
            r#"{"agent":"daedalus-agent","version":"0.13.0","awake_hold":true,
                "hold_error":null,"update_available":"0.14.0","restart_pending":false,
                "last_update_check":"2026-09-27T10:00:00Z","last_update_result":"x",
                "control_plane":{"url":"https://box","state":"approved","error":null,"node_id":"n"},
                "policy":{"awake_hold":false,"claude_remote_control":true},
                "telemetry":null}"#,
        )
        .unwrap();
        assert_eq!(p.version, "0.13.0");
        assert_eq!(p.update_available.as_deref(), Some("0.14.0"));
        assert_eq!(p.control_plane.state.as_deref(), Some("approved"));
        assert!(!p.policy.awake_hold);
    }
}
