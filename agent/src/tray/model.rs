//! What the menu says, as pure rows: the header, the switches, the
//! connection, Claude and santree submenus — tested without a menu.

use crate::claude::{ClaudeState, Report};
use crate::link::wire::Policy;
use crate::link::{LinkState, LinkStatus};
use crate::settings::{Key, Via, View};
use crate::status::StatusDocument;
use crate::util::{short, short_fingerprint};
use crate::DISPLAY_NAME;

// ── what the menu says: pure, and tested ──────────────────────────────────

/// `HH:MM` of an RFC 3339 stamp, left in UTC: converting to the local clock
/// is more than the tray needs, and the hour and minute say "recent" well
/// enough in the date-less menu.
pub(super) fn clock(ts: &str) -> &str {
    ts.get(11..16).unwrap_or(ts)
}

/// At most `max` characters of `s`, an ellipsis when cut.
pub(super) fn brief(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// A count of bytes as people read it: `12.4 MB`.
pub(super) fn bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1000.0 && u < UNITS.len() - 1 {
        v /= 1000.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

/// The header's dot (module doc): AppKit's own status images on a Mac, and
/// a grey one drawn here (`grey_dot`); none on Windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dot {
    Green,
    Amber,
    Red,
    Grey,
}

/// The header: its dot and its line, and whether a click opens Login Items
/// (the service switched off there) rather than Daedalus.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    pub dot: Dot,
    pub text: String,
    pub login_items: bool,
}

/// A session older than this without a new handshake is gone (WireGuard's
/// REJECT_AFTER_TIME); the tunnel's keepalive handshakes every two minutes.
pub(super) const HANDSHAKE_STALE_SECS: u64 = 180;

/// Whether the machine has not joined the box: unpaired — on a Mac, no
/// tunnel config (it logs in rather than pairs, enroll.rs).
pub(super) fn logged_out(p: &StatusDocument) -> bool {
    if cfg!(target_os = "macos") {
        p.controller.as_ref().is_some_and(|l| l.tunnel.is_none())
    } else {
        p.controller
            .as_ref()
            .is_some_and(|l| l.state == Some(LinkState::Unpaired))
    }
}

/// The header for one read of the page (None: the service did not answer),
/// `switched_off` when Login Items has the service off, and Claude as the
/// session last saw it. Red when the box cannot be reached or refuses this
/// machine, grey when nothing is joined, amber when something wants a look,
/// green otherwise.
pub fn header(
    page: Option<&StatusDocument>,
    switched_off: bool,
    claude: &Report,
    claude_wanted: bool,
) -> Header {
    let h = |dot, text: &str| Header {
        dot,
        text: text.to_string(),
        login_items: false,
    };
    let Some(p) = page else {
        return if switched_off {
            Header {
                login_items: true,
                ..h(Dot::Grey, "The service is off in Login Items")
            }
        } else {
            h(Dot::Red, "The service is not answering")
        };
    };
    if logged_out(p) {
        return h(Dot::Grey, UNJOINED_HEADER);
    }
    if let Some(l) = &p.controller {
        match l.state {
            Some(LinkState::KeyChanged) => return h(Dot::Red, "The box's key changed — refused"),
            Some(LinkState::Revoked) => return h(Dot::Red, "Revoked by the box"),
            Some(LinkState::Pending) => return h(Dot::Amber, "Waiting for approval in Daedalus"),
            _ if !l.connected => {
                return match &l.error {
                    Some(e) => h(Dot::Red, &format!("Disconnected — {}", brief(e, 40))),
                    None => h(Dot::Amber, "Connecting…"),
                }
            }
            _ => {}
        }
        if let Some(t) = &l.tunnel {
            if t.error.is_some()
                || t.last_handshake_secs
                    .is_none_or(|s| s >= HANDSHAKE_STALE_SECS)
            {
                return h(Dot::Amber, "VPN handshake is stale");
            }
        }
    }
    if p.restart_pending {
        return h(Dot::Amber, "Update installed — restarting");
    }
    if p.policy.awake_hold && !p.awake_hold {
        return h(Dot::Amber, "Keep awake is not holding");
    }
    if claude_wanted && !matches!(claude.state, ClaudeState::Running | ClaudeState::Starting) {
        return h(Dot::Amber, "Claude remote control is not running");
    }
    if !p.settings.failed.is_empty() {
        return h(Dot::Amber, "A setting was not applied");
    }
    h(Dot::Green, &format!("{DISPLAY_NAME} is connected"))
}

