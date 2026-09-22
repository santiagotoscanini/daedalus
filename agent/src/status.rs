//! The status page: one JSON document on a LAN port, so the box can see the
//! agent is there and awake before there is any channel between them.
//!
//! `GET /status` (and `/`) answers the document below; `GET /healthz`
//! answers `ok`. The writes are few and only from this machine — refused
//! from any address but loopback:
//!
//!   POST /update/check    the updater looks now (the tray's "check for updates")
//!   POST /claude/report   the tray's picture of Claude Code (claude.rs); the
//!                         answer carries the box's policy and, once, a restart
//!   POST /claude/restart  ask the tray to restart the server on its next report
//!
//! No auth otherwise: the page states facts about this machine that the LAN
//! can already observe, and the firewall rule `install` adds scopes it to
//! the local subnet. The tokens in the user's Claude profile never reach
//! this page — the report copies dates and a plan name, not credentials.

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use tiny_http::{Header, Method, Response, Server};

use crate::claude::{Report, ReportAnswer, Summary};
use crate::facts::Facts;
use crate::hello::{ControlPlane, Policy};
use crate::state::State;

/// A report older than this means the tray is gone (logged off, or no
/// desktop session at all), and the page says so instead of repeating it.
const REPORT_FRESH: Duration = Duration::from_secs(30);
/// The largest report body accepted.
const MAX_BODY: u64 = 1 << 20;

/// What the threads share: the persisted state plus the live facts.
pub struct Shared {
    started: Instant,
    facts: Facts,
    inner: Mutex<Live>,
}

struct Live {
    state: State,
    awake_hold: bool,
    hold_error: Option<String>,
    update_available: Option<String>,
    restart_pending: bool,
    /// Raised by `POST /update/check` or by the box's answer to a hello; the
    /// updater clears it when it looks.
    check_requested: bool,
    control_plane: ControlPlane,
    /// What the box wants of this machine; the config's defaults until the
    /// box has answered a hello.
    policy: Policy,
    /// The tray's last report and when it landed.
    claude: Option<(Report, Instant)>,
    /// Raised by the box's answer or `POST /claude/restart`; the tray takes
    /// it with its next report.
    claude_restart_requested: bool,
}

/// The tray, as the page describes it.
#[derive(Serialize)]
struct Tray {
    /// A report landed within the freshness window.
    reporting: bool,
    last_report: Option<String>,
}

#[derive(Serialize)]
struct Document<'a> {
    agent: &'static str,
    version: &'static str,
    hostname: String,
    #[serde(flatten)]
    facts: &'a Facts,
    uptime_secs: u64,
    /// The machine's, not the agent's: a small number here after a night is a reboot.
    os_uptime_secs: Option<u64>,
    /// When the machine booted, RFC 3339 UTC, derived from the OS uptime.
    booted_at: Option<String>,
    awake_hold: bool,
    hold_error: Option<&'a str>,
    power_requests: Option<String>,
    update_available: Option<&'a str>,
    restart_pending: bool,
    /// What the box asked of this machine.
    policy: &'a Policy,
    /// Claude Code on this machine, as the tray last reported it; null when
    /// the tray has not reported lately.
    claude: Option<&'a Report>,
    tray: Tray,
    claude_restart_requested: bool,
    /// The box, as this agent last saw it.
    control_plane: &'a ControlPlane,
    #[serde(flatten)]
    state: &'a State,
}

impl Shared {
    pub fn new(state: State, facts: Facts, started: Instant, policy: Policy) -> Self {
        Self {
            started,
            facts,
            inner: Mutex::new(Live {
                state,
                awake_hold: false,
                hold_error: None,
                update_available: None,
                restart_pending: false,
                check_requested: false,
                control_plane: ControlPlane::default(),
                policy,
                claude: None,
                claude_restart_requested: false,
            }),
        }
    }

    pub fn policy(&self) -> Policy {
        self.lock().policy.clone()
    }

    /// The box's decision, from a hello's answer. Returns whether it changed.
    pub fn set_policy(&self, p: Policy) -> bool {
        let mut l = self.lock();
        let changed = l.policy != p;
        l.policy = p;
        changed
    }

    pub fn request_claude_restart(&self) {
        self.lock().claude_restart_requested = true;
    }

    /// The tray's report; answers with the policy and takes the restart flag.
    pub fn set_claude(&self, r: Report) -> ReportAnswer {
        let mut l = self.lock();
        l.claude = Some((r, Instant::now()));
        ReportAnswer {
            wanted: l.policy.claude_remote_control,
            restart: std::mem::take(&mut l.claude_restart_requested),
            workdir: l.policy.claude_workdir.clone(),
        }
    }

    /// The hello's summary of Claude Code: None when the tray is silent.
    pub fn claude_summary(&self) -> Option<Summary> {
        let l = self.lock();
        l.claude
            .as_ref()
            .filter(|(_, at)| at.elapsed() < REPORT_FRESH)
            .map(|(r, _)| r.summary())
    }

    pub fn set_hold(&self, held: bool, error: Option<String>) {
        let mut l = self.lock();
        l.awake_hold = held;
        l.hold_error = error;
    }

