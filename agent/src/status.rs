//! The status page: the agent's local door for the tray, the session and
//! `daedalus-agent status`. What the box learns of a machine travels up the
//! link (link/node.rs), never through this page.
//!
//! A node binds it to loopback alone (role.rs): a machine listens on
//! nothing the LAN can reach. The controller binds every interface for one
//! reader, the box's Prometheus, whose container reaches the host through
//! pasta's host alias — its connections arrive at the host's LAN address,
//! not loopback — while the host firewall keeps the port closed to the LAN
//! (nix). To any address, two reads:
//!
//!   GET  /healthz         `ok`
//!   GET  /nodes/metrics   the telemetry of every machine connected to the
//!                         controller (link/controller.rs), and the Claude
//!                         series of each and of the controller itself, as
//!                         Prometheus text, each series labelled `node`,
//!                         `host`, `machine` and `os`; 404 on a node
//!
//! Only from loopback, and refused (403) from any other address:
//!
//!   GET  /status (and /)  the document below
//!   GET  /claude          the session's full report (session.rs `Watcher`)
//!   POST /update/check    the updater looks now (the tray's "check for updates")
//!   POST /claude/report   the tray's picture of Claude Code (its session —
//!                         on Linux the session unit's own —
//!                         session.rs, and claude/); the
//!                         answer is a `ReportAnswer`: the policy's part for
//!                         the tray and, once each, a pending update or restart
//!                         and the session verb requests waiting (claude/sessions.rs)
//!   POST /claude/roster   the session's roster of Claude sessions (claude/roster.rs)
//!   POST /claude/update   ask the tray to update Claude Code on its next report
//!   POST /claude/restart  ask the tray to restart the server on its next report
//!
//! Loopback is the whole check: any user or process on the machine may use
//! these. The tokens in the user's Claude profile never reach this page —
//! the report copies dates and a plan name, not credentials.
//!
//! The app's door on the controller is the socket (api/), which reads the
//! same `Shared` this page does. `POST /claude/update` refuses there — nix
//! pins Claude Code on the box.
//!
//! A node's page also carries `controller`: its link to the controller —
//! the address, its own fingerprint and the controller's it trusts, whether
//! that key is only trusted on first use, and the last error, a changed
//! controller key above all (link/node.rs).

use std::io::Read;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use tiny_http::{Header, Method, Response, Server};

use crate::api::wire::{event, ClaudeChanged, TelemetryUpdated};
use crate::api::Events;
use crate::claude::{Report, ReportAnswer, Roster, SessionAction, SessionRequest, Summary};
use crate::facts::Facts;
use crate::link::wire::Policy;
use crate::link::LinkStatus;
use crate::role::Role;
use crate::state::State;
use crate::telemetry::Telemetry;

/// A report older than this means the tray is gone (logged off, or no
/// desktop session at all), and the page says so instead of repeating it.
const REPORT_FRESH: Duration = Duration::from_secs(30);
/// The largest report body accepted.
const MAX_BODY: u64 = 1 << 20;
/// A roster older than this is not served: the session sends one at least
/// every `sessions::REFRESH`.
const ROSTER_FRESH: Duration = Duration::from_secs(180);
/// Session verb requests waiting for the session, at most.
pub const MAX_QUEUED_SESSIONS: usize = 8;

/// What the threads share: the persisted state plus the live facts.
pub struct Shared {
    started: Instant,
    facts: Facts,
    role: Role,
    inner: Mutex<Live>,
    /// The API's subscribers (api/): told when Claude's state or pid moves,
    /// when a telemetry sample lands, and — on the controller — when a
    /// machine connects, leaves or changes standing (link/controller.rs).
    events: Arc<Events>,
    /// The controller's own key and addresses (link/), set once at start
    /// in controller mode; `system.info` states it.
    controller: OnceLock<crate::api::wire::ControllerInfo>,
    /// The machines connected to this controller, when it listens for
    /// them; the API's `nodes.*` and `/nodes/metrics` read it.
    nodes: OnceLock<Arc<crate::link::controller::Registry>>,
}