/// The header for a machine that has not joined the box.
#[cfg(target_os = "macos")]
pub(super) const UNJOINED_HEADER: &str = "Logged out — choose Log in…";
#[cfg(not(target_os = "macos"))]
pub(super) const UNJOINED_HEADER: &str = "Not paired — choose Pair with the box…";

/// The top-level Updates row (the updater applies an offered release by
/// itself, update/: there is nothing to click but a check).
pub(super) fn update_line(p: &StatusDocument) -> String {
    if p.restart_pending {
        return "Update installed — restarting".to_string();
    }
    match (
        &p.update_available,
        &p.state.last_update_result,
        &p.state.last_update_check,
    ) {
        (Some(v), _, _) => format!("Updating to {v}…"),
        (None, Some(r), Some(t)) => format!("Updates: {} · {}", brief(r, 32), clock(t)),
        (None, Some(r), None) => format!("Updates: {}", brief(r, 32)),
        _ => "Updates: not checked yet".to_string(),
    }
}

/// One of the switches, as the menu draws it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Switch {
    pub text: String,
    pub checked: bool,
    pub enabled: bool,
}

/// `key`'s switch from the settings block (module doc): the box's value, or
/// the one on its way; why one did not take; enabled for the operator while
/// the box can be asked.
pub fn switch(key: Key, s: &View, may_change: bool) -> Switch {
    let kept = match key {
        Key::AwakeHold => s.awake_hold,
        Key::ClaudeRemoteControl => s.claude_remote_control,
        Key::Santree => s.santree,
    };
    let label = key.label();
    let pending = s.pending.iter().find(|p| p.key == key);
    let failed = s.failed.iter().find(|f| f.key == key);
    let (text, checked) = match (pending, failed) {
        (Some(p), _) if p.via == Via::Browser => {
            (format!("{label} — confirm in the browser…"), p.want)
        }
        (Some(p), _) => (format!("{label} — sending…"), p.want),
        (None, Some(f)) => (
            format!("{label} — not changed: {}", brief(&f.why, 40)),
            kept,
        ),
        (None, None) => (label.to_string(), kept),
    };
    Switch {
        text,
        checked,
        enabled: may_change && s.linked,
    }
}

/// The row under the switches: who may change them, or why they cannot be
/// changed now; "—" when they can.
pub fn switches_note(s: &View, may_change: bool) -> String {
    if !may_change {
        return match &s.operator {
            Some(name) => format!("Only {name} can change these"),
            None => "Only the user who installed the agent can change these".into(),
        };
    }
    if !s.linked {
        return "Changes need the box: not connected".into();
    }
    "—".into()
}

/// The value a click on `key`'s switch asks for: the other one — except
/// santree while its page waits, which is opened again (santree ON).
pub fn next_value(key: Key, s: &View) -> bool {
    if let Some(p) = s.pending.iter().find(|p| p.key == key) {
        return if p.via == Via::Browser { true } else { !p.want };
    }
    !match key {
        Key::AwakeHold => s.awake_hold,
        Key::ClaudeRemoteControl => s.claude_remote_control,
        Key::Santree => s.santree,
    }
}

/// Whether this user may change the settings: on macOS and Linux the
/// operator the service names (or root); on Windows anyone at the desktop.
pub(super) fn may_change_here(s: &View) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: no arguments; cannot fail.
        let me = unsafe { libc::getuid() };
        me == 0 || s.operator_uid == Some(me)
    }
    #[cfg(windows)]
    {
        let _ = s;
        true
    }
}

