//! The machine's side of the link: finding the controller, deciding whether
//! to trust it, and keeping one connection to it — the hello, the pushes,
//! the box's word back.
//!
//! **Where to.** config.toml's `controller_address`; else the address the
//! first-use key was trusted at (kept in `controller.json` in the data
//! directory); else the SRV record `_daedalus-controller._tcp` under the
//! search domains (discover.rs), asked again every `REDISCOVER`. With none
//! of them the machine reaches nobody and asks again every `IDLE_RETRY`.
//!
//! **Whom to trust** (`Target::pin`): config.toml's `controller_pin`, which
//! nothing overrides; else the key kept in `controller.json`, the first one
//! seen. With neither, the first connection's key is accepted and kept.
//! A connection whose key is not the trusted one is refused: the status
//! page and the tray say "controller key changed", with the key that came
//! (unproven: the pin check runs before the handshake signature) and the
//! one expected, and nothing is re-pinned — the operator clears it (a new
//! `--pin`, or `controller.json` removed) if the controller really did get
//! a new key outside a rotation.
//!
//! **Rotation** (rotation.rs). A controller handing its trust to a new key
//! sends, over a connection the pinned key's handshake just proved, a
//! `rotate` request: the new key and the pinned key's signature over it
//! (identity.rs `verify_rotation`). The machine checks it against THAT key
//! — never against anything the request carries — re-pins where the pin
//! was (config.toml's `controller_pin`, else `controller.json`), then
//! acknowledges and reconnects, asking for the new key by name
//! (tls.rs `server_name_for`). A statement that does not verify is
//! refused and nothing moves; only the holder of the pinned key can make
//! one, so an impostor, which cannot finish the handshake, cannot either.
//!
//! **Pinned or not.** A key from config.toml is pinned. A first-use key is
//! not, and the page (`controller.unconfirmed`) and the tray warn "trusted
//! on first use, unconfirmed: pin it"; the link works all the same.
//!
//! **The connection.** `hello` first (wire.rs): who the machine is. The
//! answer says where it stands. PENDING: the machine sends heartbeats only
//! and waits — the page shows "waiting for approval" with both fingerprints
//! — until a `state` event upgrades it in place. APPROVED: the policy
//! applies (the awake hold, Claude, providers: wire.rs `Policy`), commands
//! are taken and acknowledged at once, and the machine pushes:
//!
//! - `status` — the status page's document without its telemetry — when it
//!   changes (uptimes and report clocks aside) and every `PUSH_EVERY`; the
//!   OS's power requests in it are read every `PUSH_EVERY`;
//! - `telemetry`, the whole document at the machine's level, when a sample
//!   carries newly read static or slow facts or OS updates, and otherwise
//!   every `PUSH_EVERY` — not every 15-second sample;
//! - `claude`, the session's full report, when it changes (its clock
//!   aside) and every `PUSH_EVERY`;
//! - `providers`, what the machine's model servers answered on loopback
//!   (providers.rs), when it changes (its clocks aside) and every
//!   `PUSH_EVERY`;
//! - `claude_roster`, the session's roster of Claude sessions
//!   (claude/roster.rs), when it changes (its clock and ticking costs
//!   aside) and every `PUSH_EVERY`.
//!
//! and takes the controller's `claude_session` requests — one verb on one
//! session, checked, handed to the session, acknowledged at once; the
//! outcome rides the next roster (`actions`).
//!
//! REVOKED: the machine says so and leaves; it tries again at the slowest
//! step, in case the box changes its mind.

use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::tls::{self, Recv, Tls};
use super::wire::{
    self, name, Accepted, ClaudeSessionParams, Command, CommandParams, Hello, HelloFacts, Incoming,
    NodeState, Policy, RotateParams, StateEvent, Welcome, PROTO,
};
use super::{BACKOFF_MAX, BACKOFF_MIN, DEAD_AFTER, HANDSHAKE_TIMEOUT, HEARTBEAT, WRITE_TIMEOUT};
use crate::api::wire::{code, ApiError, Response};
use crate::config::Config;
use crate::identity::{digest, format_fingerprint, parse_fingerprint, Identity};
use crate::state::now_rfc3339;
use crate::status::Shared;

/// Where the first-use controller key is kept, in the data directory.
pub const STORE_FILE: &str = "controller.json";
/// The slowest a push waits when nothing changed.
pub const PUSH_EVERY: Duration = Duration::from_secs(60);
/// How often the pushes are looked at.
const PUSH_CHECK: Duration = Duration::from_secs(2);
/// How long a DNS-found address is used before the record is asked again.
const REDISCOVER: Duration = Duration::from_secs(10 * 60);
/// How long the loop waits when there is no controller to try.
const IDLE_RETRY: Duration = Duration::from_secs(60);

/// The controller key this machine trusted on first use, and where.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Stored {
    /// Where the controller was reached.
    pub address: Option<String>,
    /// Its key's fingerprint (identity.rs).
    pub fingerprint: String,
}