struct Live {
    state: State,
    awake_hold: bool,
    hold_error: Option<String>,
    update_available: Option<String>,
    restart_pending: bool,
    /// Raised by `POST /update/check` or by the controller's command; the
    /// updater clears it when it looks.
    check_requested: bool,
    /// What the box wants of this machine; the config's defaults until the
    /// controller has approved it.
    policy: Policy,
    /// The tray's last report and when it landed.
    claude: Option<(Report, Instant)>,
    /// What the API's subscribers were last told: a session reporting or
    /// not (`claude.changed`).
    claude_announced: bool,
    /// Raised by the controller's command or `POST /claude/update`; the
    /// tray takes it with its next report. Separate from the restart below
    /// (claude/mod.rs says why).
    claude_update_requested: bool,
    /// Raised by the controller's command or `POST /claude/restart`; the
    /// tray takes it with its next report.
    claude_restart_requested: bool,
    /// Verb requests for the sessions (claude/sessions.rs), accepted by the
    /// API or the link and handed to the session with its next report.
    claude_sessions: Vec<SessionRequest>,
    /// The session's last roster (claude/roster.rs) and when it landed.
    claude_roster: Option<(Roster, Instant)>,
    /// The last telemetry document, from the sampling thread.
    telemetry: Option<Telemetry>,
    /// Moves whenever a sample carries newly read static or slow facts or
    /// OS updates — what the link pushes at once rather than on its
    /// sample cadence (link/node.rs).
    telemetry_tier: u64,
    /// The providers on this machine, from their reader (providers.rs);
    /// None until its first read.
    providers: Option<Vec<crate::providers::ProviderReport>>,
    /// The residency verbs' outcomes (providers.rs), newest last.
    provider_actions: Vec<crate::providers::ProviderAction>,
    /// A residency verb is running; a second is refused until it ends.
    provider_busy: bool,
    /// Raised when a verb ends: the reader reads again at once.
    providers_read: bool,
    /// This machine's link to the controller, as its loop last saw it;
    /// None on the controller, and until the loop starts.
    link: Option<LinkStatus>,
}

/// The tray, as the page describes it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Serialize)]
#[cfg_attr(test, ts(rename = "StatusTray"))]
struct Tray {
    /// A report landed within the freshness window.
    reporting: bool,
    last_report: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Serialize)]
#[cfg_attr(test, ts(rename = "StatusPage"))]
pub(crate) struct Document<'a> {
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
    claude: Option<Summary>,
    tray: Tray,
    claude_update_requested: bool,
    claude_restart_requested: bool,
    /// What the machine is and how it is doing, as `Telemetry::public`
    /// (telemetry.rs); null until the first sample, a few seconds after start.
    telemetry: Option<Telemetry>,
    /// The connection to the controller (link/): its address, both
    /// fingerprints, and what went wrong. Null on the controller itself.
    controller: Option<LinkStatus>,
    #[serde(flatten)]
    state: &'a State,
}

impl Shared {
    pub fn new(state: State, facts: Facts, started: Instant, policy: Policy, role: Role) -> Self {
        Self {
            started,
            facts,
            role,
            events: Arc::new(Events::default()),
            controller: OnceLock::new(),
            nodes: OnceLock::new(),
            inner: Mutex::new(Live {
                state,
                awake_hold: false,
                hold_error: None,
                update_available: None,
                restart_pending: false,
                check_requested: false,
                policy,
                claude: None,
                claude_announced: false,
                claude_update_requested: false,
                claude_restart_requested: false,
                claude_sessions: Vec::new(),
                claude_roster: None,
                telemetry: None,
                telemetry_tier: 0,
                providers: None,
                provider_actions: Vec::new(),
                provider_busy: false,
                providers_read: false,
                link: None,
            }),
        }
    }

    /// Which parts of the agent run here (role.rs).
    pub fn role(&self) -> Role {
        self.role
    }

    pub fn policy(&self) -> Policy {
        self.lock().policy.clone()
    }