/// The Connection submenu's lines (module doc).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectionRows {
    pub title: String,
    pub link: String,
    pub vpn: String,
    pub traffic: String,
    pub address: String,
    pub endpoint: String,
    /// This machine's key: (as the row shows it, whole).
    pub own_key: (String, String),
    /// The box's key it trusts.
    pub box_key: (String, String),
}

/// The Connection submenu for one read of the link (None: the service did
/// not answer, or this is the controller).
pub fn connection_rows(link: Option<&LinkStatus>) -> ConnectionRows {
    let dash = || "—".to_string();
    let Some(l) = link else {
        return ConnectionRows {
            title: "Connection · unknown".into(),
            link: "Box: —".into(),
            vpn: "VPN: —".into(),
            traffic: "Traffic: —".into(),
            address: "Tunnel address: —".into(),
            endpoint: "Endpoint: —".into(),
            own_key: (format!("{OWN_KEY}: —"), dash()),
            box_key: ("Box's key: —".into(), dash()),
        };
    };
    let at = l.address.as_deref().map(short);
    let at = at.as_deref().unwrap_or("not found yet");
    let joined = !(cfg!(target_os = "macos") && l.tunnel.is_none());
    let link_line = match (l.state, l.error.as_deref()) {
        _ if !joined => "Box: not logged in — choose Log in…".to_string(),
        (Some(LinkState::Unpaired), _) => "Box: not paired — choose Pair with the box…".into(),
        (Some(LinkState::Approved), _) if l.connected => match l.since.as_deref() {
            Some(t) => format!("Box: {at} — approved, linked {}", clock(t)),
            None => format!("Box: {at} — approved"),
        },
        (Some(LinkState::Pending), _) => format!("Box: {at} — waiting for approval"),
        (Some(LinkState::Revoked), _) => format!("Box: {at} — revoked by the box"),
        (Some(LinkState::KeyChanged), _) => format!("Box: {at} — KEY CHANGED, refused"),
        (_, Some(e)) => format!("Box: {at} — {}", brief(e, 40)),
        (Some(s), None) => format!("Box: {at} — {s}"),
        (None, None) => "Box: none found; set controller_address".into(),
    };
    let (title, vpn, traffic, address, endpoint) = match &l.tunnel {
        Some(t) => {
            let up = t.error.is_none()
                && t.last_handshake_secs
                    .is_some_and(|s| s < HANDSHAKE_STALE_SECS);
            let vpn = match (&t.error, t.last_handshake_secs) {
                (Some(e), _) => format!("VPN: down — {}", brief(e, 40)),
                (None, Some(s)) if s < HANDSHAKE_STALE_SECS => {
                    format!("VPN: up · handshake {s} s ago")
                }
                (None, Some(s)) => format!("VPN: down · last handshake {s} s ago"),
                (None, None) => "VPN: no handshake yet".into(),
            };
            (
                format!("Connection · VPN {}", if up { "up" } else { "down" }),
                vpn,
                format!("Traffic: ↓ {} · ↑ {}", bytes(t.rx_bytes), bytes(t.tx_bytes)),
                format!(
                    "Tunnel address: {}",
                    if t.address.is_empty() {
                        "—"
                    } else {
                        &t.address
                    }
                ),
                format!("Endpoint: {}", short(&t.endpoint)),
            )
        }
        None => (
            if joined {
                "Connection · direct".into()
            } else {
                "Connection · logged out".into()
            },
            if joined {
                "VPN: none (direct to the box)".into()
            } else {
                "VPN: —".into()
            },
            "Traffic: —".into(),
            "Tunnel address: —".into(),
            "Endpoint: —".into(),
        ),
    };
    let own = if l.fingerprint.is_empty() {
        (format!("{OWN_KEY}: —"), dash())
    } else {
        (
            format!("{OWN_KEY}: {}", short_fingerprint(&l.fingerprint)),
            l.fingerprint.clone(),
        )
    };
    let theirs = match &l.controller_fingerprint {
        Some(fp) => (
            format!("Box's key: {} (pinned)", short_fingerprint(fp)),
            fp.clone(),
        ),
        None => ("Box's key: none trusted yet".into(), dash()),
    };
    ConnectionRows {
        title,
        link: link_line,
        vpn,
        traffic,
        address,
        endpoint,
        own_key: own,
        box_key: theirs,
    }
}

