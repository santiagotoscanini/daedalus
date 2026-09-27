//! Announcing this machine to the box, once a minute.
//!
//! The hello is a signed envelope: `{ payload, pubkey, sig }`, where the
//! payload is a JSON STRING the agent serialised and the signature is over
//! those exact bytes — the box verifies what it received, never a
//! re-serialisation. The payload says who this machine is (hostname, OS,
//! architecture, agent version, address, hardware address, the status page's
//! port) and how it is (up for how long, held awake or not), stamped with the
//! agent's clock: the box refuses a hello more than five minutes off its own
//! (`HELLO_MAX_SKEW_SECS`, app/src/host/agent-hello.ts), so a captured one
//! cannot be replayed after that window.
//!
//! The answer is what the box has decided: `pending` until an admin approves
//! the machine on Settings › Machines, `approved` after, `revoked` if turned
//! away. An approved machine's answer also carries the box's POLICY for it
//! (`Policy` below) and the node token, and any answer may carry three
//! one-shot instructions: `check_update` (the updater looks now),
//! `update_claude` and `restart_claude` (relayed to the tray; claude/mod.rs
//! says why they are two). The answer may also name the box's CONTROLLER —
//! `controller: {address, public_key}` — a hint the machine weighs by how
//! it reached the box (`hint_trust`): ignored over plain HTTP (or when the
//! answer was redirected to it), authenticated only over HTTPS to the box
//! config.toml names, a first use otherwise; and it never replaces a key
//! already trusted (link/node.rs `learn_from_box`). It is how a machine
//! enrolled before the link moves to it without enrolling again. Nothing
//! else rides it.
//!
//! This hello is the LEGACY path. Once the controller has approved the
//! machine over the link, it pauses, and resumes only if the link stays
//! down (`Shared::legacy_hello_wanted`).
//!
//! The payload carries a summary of Claude Code on this machine when the
//! tray has reported one (claude/): its state, versions
//! and session count, so the box's Claude page can list this machine. The
//! full report — sessions, paths, the environment id — is not in the hello:
//! the box reads it from the agent's `/claude` with the node token the
//! answer hands down (status.rs).
//!
//! Finding the box is discover.rs's job; it is re-done when a hello fails
//! and every `REDISCOVER` regardless, so a box that moves is found again.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::claude::Summary;
use crate::config::Config;
use crate::discover::{self, Found};
use crate::facts::Facts;
use crate::identity::Identity;
use crate::link::node::{learn_from_box, HintTrust, Learned};
use crate::net;
use crate::state::now_rfc3339;
use crate::status::Shared;

/// How long a found box is trusted before discovery runs again.
const REDISCOVER: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize)]
struct Payload<'a> {
    hostname: &'a str,
    os: &'a str,
    arch: &'a str,
    agent_version: &'a str,
    mac: Option<&'a str>,
    lan_ip: Option<&'a str>,
    status_port: u16,
    os_uptime_secs: Option<u64>,
    awake_hold: bool,
    /// Claude Code here, as the tray last reported it; absent when it has not.
    #[serde(skip_serializing_if = "Option::is_none")]
    claude: Option<Summary>,
    ts: u64,
}

#[derive(Serialize)]
struct Envelope<'a> {
    payload: &'a str,
    pubkey: &'a str,
    sig: &'a str,
}

/// What the box wants of this machine. The defaults stand until the box has
/// answered a hello for an approved machine; there is no local copy.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Policy {
    /// Hold the machine awake (the agent's first job; off means the box
    /// decided this machine may sleep).
    pub awake_hold: bool,
    /// Run `claude remote-control` in the user's session.
    pub claude_remote_control: bool,
    /// The directory the server runs in; empty means the tray picks the
    /// most recently used trusted project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_workdir: Option<String>,
    /// What the box knows about the providers on this machine — for now,
    /// the port to look for each on. Absent when it names none.
    #[serde(default, skip_serializing_if = "ProvidersPolicy::is_empty")]
    pub providers: ProvidersPolicy,
}

/// The providers half of the policy, one optional entry per kind.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ProvidersPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lemonade: Option<ProviderPolicy>,
}

impl ProvidersPolicy {
    pub fn is_empty(&self) -> bool {
        self.lemonade.is_none()
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ProviderPolicy {
    /// The port the provider answers on; None means the kind's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            awake_hold: true,
            claude_remote_control: true,
            claude_workdir: None,
            providers: ProvidersPolicy::default(),
        }
    }
}

#[derive(Deserialize)]
struct Answer {
    state: String,
    #[serde(default)]
    check_update: bool,
    #[serde(default)]
    update_claude: bool,
    #[serde(default)]
    restart_claude: bool,
    /// Absent for a machine the box has not approved.
    #[serde(default)]
    policy: Option<Policy>,
    /// The token that opens this node's full Claude report to the box;
    /// minted at approval, sent with every answer after.
    #[serde(default)]
    node_token: Option<String>,
    /// The controller this machine should connect to (link/): how a
    /// machine enrolled before the link learns where it is and which key to
    /// trust. Absent until the app names one.
    #[serde(default)]
    controller: Option<ControllerHint>,
}

