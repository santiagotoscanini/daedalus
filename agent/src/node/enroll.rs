//! Logging in: how a machine joins the box with a WireGuard tunnel of its
//! own (tunnel/). On macOS it is the only way in — the menu bar's "Log in…"
//! replaces pairing — and it works the same on Linux (the tests and the
//! end-to-end run there).
//!
//! ```text
//! tray ─ enroll.begin {app_url} ─▶ service: the machine's key and fingerprint, a PKCE challenge
//! tray ─ opens https://<app>/agent/enroll?key&name&os&arch&version&port&state&code_challenge…
//! admin ─ Pocket ID ─ the app: a consent page naming the machine and its key, Confirm
//!   app ─ approves the node, makes its wg-easy client ─▶ browser ─▶ http://127.0.0.1:<port>/callback?state&code
//! tray ─ administrator prompt ─ `enroll-finish CODE` as root ─ enroll.finish ─▶ service
//!   service ─ POST https://<app>/api/agent/enroll {code, code_verifier} ─▶ the client config, the pin
//!   service ─ tunnel.toml, config.toml ─ the tunnel up ─ the link through it
//! ```
//!
//! **What travels.** Out: the machine's link key, name and facts, and a
//! PKCE challenge (S256) — public. Back to the browser: a single-use code,
//! useless without the verifier, which never leaves the service that began
//! the log-in (it lives in the service's memory, `Shared`, for
//! `LOG_IN_TIMEOUT`). Redeemed, over HTTPS to the app the operator named:
//! the wg-easy client config — its private key, which wg-easy generated,
//! reaches this machine once, here, and is kept 0600 by root — the
//! controller's key fingerprint to pin, and its address inside the tunnel.
//! The answer names the node the app approved; it must be this machine.
//!
//! **The loopback** (`Loopback`): the tray binds `127.0.0.1:0` for the
//! length of one log-in, hands its port and a fresh 256-bit `state` to the
//! app in the URL, and takes exactly one `GET /callback` whose `state`
//! matches (compared in constant time): anything else is a 404, a stale
//! `state` a 400. `error=denied` is the admin declining.
//!
//! **Who may** (ipc/local/): `enroll.begin` and `enroll.leave` — root, the
//! service's own user, and the user who installed the agent
//! (`os::operator_allowed`; never merely the console user, since logging in
//! hands the machine to a box). `enroll.finish` needs root: the tray runs
//! `daedalus-agent enroll-finish` behind the administrator prompt, once per
//! log-in, as `pair` did — naming the box a machine trusts hands that box
//! the service's privileges. Both `begin` and `finish` are refused while a
//! tunnel config exists: log out first.
//!
//! **Logging out** (`enroll.leave`): the link tells the controller
//! (`leave`, answered within `LEAVE_WAIT`) and the app deletes the
//! machine's wg-easy client; then `forget_log_in` — the pin and the
//! controller's address out of config.toml, the tunnel stopped,
//! `tunnel.toml` and the kept policy deleted. No answer in time is no
//! reason to stay (the box may be gone), but a refusal is: the box answered
//! that nobody heard it, so the log-in stays for another try. A machine the box revokes
//! forgets its log-in the same way (node/link.rs).

use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::api::wire::{EnrollRedeem, EnrollRedeemed};
use crate::core::config::Config;
use crate::core::paths;
use crate::core::shared::Shared;
use crate::identity::{format_fingerprint, parse_fingerprint, Identity};
use crate::ipc::deadline::Deadline;
use crate::ipc::door::Peer;
pub use crate::ipc::local::{BeginParams, FinishParams};
use crate::ipc::rpc::{ApiError, ErrorCode};
use crate::net::Dialer;
use crate::node::tunnel::{Settings, Tunnel, WireguardConfig};

/// How long one log-in waits for the browser, and how long the service
/// keeps its PKCE verifier.
pub const LOG_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long a log-out waits for the controller's acknowledgement.
pub const LEAVE_WAIT: Duration = Duration::from_secs(3);
/// The whole redeem request to the app.
pub const REDEEM_TIMEOUT: Duration = Duration::from_secs(10);

/// Where a log-in's files are: the data directory's (`Files::here`), or a
/// test's.
#[derive(Clone, Debug)]
pub struct Files {
    /// The machine's link key (identity.rs).
    pub identity: PathBuf,
    /// tunnel.toml (tunnel/).
    pub tunnel: PathBuf,
    pub config: PathBuf,
    /// The kept policy (paths.rs `save_policy`).
    pub policy: PathBuf,
}