    /// The box's decision, from the controller. Returns whether it changed.
    pub fn set_policy(&self, p: Policy) -> bool {
        let mut l = self.lock();
        let changed = l.policy != p;
        l.policy = p;
        changed
    }

    /// The full report as JSON, for loopback.
    fn claude_document(&self) -> String {
        let l = self.lock();
        match l
            .claude
            .as_ref()
            .filter(|(_, at)| at.elapsed() < REPORT_FRESH)
        {
            Some((r, _)) => serde_json::to_string_pretty(r).unwrap_or_else(|_| "{}".into()),
            None => "null".into(),
        }
    }

    /// A new sample; `tiers_moved` when it carries static or slow facts or
    /// OS updates read since the last one (telemetry.rs).
    pub fn set_telemetry(&self, t: Telemetry, tiers_moved: bool) {
        let sampled_at = t.sampled_at.clone();
        {
            let mut l = self.lock();
            l.telemetry = Some(t);
            if tiers_moved {
                l.telemetry_tier += 1;
            }
        }
        self.events
            .publish(event::TELEMETRY_UPDATED, &TelemetryUpdated { sampled_at });
    }

    /// The last telemetry document, at the level config.toml sets; None
    /// before the first sample, or when the level is `off`.
    pub fn telemetry(&self) -> Option<Telemetry> {
        self.lock().telemetry.clone()
    }

    /// The providers as their reader last found them (providers.rs).
    pub fn set_providers(&self, list: Vec<crate::providers::ProviderReport>) {
        self.lock().providers = Some(list);
    }

    /// Claim the one residency slot; false while a verb runs.
    pub fn begin_provider_action(&self) -> bool {
        let mut l = self.lock();
        if l.provider_busy {
            return false;
        }
        l.provider_busy = true;
        true
    }

    /// A verb ended: its outcome is kept (the last `MAX_ACTIONS`), the
    /// slot freed, and the reader asked to read again at once.
    pub fn finish_provider_action(&self, a: crate::providers::ProviderAction) {
        let mut l = self.lock();
        l.provider_actions.push(a);
        let over = l
            .provider_actions
            .len()
            .saturating_sub(crate::providers::MAX_ACTIONS);
        l.provider_actions.drain(..over);
        l.provider_busy = false;
        l.providers_read = true;
    }

    pub fn provider_actions(&self) -> Vec<crate::providers::ProviderAction> {
        self.lock().provider_actions.clone()
    }

    /// Whether a read was asked for since the last call.
    pub fn take_providers_read(&self) -> bool {
        std::mem::take(&mut self.lock().providers_read)
    }

    /// The last read of the providers; None before the first.
    pub fn providers(&self) -> Option<Vec<crate::providers::ProviderReport>> {
        self.lock().providers.clone()
    }

    /// The last document with its tier counter (`set_telemetry`).
    pub fn telemetry_with_tier(&self) -> Option<(Telemetry, u64)> {
        let l = self.lock();
        l.telemetry.clone().map(|t| (t, l.telemetry_tier))
    }

    /// Edit this machine's view of its link to the controller (link/node.rs).
    pub fn set_link(&self, f: impl FnOnce(&mut LinkStatus)) {
        f(self.lock().link.get_or_insert_with(LinkStatus::default));
    }

    /// The link as the page shows it; None on the controller and before the
    /// link's loop starts.
    pub fn link(&self) -> Option<LinkStatus> {
        self.lock().link.clone()
    }

    /// The status document as the link pushes it (link/node.rs): the page
    /// without its telemetry block, which travels on its own, and with
    /// the OS's power requests as `power_requests` hands them in (a
    /// command the caller runs on its own cadence).
    pub fn status_value(&self, power_requests: Option<String>) -> serde_json::Value {
        let mut v = serde_json::to_value(self.document_with(power_requests, false))
            .unwrap_or(serde_json::Value::Null);
        if let Some(o) = v.as_object_mut() {
            o.remove("telemetry");
        }
        v
    }

    /// The controller's key and addresses, set once in controller mode.
    pub fn set_controller_info(&self, info: crate::api::wire::ControllerInfo) {
        let _ = self.controller.set(info);
    }