pub fn store_path() -> PathBuf {
    crate::config::data_dir().join(STORE_FILE)
}

/// Whether the store may be read: absent, or owned by whom private.rs
/// trusts. One that is not is never read — nor replaced by a first use.
pub fn store_trusted(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    crate::private::check_owner(path).map_err(|e| format!("{e:#}"))
}

pub fn load_store(path: &Path) -> Option<Stored> {
    store_trusted(path).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Stored>(&text)
        .ok()
        .filter(|s| parse_fingerprint(&s.fingerprint).is_ok())
}

fn save_store(path: &Path, s: &Stored) -> Result<(), String> {
    let text = serde_json::to_string_pretty(s).unwrap_or_default();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    crate::util::write_atomic(path, text.as_bytes(), Some(0o644)).map_err(|e| {
        tracing::warn!(path = %path.display(), error = %e, "link: the trusted controller key was not saved");
        format!("{}: {e}", path.display())
    })
}

/// Where this machine keeps whom it trusts: the first-use store, and the
/// config.toml whose `controller_pin` a rotation rewrites where that is
/// the pin.
#[derive(Clone, Copy, Debug)]
pub struct Trust<'a> {
    pub store: &'a Path,
    pub config: &'a Path,
}

/// Where the next attempt goes, and what it trusts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub address: String,
    pub found_via: String,
    /// The SHA-256 of the key to accept; None: trust on first use.
    pub pin: Option<[u8; 32]>,
    /// "config" or "tofu"; None with no pin.
    pub pinned_via: Option<&'static str>,
}

impl Target {
    /// Pinned in config.toml, as opposed to trusted on first use.
    pub fn pinned(&self) -> bool {
        self.pinned_via == Some("config")
    }
}

/// The pure half of choosing a target (module doc). `dns` is asked only
/// when nothing else names an address. An unreadable config pin is an
/// error, so the loop can say so rather than trust on first use.
pub fn resolve_target(
    config_address: Option<&str>,
    config_pin: Option<&str>,
    stored: Option<&Stored>,
    dns: impl FnOnce() -> Option<(String, String)>,
) -> Result<Option<Target>, String> {
    let config_address = config_address.map(str::trim).filter(|a| !a.is_empty());
    let (pin, pinned_via) = match config_pin.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => (
            Some(parse_fingerprint(p).map_err(|e| format!("controller_pin in config.toml: {e}"))?),
            Some("config"),
        ),
        None => match stored.and_then(|s| parse_fingerprint(&s.fingerprint).ok()) {
            Some(d) => (Some(d), Some("tofu")),
            None => (None, None),
        },
    };
    let (address, found_via) = match config_address {
        Some(a) => (a.to_string(), "config".to_string()),
        None => match stored.and_then(|s| s.address.clone()) {
            Some(a) => (a, "stored".to_string()),
            None => match dns() {
                Some((a, suffix)) => (a, format!("dns {suffix}")),
                None => return Ok(None),
            },
        },
    };
    if !crate::config::valid_host_port(&address) {
        return Err(format!(
            "the controller address {address:?} is not host:port"
        ));
    }
    Ok(Some(Target {
        address,
        found_via,
        pin,
        pinned_via,
    }))
}

/// How one attempt ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// Asked to stop.
    Stopped,
    /// The connection was up and approved or pending, then ended.
    Dropped(String),
    /// The controller could not be reached or refused this machine.
    Failed(String),
    /// The controller presented another key than the trusted one.
    /// `presented_unproven` is what its certificate carried, before any
    /// signature proved the peer holds it: shown, never trusted.
    KeyChanged {
        presented_unproven: [u8; 32],
        pinned: [u8; 32],
    },
    /// The box turned this machine away.
    Revoked,
    /// The controller speaks another protocol.
    Version(String),
    /// The controller handed its trust to a new key, and this machine
    /// re-pinned from `from` to `new` (the keys's digests): connect again
    /// under it.
    Rotated { from: [u8; 32], new: [u8; 32] },
}

/// What the machine is, for `hello`.
pub fn hello_of(cfg: &Config, id: &Identity, facts: &crate::facts::Facts) -> Hello {
    let adapter = crate::net::primary();
    Hello {
        proto: PROTO,
        node_id: id.node_id(),
        agent_version: crate::VERSION.into(),
        os: facts.os.into(),
        arch: facts.arch.into(),
        hostname: crate::facts::hostname(),
        mac: adapter.mac,
        lan_ip: adapter.ipv4,
        facts: HelloFacts {
            os_name: facts.os_name.clone(),
            os_version: facts.os_version.clone(),
            cpu: facts.cpu.clone(),
            memory_bytes: facts.memory_bytes,
        },
        capabilities: crate::api::capabilities(cfg, false)
            .into_iter()
            .map(str::to_string)
            .collect(),
        telemetry: cfg.telemetry,
    }
}