/// What this machine is called in the menu.
#[cfg(target_os = "macos")]
pub(super) const OWN_KEY: &str = "This Mac's key";
#[cfg(not(target_os = "macos"))]
pub(super) const OWN_KEY: &str = "This machine's key";

/// The Claude submenu's lines: its title, the server's state, its folder,
/// and the restart's words (how many sessions it ends).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeRows {
    pub title: String,
    pub server: String,
    pub folder: String,
    pub restart: String,
}

pub fn claude_rows(r: &Report, policy: &Policy) -> ClaudeRows {
    let live = r.sessions.iter().filter(|s| s.alive).count();
    let n = |k: usize| format!("{k} session{}", if k == 1 { "" } else { "s" });
    let version = r
        .server
        .version
        .as_deref()
        .or(r.cli_version.as_deref())
        .unwrap_or("");
    let server = match r.state {
        ClaudeState::Running => format!("Remote control: running {version}"),
        ClaudeState::Starting => format!("Remote control: starting {version}"),
        ClaudeState::Waiting => format!(
            "Remote control: exited — {}",
            brief(r.detail.as_deref().unwrap_or("retrying"), 40)
        ),
        ClaudeState::Off => "Remote control: off (the box's policy)".into(),
        ClaudeState::NotInstalled => {
            "Remote control: Claude Code is not installed for this user".into()
        }
        ClaudeState::NoSession => "Remote control: the session is not reporting".into(),
        other => format!("Remote control: {other}"),
    };
    let title = match r.state {
        ClaudeState::Running => format!("Claude · {}", n(live)),
        ClaudeState::Off => "Claude · off".into(),
        _ => "Claude · not running".into(),
    };
    let home = |p: &str| match r.home.as_deref() {
        Some(h) if !h.is_empty() && p.starts_with(h) => format!("~{}", &p[h.len()..]),
        _ => p.to_string(),
    };
    let folder = match (&policy.claude_workdir, &r.workdir) {
        (Some(w), _) => format!("Folder: {} (set in Daedalus)", short(&home(w))),
        (None, Some(w)) => format!("Folder: {} (the latest project)", short(&home(w))),
        (None, None) => "Folder: the latest project".into(),
    };
    let restart = if live > 0 {
        format!("Restart remote control (ends {})", n(live))
    } else {
        "Restart remote control".into()
    };
    ClaudeRows {
        title,
        server,
        folder,
        restart,
    }
}

/// The santree submenu's lines (macOS, Linux).
#[cfg(any(test, unix))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SantreeRows {
    pub title: String,
    pub host: String,
    pub open: String,
    pub refused: String,
}

#[cfg(any(test, unix))]
pub fn santree_rows(p: Option<&StatusDocument>) -> SantreeRows {
    let door = p.and_then(|p| p.santree.clone()).unwrap_or_default();
    let on = p.is_some_and(|p| p.policy.santree);
    let title = if !on {
        "santree · off".to_string()
    } else {
        format!("santree · {} open", door.open)
    };
    let host = match p.and_then(|p| p.policy.session_host.as_ref()) {
        Some(h) if on => format!("Session host: {}", short(&h.address)),
        _ => "Session host: —".into(),
    };
    let open = if door.max == 0 {
        "Open connections: —".to_string()
    } else {
        format!("Open connections: {} of {}", door.open, door.max)
    };
    let refused = match &door.last_refused {
        Some(r) => format!("Last refused: {} · {}", r.code, clock(&r.at)),
        None => "Last refused: —".into(),
    };
    SantreeRows {
        title,
        host,
        open,
        refused,
    }
}