impl Files {
    /// The service's own, in its data directory.
    pub fn here() -> Self {
        Self {
            identity: paths::data_dir().join(crate::identity::FILE),
            tunnel: paths::tunnel_path(),
            config: paths::config_path(),
            policy: paths::policy_path(),
        }
    }

    /// Where the link reads its keys from: this config.toml, and this
    /// tunnel config as this system's rule has it (link/mod.rs `KeyFiles`).
    pub fn keys(&self) -> crate::link::KeyFiles {
        crate::link::KeyFiles::on_this_os(self.config.clone(), self.tunnel.clone())
    }
}

/// A log-in the service began and has not finished: the app it goes to
/// and the PKCE verifier, held only here.
pub struct Started {
    app: String,
    verifier: Zeroizing<String>,
    at: Instant,
}

/// `enroll.begin`'s answer: what the app's page shows and binds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Begin {
    /// The app, as checked (`app_url`).
    pub app_url: String,
    /// The link key, 64 hex characters: what the app approves.
    pub public_key: String,
    /// Its fingerprint, as the menu bar shows it and the admin types.
    pub fingerprint: String,
    pub hostname: String,
    pub os: String,
    pub arch: String,
    pub version: String,
    /// PKCE, S256: base64url of SHA-256 of the verifier the service keeps.
    pub code_challenge: String,
}

/// The box's app as the menu bar asks for it: `https://host[:port]`, and
/// nothing else — no path, query, fragment or user — checked and put in
/// its one form (lowercase, no trailing slash).
pub fn app_url(text: &str) -> Result<String, String> {
    let t = text.trim();
    let bad = || format!("{t:?} is not the box's app address, https://host[:port]");
    let rest = t
        .strip_prefix("https://")
        .or_else(|| t.strip_prefix("HTTPS://"))
        .ok_or_else(bad)?;
    let rest = rest.strip_suffix('/').unwrap_or(rest).to_ascii_lowercase();
    let host_ok = |h: &str| {
        !h.is_empty()
            && h.len() <= 253
            && h.split('.')
                .all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
    };
    let ok = match rest.rsplit_once(':') {
        Some((h, _)) => crate::core::config::valid_host_port(&rest) && host_ok(h),
        None => host_ok(&rest),
    };
    if !ok {
        return Err(bad());
    }
    Ok(format!("https://{rest}"))
}

/// A code as the app hands it out: URL-safe, 16 to 128 characters.
fn code_ok(code: &str) -> bool {
    (16..=128).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 32 random bytes as base64url, unpadded (43 characters): a PKCE
/// verifier, or a log-in's `state`.
fn random_token() -> String {
    let mut raw = Zeroizing::new([0u8; 32]);
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, raw.as_mut());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw.as_ref())
}

/// PKCE's S256 challenge for `verifier` (RFC 7636 §4.2).
pub fn challenge_of(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier))
}

/// Whether `peer` may begin or leave a log-in (module doc).
pub fn may_enroll(peer: Option<&Peer>) -> bool {
    crate::ipc::door::peer_allowed(peer, &crate::os::operator_allowed())
}

/// Whether `peer` may finish one: root, or the service's own user (a
/// development run's service is its user's; an installed one is root).
pub fn may_finish(peer: Option<&Peer>) -> bool {
    let own = crate::os::own_uid().unwrap_or(0);
    matches!(peer, Some(Peer::Uid(u)) if *u == 0 || *u == own)
}

fn unavailable(msg: impl Into<String>) -> ApiError {
    ApiError::new(ErrorCode::Unavailable, msg)
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(ErrorCode::Internal, e.to_string())
}

fn logged_in_already() -> ApiError {
    unavailable("this machine is logged in already: log out first")
}