/// The service's link thread (module doc).
pub fn run_loop(
    mut cfg: Config,
    id: Identity,
    facts: crate::facts::Facts,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
) {
    let store = store_path();
    let config_path = crate::config::config_path();
    // The TLS side, once: the key's DER is made and loaded one time.
    let client = match tls::Client::new(&id) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(
                error = format!("{e:#}"),
                "link: no TLS client; no controller will be reached"
            );
            return;
        }
    };
    let mut dns_found: Option<((String, String), Instant)> = None;
    let mut backoff = BACKOFF_MIN;
    shared.set_link(|l| l.fingerprint = id.fingerprint());
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        if let Err(e) = store_trusted(&store) {
            tracing::error!(error = %e, "link: the trusted controller key cannot be read");
            shared.set_link(|l| {
                l.state = Some("refused".into());
                l.connected = false;
                l.error = Some(e);
            });
            if crate::util::sleep_until(&stop, IDLE_RETRY) {
                return;
            }
            continue;
        }
        let stored = load_store(&store);
        let target = resolve_target(
            cfg.controller_address.as_deref(),
            cfg.controller_pin.as_deref(),
            stored.as_ref(),
            || {
                if let Some((f, at)) = &dns_found {
                    if at.elapsed() < REDISCOVER {
                        return Some(f.clone());
                    }
                }
                let found = crate::discover::find_controller(&cfg, &crate::net::primary());
                dns_found = found.clone().map(|f| (f, Instant::now()));
                found
            },
        );
        let target = match target {
            Ok(Some(t)) => t,
            Ok(None) => {
                shared.set_link(|l| {
                    l.address = None;
                    l.found_via = None;
                    l.state = None;
                    l.connected = false;
                    l.error = None;
                });
                if crate::util::sleep_until(&stop, IDLE_RETRY) {
                    return;
                }
                continue;
            }
            Err(e) => {
                tracing::warn!(error = %e, "link: no controller to try");
                shared.set_link(|l| {
                    l.state = Some("refused".into());
                    l.connected = false;
                    l.error = Some(e);
                });
                if crate::util::sleep_until(&stop, IDLE_RETRY) {
                    return;
                }
                continue;
            }
        };
        shared.set_link(|l| {
            l.address = Some(target.address.clone());
            l.found_via = Some(target.found_via.clone());
            l.controller_fingerprint = target.pin.as_ref().map(format_fingerprint);
            l.pinned_via = target.pinned_via.map(str::to_string);
            l.unconfirmed = !target.pinned();
            l.state = Some("connecting".into());
        });
        let hello = hello_of(&cfg, &id, &facts);
        let ended = connect_once(
            &target,
            &client,
            hello,
            &shared,
            &stop,
            Trust {
                store: &store,
                config: &config_path,
            },
            &Cadence::default(),
        );
        let wait = match &ended {
            Ended::Stopped => return,
            Ended::Rotated { from, new } => {
                let fp = format_fingerprint(new);
                tracing::warn!(
                    fingerprint = %fp,
                    via = target.pinned_via.unwrap_or("tofu"),
                    "link: re-pinned to the controller's new key (a signed rotation); connecting under it"
                );
                // config.toml was rewritten; this process read it at start.
                if target.pinned() {
                    cfg.controller_pin = Some(fp.clone());
                }
                backoff = BACKOFF_MIN;
                shared.set_link(|l| {
                    l.connected = false;
                    l.since = None;
                    l.error = None;
                    l.rotated = Some(format!(
                        "re-pinned from {} to {fp} at {} (the controller's signed rotation)",
                        format_fingerprint(from),
                        now_rfc3339()
                    ));
                });
                Duration::ZERO
            }
            Ended::Dropped(why) => {
                tracing::info!(why, "link: the connection to the controller ended");
                // It was up: the machine is quick to come back.
                backoff = BACKOFF_MIN;
                shared.set_link(|l| {
                    l.connected = false;
                    l.since = None;
                    l.error = Some(why.clone());
                });
                BACKOFF_MIN
            }
            Ended::Failed(why) => {
                tracing::info!(address = %target.address, why, "link: controller not reached");
                shared.set_link(|l| {
                    l.connected = false;
                    l.state = Some("connecting".into());
                    l.error = Some(why.clone());
                });
                // An address found by DNS may have moved.
                if target.found_via.starts_with("dns") {
                    dns_found = None;
                }
                let w = backoff;
                backoff = (backoff * 2).min(BACKOFF_MAX);
                w
            }
            Ended::KeyChanged {
                presented_unproven,
                pinned,
            } => {
                let e = format!(
                    "controller key changed: {} presented {} (unproven), but this machine trusts {} ({}); \
                     refusing it. If the controller really has a new key, pin it (`install --pin`) \
                     or remove {}",
                    target.address,
                    format_fingerprint(&digest(presented_unproven)),
                    format_fingerprint(pinned),
                    target.pinned_via.unwrap_or("config"),
                    store.display()
                );
                tracing::error!("{e}");
                shared.set_link(|l| {
                    l.connected = false;
                    l.state = Some("key-changed".into());
                    l.error = Some(e);
                });
                BACKOFF_MAX
            }
            Ended::Revoked => {
                tracing::warn!("link: the box revoked this machine");
                shared.set_link(|l| {
                    l.connected = false;
                    l.since = None;
                    l.state = Some("revoked".into());
                    l.error = None;
                });
                BACKOFF_MAX
            }
            Ended::Version(e) => {
                tracing::warn!(error = %e, "link: the controller speaks another protocol");
                shared.set_link(|l| {
                    l.connected = false;
                    l.state = Some("refused".into());
                    l.error = Some(e.clone());
                });
                BACKOFF_MAX
            }
        };
        if crate::util::sleep_until(&stop, wait) {
            return;
        }
    }
}