    pub fn controller_info(&self) -> Option<&crate::api::wire::ControllerInfo> {
        self.controller.get()
    }

    /// This machine's own Claude series for `/nodes/metrics` — the
    /// controller's Remote Control beside the machines', labelled with the
    /// controller's node id and hostname, so one alert covers both
    /// (telemetry/metrics.rs `claude_text`). Empty before the controller's
    /// key is known.
    pub fn own_claude_metrics(&self) -> String {
        let Some(node) = self
            .controller_info()
            .and_then(|c| crate::identity::parse_public_key(&c.public_key).ok())
            .map(|k| crate::identity::node_id_of(&k))
        else {
            return String::new();
        };
        let host = crate::facts::hostname();
        let labels = crate::telemetry::Labels {
            node: &node,
            host: &host,
            machine: &host,
            os: self.facts.os,
        };
        crate::telemetry::claude_text(self.claude_report().as_ref(), &labels)
    }

    /// The machines this controller serves, once it listens for them.
    pub fn set_nodes(&self, r: Arc<crate::link::controller::Registry>) {
        let _ = self.nodes.set(r);
    }

    pub fn nodes(&self) -> Option<&Arc<crate::link::controller::Registry>> {
        self.nodes.get()
    }

    /// The events handle, for what publishes beside this struct (the
    /// controller's registry).
    pub fn events_handle(&self) -> Arc<Events> {
        Arc::clone(&self.events)
    }

    /// The session's last report while it is fresh; None when no session
    /// has reported within `REPORT_FRESH`.
    pub fn claude_report(&self) -> Option<Report> {
        self.lock()
            .claude
            .as_ref()
            .filter(|(_, at)| at.elapsed() < REPORT_FRESH)
            .map(|(r, _)| r.clone())
    }

    /// Whether an update or a restart waits for the session's next report.
    pub fn claude_instruction_waiting(&self) -> bool {
        let l = self.lock();
        l.claude_update_requested || l.claude_restart_requested || !l.claude_sessions.is_empty()
    }

    /// A verb request for the session, taken with its next report. None
    /// when `MAX_QUEUED_SESSIONS` already wait: a session that is not
    /// taking them is not one to pile more on.
    pub fn queue_claude_session(&self, action: SessionAction, id: String) -> Option<String> {
        let request = crate::claude::sessions::mint_request();
        self.queue_claude_session_as(request.clone(), action, id)
            .then_some(request)
    }

    /// The same, under a request id minted elsewhere (the controller's, for
    /// a verb it forwards over the link); false when the queue is full.
    pub fn queue_claude_session_as(
        &self,
        request: String,
        action: SessionAction,
        id: String,
    ) -> bool {
        let mut l = self.lock();
        if l.claude_sessions.len() >= MAX_QUEUED_SESSIONS {
            return false;
        }
        l.claude_sessions.push(SessionRequest {
            request,
            action,
            id,
        });
        true
    }

    /// The session's roster.
    pub fn set_claude_roster(&self, r: Roster) {
        self.lock().claude_roster = Some((r, Instant::now()));
    }

    /// The session's last roster, while it is fresh.
    pub fn claude_roster(&self) -> Option<Roster> {
        self.lock()
            .claude_roster
            .as_ref()
            .filter(|(_, at)| at.elapsed() < ROSTER_FRESH)
            .map(|(r, _)| r.clone())
    }

    pub fn facts(&self) -> &Facts {
        &self.facts
    }

    /// How long this agent has run.
    pub fn uptime(&self) -> Duration {
        self.started.elapsed()
    }

    /// Where the API's connections subscribe (api/).
    pub fn events(&self) -> &Events {
        &self.events
    }

    pub fn request_claude_update(&self) {
        self.lock().claude_update_requested = true;
    }

    pub fn request_claude_restart(&self) {
        self.lock().claude_restart_requested = true;
    }

