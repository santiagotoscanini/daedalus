//! The machine's side of the link: finding the controller, deciding whether
//! to trust it, and keeping one connection to it — the hello, the pushes,
//! the box's word back.
//!
//! **Where to.** config.toml's `controller_address`; else the address the
//! box named in a legacy hello answer, or the one first trusted (kept in
//! `controller.json` in the data directory); else the SRV record
//! `_daedalus-controller._tcp` under the same search domains the box's own
//! record is looked for in (discover.rs), asked again every
//! `REDISCOVER`. With none of them the machine stays on the legacy hello
//! alone and asks again every `IDLE_RETRY`.
//!
//! **Whom to trust** (`Target::pin`): config.toml's `controller_pin`, which
//! nothing overrides; else the key kept in `controller.json` — named by the
//! box over HTTPS (`via: "box"`), or the first key seen (`via: "tofu"`).
//! With none, the first connection's key is accepted and kept as `tofu`.
//! A connection whose key is not the trusted one is refused: the status
//! page and the tray say "controller key changed", with the key that came
//! (unproven: the pin check runs before the handshake signature) and the
//! one expected, and nothing is re-pinned — the operator clears it (a new
//! `--pin`, or `controller.json` removed) if the controller really did get
//! a new key.
//!
//! **The box's word** (`learn_from_box`) is a hint in the legacy hello's
//! answer. It counts as AUTHENTICATED only over HTTPS to the box config.toml
//! names (`control_plane_url`), the final URL HTTPS too — never to a box
//! found by DNS, which anyone answering DNS on the LAN can impersonate;
//! a plain-HTTP answer's hint is ignored outright. A hint records a key
//! only where none is trusted (as `box` when authenticated, else `tofu`),
//! an authenticated one CONFIRMS a matching first use (`tofu` → `box`), and
//! no hint ever replaces a trusted key: a different one is a conflict on
//! the status page for the operator. Rotating the controller's key is a
//! later, signed feature.
//!
//! **Confirmed or not.** A key pinned by config or confirmed by the box is
//! CONFIRMED. A first-use key is not, and the page and tray say "trusted
//! on first use, unconfirmed": the link works, but the legacy hello keeps
//! going beside it — it pauses only for a confirmed controller.
//!
//! **The connection.** `hello` first (wire.rs): who the machine is. The
//! answer says where it stands. PENDING: the machine sends heartbeats only
//! and waits — the page shows "waiting for approval" with both fingerprints
//! — until a `state` event upgrades it in place. APPROVED: the policy
//! applies (the awake hold, Claude, providers — the same `Policy` the
//! legacy hello answer carries), commands are taken and acknowledged at
//! once, and the machine pushes:
//!
//! - `status` — the status page's document without its telemetry — when it
//!   changes (uptimes and report clocks aside) and every `PUSH_EVERY`; the
//!   OS's power requests in it are read every `PUSH_EVERY`;
//! - `telemetry`, the whole document at the machine's level, when a sample
//!   carries newly read static or slow facts or OS updates, and otherwise
//!   every `PUSH_EVERY` — not every 15-second sample;
//! - `claude`, the session's full report, when it changes (its clock
//!   aside) and every `PUSH_EVERY`;
//! - `providers` when the list changes.
//!
//! REVOKED: the machine says so and leaves; it tries again at the slowest
//! step, in case the box changes its mind.
//!
//! **The migration** (PLAN, feature 13): the legacy hello to the app goes
//! on alongside all this until the controller has approved the machine
//! and its key is confirmed (above); from then on it pauses (`Shared::legacy_hello_wanted`) — and resumes
//! if the link has been down for `LEGACY_FALLBACK`, so a controller that
//! went away does not take the machine off the box's pages. The LAN status
//! page and its token-gated reads stay as they are in this step.

use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::tls::{self, Recv, Tls};
use super::wire::{
    self, name, Accepted, Command, CommandParams, Hello, HelloFacts, Incoming, NodeState,
    StateEvent, Welcome, PROTO,
};
use super::{BACKOFF_MAX, BACKOFF_MIN, DEAD_AFTER, HANDSHAKE_TIMEOUT, HEARTBEAT, WRITE_TIMEOUT};
use crate::api::wire::{code, ApiError, Response};
use crate::config::Config;
use crate::hello::Policy;
use crate::identity::{digest, format_fingerprint, parse_fingerprint, Identity};
use crate::state::now_rfc3339;
use crate::status::Shared;