/// How often a connection does what it does; `Default` is the module's
/// constants, the tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct Cadence {
    pub heartbeat: Duration,
    pub dead_after: Duration,
    pub push_every: Duration,
    pub push_check: Duration,
}

impl Default for Cadence {
    fn default() -> Self {
        Self {
            heartbeat: HEARTBEAT,
            dead_after: DEAD_AFTER,
            push_every: PUSH_EVERY,
            push_check: PUSH_CHECK,
        }
    }
}

fn io_why(e: &std::io::Error) -> String {
    e.to_string()
}

/// One attempt: connect, prove both keys, hello, then the conversation
/// until it ends.
pub fn connect_once(
    target: &Target,
    client: &tls::Client,
    hello: Hello,
    shared: &Arc<Shared>,
    stop: &AtomicBool,
    trust: Trust<'_>,
    cadence: &Cadence,
) -> Ended {
    let addrs: Vec<_> = match target.address.to_socket_addrs() {
        Ok(a) => a.collect(),
        Err(e) => return Ended::Failed(format!("{}: {e}", target.address)),
    };
    let Some(sock) = addrs
        .iter()
        .find_map(|a| TcpStream::connect_timeout(a, HANDSHAKE_TIMEOUT).ok())
    else {
        return Ended::Failed(format!("{}: no answer", target.address));
    };
    let _ = sock.set_write_timeout(Some(WRITE_TIMEOUT));
    let mut tls = match client.connect(sock, target.pin, HANDSHAKE_TIMEOUT) {
        Ok(t) => t,
        Err(tls::ConnectError::KeyMismatch {
            presented_unproven,
            pinned,
        }) => {
            return Ended::KeyChanged {
                presented_unproven,
                pinned,
            }
        }
        Err(tls::ConnectError::Io(e)) => return Ended::Failed(format!("TLS: {}", io_why(&e))),
    };
    let Some(controller_key) = tls.peer_key() else {
        return Ended::Failed("the controller presented no key".into());
    };
    let controller_fp = format_fingerprint(&digest(&controller_key));
    if target.pin.is_none() {
        // Trust on first use: this key, from now on.
        tracing::warn!(
            address = %target.address,
            fingerprint = %controller_fp,
            "link: trusting the controller's key on first use"
        );
        let _ = save_store(
            trust.store,
            &Stored {
                address: Some(target.address.clone()),
                fingerprint: controller_fp.clone(),
            },
        );
    }
    shared.set_link(|l| {
        l.fingerprint = client.fingerprint().to_string();
        l.controller_fingerprint = Some(controller_fp.clone());
        l.pinned_via = Some(target.pinned_via.unwrap_or("tofu").into());
        l.unconfirmed = !target.pinned();
    });

    // hello, and its answer.
    if let Err(e) = tls.send(&wire::request(1, name::HELLO, &hello)) {
        return Ended::Failed(format!("hello: {e}"));
    }
    let until = Instant::now() + HANDSHAKE_TIMEOUT;
    let welcome: Welcome = loop {
        match tls.recv() {
            Ok(Recv::Line(l)) => match Incoming::parse(&l) {
                Ok(Incoming::Answer {
                    id: Some(1),
                    result: Ok(v),
                }) => match serde_json::from_value(v) {
                    Ok(w) => break w,
                    Err(e) => return Ended::Failed(format!("the controller's answer: {e}")),
                },
                Ok(Incoming::Answer { result: Err(e), .. }) => {
                    tls.close();
                    return match e.code.as_str() {
                        "version" => Ended::Version(e.msg),
                        "forbidden" => Ended::Revoked,
                        _ => Ended::Failed(format!("refused: {}", e.msg)),
                    };
                }
                _ => continue,
            },
            Ok(Recv::Idle) if Instant::now() < until => continue,
            Ok(Recv::Idle) => return Ended::Failed("no answer to hello".into()),
            Ok(Recv::Closed) => return Ended::Failed("closed before answering hello".into()),
            Err(e) => return Ended::Failed(format!("hello: {e}")),
        }
    };
    if welcome.state == NodeState::Revoked {
        tls.close();
        return Ended::Revoked;
    }
    tracing::info!(
        address = %target.address,
        state = welcome.state.as_str(),
        controller = %welcome.controller.hostname,
        "link: connected to the controller"
    );
    shared.set_link(|l| {
        l.connected = true;
        l.since = Some(now_rfc3339());
        l.state = Some(welcome.state.as_str().into());
        l.error = None;
    });
    // Where a rotation re-pins: where the pin is (module doc).
    let repin = |new: &[u8; 32]| -> Result<(), String> {
        let fp = format_fingerprint(&digest(new));
        if target.pinned() {
            crate::config::set_controller_pin_at(trust.config, &fp).map_err(|e| format!("{e:#}"))
        } else {
            save_store(
                trust.store,
                &Stored {
                    address: Some(target.address.clone()),
                    fingerprint: fp,
                },
            )
        }
    };
    let ended = converse(
        &mut tls,
        welcome,
        shared,
        stop,
        cadence,
        shared.role().claude_update,
        (controller_key, &repin),
    );
    if !matches!(ended, Ended::Stopped | Ended::Revoked) {
        tls.close();
    }
    shared.set_link(|l| {
        l.connected = false;
        l.since = None;
    });
    ended
}