/// `enroll.begin`: this machine as the app's page needs it, and a fresh
/// PKCE pair — the verifier kept here, the challenge handed out.
pub fn begin(shared: &Shared, files: &Files, p: BeginParams) -> Result<Begin, ApiError> {
    if !shared.role.link {
        return Err(ApiError::new(
            ErrorCode::Unsupported,
            "the controller does not log in to anything",
        ));
    }
    if files.tunnel.exists() {
        return Err(logged_in_already());
    }
    let app = app_url(&p.app_url).map_err(|e| ApiError::new(ErrorCode::BadRequest, e))?;
    let id =
        Identity::load_or_create_at(&files.identity).map_err(|e| internal(format!("{e:#}")))?;
    let verifier = Zeroizing::new(random_token());
    let code_challenge = challenge_of(&verifier);
    shared.link.set_log_in(Some(Started {
        app: app.clone(),
        verifier,
        at: Instant::now(),
    }));
    let facts = &shared.facts;
    Ok(Begin {
        app_url: app,
        public_key: id.public_key_hex(),
        fingerprint: id.fingerprint(),
        hostname: crate::core::facts::hostname(),
        os: facts.os.clone(),
        arch: facts.arch.clone(),
        version: crate::VERSION.to_string(),
        code_challenge,
    })
}

/// Redeem at the app over HTTPS (module doc).
pub fn redeem_https(app: &str, body: &EnrollRedeem) -> Result<EnrollRedeemed, String> {
    let url = format!("{app}/api/agent/enroll");
    match crate::http::agent()
        .post(&url)
        .timeout(REDEEM_TIMEOUT)
        .send_json(body)
    {
        Ok(r) => r
            .into_json::<EnrollRedeemed>()
            .map_err(|e| format!("{url} answered something else: {e}")),
        Err(ureq::Error::Status(status, r)) => {
            let text: String = r
                .into_string()
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            Err(format!("{url} refused it ({status}): {text}"))
        }
        Err(e) => Err(format!("{url} did not answer: {e}")),
    }
}

/// `enroll.finish`: redeem the code at the app the log-in began with
/// (`redeem`: `redeem_https` in the service), check everything the answer
/// says, and link through the tunnel it describes (module doc).
pub fn finish(
    shared: &Shared,
    files: &Files,
    p: FinishParams,
    redeem: impl FnOnce(&str, &EnrollRedeem) -> Result<EnrollRedeemed, String>,
) -> Result<String, ApiError> {
    if files.tunnel.exists() {
        return Err(logged_in_already());
    }
    if !code_ok(&p.code) {
        return Err(ApiError::new(
            ErrorCode::BadRequest,
            "the code is not one the app hands out",
        ));
    }
    let started = shared
        .link
        .take_log_in()
        .filter(|s| s.at.elapsed() < LOG_IN_TIMEOUT)
        .ok_or_else(|| unavailable("no log-in waits for this code: start it again"))?;
    let answer = redeem(
        &started.app,
        &EnrollRedeem {
            code: p.code,
            code_verifier: started.verifier.to_string(),
        },
    )
    .map_err(unavailable)?;

    // Everything the answer says, checked before anything is written.
    let id =
        Identity::load_or_create_at(&files.identity).map_err(|e| internal(format!("{e:#}")))?;
    if answer.node != id.node_id() {
        return Err(unavailable(format!(
            "the app approved node {:?}, not this machine ({})",
            answer.node,
            id.node_id()
        )));
    }
    let settings: Settings = answer
        .wireguard
        .checked()
        .map_err(|e| unavailable(format!("the tunnel's config: {e}")))?;
    let pin = parse_fingerprint(answer.controller.pin.trim())
        .map(|d| format_fingerprint(&d))
        .map_err(|e| unavailable(format!("the controller's pin: {e:#}")))?;
    let controller: std::net::SocketAddrV4 = answer.controller.address.parse().map_err(|_| {
        unavailable(format!(
            "the controller's address {:?} is not an address and port",
            answer.controller.address
        ))
    })?;
    if *controller.ip() != settings.target || controller.port() == 0 {
        return Err(unavailable(format!(
            "the controller's address {controller} is not the tunnel's ({})",
            settings.target
        )));
    }

    answer
        .wireguard
        .write_at(&files.tunnel)
        .map_err(|e| internal(format!("{e:#}")))?;
    let tunnel = Tunnel::start(settings.clone()).map_err(|e| {
        let _ = std::fs::remove_file(&files.tunnel);
        internal(format!("the tunnel did not start: {e}"))
    })?;
    let moved = crate::node::pair::moves_pin(&files.config, &pin);
    let written = crate::core::config::write_link_config_at(
        &files.config,
        &Config {
            controller_pin: Some(pin.clone()),
            controller_address: Some(controller.to_string()),
            app_url: Some(started.app.clone()),
            ..Config::default()
        },
    );
    if let Err(e) = written {
        tunnel.stop();
        let _ = std::fs::remove_file(&files.tunnel);
        return Err(internal(format!("{e:#}")));
    }
    if moved {
        // Another box's santree grant does not carry over.
        paths::forget_santree();
        crate::node::link::drop_santree(shared);
    }
    // The tunnel first, then the keys: the link's next dial goes through it.
    shared.link.set_dialer(Dialer::Tunnel(tunnel));
    crate::node::pair::reload(shared, &files.keys()).map_err(|e| internal(format!("{e:#}")))?;
    tracing::info!(
        app = %started.app,
        endpoint = %settings.endpoint,
        address = %settings.address,
        controller = %controller,
        "logged in: the link and santree go through this machine's tunnel"
    );
    Ok(format!(
        "logged in: this machine reaches the box at {controller} through its own tunnel ({})",
        settings.endpoint
    ))
}