/// Where the trusted controller key is kept, in the data directory.
pub const STORE_FILE: &str = "controller.json";
/// How long after the link was last up and approved the legacy hello stays
/// paused.
pub const LEGACY_FALLBACK: Duration = Duration::from_secs(5 * 60);
/// The slowest a push waits when nothing changed.
pub const PUSH_EVERY: Duration = Duration::from_secs(60);
/// How often the pushes are looked at.
const PUSH_CHECK: Duration = Duration::from_secs(2);
/// How long a DNS-found address is used before the record is asked again.
const REDISCOVER: Duration = Duration::from_secs(10 * 60);
/// How long the loop waits when there is no controller to try.
const IDLE_RETRY: Duration = Duration::from_secs(60);

/// The controller key this machine trusts, and where it is.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Stored {
    /// Where the controller was reached, or named by the box.
    pub address: Option<String>,
    /// Its key's fingerprint (identity.rs).
    pub fingerprint: String,
    /// "box" or "tofu".
    pub via: String,
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

fn save_store(path: &Path, s: &Stored) {
    let text = serde_json::to_string_pretty(s).unwrap_or_default();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(path, text) {
        tracing::warn!(path = %path.display(), error = %e, "link: the trusted controller key was not saved");
    }
}

/// How far a hello answer's controller hint can be believed (hello.rs
/// decides; a plain-HTTP answer's hint is never passed here at all).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HintTrust {
    /// Over HTTPS to the box config.toml's `control_plane_url` names — an
    /// address the operator wrote, not one DNS answered — and the answer's
    /// final URL was HTTPS too.
    Authenticated,
    /// Over HTTPS, but to a box found through DNS (the SRV record), which
    /// anyone who can answer DNS on the LAN can point elsewhere: as good as
    /// a first use, never more.
    Unauthenticated,
}

/// What a hint did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Learned {
    /// Nothing was trusted yet: the hint's key is now, as `box` or `tofu`.
    Recorded,
    /// The trusted key was the hint's; an authenticated hint confirmed a
    /// first use (`tofu` → `box`), or moved the address.
    Confirmed,
    /// Nothing changed.
    Unchanged,
    /// The hint names another key than the one trusted. Nothing is
    /// replaced: the operator decides (the message says how).
    Conflict(String),
    /// Not a key or not an address.
    Ignored(String),
}

/// The box named its controller in a legacy hello answer (module doc):
/// a hint can record a key where none is trusted, and confirm the one that
/// is, but it NEVER replaces a trusted key — config's, the box's or a first
/// use's. `config_pin` is config.toml's, which nothing overrides.
pub fn learn_from_box(
    store: &Path,
    config_pin: Option<&str>,
    address: &str,
    public_key_hex: &str,
    trust: HintTrust,
) -> Learned {
    let Ok(key) = crate::identity::parse_public_key(public_key_hex) else {
        return Learned::Ignored(format!(
            "the box named a controller key that is not one: {:?}",
            public_key_hex.chars().take(80).collect::<String>()
        ));
    };
    if !crate::config::valid_host_port(address) {
        return Learned::Ignored(format!(
            "the box named a controller address that is not host:port: {:?}",
            address.chars().take(80).collect::<String>()
        ));
    }
    if let Err(e) = store_trusted(store) {
        return Learned::Ignored(e);
    }
    let fp = format_fingerprint(&digest(&key));
    let conflict = |trusted: &str, via: &str| {
        Learned::Conflict(format!(
            "the box names controller key {fp}, but this machine trusts {trusted} ({via}); \
             nothing was changed. If the controller's key really changed, pin the new one \
             (`install --pin`){}",
            if via == "config" {
                String::new()
            } else {
                format!(" or remove {}", store.display())
            }
        ))
    };
    if let Some(pin) = config_pin.and_then(|p| parse_fingerprint(p).ok()) {
        return if pin == digest(&key) {
            Learned::Unchanged
        } else {
            conflict(&format_fingerprint(&pin), "config")
        };
    }
    let authenticated = trust == HintTrust::Authenticated;
    let (next, learned) = match load_store(store) {
        None => (
            Stored {
                address: Some(address.into()),
                fingerprint: fp,
                via: if authenticated { "box" } else { "tofu" }.into(),
            },
            Learned::Recorded,
        ),
        Some(s) if s.fingerprint == fp && authenticated => {
            let next = Stored {
                address: Some(address.into()),
                fingerprint: fp,
                via: "box".into(),
            };
            let learned = if next == s {
                Learned::Unchanged
            } else {
                Learned::Confirmed
            };
            (next, learned)
        }
        // An unauthenticated hint moves nothing, not even the address.
        Some(s) if s.fingerprint == fp => (s, Learned::Unchanged),
        Some(s) => return conflict(&s.fingerprint, &s.via),
    };
    if matches!(learned, Learned::Recorded | Learned::Confirmed) {
        tracing::info!(fingerprint = %next.fingerprint, via = %next.via, "link: the box named its controller");
        save_store(store, &next);
    }
    learned
}