/// What was pushed last, to push only what moved.
#[derive(Default)]
struct Pushed {
    checked: Option<Instant>,
    status: Option<(String, Instant)>,
    power: Option<(Option<String>, Instant)>,
    telemetry: Option<(u64, String, Instant)>,
    providers: Option<(String, Instant)>,
    claude: Option<(String, Instant)>,
    roster: Option<(String, Instant)>,
}

/// The status document without what moves by itself.
fn status_digest(v: &Value) -> String {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        for k in [
            "uptime_secs",
            "os_uptime_secs",
            "booted_at",
            "power_requests",
        ] {
            o.remove(k);
        }
        if let Some(t) = o.get_mut("tray").and_then(Value::as_object_mut) {
            t.remove("last_report");
        }
    }
    v.to_string()
}

impl Pushed {
    /// Push what is due; an error is the connection's.
    fn run(&mut self, tls: &mut Tls, shared: &Shared, cadence: &Cadence) -> std::io::Result<()> {
        if self
            .checked
            .is_some_and(|c| c.elapsed() < cadence.push_check)
        {
            return Ok(());
        }
        self.checked = Some(Instant::now());
        let due = |at: &Instant| at.elapsed() >= cadence.push_every;

        // The OS's power requests: a command, read on the slow cadence.
        if self.power.as_ref().is_none_or(|(_, at)| due(at)) {
            self.power = Some((crate::power::requests_report(), Instant::now()));
        }
        let power = self.power.as_ref().and_then(|(p, _)| p.clone());
        let status = shared.status_value(power);
        let d = status_digest(&status);
        if self
            .status
            .as_ref()
            .is_none_or(|(prev, at)| *prev != d || due(at))
        {
            tls.send(&wire::event(name::STATUS, &status))?;
            self.status = Some((d, Instant::now()));
        }

        if let Some((t, tier)) = shared.telemetry_with_tier() {
            let moved = self
                .telemetry
                .as_ref()
                .is_none_or(|(prev_tier, prev_at, at)| {
                    *prev_tier != tier || (*prev_at != t.sampled_at && due(at))
                });
            if moved {
                let line = wire::event(name::TELEMETRY, &t);
                if line.len() > super::MAX_LINE {
                    tracing::warn!(bytes = line.len(), "link: the telemetry document is past the line limit; sent without the application list");
                    let mut slim = t.clone();
                    slim.apps.clear();
                    tls.send(&wire::event(name::TELEMETRY, &slim))?;
                } else {
                    tls.send(&line)?;
                }
                self.telemetry = Some((tier, t.sampled_at.clone(), Instant::now()));
            }
        }

        // The providers, on the same rule, their clocks aside
        // (`providers::digest`); read whatever the telemetry level.
        if let Some(list) = shared.providers() {
            let d = crate::providers::digest(&list);
            if self
                .providers
                .as_ref()
                .is_none_or(|(prev, at)| *prev != d || due(at))
            {
                tls.send(&wire::event(name::PROVIDERS, &list))?;
                self.providers = Some((d, Instant::now()));
            }
        }

        let report = shared.claude_report();
        let d = match &report {
            Some(r) => {
                let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
                if let Some(o) = v.as_object_mut() {
                    o.remove("reported_at");
                }
                v.to_string()
            }
            None => "null".into(),
        };
        if self
            .claude
            .as_ref()
            .is_none_or(|(prev, at)| *prev != d || due(at))
        {
            tls.send(&wire::event(name::CLAUDE, &report))?;
            self.claude = Some((d, Instant::now()));
        }

        // The roster, on the same rule: its clock and the costs that tick
        // by themselves aside (`Roster::digest`). The session keeps it
        // within `roster::MAX_BYTES`, well inside a line.
        let roster = shared.claude_roster();
        let d = roster
            .as_ref()
            .map(crate::claude::Roster::digest)
            .unwrap_or_else(|| "null".into());
        if self
            .roster
            .as_ref()
            .is_none_or(|(prev, at)| *prev != d || due(at))
        {
            tls.send(&wire::event(name::CLAUDE_ROSTER, &roster))?;
            self.roster = Some((d, Instant::now()));
        }
        Ok(())
    }
}