/// `enroll.leave`: tell the controller, then forget the log-in (module
/// doc). Logged out already is no error.
pub fn leave(shared: &Shared, files: &Files) -> Result<String, ApiError> {
    let approved = shared.link.linked();
    if approved {
        let answer = shared.link.request_leave().recv_timeout(LEAVE_WAIT);
        // Not taken in time: withdrawn, so a later link does not send it.
        shared.link.take_leave();
        match answer {
            Ok(Ok(())) => {}
            // The box answered, and nobody there heard it: logging out now
            // would leave the box holding this machine and its tunnel.
            Ok(Err(why)) => {
                return Err(unavailable(format!(
                    "the box did not take the log-out ({why}); this machine is still logged in, try again"
                )))
            }
            Err(_) => tracing::warn!(
                "log-out: the controller did not acknowledge in time; logging out anyway"
            ),
        }
    }
    shared.link.set_log_in(None);
    forget_log_in(shared, files, "logged out from this machine")
        .map_err(|e| internal(format!("{e:#}")))?;
    Ok("logged out: this machine no longer reaches the box".into())
}

/// Forget this machine's log-in (module doc): the pin and address first —
/// once they are gone nothing dials — then the tunnel, its file and the
/// kept policy. A failure to clear config.toml leaves every dial refused
/// rather than let the link try the old address directly.
pub fn forget_log_in(shared: &Shared, files: &Files, why: &str) -> anyhow::Result<()> {
    let old = shared.link.dialer();
    if let Err(e) = crate::core::config::clear_link_keys_at(&files.config) {
        shared.link.set_dialer(Dialer::Refused(format!(
            "the log-out did not finish ({e:#}); run `daedalus-agent install` again"
        )));
        return Err(e);
    }
    shared.link.set_dialer(Dialer::Direct);
    if let Dialer::Tunnel(t) = old {
        t.stop();
    }
    for p in [&files.tunnel, &files.policy] {
        match std::fs::remove_file(p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!(path = %p.display(), error = %e, "log-out: not removed"),
        }
    }
    shared
        .settings
        .set_policy(crate::link::wire::Policy::default());
    crate::node::pair::reload(shared, &files.keys())?;
    tracing::info!(why, "logged out: no tunnel, no controller trusted");
    Ok(())
}

/// At the service's start: how it reaches the box, from the file a log-in
/// left (net.rs `Dialer`). A tunnel config that cannot be brought up
/// refuses every dial instead of letting the link go around it.
pub fn start(shared: &Shared, files: &Files) {
    let dialer = match WireguardConfig::load_at(&files.tunnel) {
        Ok(None) => Dialer::Direct,
        Ok(Some(settings)) => match Tunnel::start(settings) {
            Ok(t) => Dialer::Tunnel(t),
            Err(e) => Dialer::Refused(format!("the tunnel could not start: {e}")),
        },
        Err(e) => Dialer::Refused(format!("the tunnel config: {e:#}")),
    };
    if let Dialer::Refused(why) = &dialer {
        tracing::error!(
            why,
            "tunnel: refusing every dial until this is fixed (or logged out)"
        );
    }
    shared.link.set_dialer(dialer);
}

// ── the menu bar's half: the URL and the loopback callback ────────────────

/// The page the admin confirms on: this machine's public values, the
/// callback's port, the log-in's `state` and its PKCE challenge.
pub fn enroll_url(b: &Begin, port: u16, state: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("key", &b.public_key)
        .append_pair("name", &b.hostname)
        .append_pair("os", &b.os)
        .append_pair("arch", &b.arch)
        .append_pair("version", &b.version)
        .append_pair("port", &port.to_string())
        .append_pair("state", state)
        .append_pair("code_challenge", &b.code_challenge)
        .append_pair("code_challenge_method", "S256")
        .finish();
    format!("{}/agent/enroll?{query}", b.app_url)
}