/// The box's word on its controller, in a hello answer.
#[derive(Deserialize)]
struct ControllerHint {
    address: String,
    public_key: String,
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

fn send(
    url: &str,
    id: &Identity,
    facts: &Facts,
    adapter: &net::Adapter,
    cfg: &Config,
    awake: bool,
    claude: Option<Summary>,
) -> Result<(Answer, String)> {
    let payload = Payload {
        hostname: &crate::facts::hostname(),
        os: facts.os,
        arch: facts.arch,
        agent_version: crate::VERSION,
        mac: adapter.mac.as_deref(),
        lan_ip: adapter.ipv4.as_deref(),
        status_port: cfg.port,
        os_uptime_secs: crate::power::os_uptime_secs(),
        awake_hold: awake,
        claude,
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
    let resp = crate::http::agent()
        .post(&format!("{url}/api/nodes/hello"))
        .set(
            "User-Agent",
            concat!("daedalus-agent/", env!("CARGO_PKG_VERSION")),
        )
        .timeout(Duration::from_secs(15))
        .send_json(serde_json::to_value(&envelope)?);
    match resp {
        Ok(r) => {
            // Where the answer really came from, redirects followed.
            let final_url = r.get_url().to_string();
            let a = r
                .into_json::<Answer>()
                .context("reading the box's answer")?;
            Ok((a, final_url))
        }
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            anyhow::bail!("the box answered {code}: {}", body.trim())
        }
        Err(e) => Err(e).context("reaching the box"),
    }
}

/// How far the controller hint in an answer can be believed: not at all
/// unless both the URL asked and the one that answered (redirects followed)
/// are HTTPS; authenticated only when the box's address is the operator's
/// own (`control_plane_url`, `found_via == "config"`), never one DNS gave.
fn hint_trust(found_via: &str, asked: &str, answered: &str) -> Option<HintTrust> {
    if !(asked.starts_with("https://") && answered.starts_with("https://")) {
        return None;
    }
    Some(if found_via == "config" {
        HintTrust::Authenticated
    } else {
        HintTrust::Unauthenticated
    })
}

/// The answer named the controller: keep, confirm, or flag it
/// (link/node.rs `learn_from_box`); a plain-HTTP answer's hint is ignored.
fn take_hint(
    cfg: &Config,
    shared: &Shared,
    h: &ControllerHint,
    found_via: &str,
    asked: &str,
    answered: &str,
) {
    let Some(trust) = hint_trust(found_via, asked, answered) else {
        tracing::debug!("the box's controller hint came over plain HTTP; ignored");
        return;
    };
    let learned = learn_from_box(
        &crate::link::node::store_path(),
        cfg.controller_pin.as_deref(),
        &h.address,
        &h.public_key,
        trust,
    );
    match learned {
        Learned::Conflict(msg) => {
            tracing::error!("{msg}");
            shared.set_link(|l| l.conflict = Some(msg));
        }
        Learned::Ignored(msg) => tracing::warn!("{msg}"),
        Learned::Recorded | Learned::Confirmed | Learned::Unchanged => {
            shared.set_link(|l| l.conflict = None);
        }
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
        if crate::util::sleep_until(&stop, wait) {
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

        // Approved over the link: the controller carries this machine now
        // (link/node.rs), and the hello waits unless the link stays down.
        if !shared.legacy_hello_wanted() {
            shared.update_control_plane(|c| {
                c.error = None;
            });
            continue;
        }
        let awake = shared.awake_hold();
        let claude = shared.claude_summary();
        match send(&box_.url, &id, &facts, &adapter, &cfg, awake, claude) {
            Ok((a, final_url)) => {
                shared.update_control_plane(|c| {
                    c.url = Some(box_.url.clone());
                    c.found_via = Some(box_.via.clone());
                    c.state = Some(a.state.clone());
                    c.last_hello = Some(now_rfc3339());
                    c.error = None;
                });
                if let Some(h) = &a.controller {
                    take_hint(&cfg, &shared, h, &box_.via, &box_.url, &final_url);
                }
                if a.check_update {
                    tracing::info!("the box asked for an update check");
                    shared.request_check();
                }
                if a.update_claude {
                    tracing::info!("the box asked for a Claude Code update");
                    shared.request_claude_update();
                }
                if a.restart_claude {
                    tracing::info!("the box asked for a Claude remote-control restart");
                    shared.request_claude_restart();
                }
                // The token is only ever carried for an approved node; anything
                // else clears it, so a revoked node stops answering the box too.
                shared.set_node_token(
                    a.node_token
                        .filter(|t| !t.is_empty() && a.state == "approved"),
                );
                // The policy is the box's to set only once it has approved
                // this machine; before that `Policy::default()` stands.
                if let (Some(p), "approved") = (a.policy, a.state.as_str()) {
                    if shared.set_policy(p.clone()) {
                        tracing::info!(
                            awake_hold = p.awake_hold,
                            claude_remote_control = p.claude_remote_control,
                            claude_workdir = p.claude_workdir.as_deref().unwrap_or(""),
                            "policy from the box"
                        );
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_to_the_configured_box_authenticates_a_hint() {
        let h = "https://box.example.org";
        assert_eq!(hint_trust("config", h, h), Some(HintTrust::Authenticated));
        // Found by DNS: at best a first use.
        assert_eq!(hint_trust("lan", h, h), Some(HintTrust::Unauthenticated));
        // Redirected to plain HTTP, or plain HTTP from the start: ignored.
        assert_eq!(
            hint_trust("config", h, "http://box.example.org/api/nodes/hello"),
            None
        );
        assert_eq!(
            hint_trust("config", "http://box.lan:8080", "http://box.lan:8080"),
            None
        );
        assert_eq!(hint_trust("lan", "http://box.lan:8080", "https://x"), None);
    }
}