/// Take one verb on a Claude session from the controller: checked here
/// (the selector, the policy, a session to hand it to) and again by the
/// session, which runs it and reports the outcome in its roster under the
/// controller's request id.
fn take_claude_session(shared: &Shared, p: Value) -> Result<Accepted, ApiError> {
    let params: ClaudeSessionParams = serde_json::from_value(p)
        .map_err(|e| ApiError::new(code::BAD_REQUEST, format!("claude_session: {e}")))?;
    crate::claude::sessions::check_selector(params.action, &params.id)
        .map_err(|e| ApiError::new(code::BAD_REQUEST, e))?;
    if params.request.len() != 16 || !params.request.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::new(
            code::BAD_REQUEST,
            "claude_session: the request id is sixteen hex characters",
        ));
    }
    if !shared.policy().claude_remote_control {
        return Err(ApiError::new(
            code::UNAVAILABLE,
            "Claude is off on this machine (the box's policy)",
        ));
    }
    if shared.claude_report().is_none() {
        return Err(ApiError::new(
            code::UNAVAILABLE,
            "no session is reporting on this machine",
        ));
    }
    if !shared.queue_claude_session_as(params.request.clone(), params.action, params.id.clone()) {
        return Err(ApiError::new(
            code::BUSY,
            "the session has requests waiting that it has not taken",
        ));
    }
    tracing::info!(
        request = %params.request,
        action = params.action.as_str(),
        id = %params.id,
        "the controller asked for a Claude session verb"
    );
    Ok(Accepted { accepted: true })
}

/// Take one residency verb from the controller: checked here, run on a
/// thread of its own (a load takes tens of seconds, and the link must keep
/// its heartbeats), acknowledged at once. The outcome rides the next
/// `providers` document under the controller's request id; the reader
/// reads again as soon as the verb ends, so the document shows the slot as
/// it now is.
fn take_provider_model(shared: &Arc<Shared>, p: Value) -> Result<Accepted, ApiError> {
    let params: crate::providers::ProviderModelParams = serde_json::from_value(p)
        .map_err(|e| ApiError::new(code::BAD_REQUEST, format!("provider_model: {e}")))?;
    params
        .check()
        .map_err(|e| ApiError::new(code::BAD_REQUEST, format!("provider_model: {e}")))?;
    let port = shared
        .policy()
        .providers
        .lemonade
        .and_then(|l| l.port)
        .unwrap_or(crate::providers::LEMONADE_DEFAULT_PORT);
    if !shared.begin_provider_action() {
        return Err(ApiError::new(
            code::BUSY,
            "a residency verb is still running on this machine",
        ));
    }
    tracing::info!(
        request = %params.request,
        action = ?params.action,
        model = %params.model,
        "the controller asked for a residency verb"
    );
    let shared2 = Arc::clone(shared);
    let (request, model) = (params.request.clone(), params.model.clone());
    let spawned = std::thread::Builder::new()
        .name("provider-model".into())
        .spawn(move || {
            let result = crate::providers::residency(port, &params);
            let (ok, message) = match result {
                Ok(m) => (true, m),
                Err(m) => (false, m),
            };
            tracing::info!(request = %params.request, ok, message = %message, "residency verb ended");
            shared2.finish_provider_action(crate::providers::ProviderAction {
                request: params.request,
                model: crate::providers::clip(&params.model, crate::providers::MAX_TEXT),
                ok,
                message: crate::providers::clip(&message, crate::providers::MAX_TEXT),
                at: crate::state::now_rfc3339(),
            });
        });
    if spawned.is_err() {
        shared.finish_provider_action(crate::providers::ProviderAction {
            request,
            model: crate::providers::clip(&model, crate::providers::MAX_TEXT),
            ok: false,
            message: "could not start the residency verb".into(),
            at: crate::state::now_rfc3339(),
        });
        return Err(ApiError::new(
            code::UNAVAILABLE,
            "could not start the residency verb",
        ));
    }
    Ok(Accepted { accepted: true })
}

/// Check a rotation statement against `pinned`, the key this connection's
/// handshake proved (module doc): the new key, when `pinned` signed it.
pub fn take_rotate(pinned: &[u8; 32], p: Value) -> Result<[u8; 32], ApiError> {
    let params: RotateParams = serde_json::from_value(p)
        .map_err(|e| ApiError::new(code::BAD_REQUEST, format!("rotate: {e}")))?;
    let new = crate::identity::parse_public_key(&params.new_public_key)
        .map_err(|e| ApiError::new(code::BAD_REQUEST, format!("rotate: {e}")))?;
    let sig = hex::decode(&params.signature)
        .map_err(|_| ApiError::new(code::BAD_REQUEST, "rotate: the signature is not hex"))?;
    if !crate::identity::verify_rotation(pinned, &new, &sig) {
        return Err(ApiError::new(
            code::FORBIDDEN,
            "rotate: the statement is not the trusted controller key's; nothing re-pinned",
        ));
    }
    Ok(new)
}

