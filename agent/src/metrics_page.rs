//! The controller's metrics page. No HTTP answers on a node: a machine
//! listens on nothing, loopback included. The controller keeps one small
//! page on `port` (role.rs `status_on_lan`), on every interface, for one
//! reader — the box's Prometheus, whose container reaches the host through
//! pasta's host alias, so its connections arrive at the host's LAN address,
//! not loopback — while the host firewall keeps the port closed to the LAN
//! (nix):
//!
//!   GET  /healthz         `ok`
//!   GET  /nodes/metrics   the telemetry of every machine connected to the
//!                         controller (link/controller.rs), and the Claude
//!                         series of each and of the controller itself, as
//!                         Prometheus text, each series labelled `node`,
//!                         `host`, `machine` and `os`
//!
//! and 404 for anything else. The app's door on the controller is the API
//! socket (api/), which reads the same `Shared`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tiny_http::{Header, Method, Response, Server};

use crate::shared::Shared;

/// How often a metrics page that could not bind its port tries again.
pub const BIND_RETRY: Duration = Duration::from_secs(15);

/// The controller's metrics page, bound now or later: a port another
/// process holds does
/// not stop the service — the link, the telemetry and the awake hold go on
/// — it is tried again every `BIND_RETRY`, and whoever holds it is logged
/// where the OS says (`os::port_holder`).
pub struct Page {
    server: Arc<Mutex<Option<Arc<Server>>>>,
    /// When it started answering.
    since: Arc<Mutex<Option<Instant>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

impl Page {
    pub fn start(port: u16, shared: Arc<Shared>) -> Self {
        use std::sync::atomic::AtomicBool;
        let page = Self {
            server: Arc::new(Mutex::new(None)),
            since: Arc::new(Mutex::new(None)),
            stop: Arc::new(AtomicBool::new(false)),
        };
        let (server, since, stop) = (
            Arc::clone(&page.server),
            Arc::clone(&page.since),
            Arc::clone(&page.stop),
        );
        let bind = move || -> bool {
            match serve_metrics(port, Arc::clone(&shared)) {
                Ok(s) => {
                    *server.lock().unwrap_or_else(|p| p.into_inner()) = Some(s);
                    *since.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
                    true
                }
                Err(e) => {
                    tracing::error!(
                        error = format!("{e:#}"),
                        port,
                        held_by = crate::os::port_holder(port).as_deref().unwrap_or("unknown"),
                        "the metrics page could not bind its port; the service runs on and tries again"
                    );
                    false
                }
            }
        };
        if !bind() {
            let _ = std::thread::Builder::new()
                .name("status-bind".into())
                .spawn(move || {
                    while !crate::util::sleep_until(&stop, BIND_RETRY) {
                        if bind() {
                            return;
                        }
                    }
                });
        }
        page
    }

    /// How long the page has answered; None while it is not bound.
    pub fn up_for(&self) -> Option<Duration> {
        self.since
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map(|t| t.elapsed())
    }
}

impl Drop for Page {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(s) = self.server.lock().unwrap_or_else(|p| p.into_inner()).take() {
            s.unblock();
        }
    }
}
/// Answer the controller's metrics page on every interface's `port`
/// (module doc) from a thread until `unblock` is called on the returned
/// server.
pub fn serve_metrics(port: u16, shared: Arc<Shared>) -> Result<Arc<Server>> {
    let server = Server::http(("0.0.0.0", port))
        .map_err(|e| anyhow::anyhow!("{e}"))
        .with_context(|| format!("binding the metrics page on 0.0.0.0:{port}"))?;
    // `incoming_requests` takes `&self` and `Server` is `Send + Sync`, so the
    // thread and the caller share one through an Arc; `unblock` from the
    // caller ends the loop in the thread.
    let server = Arc::new(server);
    let for_thread = Arc::clone(&server);
    std::thread::Builder::new()
        .name("metrics".into())
        .spawn(move || {
            for req in for_thread.incoming_requests() {
                let (code, body, ctype) = match (req.method(), req.url()) {
                    (&Method::Get, "/healthz") => (200, "ok\n".to_string(), "text/plain"),
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
        .context("spawning the metrics page")?;
    tracing::info!(port, "metrics page answering");
    Ok(server)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Mode;
    use crate::facts::Facts;
    use crate::link::wire::Policy;
    use crate::role::Role;
    use crate::state::State;

    fn shared_as(mode: Mode) -> Arc<Shared> {
        Arc::new(Shared::new(
            State::default(),
            Facts::default(),
            Instant::now(),
            Policy::default(),
            Role::of(mode),
        ))
    }

    /// The controller's page answers `/healthz` and `/nodes/metrics`, and
    /// nothing of the machine: the document is the local socket's.
    #[test]
    fn the_metrics_page_answers_the_scrape_alone() {
        let shared = shared_as(Mode::Controller);
        let cid = crate::identity::Identity::from_seed([200; 32]);
        shared.set_nodes(Arc::new(crate::link::controller::Registry::new(
            &cid,
            shared.events_handle(),
            Default::default(),
        )));
        let port = std::net::TcpListener::bind("0.0.0.0:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let server = serve_metrics(port, shared).unwrap();
        let get = |path: &str| -> Option<u16> {
            match ureq::get(&format!("http://127.0.0.1:{port}{path}"))
                .timeout(Duration::from_secs(3))
                .call()
            {
                Ok(r) => Some(r.status()),
                Err(ureq::Error::Status(c, _)) => Some(c),
                Err(ureq::Error::Transport(_)) => None,
            }
        };
        assert_eq!(get("/healthz"), Some(200));
        assert_eq!(get("/nodes/metrics"), Some(200));
        for p in ["/", "/status", "/claude", "/metrics"] {
            assert_eq!(get(p), Some(404), "{p}");
        }
        server.unblock();
    }
}