    /// The tray's report; answers with the policy and takes the pending
    /// instructions. `mem::take` on each, so an instruction is handed out
    /// exactly once — a tray that reports every five seconds must not be
    /// told to update five seconds later all over again.
    ///
    /// A report after silence, or whose state or pid differs from the
    /// previous one, is told to the API's subscribers as `claude.changed`.
    pub fn set_claude(&self, r: Report) -> ReportAnswer {
        let mut l = self.lock();
        let moved = !l.claude_announced
            || l.claude
                .as_ref()
                .is_none_or(|(prev, _)| prev.state != r.state || prev.pid != r.pid);
        let changed = moved.then(|| ClaudeChanged {
            reporting: true,
            state: Some(r.state.clone()),
            pid: r.pid,
        });
        l.claude_announced = true;
        l.claude = Some((r, Instant::now()));
        let answer = ReportAnswer {
            wanted: l.policy.claude_remote_control,
            update: std::mem::take(&mut l.claude_update_requested),
            restart: std::mem::take(&mut l.claude_restart_requested),
            workdir: l.policy.claude_workdir.clone(),
            sessions: std::mem::take(&mut l.claude_sessions),
        };
        drop(l);
        if let Some(c) = changed {
            self.events.publish(event::CLAUDE_CHANGED, &c);
        }
        answer
    }

    /// Tell the API's subscribers when the session has gone quiet: once, as
    /// `claude.changed` with `reporting: false`, when the last report has
    /// aged past `REPORT_FRESH`. The service's loop calls it twice a second;
    /// the next report announces the session again.
    pub fn check_claude_fresh(&self) {
        self.announce_silence_after(REPORT_FRESH);
    }

    fn announce_silence_after(&self, fresh: Duration) {
        let mut l = self.lock();
        let stale = l
            .claude
            .as_ref()
            .is_none_or(|(_, at)| at.elapsed() >= fresh);
        if !(l.claude_announced && stale) {
            return;
        }
        l.claude_announced = false;
        drop(l);
        self.events.publish(
            event::CLAUDE_CHANGED,
            &ClaudeChanged {
                reporting: false,
                state: None,
                pid: None,
            },
        );
    }

    /// Whether the tray has reported within the freshness window.
    pub fn tray_reporting(&self) -> bool {
        self.lock()
            .claude
            .as_ref()
            .is_some_and(|(_, at)| at.elapsed() < REPORT_FRESH)
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

    /// The open page, as served.
    fn document(&self) -> String {
        let power = crate::power::requests_report();
        serde_json::to_string_pretty(&self.document_with(power, true))
            .unwrap_or_else(|_| "{}".into())
    }

    /// The page as a value: with `Telemetry::public` when `telemetry`,
    /// with its block null otherwise; `power_requests` is what the OS
    /// reported, read by the caller outside the lock.
    fn document_with(&self, power_requests: Option<String>, telemetry: bool) -> serde_json::Value {
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
            power_requests,
            update_available: l.update_available.as_deref(),
            restart_pending: l.restart_pending,
            policy: &l.policy,
            claude: l
                .claude
                .as_ref()
                .filter(|(_, at)| at.elapsed() < REPORT_FRESH)
                .map(|(r, _)| r.summary()),
            tray: Tray {
                reporting: l
                    .claude
                    .as_ref()
                    .is_some_and(|(_, at)| at.elapsed() < REPORT_FRESH),
                last_report: l.claude.as_ref().map(|(r, _)| r.reported_at.clone()),
            },
            claude_update_requested: l.claude_update_requested,
            claude_restart_requested: l.claude_restart_requested,
            telemetry: if telemetry {
                l.telemetry.as_ref().map(Telemetry::public)
            } else {
                None
            },
            controller: l.link.clone(),
            state: &l.state,
        };
        serde_json::to_value(&doc).unwrap_or(serde_json::Value::Null)
    }
}

/// What any address may ask; everything else is for loopback (module doc).
fn open_to_any(method: &Method, url: &str) -> bool {
    *method == Method::Get && matches!(url, "/healthz" | "/nodes/metrics")
}

