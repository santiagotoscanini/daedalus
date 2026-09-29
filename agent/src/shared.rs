//! What the service's threads share (`Shared`) and the status document
//! built from it: the agent's picture of this machine, which the tray, the
//! session and `daedalus-agent status` read through the local socket
//! (local.rs) and the link pushes to the controller (link/node.rs), without
//! its telemetry. The tokens in the user's Claude profile never reach it —
//! the report copies dates and a plan name, not credentials. The
//! controller's metrics page reads it too (metrics_page.rs).
//!
//! socket (api/), which reads the same `Shared`.
//!
//! A node's document also carries `controller`: its link to the controller —
//! the address, its own fingerprint and the controller's it trusts, whether
//! that key is only trusted on first use, and the last error, a changed
//! controller key above all (link/node.rs).

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::api::wire::{event, ClaudeChanged, TelemetryUpdated};
use crate::claude::{Report, ReportAnswer, Roster, SessionAction, SessionRequest, Summary};
use crate::facts::Facts;
use crate::link::wire::Policy;
use crate::link::LinkStatus;
use crate::role::Role;
use crate::rpc::Events;
use crate::state::State;
use crate::telemetry::Telemetry;
use crate::util::LockExt;

/// A report older than this means the tray is gone (logged off, or no
/// desktop session at all), and the page says so instead of repeating it.
const REPORT_FRESH: Duration = Duration::from_secs(30);
/// A roster older than this is not served: the session sends one at least
/// every `sessions::REFRESH`.
const ROSTER_FRESH: Duration = Duration::from_secs(180);
/// Session verb requests waiting for the session, at most.
pub const MAX_QUEUED_SESSIONS: usize = 8;

/// The controller's keys (link/rotation.rs) and where machines reach it.
pub struct Controller {
    pub keys: Arc<crate::link::rotation::Keys>,
    pub listen: Option<String>,
    pub advertise: Vec<String>,
}

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
    /// The controller's keys and addresses (link/), set once at start in
    /// controller mode; `system.info` states them.
    controller: OnceLock<Controller>,
    /// The machines connected to this controller, when it listens for
    /// them; the API's `nodes.*` and `/nodes/metrics` read it.
    nodes: OnceLock<Arc<crate::link::controller::Registry>>,
    /// The OS's power requests as last read (`refresh_power_requests`).
    power: Mutex<Option<String>>,
    /// The service's stop, nudged when an update check is asked for, so the
    /// updater wakes at once (`request_check`).
    stop: OnceLock<crate::util::Shutdown>,
}

struct Live {
    state: State,
    awake_hold: bool,
    hold_error: Option<String>,
    update_available: Option<String>,
    restart_pending: bool,
    /// Raised by the local socket's `update.check` or by the controller's command; the
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
    /// Raised by the controller's command or the local socket's `claude.update`; the
    /// tray takes it with its next report. Separate from the restart below
    /// (claude/mod.rs says why).
    claude_update_requested: bool,
    /// Raised by the controller's command or the local socket's `claude.restart`; the
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
            power: Mutex::new(None),
            stop: OnceLock::new(),
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
    pub fn set_controller(&self, c: Controller) {
        let _ = self.controller.set(c);
    }

    /// The controller's keys, where this is the controller.
    pub fn controller_keys(&self) -> Option<&Arc<crate::link::rotation::Keys>> {
        self.controller.get().map(|c| &c.keys)
    }

    /// The controller as `system.info` states it: the key going forward,
    /// the addresses, and a rotation under way (link/rotation.rs).
    pub fn controller_info(&self) -> Option<crate::api::wire::ControllerInfo> {
        let c = self.controller.get()?;
        let id = c.keys.forward();
        Some(crate::api::wire::ControllerInfo {
            public_key: id.public_key_hex(),
            fingerprint: id.fingerprint(),
            listen: c.listen.clone(),
            advertise: c.advertise.clone(),
            rotation: c.keys.info(),
        })
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

    /// The service's stop, which a check request nudges (lib.rs).
    pub fn set_shutdown(&self, stop: crate::util::Shutdown) {
        let _ = self.stop.set(stop);
    }

    pub fn request_check(&self) {
        self.lock().check_requested = true;
        if let Some(s) = self.stop.get() {
            s.nudge();
        }
    }

    /// Whether a check was asked for since the last call; clears it.
    pub fn take_check_request(&self) -> bool {
        std::mem::take(&mut self.lock().check_requested)
    }

    /// The persisted state as it stands.
    pub fn state(&self) -> State {
        self.lock().state.clone()
    }

    /// Edit and persist the state in one step.
    pub fn with_state(&self, f: impl FnOnce(&mut State)) {
        let mut l = self.lock();
        f(&mut l.state);
        l.state.save();
    }

    /// `with_state`, and whether the state reached the disk.
    pub fn with_state_saved(&self, f: impl FnOnce(&mut State)) -> std::io::Result<()> {
        let mut l = self.lock();
        f(&mut l.state);
        l.state.try_save()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Live> {
        self.inner.lock_ok()
    }

    /// The document as the local socket serves it (local.rs): the open
    /// telemetry, and the OS's power requests as last read — never read
    /// here: on Windows that is `powercfg`, far too slow for a request
    /// (`refresh_power_requests`, on the service's own thread).
    pub fn document_value(&self) -> serde_json::Value {
        let power = self.power.lock_ok().clone();
        self.document_with(power, true)
    }

    /// Read the OS's power requests for the document (a command; call it
    /// off any request's path).
    pub fn refresh_power_requests(&self) {
        let r = crate::power::requests_report();
        *self.power.lock_ok() = r;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Mode;

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