/// How a log-in ended in the browser.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Confirmed: the code the service redeems.
    Code(String),
    /// The admin declined on the app's page.
    Denied,
}

/// A callback whose `state` is not this log-in's.
#[derive(Debug, PartialEq, Eq)]
pub struct Stale;

/// The pure half of `Loopback::wait`: one callback's query against the
/// log-in's `state` — `Stale` when it is not this log-in's, else what it
/// says.
pub fn callback(query: &str, state: &str) -> Result<Result<Outcome, String>, Stale> {
    let mut got = std::collections::HashMap::new();
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        // A key twice is not a callback anyone sent.
        if got.insert(k.into_owned(), v.into_owned()).is_some() {
            return Err(Stale);
        }
    }
    let theirs = got.get("state").map(String::as_bytes).unwrap_or_default();
    if theirs.len() != state.len() || !bool::from(theirs.ct_eq(state.as_bytes())) {
        return Err(Stale);
    }
    if let Some(e) = got.get("error") {
        return Ok(if e == "denied" {
            Ok(Outcome::Denied)
        } else {
            Err(format!("the box said {e:?}"))
        });
    }
    Ok(match got.get("code") {
        Some(c) if code_ok(c) => Ok(Outcome::Code(c.clone())),
        Some(_) => Err("the code is not one the app hands out".into()),
        None => Err("the callback carries no code".into()),
    })
}

/// One log-in's loopback listener, waiting for the browser (module doc).
pub struct Loopback {
    server: tiny_http::Server,
    port: u16,
    state: String,
}

impl Loopback {
    /// Bind the callback's port and make the log-in's `state`.
    pub fn new() -> Result<Self, String> {
        let server = tiny_http::Server::http("127.0.0.1:0")
            .map_err(|e| format!("could not listen on loopback for the callback: {e}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .ok_or("the callback listener has no port")?;
        Ok(Self {
            server,
            port,
            state: random_token(),
        })
    }

    /// The URL to open in the browser.
    pub fn url(&self, b: &Begin) -> String {
        enroll_url(b, self.port, &self.state)
    }

    /// Serve the loopback until the browser brings this log-in's callback
    /// or `within` passes. Anything but `GET /callback` is a 404; a
    /// callback with another `state` a 400, and the wait goes on.
    pub fn wait(self, within: Duration) -> Result<Outcome, String> {
        let deadline = Deadline::after(within);
        loop {
            let req = match self.server.recv_timeout(deadline.remaining()) {
                Ok(Some(r)) => r,
                Ok(None) => return Err("no answer from the browser in time".into()),
                Err(e) => return Err(format!("the callback listener failed: {e}")),
            };
            let (path, query) = match req.url().split_once('?') {
                Some((p, q)) => (p.to_string(), q.to_string()),
                None => (req.url().to_string(), String::new()),
            };
            if *req.method() != tiny_http::Method::Get || path != "/callback" {
                let _ = req.respond(page(404, "Not found."));
                continue;
            }
            match callback(&query, &self.state) {
                Err(Stale) => {
                    let _ = req.respond(page(
                        400,
                        "This link is not for the log-in the menu bar is waiting for.",
                    ));
                }
                Ok(Err(e)) => {
                    let _ = req.respond(page(400, &format!("Not logged in: {e}")));
                    return Err(e);
                }
                Ok(Ok(Outcome::Denied)) => {
                    let _ = req.respond(page(200, "Declined. You can close this tab."));
                    return Ok(Outcome::Denied);
                }
                Ok(Ok(outcome)) => {
                    let _ = req.respond(page(
                        200,
                        "Almost done: confirm with this Mac's password in the dialog that \
                         opens. You can close this tab.",
                    ));
                    return Ok(outcome);
                }
            }
        }
    }
}

/// A small page for the browser tab: no script, nothing cached, no referrer.
fn page(status: u16, text: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Daedalus</title>\
         <body style=\"font:16px system-ui;margin:3em\"><p>{escaped}</p>"
    );
    let header = |k: &str, v: &str| tiny_http::Header::from_bytes(k, v).expect("a valid header");
    tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "text/html; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("Referrer-Policy", "no-referrer"))
        .with_header(header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'",
        ))
}

#[cfg(test)]
mod tests;