    pub fn set_update_available(&self, v: Option<String>) {
        self.lock().update_available = v;
    }

    pub fn set_restart_pending(&self) {
        self.lock().restart_pending = true;
    }

    pub fn awake_hold(&self) -> bool {
        self.lock().awake_hold
    }

    pub fn set_control_plane(&self, c: ControlPlane) {
        self.lock().control_plane = c;
    }

    pub fn update_control_plane(&self, f: impl FnOnce(&mut ControlPlane)) {
        f(&mut self.lock().control_plane);
    }

    /// A copy of what the page says about the box, for the tray.
    pub fn control_plane(&self) -> ControlPlane {
        self.lock().control_plane.clone()
    }

    pub fn request_check(&self) {
        self.lock().check_requested = true;
    }

    /// Whether a check was asked for since the last call; clears it.
    pub fn take_check_request(&self) -> bool {
        std::mem::take(&mut self.lock().check_requested)
    }

    /// Edit and persist the state in one step.
    pub fn with_state(&self, f: impl FnOnce(&mut State)) {
        let mut l = self.lock();
        f(&mut l.state);
        l.state.save();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Live> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn document(&self) -> String {
        let l = self.lock();
        let os_uptime = crate::power::os_uptime_secs();
        let doc = Document {
            agent: crate::SERVICE_NAME,
            version: crate::VERSION,
            hostname: crate::facts::hostname(),
            facts: &self.facts,
            uptime_secs: self.started.elapsed().as_secs(),
            os_uptime_secs: os_uptime,
            booted_at: os_uptime.map(crate::state::rfc3339_ago),
            awake_hold: l.awake_hold,
            hold_error: l.hold_error.as_deref(),
            power_requests: crate::power::requests_report(),
            update_available: l.update_available.as_deref(),
            restart_pending: l.restart_pending,
            policy: &l.policy,
            claude: l
                .claude
                .as_ref()
                .filter(|(_, at)| at.elapsed() < REPORT_FRESH)
                .map(|(r, _)| r),
            tray: Tray {
                reporting: l
                    .claude
                    .as_ref()
                    .is_some_and(|(_, at)| at.elapsed() < REPORT_FRESH),
                last_report: l.claude.as_ref().map(|(r, _)| r.reported_at.clone()),
            },
            claude_restart_requested: l.claude_restart_requested,
            control_plane: &l.control_plane,
            state: &l.state,
        };
        serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".into())
    }
}

/// Answer on `0.0.0.0:port` from a thread until `unblock` is called on the
/// returned server.
pub fn serve(port: u16, shared: Arc<Shared>) -> Result<Arc<Server>> {
    let server = Server::http(("0.0.0.0", port))
        .map_err(|e| anyhow::anyhow!("{e}"))
        .with_context(|| format!("binding the status page on port {port}"))?;
    // `incoming_requests` takes `&self` and `Server` is `Send + Sync`, so the
    // thread and the caller share one through an Arc; `unblock` from the
    // caller ends the loop in the thread.
    let server = Arc::new(server);
    let for_thread = Arc::clone(&server);
    std::thread::Builder::new()
        .name("status".into())
        .spawn(move || {
            for mut req in for_thread.incoming_requests() {
                let local = req.remote_addr().is_some_and(|a| a.ip().is_loopback());
                let (code, body, ctype) = match (req.method(), req.url()) {
                    (&Method::Get, "/healthz") => (200, "ok\n".to_string(), "text/plain"),
                    (&Method::Get, "/" | "/status") => (200, shared.document(), "application/json"),
                    (&Method::Post, "/update/check") if local => {
                        shared.request_check();
                        (202, "checking\n".to_string(), "text/plain")
                    }
                    (&Method::Post, "/claude/restart") if local => {
                        shared.request_claude_restart();
                        (
                            202,
                            "restart queued for the tray\n".to_string(),
                            "text/plain",
                        )
                    }
                    (&Method::Post, "/claude/report") if local => {
                        let mut body = String::new();
                        let read = req.as_reader().take(MAX_BODY).read_to_string(&mut body);
                        match read
                            .ok()
                            .and_then(|_| serde_json::from_str::<Report>(&body).ok())
                        {
                            Some(r) => {
                                let answer = shared.set_claude(r);
                                (
                                    200,
                                    serde_json::to_string(&answer).unwrap_or_else(|_| "{}".into()),
                                    "application/json",
                                )
                            }
                            None => (400, "not a report\n".to_string(), "text/plain"),
                        }
                    }
                    (&Method::Post, "/update/check" | "/claude/restart" | "/claude/report") => {
                        (403, "only from this machine\n".to_string(), "text/plain")
                    }
                    _ => (404, "not found\n".to_string(), "text/plain"),
                };
                let header = Header::from_bytes("Content-Type", ctype)
                    .unwrap_or_else(|_| unreachable!("static header"));
                let _ = req.respond(
                    Response::from_string(body)
                        .with_status_code(code)
                        .with_header(header),
                );
            }
        })
        .context("spawning the status server")?;
    tracing::info!(port, "status page answering");
    Ok(server)
}
