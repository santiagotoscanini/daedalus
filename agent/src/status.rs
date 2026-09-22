//! The status page: one JSON document on a LAN port, so the box can see the
//! agent is there and awake before there is any channel between them.
//!
//! `GET /status` (and `/`) answers the document below; `GET /healthz`
//! answers `ok`. Nothing else, no writes, no auth: it states facts about
//! this machine that the LAN can already observe, and the firewall rule
//! `install` adds scopes it to the local subnet.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context, Result};
use serde::Serialize;
use tiny_http::{Header, Method, Response, Server};

use crate::state::State;

/// What the threads share: the persisted state plus the live facts.
pub struct Shared {
    started: Instant,
    inner: Mutex<Live>,
}

struct Live {
    state: State,
    awake_hold: bool,
    hold_error: Option<String>,
    update_available: Option<String>,
    restart_pending: bool,
}

#[derive(Serialize)]
struct Document<'a> {
    agent: &'static str,
    version: &'static str,
    hostname: String,
    os: &'static str,
    uptime_secs: u64,
    awake_hold: bool,
    hold_error: Option<&'a str>,
    power_requests: Option<String>,
    update_available: Option<&'a str>,
    restart_pending: bool,
    #[serde(flatten)]
    state: &'a State,
}

impl Shared {
    pub fn new(state: State, started: Instant) -> Self {
        Self {
            started,
            inner: Mutex::new(Live {
                state,
                awake_hold: false,
                hold_error: None,
                update_available: None,
                restart_pending: false,
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
        let doc = Document {
            agent: crate::SERVICE_NAME,
            version: crate::VERSION,
            hostname: hostname(),
            os: std::env::consts::OS,
            uptime_secs: self.started.elapsed().as_secs(),
            awake_hold: l.awake_hold,
            hold_error: l.hold_error.as_deref(),
            power_requests: crate::power::requests_report(),
            update_available: l.update_available.as_deref(),
            restart_pending: l.restart_pending,
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
                let (code, body, ctype) = match (req.method(), req.url()) {
                    (&Method::Get, "/healthz") => (200, "ok\n".to_string(), "text/plain"),
                    (&Method::Get, "/" | "/status") => (200, shared.document(), "application/json"),
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