/// Answer on `port` — loopback on a node, every interface on the controller
/// (`Role::status_address`) — from a thread until `unblock` is called on
/// the returned server.
pub fn serve(port: u16, shared: Arc<Shared>) -> Result<Arc<Server>> {
    let address = shared.role.status_address();
    let server = Server::http((address, port))
        .map_err(|e| anyhow::anyhow!("{e}"))
        .with_context(|| format!("binding the status page on {address}:{port}"))?;
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
                    (m, u) if !local && !open_to_any(m, u) => (
                        403,
                        "only /healthz and /nodes/metrics answer other addresses\n".to_string(),
                        "text/plain",
                    ),
                    (&Method::Get, "/healthz") => (200, "ok\n".to_string(), "text/plain"),
                    // The connected machines' telemetry, on the controller
                    // (link/controller.rs).
                    (&Method::Get, "/nodes/metrics") => match shared.nodes() {
                        Some(r) => (
                            200,
                            format!("{}{}", shared.own_claude_metrics(), r.metrics()),
                            "text/plain; version=0.0.4",
                        ),
                        None => (
                            404,
                            "no machines connect to this agent\n".to_string(),
                            "text/plain",
                        ),
                    },
                    (&Method::Get, "/" | "/status") => (200, shared.document(), "application/json"),
                    (&Method::Get, "/claude") => {
                        (200, shared.claude_document(), "application/json")
                    }
                    (&Method::Post, "/update/check") => {
                        shared.request_check();
                        (202, "checking\n".to_string(), "text/plain")
                    }
                    (&Method::Post, "/claude/update") if !shared.role.claude_update => (
                        403,
                        "Claude Code is updated by nix on this machine\n".to_string(),
                        "text/plain",
                    ),
                    (&Method::Post, "/claude/update") => {
                        shared.request_claude_update();
                        (
                            202,
                            "update queued for the tray\n".to_string(),
                            "text/plain",
                        )
                    }
                    (&Method::Post, "/claude/restart") => {
                        shared.request_claude_restart();
                        (
                            202,
                            "restart queued for the tray\n".to_string(),
                            "text/plain",
                        )
                    }
                    (&Method::Post, "/claude/roster") => {
                        let mut body = String::new();
                        let read = req.as_reader().take(MAX_BODY).read_to_string(&mut body);
                        match read
                            .ok()
                            .and_then(|_| serde_json::from_str::<Roster>(&body).ok())
                        {
                            Some(r) => {
                                shared.set_claude_roster(r);
                                (204, String::new(), "text/plain")
                            }
                            None => (400, "not a roster\n".to_string(), "text/plain"),
                        }
                    }
                    (&Method::Post, "/claude/report") => {
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
    tracing::info!(address, port, "status page answering");
    Ok(server)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Mode;

    #[test]
    fn other_addresses_get_healthz_and_nodes_metrics_alone() {
        for (m, u) in [(Method::Get, "/healthz"), (Method::Get, "/nodes/metrics")] {
            assert!(open_to_any(&m, u), "{u}");
        }
        for (m, u) in [
            (Method::Get, "/"),
            (Method::Get, "/status"),
            (Method::Get, "/claude"),
            (Method::Get, "/metrics"),
            (Method::Get, "/telemetry"),
            (Method::Post, "/nodes/metrics"),
            (Method::Post, "/update/check"),
            (Method::Post, "/claude/report"),
            (Method::Post, "/claude/update"),
            (Method::Post, "/claude/restart"),
        ] {
            assert!(!open_to_any(&m, u), "{m} {u}");
        }
    }

    /// A page served on a free port, with a GET that returns the status
    /// code, or None when nothing listens there.
    fn page(shared: Arc<Shared>) -> (Arc<Server>, impl Fn(std::net::IpAddr, &str) -> Option<u16>) {
        // A free port: bind, read it, let go.
        let port = std::net::TcpListener::bind("0.0.0.0:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let server = serve(port, shared).unwrap();
        let get = move |host: std::net::IpAddr, path: &str| -> Option<u16> {
            match ureq::get(&format!("http://{host}:{port}{path}"))
                .timeout(Duration::from_secs(3))
                .call()
            {
                Ok(r) => Some(r.status()),
                Err(ureq::Error::Status(c, _)) => Some(c),
                Err(ureq::Error::Transport(_)) => None,
            }
        };
        (server, get)
    }

    /// Another address of this machine, which is not loopback to the server;
    /// None where the machine has no route out.
    fn lan_address() -> Option<std::net::IpAddr> {
        std::net::UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("192.0.2.1:9").map(|_| s))
            .and_then(|s| s.local_addr())
            .map(|a| a.ip())
            .ok()
            .filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
    }

    fn shared_as(mode: Mode) -> Arc<Shared> {
        Arc::new(Shared::new(
            State::default(),
            Facts::default(),
            Instant::now(),
            Policy::default(),
            Role::of(mode),
        ))
    }

    /// A node listens on loopback alone: in full there, not at all on any
    /// other address. It has no `/metrics` and no machines of its own.
    #[test]
    fn a_node_page_listens_on_loopback_alone() {
        let (server, get) = page(shared_as(Mode::Node));
        let lo: std::net::IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(get(lo, "/status"), Some(200));
        assert_eq!(get(lo, "/claude"), Some(200));
        assert_eq!(get(lo, "/healthz"), Some(200));
        assert_eq!(get(lo, "/metrics"), Some(404));
        assert_eq!(get(lo, "/nodes/metrics"), Some(404));
        if let Some(lan) = lan_address() {
            for p in ["/healthz", "/status", "/nodes/metrics"] {
                assert_eq!(get(lan, p), None, "{p}");
            }
        }
        server.unblock();
    }

    /// The controller binds every interface, answering loopback in full and
    /// anything else only `/healthz` and `/nodes/metrics`.
    #[test]
    fn a_controller_page_answers_other_addresses_the_scrape_alone() {
        let shared = shared_as(Mode::Controller);
        let cid = crate::identity::Identity::from_seed([200; 32]);
        shared.set_nodes(Arc::new(crate::link::controller::Registry::new(
            &cid,
            shared.events_handle(),
            Default::default(),
        )));
        let (server, get) = page(shared);
        let lo: std::net::IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(get(lo, "/status"), Some(200));
        assert_eq!(get(lo, "/nodes/metrics"), Some(200));
        assert_eq!(get(lo, "/metrics"), Some(404));
        if let Some(lan) = lan_address() {
            assert_eq!(get(lan, "/healthz"), Some(200));
            assert_eq!(get(lan, "/nodes/metrics"), Some(200));
            for p in ["/status", "/", "/claude", "/metrics", "/telemetry"] {
                assert_eq!(get(lan, p), Some(403), "{p}");
            }
        }
        server.unblock();
    }

    #[test]
    fn claude_changed_covers_reporting_both_ways() {
        let shared = Shared::new(
            State::default(),
            Facts::default(),
            Instant::now(),
            Policy::default(),
            Role::of(Mode::Controller),
        );
        let rx = shared.events().subscribe();
        let report = |pid| Report {
            state: "running".into(),
            pid: Some(pid),
            ..Default::default()
        };
        // Nothing reported yet: no silence to announce.
        shared.announce_silence_after(Duration::ZERO);
        shared.set_claude(report(1));
        shared.set_claude(report(1));
        shared.announce_silence_after(Duration::from_secs(60));
        shared.announce_silence_after(Duration::ZERO);
        shared.announce_silence_after(Duration::ZERO);
        // The same report after silence is news again.
        shared.set_claude(report(1));
        let got: Vec<String> = rx.try_iter().map(|l| l.to_string()).collect();
        assert_eq!(
            got,
            [
                r#"{"e":"claude.changed","p":{"reporting":true,"state":"running","pid":1}}"#,
                r#"{"e":"claude.changed","p":{"reporting":false,"state":null,"pid":null}}"#,
                r#"{"e":"claude.changed","p":{"reporting":true,"state":"running","pid":1}}"#,
            ]
        );
    }
}