/// Apply one command from the controller; the answer's body or an error.
fn take_command(shared: &Shared, p: Value, claude_update: bool) -> Result<Accepted, ApiError> {
    let params: CommandParams = serde_json::from_value(p)
        .map_err(|e| ApiError::new(code::BAD_REQUEST, format!("command: {e}")))?;
    match params.command {
        Command::CheckUpdate => {
            tracing::info!("the controller asked for an update check");
            shared.request_check();
        }
        Command::ClaudeUpdate if !claude_update => {
            return Err(ApiError::new(
                code::UNSUPPORTED,
                "this agent does not update Claude Code",
            ))
        }
        Command::ClaudeUpdate => {
            tracing::info!("the controller asked for a Claude Code update");
            shared.request_claude_update();
        }
        Command::ClaudeRestart => {
            tracing::info!("the controller asked for a Claude remote-control restart");
            shared.request_claude_restart();
        }
    }
    Ok(Accepted { accepted: true })
}

/// How a connection re-pins to the key a rotation hands over to.
type Repin<'a> = &'a dyn Fn(&[u8; 32]) -> Result<(), String>;

/// The conversation after `hello` (module doc).
fn converse(
    tls: &mut Tls,
    welcome: Welcome,
    shared: &Arc<Shared>,
    stop: &AtomicBool,
    cadence: &Cadence,
    claude_update: bool,
    // The key the handshake proved, and how to re-pin to its successor.
    peer: ([u8; 32], Repin<'_>),
) -> Ended {
    let mut state = welcome.state;
    if let (NodeState::Approved, Some(p)) = (state, welcome.policy) {
        apply_policy(shared, p);
    }
    let mut pushed = Pushed::default();
    let mut heard = Instant::now();
    let mut said = Instant::now();
    loop {
        if stop.load(Ordering::Relaxed) {
            tls.close();
            return Ended::Stopped;
        }
        if state == NodeState::Approved {
            if let Err(e) = pushed.run(tls, shared, cadence) {
                return Ended::Dropped(format!("a write failed: {e}"));
            }
        }
        if said.elapsed() >= cadence.heartbeat {
            if let Err(e) = tls.send(wire::HB_LINE) {
                return Ended::Dropped(format!("a write failed: {e}"));
            }
            said = Instant::now();
        }
        let line = match tls.recv() {
            Ok(Recv::Line(l)) => l,
            Ok(Recv::Idle) => {
                if heard.elapsed() > cadence.dead_after {
                    return Ended::Dropped(format!(
                        "no word from the controller for {} s",
                        cadence.dead_after.as_secs()
                    ));
                }
                continue;
            }
            Ok(Recv::Closed) => return Ended::Dropped("closed by the controller".into()),
            Err(e) => return Ended::Dropped(format!("the connection failed: {e}")),
        };
        heard = Instant::now();
        match Incoming::parse(&line) {
            Ok(Incoming::Event { e, p }) => match e.as_str() {
                name::STATE => {
                    let Ok(s) = serde_json::from_value::<StateEvent>(p) else {
                        continue;
                    };
                    tracing::info!(
                        state = s.state.as_str(),
                        "link: the controller says where this machine stands"
                    );
                    state = s.state;
                    shared.set_link(|l| l.state = Some(state.as_str().into()));
                    match state {
                        NodeState::Approved => pushed = Pushed::default(),
                        NodeState::Revoked => {
                            tls.close();
                            return Ended::Revoked;
                        }
                        _ => {}
                    }
                }
                name::POLICY if state == NodeState::Approved => {
                    if let Ok(p) = serde_json::from_value::<Policy>(p) {
                        apply_policy(shared, p);
                    }
                }
                _ => {}
            },
            Ok(Incoming::Request { id, m, p }) => {
                let mut rotated = None;
                let answer = match m.as_str() {
                    // Whatever the machine's standing: the key it trusts
                    // hands over to another (module doc).
                    name::ROTATE => match take_rotate(&peer.0, p).and_then(|new| {
                        (peer.1)(&new)
                            .map(|()| new)
                            .map_err(|e| ApiError::new(code::INTERNAL, format!("re-pinning: {e}")))
                    }) {
                        Ok(new) => {
                            rotated = Some((digest(&peer.0), digest(&new)));
                            Response::ok(id, &Accepted { accepted: true })
                        }
                        Err(e) => {
                            tracing::warn!(error = %e.msg, "link: refused a controller key rotation");
                            Response::err(Some(id), e)
                        }
                    },
                    name::COMMAND if state == NodeState::Approved => {
                        match take_command(shared, p, claude_update) {
                            Ok(a) => Response::ok(id, &a),
                            Err(e) => Response::err(Some(id), e),
                        }
                    }
                    name::CLAUDE_SESSION if state == NodeState::Approved => {
                        match take_claude_session(shared, p) {
                            Ok(a) => Response::ok(id, &a),
                            Err(e) => Response::err(Some(id), e),
                        }
                    }
                    name::PROVIDER_MODEL if state == NodeState::Approved => {
                        match take_provider_model(shared, p) {
                            Ok(a) => Response::ok(id, &a),
                            Err(e) => Response::err(Some(id), e),
                        }
                    }
                    name::COMMAND | name::CLAUDE_SESSION | name::PROVIDER_MODEL => Response::err(
                        Some(id),
                        ApiError::new(code::UNAVAILABLE, "this machine is not approved"),
                    ),
                    _ => Response::err(
                        Some(id),
                        ApiError::new(
                            code::UNKNOWN_METHOD,
                            format!("no method `{m}` on a machine"),
                        ),
                    ),
                };
                let line = serde_json::to_string(&answer).unwrap_or_default();
                if let Err(e) = tls.send(&line) {
                    return Ended::Dropped(format!("a write failed: {e}"));
                }
                said = Instant::now();
                if let Some((from, new)) = rotated {
                    tls.close();
                    return Ended::Rotated { from, new };
                }
            }
            Ok(Incoming::Answer { .. }) => {}
            Err(e) => tracing::debug!(error = %e, "link: a line that is not a message"),
        }
    }
}

/// The box's decision: into the shared state, and — when it moved — kept on
/// disk, so the next start begins from it (config.rs `last_policy`).
fn apply_policy(shared: &Shared, p: Policy) {
    let changed = shared.set_policy(p.clone());
    if changed || !crate::config::policy_path().exists() {
        crate::config::save_policy(&p);
    }
    if changed {
        tracing::info!(
            awake_hold = p.awake_hold,
            claude_remote_control = p.claude_remote_control,
            claude_workdir = p.claude_workdir.as_deref().unwrap_or(""),
            "policy from the controller"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(n: u8) -> String {
        format_fingerprint(&[n; 32])
    }

    #[test]
    fn the_target_follows_config_then_the_store_then_dns() {
        let no_dns = || -> Option<(String, String)> { panic!("DNS asked") };
        // Nothing: DNS is asked, and nothing found is no target.
        assert_eq!(resolve_target(None, None, None, || None), Ok(None));
        // DNS alone: trust on first use.
        let t = resolve_target(None, None, None, || {
            Some(("box.lan:7788".into(), "lan".into()))
        })
        .unwrap()
        .unwrap();
        assert_eq!(
            (t.found_via.as_str(), t.pin, t.pinned_via),
            ("dns lan", None, None)
        );
        assert!(!t.pinned());
        // Config address and pin win over everything.
        let stored = Stored {
            address: Some("old.lan:7788".into()),
            fingerprint: fp(2),
        };
        let t = resolve_target(Some("box.lan:7788"), Some(&fp(1)), Some(&stored), no_dns)
            .unwrap()
            .unwrap();
        assert_eq!(t.address, "box.lan:7788");
        assert_eq!((t.pin, t.pinned_via), (Some([1; 32]), Some("config")));
        assert!(t.pinned());
        // The store: the first use, its address and key.
        let t = resolve_target(None, None, Some(&stored), no_dns)
            .unwrap()
            .unwrap();
        assert_eq!(
            (t.address.as_str(), t.found_via.as_str()),
            ("old.lan:7788", "stored")
        );
        assert_eq!((t.pin, t.pinned_via), (Some([2; 32]), Some("tofu")));
        assert!(!t.pinned());
        let t = resolve_target(Some("box.lan:7788"), None, Some(&stored), no_dns)
            .unwrap()
            .unwrap();
        assert_eq!(
            (t.pin, t.pinned_via, t.found_via.as_str()),
            (Some([2; 32]), Some("tofu"), "config")
        );
        // A config pin that is not a fingerprint is said, never trusted past.
        assert!(
            resolve_target(Some("box.lan:7788"), Some("nope"), None, no_dns)
                .unwrap_err()
                .contains("controller_pin")
        );
        assert!(resolve_target(Some("box.lan"), None, None, no_dns).is_err());
    }

    #[test]
    fn the_status_digest_ignores_what_moves_by_itself() {
        let a = serde_json::json!({"uptime_secs": 1, "awake_hold": true, "tray": {"reporting": true, "last_report": "t1"}});
        let b = serde_json::json!({"uptime_secs": 9, "awake_hold": true, "tray": {"reporting": true, "last_report": "t2"}});
        let c = serde_json::json!({"uptime_secs": 9, "awake_hold": false, "tray": {"reporting": true, "last_report": "t2"}});
        assert_eq!(status_digest(&a), status_digest(&b));
        assert_ne!(status_digest(&b), status_digest(&c));
    }
}
