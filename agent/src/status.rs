//! The status page: one JSON document on a LAN port, so the box can see the
//! agent is there and awake before there is any channel between them.
//!
//! `GET /status` (and `/`) answers the document below; `GET /healthz`
//! answers `ok`. One write, and only from this machine: `POST /update/check`
//! asks the updater to look now — the tray's "check for updates" — and is
//! refused from any address but loopback. No auth otherwise: the page states
//! facts about this machine that the LAN can already observe, and the
//! firewall rule `install` adds scopes it to the local subnet.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context, Result};
use serde::Serialize;
use tiny_http::{Header, Method, Response, Server};

use crate::facts::Facts;
use crate::hello::ControlPlane;
use crate::state::State;

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
    /// The box, as this agent last saw it.
    control_plane: &'a ControlPlane,
    #[serde(flatten)]
    state: &'a State,
}

impl Shared {
    pub fn new(state: State, facts: Facts, started: Instant) -> Self {
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
            }),
        }
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
            hostname: hostname(),
            facts: &self.facts,
            uptime_secs: self.started.elapsed().as_secs(),
            os_uptime_secs: os_uptime,
            booted_at: os_uptime.map(crate::state::rfc3339_ago),
            awake_hold: l.awake_hold,
            hold_error: l.hold_error.as_deref(),
            power_requests: crate::power::requests_report(),
            update_available: l.update_available.as_deref(),
            restart_pending: l.restart_pending,
            control_plane: &l.control_plane,
            state: &l.state,
        };
        serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".into())
    }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into())
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
            for req in for_thread.incoming_requests() {
                let local = req.remote_addr().is_some_and(|a| a.ip().is_loopback());
                let (code, body, ctype) = match (req.method(), req.url()) {
                    (&Method::Get, "/healthz") => (200, "ok\n".to_string(), "text/plain"),
                    (&Method::Get, "/" | "/status") => (200, shared.document(), "application/json"),
                    (&Method::Post, "/update/check") if local => {
                        shared.request_check();
                        (202, "checking\n".to_string(), "text/plain")
                    }
                    (&Method::Post, "/update/check") => {
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