/// Where the next attempt goes, and what it trusts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub address: String,
    pub found_via: String,
    /// The SHA-256 of the key to accept; None: trust on first use.
    pub pin: Option<[u8; 32]>,
    pub pinned_via: Option<&'static str>,
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
            Some(d) => (
                Some(d),
                Some(if stored.is_some_and(|s| s.via == "box") {
                    "box"
                } else {
                    "tofu"
                }),
            ),
            None => (None, None),
        },
    };
    let (address, found_via) = match config_address {
        Some(a) => (a.to_string(), "config".to_string()),
        None => match stored.and_then(|s| s.address.clone()) {
            Some(a) => (
                a,
                if stored.is_some_and(|s| s.via == "box") {
                    "box"
                } else {
                    "stored"
                }
                .to_string(),
            ),
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
        status_port: cfg.port,
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
    cfg: Config,
    id: Identity,
    facts: crate::facts::Facts,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
) {
    let store = store_path();
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
            l.unconfirmed = !matches!(target.pinned_via, Some("config" | "box"));
            l.state = Some("connecting".into());
        });
        let hello = hello_of(&cfg, &id, &facts);
        let ended = connect_once(
            &target,
            &client,
            hello,
            &shared,
            &stop,
            &store,
            &Cadence::default(),
        );
        let wait = match &ended {
            Ended::Stopped => return,
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
                shared.link_not_approved();
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
    shared: &Shared,
    stop: &AtomicBool,
    store: &Path,
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
        save_store(
            store,
            &Stored {
                address: Some(target.address.clone()),
                fingerprint: controller_fp.clone(),
                via: "tofu".into(),
            },
        );
    }
    // Pinned by config or confirmed by the box; a first use is not.
    let confirmed = matches!(target.pinned_via, Some("config" | "box"));
    shared.set_link(|l| {
        l.fingerprint = client.fingerprint().to_string();
        l.controller_fingerprint = Some(controller_fp.clone());
        l.pinned_via = Some(target.pinned_via.unwrap_or("tofu").into());
        l.unconfirmed = !confirmed;
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
    if welcome.state != NodeState::Approved {
        shared.link_not_approved();
    }
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
    let ended = converse(
        &mut tls,
        welcome,
        shared,
        stop,
        cadence,
        shared.role().claude_update,
        confirmed,
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
    providers: Option<String>,
    claude: Option<(String, Instant)>,
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
        if let Some(c) = o.get_mut("control_plane").and_then(Value::as_object_mut) {
            c.remove("last_hello");
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
            let p = serde_json::to_string(&t.providers).unwrap_or_default();
            if self.providers.as_ref() != Some(&p) {
                tls.send(&wire::event(name::PROVIDERS, &t.providers))?;
                self.providers = Some(p);
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
        Ok(())
    }
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

/// The conversation after `hello` (module doc).
fn converse(
    tls: &mut Tls,
    welcome: Welcome,
    shared: &Shared,
    stop: &AtomicBool,
    cadence: &Cadence,
    claude_update: bool,
    confirmed: bool,
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
            // Only a confirmed controller stands in for the legacy hello.
            if confirmed {
                shared.link_approved_now();
            }
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
                            shared.link_not_approved();
                            tls.close();
                            return Ended::Revoked;
                        }
                        _ => shared.link_not_approved(),
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
                let answer = match m.as_str() {
                    name::COMMAND if state == NodeState::Approved => {
                        match take_command(shared, p, claude_update) {
                            Ok(a) => Response::ok(id, &a),
                            Err(e) => Response::err(Some(id), e),
                        }
                    }
                    name::COMMAND => Response::err(
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
            }
            Ok(Incoming::Answer { .. }) => {}
            Err(e) => tracing::debug!(error = %e, "link: a line that is not a message"),
        }
    }
}

fn apply_policy(shared: &Shared, p: Policy) {
    if shared.set_policy(p.clone()) {
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
        // Config address and pin win over everything.
        let stored = Stored {
            address: Some("old.lan:7788".into()),
            fingerprint: fp(2),
            via: "box".into(),
        };
        let t = resolve_target(Some("box.lan:7788"), Some(&fp(1)), Some(&stored), no_dns)
            .unwrap()
            .unwrap();
        assert_eq!(t.address, "box.lan:7788");
        assert_eq!((t.pin, t.pinned_via), (Some([1; 32]), Some("config")));
        // The store: the box's word, or a first use.
        let t = resolve_target(None, None, Some(&stored), no_dns)
            .unwrap()
            .unwrap();
        assert_eq!(
            (t.address.as_str(), t.found_via.as_str()),
            ("old.lan:7788", "box")
        );
        assert_eq!((t.pin, t.pinned_via), (Some([2; 32]), Some("box")));
        let tofu = Stored {
            via: "tofu".into(),
            ..stored.clone()
        };
        let t = resolve_target(Some("box.lan:7788"), None, Some(&tofu), no_dns)
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
    fn a_hint_records_or_confirms_but_never_replaces_a_key() {
        use HintTrust::{Authenticated, Unauthenticated};
        let dir = std::env::temp_dir().join(format!("daedalus-link-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = dir.join(STORE_FILE);
        let key_a = hex::encode([1u8; 32]);
        let key_b = hex::encode([2u8; 32]);
        let fp_a = format_fingerprint(&digest(&[1; 32]));
        let fp_b = format_fingerprint(&digest(&[2; 32]));
        let stored = || load_store(&store).unwrap();

        // A box found by DNS, on an empty store: a first use.
        assert_eq!(
            learn_from_box(&store, None, "box.lan:7788", &key_a, Unauthenticated),
            Learned::Recorded
        );
        assert_eq!(
            (stored().fingerprint, stored().via),
            (fp_a.clone(), "tofu".into())
        );
        // Another key, even authenticated: a conflict, nothing replaced,
        // not even the address.
        for trust in [Unauthenticated, Authenticated] {
            let l = learn_from_box(&store, None, "evil.lan:7788", &key_b, trust);
            assert!(
                matches!(&l, Learned::Conflict(m) if m.contains(&fp_b) && m.contains("tofu")),
                "{l:?}"
            );
        }
        assert_eq!(stored().fingerprint, fp_a);
        assert_eq!(stored().address.as_deref(), Some("box.lan:7788"));
        // The same key unauthenticated moves nothing; authenticated, it
        // confirms the first use and may move the address.
        assert_eq!(
            learn_from_box(&store, None, "box2.lan:7788", &key_a, Unauthenticated),
            Learned::Unchanged
        );
        assert_eq!(stored().address.as_deref(), Some("box.lan:7788"));
        assert_eq!(
            learn_from_box(&store, None, "box2.lan:7788", &key_a, Authenticated),
            Learned::Confirmed
        );
        assert_eq!(
            (stored().via, stored().address),
            ("box".into(), Some("box2.lan:7788".into()))
        );
        assert_eq!(
            learn_from_box(&store, None, "box2.lan:7788", &key_a, Authenticated),
            Learned::Unchanged
        );
        // A confirmed key is not replaced either.
        assert!(matches!(
            learn_from_box(&store, None, "box.lan:7788", &key_b, Authenticated),
            Learned::Conflict(_)
        ));
        // Garbage is ignored.
        assert!(matches!(
            learn_from_box(&store, None, "box.lan:7788", "zz", Authenticated),
            Learned::Ignored(_)
        ));
        assert!(matches!(
            learn_from_box(&store, None, "not an address", &key_a, Authenticated),
            Learned::Ignored(_)
        ));
        // A config pin stands over any hint.
        assert!(matches!(
            learn_from_box(&store, Some(&fp_b), "box.lan:7788", &key_a, Authenticated),
            Learned::Conflict(m) if m.contains("config")
        ));
        assert_eq!(
            learn_from_box(&store, Some(&fp_a), "box.lan:7788", &key_a, Authenticated),
            Learned::Unchanged
        );
        let t = resolve_target(None, Some(&fp_b), load_store(&store).as_ref(), || None)
            .unwrap()
            .unwrap();
        assert_eq!(t.pin, Some(digest(&[2; 32])));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_status_digest_ignores_what_moves_by_itself() {
        let a = serde_json::json!({"uptime_secs": 1, "awake_hold": true, "tray": {"reporting": true, "last_report": "t1"}, "control_plane": {"last_hello": "x"}});
        let b = serde_json::json!({"uptime_secs": 9, "awake_hold": true, "tray": {"reporting": true, "last_report": "t2"}, "control_plane": {"last_hello": "y"}});
        let c = serde_json::json!({"uptime_secs": 9, "awake_hold": false, "tray": {"reporting": true, "last_report": "t2"}, "control_plane": {"last_hello": "y"}});
        assert_eq!(status_digest(&a), status_digest(&b));
        assert_ne!(status_digest(&b), status_digest(&c));
    }
}
