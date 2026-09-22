//! Announcing this machine to the box, once a minute.
//!
//! The hello is a signed envelope: `{ payload, pubkey, sig }`, where the
//! payload is a JSON STRING the agent serialised and the signature is over
//! those exact bytes — the box verifies what it received, never a
//! re-serialisation. The payload says who this machine is (hostname, OS,
//! architecture, agent version, address, hardware address, the status page's
//! port) and how it is (up for how long, held awake or not), stamped with the
//! agent's clock so a captured hello cannot be replayed later.
//!
//! The answer is what the box has decided: `pending` until an admin approves
//! the machine on System › Machines, `approved` after, `revoked` if turned
//! away. One instruction can ride it — `check_update: true`, which asks the
//! updater to look now rather than on its next tick — and that is the only
//! thing the box can make this agent do in this version.
//!
//! Finding the box is discover.rs's job; it is re-done when a hello fails
//! and every few minutes regardless, so a box that moves is found again.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::discover::{self, Found};
use crate::facts::Facts;
use crate::identity::Identity;
use crate::net;
use crate::state::now_rfc3339;
use crate::status::Shared;

/// How long a found box is trusted before discovery runs again.
const REDISCOVER: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize)]
struct Payload<'a> {
    hostname: &'a str,
    os: &'a str,
    os_name: &'a str,
    os_version: &'a str,
    arch: &'a str,
    cpu: &'a str,
    memory_bytes: Option<u64>,
    agent_version: &'a str,
    mac: Option<&'a str>,
    lan_ip: Option<&'a str>,
    status_port: u16,
    os_uptime_secs: Option<u64>,
    awake_hold: bool,
    ts: u64,
}

#[derive(Serialize)]
struct Envelope<'a> {
    payload: &'a str,
    pubkey: &'a str,
    sig: &'a str,
}

#[derive(Deserialize)]
struct Answer {
    state: String,
    #[serde(default)]
    check_update: bool,
}

/// What the status page and the tray show about the box.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ControlPlane {
    /// The box's base URL, once found.
    pub url: Option<String>,
    /// Where the URL came from: "config" or the DNS suffix that answered.
    pub found_via: Option<String>,
    /// "pending" | "approved" | "revoked", from the last answer.
    pub state: Option<String>,
    pub node_id: String,
    pub last_hello: Option<String>,
    /// Why the last hello did not land, if it did not.
    pub error: Option<String>,
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

fn send(
    url: &str,
    id: &Identity,
    facts: &Facts,
    adapter: &net::Adapter,
    cfg: &Config,
    awake: bool,
) -> Result<Answer> {
    let payload = Payload {
        hostname: &hostname(),
        os: facts.os,
        os_name: &facts.os_name,
        os_version: &facts.os_version,
        arch: facts.arch,
        cpu: &facts.cpu,
        memory_bytes: facts.memory_bytes,
        agent_version: crate::VERSION,
        mac: adapter.mac.as_deref(),
        lan_ip: adapter.ipv4.as_deref(),
        status_port: cfg.port,
        os_uptime_secs: crate::power::os_uptime_secs(),
        awake_hold: awake,
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    let text = serde_json::to_string(&payload).context("serialising the hello")?;
    let pubkey = id.public_key_hex();
    let sig = id.sign_hex(text.as_bytes());
    let envelope = Envelope {
        payload: &text,
        pubkey: &pubkey,
        sig: &sig,
    };
    let resp = ureq::post(&format!("{url}/api/nodes/hello"))
        .set(
            "User-Agent",
            concat!("daedalus-agent/", env!("CARGO_PKG_VERSION")),
        )
        .timeout(Duration::from_secs(15))
        .send_json(serde_json::to_value(&envelope)?);
    match resp {
        Ok(r) => r.into_json::<Answer>().context("reading the box's answer"),
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            anyhow::bail!("the box answered {code}: {}", body.trim())
        }
        Err(e) => Err(e).context("reaching the box"),
    }
}

/// The service's hello thread.
pub fn run_loop(
    cfg: Config,
    id: Identity,
    facts: Facts,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
) {
    let interval = Duration::from_secs(cfg.hello_secs.max(15));
    let mut found: Option<(Found, Instant)> = None;
    shared.set_control_plane(ControlPlane {
        node_id: id.node_id(),
        ..Default::default()
    });

    let mut wait = Duration::from_secs(5);
    loop {
        if crate::update::sleep_until(&stop, wait) {
            return;
        }
        wait = interval;

        let adapter = net::primary();
        let stale = found
            .as_ref()
            .is_none_or(|(_, at)| at.elapsed() > REDISCOVER);
        if stale {
            found = discover::find(&cfg, &adapter).map(|f| (f, Instant::now()));
        }
        let Some((box_, _)) = found.as_ref() else {
            shared.update_control_plane(|c| {
                c.url = None;
                c.found_via = None;
                c.error = Some(format!(
                    "no {} record under {}",
                    discover::SERVICE,
                    if adapter.dns_suffixes.is_empty() {
                        "any search domain (none from DHCP)".to_string()
                    } else {
                        adapter.dns_suffixes.join(", ")
                    }
                ));
            });
            continue;
        };

        let awake = shared.awake_hold();
        match send(&box_.url, &id, &facts, &adapter, &cfg, awake) {
            Ok(a) => {
                shared.update_control_plane(|c| {
                    c.url = Some(box_.url.clone());
                    c.found_via = Some(box_.via.clone());
                    c.state = Some(a.state.clone());
                    c.last_hello = Some(now_rfc3339());
                    c.error = None;
                });
                if a.check_update {
                    tracing::info!("the box asked for an update check");
                    shared.request_check();
                }
            }
            Err(e) => {
                tracing::warn!(
                    url = box_.url,
                    error = format!("{e:#}"),
                    "hello not delivered"
                );
                shared.update_control_plane(|c| {
                    c.url = Some(box_.url.clone());
                    c.found_via = Some(box_.via.clone());
                    c.error = Some(format!("{e:#}"));
                });
                // Look for the box again next time: it may have moved.
                found = None;
            }
        }
    }
}
