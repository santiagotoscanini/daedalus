//! The tray icon: the daedalus mark in the taskbar's corner (a Mac's menu
//! bar), showing what the service reports — a UI over the session
//! (session.rs).
//!
//! A separate, windowless program in the desktop session, because the
//! service runs in session 0 where there is no taskbar to draw on. The
//! session reads the status document through the local socket (local.rs)
//! every `session::POLL`; the tray reflects each read: the icon (ember when
//! all is well, an amber dot when something wants attention, grey when the
//! service does not answer), the tooltip, and the menu.
//!
//! **The menu** has one fixed structure — nothing is inserted or removed
//! while it lives, so it redraws in place even while it is open (tao's timer
//! runs in the menu's run-loop mode): a row that does not apply says so
//! ("—") rather than vanishing.
//!
//! ```text
//! ● Daedalus Agent is connected          the header: a status dot and one line (click: Open Daedalus)
//!   Daedalus Agent 0.25.0                what runs here
//! ───
//!   Open Daedalus                        the app
//!   This Mac in Daedalus…   ⌘,           Settings › Machines, at this machine
//! ───
//! ✓ Keep awake                           the settings this machine may ask for (settings.rs)
//! ✓ Claude Remote Control
//!   santree on the box                   (not on Windows: santree has no door there)
//!   —                                    who may change them, or why not now
//! ───
//!   Connection · VPN up ▸                the link, the tunnel, both keys (shortened; Copy in each key's submenu)
//!   Claude · 2 sessions ▸                Claude Code's facts and verbs
//!   santree · 1 open ▸                   santree's door (not on Windows)
//!   Updates: up to date · 10:00 ▸        Check for updates now
//!   Troubleshoot ▸                       the status document, the logs
//! ───
//!   Log out of the box… / Log in…        (Pair with the box… off a Mac)
//!   Uninstall Daedalus Agent…            (a Mac)
//!   Quit menu bar app       ⌘Q
//! ```
//!
//! On a Mac each row carries a Lucide glyph (`ICONS`), a template image the
//! bundle carries in Resources (macos/icons/), and the header AppKit's own
//! status dot: green, amber, red, and a grey one drawn here (`Dot`). Windows
//! draws neither: the header's words carry the state there.
//!
//! **A switch** asks the service (`settings.set`) and reads the page again at
//! once: the check shows the box's value, or the value on its way while the
//! box has not answered ("— sending…"), or the box's value again with why
//! when it did not take ("— not changed: …"). santree ON opens the page in
//! Daedalus where an admin confirms it; a click while that page waits opens
//! it again.
//!
//! What the tray stands over is the OS's choice (`os::TRAY_OWNS_SESSION`),
//! named here as `Backing`:
//!
//! - `Owns` (Windows, macOS): the tray runs the session — the Claude
//!   supervisor (claude/) — because this process is the one in the user's
//!   desktop session, with the user's Claude login. `claude remote-control`
//!   and the sessions it resumed are not its children but jobs of the OS
//!   (a launchd job, a detached process; jobs/), reported to the
//!   service every poll: quitting, updating or crashing the tray ends no
//!   Claude session, and the next tray re-attaches to them.
//! - `Watches` (Linux): the session is a systemd user unit that runs with
//!   or without a desktop, so Claude never waits on a login; the tray only
//!   shows it, through the service (`session::Watcher`), and its restart
//!   goes to the session by way of the service.
//!
//! Either way quitting the tray stops nothing but the tray: Claude remote
//! control and the service keep running.
//!
//! It also keeps itself current: when a poll sees the page report a
//! version other than its own, an update has swapped the binaries under
//! it, and the tray restarts itself onto the new one. One instance at a
//! time, and the loop that drives all this, are the OS's
//! (os/windows/tray.rs: a named mutex and the Win32 message loop;
//! os/macos/tray.rs: a file lock and a tao event loop; os/linux/tray.rs: a
//! file lock and GTK's main loop).

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use tray_icon::menu::{
    CheckMenuItem, IconMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use crate::claude::Report;
use crate::link::wire::Policy;
use crate::os::tray::{open, relaunch_self};
use crate::paths;
use crate::session::{LinkPage, Page, Places, Session, Tick, Watcher};
use crate::settings::{short, short_fingerprint, Key, Via, View};
use crate::{config, DISPLAY_NAME, VERSION};

/// What the tray stands over; the module doc says which OS has which.
enum Backing {
    /// It runs the session: the supervisor of a Claude server that runs as
    /// a job of its own.
    Owns(Box<Session>),
    /// It shows a session another process runs.
    Watches(Watcher),
}

impl Backing {
    fn claude_wanted(&self) -> bool {
        match self {
            Backing::Owns(s) => s.claude_wanted(),
            Backing::Watches(w) => w.claude_wanted(),
        }
    }

    fn check_updates_now(&mut self) {
        match self {
            Backing::Owns(s) => s.check_updates_now(),
            Backing::Watches(w) => w.check_updates_now(),
        }
    }

    fn restart_claude(&mut self) {
        match self {
            Backing::Owns(s) => s.restart_claude(),
            Backing::Watches(w) => w.restart_claude(),
        }
    }

    fn poll_now(&mut self) {
        match self {
            Backing::Owns(s) => s.poll_now(),
            Backing::Watches(w) => w.poll_now(),
        }
    }

    fn tick(&mut self) -> Tick {
        match self {
            Backing::Owns(s) => s.tick(),
            Backing::Watches(w) => w.tick(),
        }
    }
}

/// What quitting does: the tray alone (module doc).
#[cfg(target_os = "macos")]
const QUIT_LABEL: &str = "Quit menu bar app";
#[cfg(not(target_os = "macos"))]
const QUIT_LABEL: &str = "Quit tray icon";

const ICON_OK: &[u8] = include_bytes!("../assets/tray-ok.png");
const ICON_WARN: &[u8] = include_bytes!("../assets/tray-warn.png");
const ICON_OFF: &[u8] = include_bytes!("../assets/tray-off.png");

#[derive(PartialEq, Eq, Clone, Copy)]
enum Look {
    Ok,
    Warn,
    Off,
}

struct Icons {
    ok: Icon,
    warn: Icon,
    off: Icon,
}

fn decode(png: &[u8]) -> Result<Icon> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().context("png header")?;
    let mut buf = vec![0u8; reader.output_buffer_size().unwrap_or(0)];
    let info = reader.next_frame(&mut buf).context("png frame")?;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buf[..info.buffer_size()]
            .chunks(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        other => anyhow::bail!("tray icon is {other:?}, not RGB(A)"),
    };
    Icon::from_rgba(rgba, info.width, info.height).context("tray icon pixels")
}

// ── what the menu says: pure, and tested ──────────────────────────────────

/// `HH:MM` of an RFC 3339 stamp, left in UTC: converting to the local clock
/// is more than the tray needs, and the hour and minute say "recent" well
/// enough in the date-less menu.
fn clock(ts: &str) -> &str {
    ts.get(11..16).unwrap_or(ts)
}

/// At most `max` characters of `s`, an ellipsis when cut.
fn brief(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// A count of bytes as people read it: `12.4 MB`.
fn bytes(n: u64) -> String {
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
const HANDSHAKE_STALE_SECS: u64 = 180;

/// Whether the machine has not joined the box: unpaired — on a Mac, no
/// tunnel config (it logs in rather than pairs, enroll.rs).
fn logged_out(p: &Page) -> bool {
    if cfg!(target_os = "macos") {
        p.controller.as_ref().is_some_and(|l| l.tunnel.is_none())
    } else {
        p.controller
            .as_ref()
            .is_some_and(|l| l.state.as_deref() == Some("unpaired"))
    }
}

/// The header for one read of the page (None: the service did not answer),
/// `switched_off` when Login Items has the service off, and Claude as the
/// session last saw it. Red when the box cannot be reached or refuses this
/// machine, grey when nothing is joined, amber when something wants a look,
/// green otherwise.
pub fn header(
    page: Option<&Page>,
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
        match l.state.as_deref() {
            Some("key-changed") => return h(Dot::Red, "The box's key changed — refused"),
            Some("revoked") => return h(Dot::Red, "Revoked by the box"),
            Some("pending") => return h(Dot::Amber, "Waiting for approval in Daedalus"),
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
    if claude_wanted && !matches!(claude.state.as_str(), "running" | "starting") {
        return h(Dot::Amber, "Claude remote control is not running");
    }
    if p.settings.as_ref().is_some_and(|s| !s.failed.is_empty()) {
        return h(Dot::Amber, "A setting was not applied");
    }
    h(Dot::Green, &format!("{DISPLAY_NAME} is connected"))
}

/// The header for a machine that has not joined the box.
#[cfg(target_os = "macos")]
const UNJOINED_HEADER: &str = "Logged out — choose Log in…";
#[cfg(not(target_os = "macos"))]
const UNJOINED_HEADER: &str = "Not paired — choose Pair with the box…";

/// The top-level Updates row (the updater applies an offered release by
/// itself, update/: there is nothing to click but a check).
fn update_line(p: &Page) -> String {
    if p.restart_pending {
        return "Update installed — restarting".to_string();
    }
    if let Some(r) = &p.reinstall_required {
        return format!("{}: re-install from the website", r.version);
    }
    match (
        &p.update_available,
        &p.last_update_result,
        &p.last_update_check,
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
fn may_change_here(s: &View) -> bool {
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
pub fn connection_rows(link: Option<&LinkPage>) -> ConnectionRows {
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
    let link_line = match (l.state.as_deref(), l.error.as_deref()) {
        _ if !joined => "Box: not logged in — choose Log in…".to_string(),
        (Some("unpaired"), _) => "Box: not paired — choose Pair with the box…".into(),
        (Some("approved"), _) if l.connected => match l.since.as_deref() {
            Some(t) => format!("Box: {at} — approved, linked {}", clock(t)),
            None => format!("Box: {at} — approved"),
        },
        (Some("pending"), _) => format!("Box: {at} — waiting for approval"),
        (Some("revoked"), _) => format!("Box: {at} — revoked by the box"),
        (Some("key-changed"), _) => format!("Box: {at} — KEY CHANGED, refused"),
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
const OWN_KEY: &str = "This Mac's key";
#[cfg(not(target_os = "macos"))]
const OWN_KEY: &str = "This machine's key";

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
    let server = match r.state.as_str() {
        "running" => format!("Remote control: running {version}"),
        "starting" => format!("Remote control: starting {version}"),
        "waiting" => format!(
            "Remote control: exited — {}",
            brief(r.detail.as_deref().unwrap_or("retrying"), 40)
        ),
        "off" => "Remote control: off (the box's policy)".into(),
        "not-installed" => "Remote control: Claude Code is not installed for this user".into(),
        "no-session" => "Remote control: the session is not reporting".into(),
        "" => "Remote control: —".into(),
        other => format!("Remote control: {other}"),
    };
    let title = match r.state.as_str() {
        "running" => format!("Claude · {}", n(live)),
        "off" => "Claude · off".into(),
        "" => "Claude".into(),
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SantreeRows {
    pub title: String,
    pub host: String,
    pub open: String,
    pub refused: String,
}

pub fn santree_rows(p: Option<&Page>) -> SantreeRows {
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

// ── the menu itself ──────────────────────────────────────────────────────

/// The menu's glyphs (macOS): Lucide icons by name, each a template image in
/// the bundle's Resources as `<name>Template.png` and `@2x` (macos/icons/).
/// Outside a bundle (a development build) AppKit finds none, and the rows
/// have no icon.
pub const ICONS: [&str; 10] = [
    "layout-dashboard",
    "settings",
    "network",
    "sparkles",
    "trees",
    "refresh-cw",
    "life-buoy",
    "user",
    "trash-2",
    "power",
];

#[cfg(target_os = "macos")]
fn glyph(name: &str) -> tray_icon::menu::NativeIcon {
    debug_assert!(ICONS.contains(&name));
    tray_icon::menu::NativeIcon::from_name(format!("{name}Template"))
}

/// A grey status dot for the header (AppKit has green, amber and red; its
/// "none" is clear), the size of theirs: 36 px for muda's 18 points.
#[cfg(target_os = "macos")]
fn grey_dot() -> Result<tray_icon::menu::Icon> {
    const SIZE: u32 = 36;
    let (c, r) = (SIZE as f32 / 2.0, 7.0_f32);
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 + 0.5 - c).powi(2) + (y as f32 + 0.5 - c).powi(2)).sqrt();
            let a = (r + 0.5 - d).clamp(0.0, 1.0);
            rgba.extend_from_slice(&[142, 142, 147, (a * 255.0) as u8]);
        }
    }
    tray_icon::menu::Icon::from_rgba(rgba, SIZE, SIZE).context("the grey dot")
}

/// A value's submenu: the whole value (a disabled row) and Copy, where the
/// OS has a clipboard to reach (not Linux).
struct Copyable {
    menu: Submenu,
    full: MenuItem,
    #[cfg(any(target_os = "macos", windows))]
    copy: MenuItem,
    value: String,
}

impl Copyable {
    fn new() -> Result<Self> {
        let menu = Submenu::new("…", true);
        let full = MenuItem::new("—", false, None);
        menu.append(&full).context("building the menu")?;
        #[cfg(any(target_os = "macos", windows))]
        let copy = MenuItem::new("Copy", true, None);
        #[cfg(any(target_os = "macos", windows))]
        menu.append(&copy).context("building the menu")?;
        Ok(Self {
            menu,
            full,
            #[cfg(any(target_os = "macos", windows))]
            copy,
            value: String::new(),
        })
    }

    fn show(&mut self, (row, full): &(String, String)) {
        self.menu.set_text(row);
        self.full.set_text(full);
        let known = full != "—";
        #[cfg(any(target_os = "macos", windows))]
        self.copy.set_enabled(known);
        self.value = if known { full.clone() } else { String::new() };
    }
}

struct Ui {
    tray: TrayIcon,
    icons: Icons,
    look: Look,
    header: IconMenuItem,
    header_now: Option<Header>,
    #[cfg(target_os = "macos")]
    grey: tray_icon::menu::Icon,
    open_app: IconMenuItem,
    this_machine: IconMenuItem,
    awake: CheckMenuItem,
    claude_rc: CheckMenuItem,
    #[cfg(unix)]
    santree: CheckMenuItem,
    note: MenuItem,
    connection: Submenu,
    link: MenuItem,
    vpn: MenuItem,
    traffic: MenuItem,
    address: MenuItem,
    endpoint: MenuItem,
    own_key: Copyable,
    box_key: Copyable,
    claude: Submenu,
    claude_server: MenuItem,
    claude_folder: MenuItem,
    update_claude: MenuItem,
    restart_claude: MenuItem,
    open_claude_log: MenuItem,
    #[cfg(unix)]
    santree_menu: Submenu,
    #[cfg(unix)]
    santree_host: MenuItem,
    #[cfg(unix)]
    santree_open: MenuItem,
    #[cfg(unix)]
    santree_refused: MenuItem,
    updates: Submenu,
    check_now: MenuItem,
    open_status: MenuItem,
    open_logs: MenuItem,
    /// Log in / log out (a Mac), pair (elsewhere): one row whose words swap.
    account: IconMenuItem,
    #[cfg(target_os = "macos")]
    uninstall: IconMenuItem,
    quit: IconMenuItem,
    /// The settings as last read, for a click's next value.
    settings: Option<View>,
    /// Whether the account row logs out (a Mac logged in) rather than in.
    #[cfg(target_os = "macos")]
    logged_in: bool,
    /// When Login Items was last asked: at most once a minute, and only while
    /// the service does not answer.
    #[cfg(target_os = "macos")]
    login_asked: Option<std::time::Instant>,
    #[cfg(target_os = "macos")]
    switched_off: bool,
}

impl Ui {
    fn build() -> Result<Self> {
        let icons = Icons {
            ok: decode(ICON_OK)?,
            warn: decode(ICON_WARN)?,
            off: decode(ICON_OFF)?,
        };
        let item = |text: &str, enabled: bool| IconMenuItem::new(text, enabled, None, None);
        let line = |text: &str| MenuItem::new(text, false, None);
        let header = item("…", true);
        let about = line(&format!("{DISPLAY_NAME} {VERSION}"));
        let open_app = item("Open Daedalus", true);
        #[cfg(target_os = "macos")]
        let this_machine = IconMenuItem::new(
            "This Mac in Daedalus…",
            true,
            None,
            Some(cmd(tray_icon::menu::accelerator::Code::Comma)),
        );
        #[cfg(not(target_os = "macos"))]
        let this_machine = item("This machine in Daedalus…", true);
        let check = |key: Key| CheckMenuItem::new(key.label(), false, false, None);
        let awake = check(Key::AwakeHold);
        let claude_rc = check(Key::ClaudeRemoteControl);
        #[cfg(unix)]
        let santree = check(Key::Santree);
        let note = line("—");

        let connection = Submenu::new("Connection", true);
        let (link, vpn, traffic, address, endpoint) = (
            line("Box: …"),
            line("VPN: …"),
            line("Traffic: …"),
            line("Tunnel address: …"),
            line("Endpoint: …"),
        );
        let own_key = Copyable::new()?;
        let box_key = Copyable::new()?;
        connection
            .append_items(&[
                &link,
                &vpn,
                &traffic,
                &address,
                &endpoint,
                &PredefinedMenuItem::separator(),
                &own_key.menu,
                &box_key.menu,
            ])
            .context("building the menu")?;

        let claude = Submenu::new("Claude", true);
        let claude_server = line("Remote control: …");
        let claude_folder = line("Folder: …");
        let update_claude = MenuItem::new("Update Claude Code", true, None);
        let restart_claude = MenuItem::new("Restart remote control", true, None);
        let open_claude_log = MenuItem::new("Open remote-control log", true, None);
        claude
            .append_items(&[
                &claude_server,
                &claude_folder,
                &PredefinedMenuItem::separator(),
                &update_claude,
                &restart_claude,
                &open_claude_log,
            ])
            .context("building the menu")?;

        #[cfg(unix)]
        let santree_menu = Submenu::new("santree", true);
        #[cfg(unix)]
        let (santree_host, santree_open, santree_refused) = (
            line("Session host: …"),
            line("Open connections: …"),
            line("Last refused: …"),
        );
        #[cfg(unix)]
        santree_menu
            .append_items(&[&santree_host, &santree_open, &santree_refused])
            .context("building the menu")?;

        let updates = Submenu::new("Updates: …", true);
        let check_now = MenuItem::new("Check for updates now", true, None);
        updates.append(&check_now).context("building the menu")?;
        let troubleshoot = Submenu::new("Troubleshoot", true);
        let open_status = MenuItem::new("Show status (JSON)", true, None);
        let open_logs = MenuItem::new("Open logs folder", true, None);
        troubleshoot
            .append_items(&[&open_status, &open_logs])
            .context("building the menu")?;

        let account = item(JOIN_LABEL, true);
        #[cfg(target_os = "macos")]
        let uninstall = item(&format!("Uninstall {DISPLAY_NAME}…"), true);
        #[cfg(target_os = "macos")]
        let quit = IconMenuItem::new(
            QUIT_LABEL,
            true,
            None,
            Some(cmd(tray_icon::menu::accelerator::Code::KeyQ)),
        );
        #[cfg(not(target_os = "macos"))]
        let quit = item(QUIT_LABEL, true);

        let sep = PredefinedMenuItem::separator;
        let (s1, s2, s3, s4, s5) = (sep(), sep(), sep(), sep(), sep());
        let mut rows: Vec<&dyn IsMenuItem> = vec![&header, &about, &s1, &open_app, &this_machine];
        rows.extend([&s2 as &dyn IsMenuItem, &awake, &claude_rc]);
        #[cfg(unix)]
        rows.push(&santree);
        rows.extend([&note as &dyn IsMenuItem, &s3, &connection, &claude]);
        #[cfg(unix)]
        rows.push(&santree_menu);
        rows.extend([&updates as &dyn IsMenuItem, &troubleshoot, &s4, &account]);
        #[cfg(target_os = "macos")]
        rows.push(&uninstall);
        rows.extend([&s5 as &dyn IsMenuItem, &quit]);
        let menu = Menu::new();
        menu.append_items(&rows).context("building the menu")?;

        #[cfg(target_os = "macos")]
        {
            open_app.set_native_icon(Some(glyph("layout-dashboard")));
            this_machine.set_native_icon(Some(glyph("settings")));
            connection.set_native_icon(Some(glyph("network")));
            claude.set_native_icon(Some(glyph("sparkles")));
            santree_menu.set_native_icon(Some(glyph("trees")));
            updates.set_native_icon(Some(glyph("refresh-cw")));
            troubleshoot.set_native_icon(Some(glyph("life-buoy")));
            account.set_native_icon(Some(glyph("user")));
            uninstall.set_native_icon(Some(glyph("trash-2")));
            quit.set_native_icon(Some(glyph("power")));
        }

        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip(format!("{DISPLAY_NAME} {VERSION}"))
            .with_icon(icons.off.clone())
            .build()
            .context("creating the tray icon")?;

        Ok(Self {
            tray,
            icons,
            look: Look::Off,
            header,
            header_now: None,
            #[cfg(target_os = "macos")]
            grey: grey_dot()?,
            open_app,
            this_machine,
            awake,
            claude_rc,
            #[cfg(unix)]
            santree,
            note,
            connection,
            link,
            vpn,
            traffic,
            address,
            endpoint,
            own_key,
            box_key,
            claude,
            claude_server,
            claude_folder,
            update_claude,
            restart_claude,
            open_claude_log,
            #[cfg(unix)]
            santree_menu,
            #[cfg(unix)]
            santree_host,
            #[cfg(unix)]
            santree_open,
            #[cfg(unix)]
            santree_refused,
            updates,
            check_now,
            open_status,
            open_logs,
            account,
            #[cfg(target_os = "macos")]
            uninstall,
            quit,
            settings: None,
            #[cfg(target_os = "macos")]
            logged_in: false,
            #[cfg(target_os = "macos")]
            login_asked: None,
            #[cfg(target_os = "macos")]
            switched_off: false,
        })
    }

    fn set_look(&mut self, look: Look) {
        if look == self.look {
            return;
        }
        let icon = match look {
            Look::Ok => &self.icons.ok,
            Look::Warn => &self.icons.warn,
            Look::Off => &self.icons.off,
        };
        let _ = self.tray.set_icon(Some(icon.clone()));
        self.look = look;
    }

    /// The header's dot and line; the dot only where the OS draws one.
    fn set_header(&mut self, h: Header) {
        if self.header_now.as_ref() == Some(&h) {
            return;
        }
        self.header.set_text(&h.text);
        #[cfg(target_os = "macos")]
        {
            use tray_icon::menu::NativeIcon;
            match h.dot {
                Dot::Green => self
                    .header
                    .set_native_icon(Some(NativeIcon::StatusAvailable)),
                Dot::Amber => self
                    .header
                    .set_native_icon(Some(NativeIcon::StatusPartiallyAvailable)),
                Dot::Red => self
                    .header
                    .set_native_icon(Some(NativeIcon::StatusUnavailable)),
                Dot::Grey => self.header.set_icon(Some(self.grey.clone())),
            }
        }
        self.header_now = Some(h);
    }

    /// Whether Login Items has the service switched off: asked only while
    /// the service does not answer (`silent`), at most once a minute.
    #[cfg(target_os = "macos")]
    fn login_items_off(&mut self, silent: bool) -> bool {
        if !silent {
            self.login_asked = None;
            self.switched_off = false;
            return false;
        }
        let now = std::time::Instant::now();
        let due = self
            .login_asked
            .is_none_or(|t| now.duration_since(t) >= std::time::Duration::from_secs(60));
        if due {
            self.login_asked = Some(now);
            self.switched_off = crate::os::tray::service_switched_off();
        }
        self.switched_off
    }

    /// Reflect one read of the page (or its absence) and the supervisor's
    /// state. Every row is set on every read, so the menu is right even
    /// while it is open, and a switch muda flipped on its click shows the
    /// service's value again in the same pass.
    fn show(&mut self, page: Option<&Page>, claude: &Report, claude_wanted: bool) {
        #[cfg(target_os = "macos")]
        let switched_off = self.login_items_off(page.is_none());
        #[cfg(not(target_os = "macos"))]
        let switched_off = false;
        #[allow(unused_mut)]
        let mut head = header(page, switched_off, claude, claude_wanted);
        // A log-in waiting for the browser says so, with this Mac's key to
        // compare with the page's.
        #[cfg(target_os = "macos")]
        if let Some(note) = crate::os::tray::log_in_note() {
            head = Header {
                dot: Dot::Amber,
                text: note,
                login_items: false,
            };
        }

        // The switches.
        let settings = page.and_then(|p| p.settings.clone());
        let may = settings.as_ref().is_some_and(may_change_here);
        let set_switch = |item: &CheckMenuItem, key: Key| match &settings {
            Some(s) => {
                let sw = switch(key, s, may);
                item.set_text(&sw.text);
                item.set_checked(sw.checked);
                item.set_enabled(sw.enabled);
            }
            None => {
                item.set_text(key.label());
                item.set_checked(false);
                item.set_enabled(false);
            }
        };
        set_switch(&self.awake, Key::AwakeHold);
        set_switch(&self.claude_rc, Key::ClaudeRemoteControl);
        #[cfg(unix)]
        set_switch(&self.santree, Key::Santree);
        self.note.set_text(match &settings {
            Some(s) => switches_note(s, may),
            None if page.is_some() => "Restart the service to change these here".into(),
            None => "—".into(),
        });
        self.settings = settings;

        // The app's two links.
        let app = app_url();
        self.open_app.set_enabled(app.is_some());
        self.this_machine.set_enabled(app.is_some());

        // Connection, Claude, santree, Updates.
        let link = page.and_then(|p| p.controller.as_ref());
        let rows = connection_rows(link);
        self.connection.set_text(&rows.title);
        self.link.set_text(&rows.link);
        self.vpn.set_text(&rows.vpn);
        self.traffic.set_text(&rows.traffic);
        self.address.set_text(&rows.address);
        self.endpoint.set_text(&rows.endpoint);
        self.own_key.show(&rows.own_key);
        self.box_key.show(&rows.box_key);
        let policy = page.map(|p| p.policy.clone()).unwrap_or_default();
        let c = claude_rows(claude, &policy);
        self.claude.set_text(&c.title);
        self.claude_server.set_text(&c.server);
        self.claude_folder.set_text(&c.folder);
        self.restart_claude.set_text(&c.restart);
        #[cfg(unix)]
        {
            let s = santree_rows(page);
            self.santree_menu.set_text(&s.title);
            self.santree_host.set_text(&s.host);
            self.santree_open.set_text(&s.open);
            self.santree_refused.set_text(&s.refused);
        }
        self.updates.set_text(match page {
            Some(p) => update_line(p),
            None => "Updates: unknown".into(),
        });

        // The account row: log in or out (a Mac), pair (elsewhere).
        #[cfg(target_os = "macos")]
        {
            self.logged_in = page.is_some_and(|p| !logged_out(p));
            self.account.set_text(if self.logged_in {
                "Log out of the box…"
            } else {
                JOIN_LABEL
            });
            self.account.set_enabled(page.is_some());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let unpaired = page.is_some_and(logged_out);
            self.account.set_text(if unpaired {
                JOIN_LABEL
            } else {
                "Paired with the box"
            });
            self.account.set_enabled(unpaired);
        }

        // The icon and its tooltip.
        let look = match (page, head.dot) {
            (None, _) => Look::Off,
            (Some(_), Dot::Green) => Look::Ok,
            (Some(_), _) => Look::Warn,
        };
        let version = page.map_or(VERSION, |p| p.version.as_str());
        let _ = self.tray.set_tooltip(Some(format!(
            "{DISPLAY_NAME} {version}\n{}\n{}",
            head.text, c.server
        )));
        self.set_look(look);
        self.set_header(head);
    }
}

/// ⌘ and `code`: a Mac's key equivalent, which works while the menu is open.
#[cfg(target_os = "macos")]
fn cmd(code: tray_icon::menu::accelerator::Code) -> tray_icon::menu::accelerator::Accelerator {
    tray_icon::menu::accelerator::Accelerator::new(
        tray_icon::menu::accelerator::Modifiers::META,
        code,
    )
}

/// The app this machine logged in to (config.toml's `app_url`), if any.
fn app_url() -> Option<String> {
    config::load_for_user().ok().and_then(|c| c.app_url)
}

/// The entry that joins the box while the machine has not: a Mac logs in
/// (enroll.rs, os/macos/tray.rs `join`), every other machine pairs
/// (pair.rs, os/*/tray.rs `join`).
#[cfg(target_os = "macos")]
pub const JOIN_LABEL: &str = "Log in…";
#[cfg(not(target_os = "macos"))]
pub const JOIN_LABEL: &str = "Pair with the box…";

/// The pairing dialog's title and prompt (os/*/tray.rs `join`).
#[cfg(not(target_os = "macos"))]
pub const PAIR_TITLE: &str = "Pair with the box";
#[cfg(not(target_os = "macos"))]
pub const PAIR_PROMPT: &str = "Paste the controller key from Settings › Machines on the box. \
     The whole pair or install line from that page works too.";

/// What the dialog's text becomes: the `pair` verb, run as an
/// administrator behind the OS's own prompt (os/*/tray.rs
/// `pair_elevated`: UAC, macOS's administrator password, polkit), or the
/// reason it did not, for the answer's dialog. Pairing names the
/// controller that commands this machine's service, so it asks what
/// `install` asks; the tray never writes config.toml, and the local
/// socket has no door for it (local.rs). The paste is checked first
/// (pair.rs `parse_pasted`): nothing malformed ever reaches the prompt,
/// and only the checked key and address — a fingerprint and host:port —
/// reach the command line.
#[cfg(not(target_os = "macos"))]
pub fn pair_pasted(text: &str) -> std::result::Result<String, String> {
    let (exe, args, p) = pair_command(text)?;
    crate::os::tray::pair_elevated(&exe, &args, &p)
}

/// The paste, checked, as the agent binary beside the tray and the `pair`
/// arguments to run it with.
#[cfg(not(target_os = "macos"))]
fn pair_command(
    text: &str,
) -> std::result::Result<(PathBuf, Vec<String>, crate::pair::Pairing), String> {
    let p = crate::pair::parse_pasted(text).map_err(|e| format!("{e:#}"))?;
    Ok((agent_exe()?, pair_args(&p), p))
}

/// `pair --pin KEY [--controller HOST:PORT]` for a checked pairing.
#[cfg(not(target_os = "macos"))]
pub fn pair_args(p: &crate::pair::Pairing) -> Vec<String> {
    let mut a = vec!["pair".to_string(), "--pin".to_string(), p.pin.clone()];
    if let Some(c) = &p.controller {
        a.extend(["--controller".to_string(), c.clone()]);
    }
    a
}

/// The service's binary, installed beside the tray on every OS.
pub(crate) fn agent_exe() -> std::result::Result<PathBuf, String> {
    let me = std::env::current_exe().map_err(|e| format!("locating the tray: {e}"))?;
    let exe = me.with_file_name(format!(
        "{}{}",
        crate::SERVICE_NAME,
        std::env::consts::EXE_SUFFIX
    ));
    if exe.is_file() {
        Ok(exe)
    } else {
        Err(format!("no {} beside the tray", exe.display()))
    }
}

/// Linux: polkit's `pkexec` runs the agent as root, after its own prompt.
#[cfg(any(test, target_os = "linux"))]
pub fn pkexec_argv(
    pkexec: &std::path::Path,
    exe: &std::path::Path,
    args: &[String],
) -> Vec<std::ffi::OsString> {
    let mut v = vec![pkexec.as_os_str().to_owned(), exe.as_os_str().to_owned()];
    v.extend(args.iter().map(Into::into));
    v
}

/// macOS: osascript's arguments to run the agent as root behind the
/// administrator prompt, which says `prompt` (the app's install, a
/// log-in's `enroll-finish`, "Uninstall…"; os/macos/tray.rs). The script is
/// fixed; the binary, its arguments and the prompt ride `argv`, and each
/// word of the command is shell-quoted by AppleScript's `quoted form of`,
/// so nothing the browser sent — nor an account's name — is ever spliced
/// into the script or the shell line. The binary comes first: an absolute
/// path, so osascript reads every word after it as an argument, never an
/// option; the prompt is the last.
#[cfg(any(test, target_os = "macos"))]
pub fn osascript_argv(
    exe: &std::path::Path,
    args: &[String],
    prompt: &str,
) -> Vec<std::ffi::OsString> {
    const SCRIPT: [&str; 8] = [
        "on run argv",
        "set n to count of argv",
        "set cmd to quoted form of (item 1 of argv)",
        "repeat with i from 2 to (n - 1)",
        "set cmd to cmd & \" \" & quoted form of (item i of argv)",
        "end repeat",
        "do shell script cmd with prompt (item n of argv) \
         with administrator privileges without altering line endings",
        "end run",
    ];
    let mut v: Vec<std::ffi::OsString> = Vec::new();
    for line in SCRIPT {
        v.push("-e".into());
        v.push(line.into());
    }
    v.push(exe.as_os_str().to_owned());
    v.extend(args.iter().map(Into::into));
    v.push(prompt.into());
    v
}

/// Windows: `ShellExecuteExW`'s parameters line, each argument quoted as
/// `CommandLineToArgvW` (and Rust's own argument parsing) reads it back.
#[cfg(any(test, windows))]
pub fn windows_parameters(args: &[String]) -> String {
    let mut line = String::new();
    for (i, a) in args.iter().enumerate() {
        if i > 0 {
            line.push(' ');
        }
        if !a.is_empty() && !a.contains([' ', '\t', '\n', '\u{b}', '"']) {
            line.push_str(a);
            continue;
        }
        line.push('"');
        let mut slashes = 0;
        for c in a.chars() {
            match c {
                '\\' => slashes += 1,
                '"' => {
                    line.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
                    line.push('"');
                    slashes = 0;
                }
                c => {
                    line.extend(std::iter::repeat_n('\\', slashes));
                    line.push(c);
                    slashes = 0;
                }
            }
        }
        line.extend(std::iter::repeat_n('\\', slashes * 2));
        line.push('"');
    }
    line
}

/// Windows, whose dialogs are another program (PowerShell): ask on a thread
/// of its own so the tray's loop never waits on a person, pair with what
/// came back, and show the outcome. One at a time.
#[cfg(windows)]
pub fn pair_on_a_thread(ask: fn() -> Option<String>, tell: fn(&str, bool)) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static OPEN: AtomicBool = AtomicBool::new(false);
    if OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("pair".into())
        .spawn(move || {
            if let Some(text) = ask().filter(|t| !t.trim().is_empty()) {
                match pair_pasted(&text) {
                    Ok(said) => tell(&said, true),
                    Err(e) => tell(&format!("Not paired: {e}"), false),
                }
            }
            OPEN.store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        OPEN.store(false, Ordering::SeqCst);
    }
}

/// What a tick or a menu click decided.
#[derive(PartialEq, Eq)]
pub enum Flow {
    Continue,
    Quit,
}

/// The tray between ticks: what it stands over, the menu, and the two log
/// paths the menu opens. The platform loops (os/*/tray.rs) drive it — Win32
/// messages on Windows, a tao event loop on macOS, GTK's on Linux — and it
/// knows nothing about any of them. Fields drop in order: an owned session
/// (its supervisor; the Claude jobs run on) before the icon.
pub struct Tray {
    session: Backing,
    ui: Ui,
    logs: PathBuf,
    claude_log: PathBuf,
}

impl Tray {
    pub fn start() -> Result<Self> {
        let cfg = config::load_for_user()?;
        if !cfg.role().tray {
            bail!("no tray in controller mode (config.toml says mode = \"controller\")");
        }
        let logs: PathBuf = paths::user_log_dir();
        let places = Places::of_user(&cfg);
        let claude_log = places.claude_log.clone();
        // The icon first, then the session, as it always was.
        let ui = Ui::build()?;
        let session = if crate::os::TRAY_OWNS_SESSION {
            Backing::Owns(Box::new(Session::new(places)?))
        } else {
            Backing::Watches(Watcher::new())
        };
        Ok(Self {
            session,
            ui,
            logs,
            claude_log,
        })
    }

    /// "Show status (JSON)": the service's status document, as its local
    /// socket answers it, written to `status.json` in the tray's log
    /// directory and opened — there is no page to point a browser at.
    fn show_status(&self) {
        let text = match crate::local::call("status", serde_json::Value::Null) {
            Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
            Err(e) => format!("{{\"error\": {}}}", serde_json::Value::String(e)),
        };
        let path = self.logs.join("status.json");
        if std::fs::create_dir_all(&self.logs)
            .and_then(|()| {
                crate::util::write_atomic(&path, text.as_bytes(), crate::util::Access::Inherit)
            })
            .is_ok()
        {
            open(&path.to_string_lossy());
        }
    }

    /// The app, at `path` (empty: its front page); nothing without one.
    fn open_app(path: &str) {
        if let Some(app) = app_url() {
            open(&format!("{}{path}", app.trim_end_matches('/')));
        }
    }

    /// A switch was clicked: the other value is asked for (`next_value`),
    /// the page that confirms santree ON opened, and the page read again at
    /// once so the row shows what became of it. muda flipped the check on
    /// the click; the read puts the service's word back.
    fn ask(&mut self, key: Key) {
        if let Some(s) = &self.ui.settings {
            let value = next_value(key, s);
            let answer = crate::local::call_as::<crate::local::SetAnswer>(
                "settings.set",
                serde_json::json!({ "key": key, "value": value }),
            );
            if let Ok(crate::local::SetAnswer {
                confirm_url: Some(url),
                ..
            }) = answer
            {
                // The service names a page on the app it logged in to; an
                // https URL and nothing else is handed to the browser.
                if url.starts_with("https://") {
                    open(&url);
                }
            }
        }
        self.session.poll_now();
    }

    /// Every menu click since the last look.
    pub fn menu(&mut self) -> Flow {
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            let id = ev.id();
            let ui = &self.ui;
            if *id == ui.quit.id() {
                return Flow::Quit;
            }
            #[cfg(target_os = "macos")]
            if *id == ui.uninstall.id() {
                crate::os::tray::uninstall();
                continue;
            }
            #[cfg(any(target_os = "macos", windows))]
            {
                let copied = [&ui.own_key, &ui.box_key]
                    .into_iter()
                    .find(|k| *id == k.copy.id())
                    .map(|k| k.value.clone());
                if let Some(v) = copied {
                    if !v.is_empty() {
                        crate::os::tray::copy(&v);
                    }
                    continue;
                }
            }
            if *id == ui.header.id() {
                #[cfg(target_os = "macos")]
                if ui.header_now.as_ref().is_some_and(|h| h.login_items) {
                    crate::os::tray::open_login_items();
                    continue;
                }
                Self::open_app("");
            } else if *id == ui.open_app.id() {
                Self::open_app("");
            } else if *id == ui.this_machine.id() {
                let node = ui.settings.as_ref().and_then(|s| s.node.clone());
                Self::open_app(&match node {
                    Some(n) => format!("/settings?tab=machines&node={n}"),
                    None => "/settings?tab=machines".into(),
                });
            } else if *id == ui.awake.id() {
                self.ask(Key::AwakeHold);
            } else if *id == ui.claude_rc.id() {
                self.ask(Key::ClaudeRemoteControl);
            } else if cfg!(unix) && self.is_santree(id) {
                self.ask(Key::Santree);
            } else if *id == ui.account.id() {
                #[cfg(target_os = "macos")]
                if ui.logged_in {
                    crate::os::tray::log_out();
                    continue;
                }
                crate::os::tray::join();
            } else if *id == ui.check_now.id() {
                self.session.check_updates_now();
            } else if *id == ui.update_claude.id() {
                let _ = crate::local::call("claude.update", serde_json::Value::Null);
                self.session.poll_now();
            } else if *id == ui.restart_claude.id() {
                self.session.restart_claude();
            } else if *id == ui.open_claude_log.id() {
                open(&self.claude_log.to_string_lossy());
            } else if *id == ui.open_status.id() {
                self.show_status();
            } else if *id == ui.open_logs.id() {
                open(&self.logs.to_string_lossy());
            }
        }
        Flow::Continue
    }

    #[cfg(unix)]
    fn is_santree(&self, id: &tray_icon::menu::MenuId) -> bool {
        *id == self.ui.santree.id()
    }

    #[cfg(not(unix))]
    fn is_santree(&self, _: &tray_icon::menu::MenuId) -> bool {
        false
    }

    /// Advance the session and, when it polled, redraw. Quit means an
    /// update swapped the binary and we are leaving for the new one — on
    /// Windows and Linux by starting it first (`os::tray::relaunch_self`);
    /// under launchd, leaving is enough, as KeepAlive starts it. Claude runs
    /// on untouched in its jobs, and the new tray re-attaches to them.
    pub fn tick(&mut self) -> Flow {
        match self.session.tick() {
            Tick::Idle => Flow::Continue,
            Tick::VersionChanged => {
                relaunch_self();
                Flow::Quit
            }
            Tick::Polled(poll) => {
                self.ui.show(
                    poll.page.as_ref(),
                    &poll.report,
                    self.session.claude_wanted(),
                );
                Flow::Continue
            }
        }
    }
}

/// The menu and its icons built, and nothing run: the CI smoke test of a
/// built app (`DAEDALUS_AGENT_SMOKE`, os/macos/tray.rs).
#[cfg(target_os = "macos")]
pub fn smoke() -> Result<()> {
    Ui::build().map(|_| ())
}

/// Write why the tray could not run where a windowless program can be
/// read: `tray.err` in the tray's log directory (beside the service's logs
/// on Windows, ~/Library/Logs on macOS, ~/.local/state on Linux).
pub fn write_failure(e: &anyhow::Error) {
    let dir = paths::user_log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = crate::util::write_atomic(
        &dir.join("tray.err"),
        format!("{e:#}\n").as_bytes(),
        crate::util::Access::Inherit,
    );
}

/// The tray program's `main` (`os::tray_main`): the OS's loop until quit;
/// a failure, with nowhere to print, goes to `tray.err` and exits 1.
pub fn main() {
    if let Err(e) = crate::os::tray::run() {
        write_failure(&e);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::TunnelStatus;
    use crate::settings::{FailedView, PendingView};
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn the_updates_row_says_what_the_updater_is_doing() {
        let checked = Page {
            last_update_result: Some("up to date".into()),
            last_update_check: Some("2026-09-30T10:00:00Z".into()),
            ..Page::default()
        };
        assert_eq!(update_line(&checked), "Updates: up to date · 10:00");
        let offered = Page {
            update_available: Some("0.25.1".into()),
            ..Page::default()
        };
        assert_eq!(update_line(&offered), "Updating to 0.25.1…");
        let restarting = Page {
            restart_pending: true,
            ..Page::default()
        };
        assert_eq!(update_line(&restarting), "Update installed — restarting");
        let reinstall = Page {
            reinstall_required: Some(crate::update::ReinstallRequired {
                version: "0.26.0".into(),
            }),
            ..checked
        };
        assert_eq!(
            update_line(&reinstall),
            "0.26.0: re-install from the website"
        );
        assert_eq!(update_line(&Page::default()), "Updates: not checked yet");
    }

    fn linked_page() -> Page {
        Page {
            awake_hold: true,
            policy: Policy {
                awake_hold: true,
                claude_remote_control: true,
                ..Default::default()
            },
            controller: Some(LinkPage {
                address: Some("box.lan:7788".into()),
                state: Some("approved".into()),
                connected: true,
                since: Some("2026-09-30T09:12:00Z".into()),
                fingerprint: "f876:e2c7:1a0b:2c3d:4e5f:6a7b:8c9d:0e1f:2a3b:4c5d:6e7f:8a9b:0c1d:2e3f:4a5b:8029".into(),
                controller_fingerprint: Some("3a1b:0c9d:1111:2222:3333:4444:5555:6666:7777:8888:9999:aaaa:bbbb:cccc:dddd:77e2".into()),
                error: None,
                tunnel: Some(TunnelStatus {
                    endpoint: "s2.toscanini.me:51820".into(),
                    address: "10.8.0.5".into(),
                    last_handshake_secs: Some(42),
                    rx_bytes: 12_400_000,
                    tx_bytes: 2_200_000,
                    ..Default::default()
                }),
            }),
            settings: Some(View {
                linked: true,
                awake_hold: true,
                claude_remote_control: true,
                operator_uid: Some(501),
                operator: Some("santiago".into()),
                ..Default::default()
            }),
            ..Page::default()
        }
    }

    fn running() -> Report {
        Report {
            state: "running".into(),
            ..Default::default()
        }
    }

    /// One test per header state (module doc), in the order they win.
    #[test]
    fn the_header_has_one_state_for_every_way_things_stand() {
        let ok = linked_page();
        let r = running();
        let h = |p: Option<&Page>, off: bool, claude: &Report, wanted: bool| {
            let h = header(p, off, claude, wanted);
            (h.dot, h.text)
        };
        assert_eq!(
            h(Some(&ok), false, &r, true),
            (Dot::Green, "Daedalus Agent is connected".into())
        );
        // The service is silent: switched off in Login Items, or not answering.
        let off = header(None, true, &r, true);
        assert_eq!((off.dot, off.login_items), (Dot::Grey, true));
        assert_eq!(off.text, "The service is off in Login Items");
        assert_eq!(
            h(None, false, &r, true),
            (Dot::Red, "The service is not answering".into())
        );
        // Not joined.
        let mut out = linked_page();
        if cfg!(target_os = "macos") {
            out.controller.as_mut().unwrap().tunnel = None;
        } else {
            out.controller.as_mut().unwrap().state = Some("unpaired".into());
        }
        let (dot, text) = h(Some(&out), false, &r, true);
        assert_eq!(dot, Dot::Grey);
        assert_eq!(text, UNJOINED_HEADER);
        // The link's states.
        let with = |f: &dyn Fn(&mut LinkPage)| {
            let mut p = linked_page();
            f(p.controller.as_mut().unwrap());
            p
        };
        let changed = with(&|l| l.state = Some("key-changed".into()));
        assert_eq!(
            h(Some(&changed), false, &r, true),
            (Dot::Red, "The box's key changed — refused".into())
        );
        let revoked = with(&|l| l.state = Some("revoked".into()));
        assert_eq!(h(Some(&revoked), false, &r, true).1, "Revoked by the box");
        let pending = with(&|l| l.state = Some("pending".into()));
        assert_eq!(
            h(Some(&pending), false, &r, true),
            (Dot::Amber, "Waiting for approval in Daedalus".into())
        );
        let down = with(&|l| {
            l.connected = false;
            l.state = Some("connecting".into());
            l.error = Some("connection refused by box.lan:7788 after three tries in a row".into());
        });
        let (dot, text) = h(Some(&down), false, &r, true);
        assert_eq!(dot, Dot::Red);
        assert!(
            text.starts_with("Disconnected — connection refused"),
            "{text}"
        );
        assert!(text.chars().count() <= "Disconnected — ".chars().count() + 40);
        let connecting = with(&|l| {
            l.connected = false;
            l.state = Some("connecting".into());
        });
        assert_eq!(
            h(Some(&connecting), false, &r, true),
            (Dot::Amber, "Connecting…".into())
        );
        let stale = with(&|l| l.tunnel.as_mut().unwrap().last_handshake_secs = Some(600));
        assert_eq!(h(Some(&stale), false, &r, true).1, "VPN handshake is stale");
        // The machine's own.
        let restarting = Page {
            restart_pending: true,
            ..linked_page()
        };
        assert_eq!(
            h(Some(&restarting), false, &r, true).1,
            "Update installed — restarting"
        );
        let unheld = Page {
            awake_hold: false,
            ..linked_page()
        };
        assert_eq!(
            h(Some(&unheld), false, &r, true),
            (Dot::Amber, "Keep awake is not holding".into())
        );
        // Not holding because the box lets it sleep: fine.
        let mut sleeps = unheld;
        sleeps.policy.awake_hold = false;
        assert_eq!(h(Some(&sleeps), false, &r, true).0, Dot::Green);
        let exited = Report {
            state: "waiting".into(),
            ..Default::default()
        };
        assert_eq!(
            h(Some(&ok), false, &exited, true).1,
            "Claude remote control is not running"
        );
        assert_eq!(h(Some(&ok), false, &exited, false).0, Dot::Green);
        let mut failed = linked_page();
        failed.settings.as_mut().unwrap().failed = vec![FailedView {
            key: Key::AwakeHold,
            want: false,
            why: "Daedalus did not apply it".into(),
        }];
        assert_eq!(
            h(Some(&failed), false, &r, true),
            (Dot::Amber, "A setting was not applied".into())
        );
    }

    #[test]
    fn a_switch_shows_the_box_s_value_or_the_one_on_its_way() {
        let base = linked_page().settings.unwrap();
        let sw = switch(Key::AwakeHold, &base, true);
        assert_eq!(
            sw,
            Switch {
                text: "Keep awake".into(),
                checked: true,
                enabled: true
            }
        );
        assert_eq!(switches_note(&base, true), "—");
        // On its way: the value asked for.
        let mut s = base.clone();
        s.pending = vec![PendingView {
            key: Key::AwakeHold,
            want: false,
            via: Via::Box,
        }];
        let sw = switch(Key::AwakeHold, &s, true);
        assert_eq!(
            (sw.text.as_str(), sw.checked),
            ("Keep awake — sending…", false)
        );
        // A click while it is on its way asks for the other value again.
        assert!(next_value(Key::AwakeHold, &s));
        // Not taken: the box's value, and why.
        let mut s = base.clone();
        s.failed = vec![FailedView {
            key: Key::ClaudeRemoteControl,
            want: false,
            why: "Daedalus is not listening (the app is down) and more words past forty".into(),
        }];
        let sw = switch(Key::ClaudeRemoteControl, &s, true);
        assert!(sw.checked);
        assert!(
            sw.text
                .starts_with("Claude Remote Control — not changed: Daedalus is not listening"),
            "{}",
            sw.text
        );
        assert!(sw.text.ends_with('…'));
        // santree ON waits on the browser; a click opens the page again.
        let mut s = base.clone();
        s.pending = vec![PendingView {
            key: Key::Santree,
            want: true,
            via: Via::Browser,
        }];
        let sw = switch(Key::Santree, &s, true);
        assert_eq!(
            (sw.text.as_str(), sw.checked),
            ("santree on the box — confirm in the browser…", true)
        );
        assert!(next_value(Key::Santree, &s));
        // On: a click sends OFF.
        let on = View {
            santree: true,
            ..base.clone()
        };
        assert!(!next_value(Key::Santree, &on));
        // Someone else at this Mac: read-only, and says whose they are.
        let sw = switch(Key::AwakeHold, &base, false);
        assert!(!sw.enabled);
        assert_eq!(
            switches_note(&base, false),
            "Only santiago can change these"
        );
        let nobody = View {
            operator: None,
            ..base.clone()
        };
        assert_eq!(
            switches_note(&nobody, false),
            "Only the user who installed the agent can change these"
        );
        // Not linked: disabled, and why.
        let unlinked = View {
            linked: false,
            ..base
        };
        assert!(!switch(Key::AwakeHold, &unlinked, true).enabled);
        assert_eq!(
            switches_note(&unlinked, true),
            "Changes need the box: not connected"
        );
    }

    #[test]
    fn the_connection_submenu_shortens_what_is_long_and_keeps_it_whole_for_copy() {
        let p = linked_page();
        let rows = connection_rows(p.controller.as_ref());
        assert_eq!(rows.title, "Connection · VPN up");
        assert_eq!(rows.link, "Box: box.lan:7788 — approved, linked 09:12");
        assert_eq!(rows.vpn, "VPN: up · handshake 42 s ago");
        assert_eq!(rows.traffic, "Traffic: ↓ 12.4 MB · ↑ 2.2 MB");
        assert_eq!(rows.address, "Tunnel address: 10.8.0.5");
        assert_eq!(rows.endpoint, "Endpoint: s2.toscanini.me:51820");
        assert_eq!(rows.own_key.0, format!("{OWN_KEY}: f876:e2c7…8029"));
        assert!(rows.own_key.1.starts_with("f876:e2c7:1a0b") && rows.own_key.1.ends_with(":8029"));
        assert_eq!(rows.box_key.0, "Box's key: 3a1b:0c9d…77e2 (pinned)");
        // Down, and why.
        let mut l = p.controller.clone().unwrap();
        l.tunnel.as_mut().unwrap().error = Some("s2.toscanini.me:51820 does not resolve".into());
        let rows = connection_rows(Some(&l));
        assert_eq!(rows.title, "Connection · VPN down");
        assert_eq!(
            rows.vpn,
            "VPN: down — s2.toscanini.me:51820 does not resolve"
        );
        // Pending: compare both keys.
        let mut l = p.controller.clone().unwrap();
        l.state = Some("pending".into());
        assert_eq!(
            connection_rows(Some(&l)).link,
            "Box: box.lan:7788 — waiting for approval"
        );
        // Not joined: a Mac logs in, the others pair; nothing to copy.
        let mut l = p.controller.clone().unwrap();
        if cfg!(target_os = "macos") {
            l.tunnel = None;
            assert_eq!(
                connection_rows(Some(&l)).link,
                "Box: not logged in — choose Log in…"
            );
            assert_eq!(connection_rows(Some(&l)).title, "Connection · logged out");
        } else {
            l.tunnel = None;
            l.state = Some("unpaired".into());
            l.controller_fingerprint = None;
            let rows = connection_rows(Some(&l));
            assert_eq!(rows.link, "Box: not paired — choose Pair with the box…");
            assert_eq!(
                rows.box_key,
                ("Box's key: none trusted yet".into(), "—".into())
            );
            assert_eq!(rows.title, "Connection · direct");
        }
        assert_eq!(connection_rows(None).own_key.1, "—");
        assert_eq!(bytes(999), "999 B");
        assert_eq!(bytes(3_100), "3.1 KB");
    }

    #[test]
    fn claude_and_santree_say_what_runs_and_what_a_restart_ends() {
        let mut r = running();
        r.server.version = Some("2.1.4".into());
        r.home = Some("/Users/santiago".into());
        r.workdir = Some("/Users/santiago/projects".into());
        r.sessions = vec![
            crate::claude::Session {
                alive: true,
                ..Default::default()
            },
            crate::claude::Session {
                alive: true,
                ..Default::default()
            },
            crate::claude::Session::default(),
        ];
        let c = claude_rows(&r, &Policy::default());
        assert_eq!(c.title, "Claude · 2 sessions");
        assert_eq!(c.server, "Remote control: running 2.1.4");
        assert_eq!(c.folder, "Folder: ~/projects (the latest project)");
        assert_eq!(c.restart, "Restart remote control (ends 2 sessions)");
        let set = Policy {
            claude_workdir: Some("/Users/santiago/work".into()),
            ..Default::default()
        };
        assert_eq!(
            claude_rows(&r, &set).folder,
            "Folder: ~/work (set in Daedalus)"
        );
        let off = Report {
            state: "off".into(),
            ..Default::default()
        };
        assert_eq!(claude_rows(&off, &Policy::default()).title, "Claude · off");

        let mut p = linked_page();
        assert_eq!(santree_rows(Some(&p)).title, "santree · off");
        p.policy.santree = true;
        p.policy.session_host = Some(crate::link::wire::SessionHost {
            address: "s2.toscanini.me:7789".into(),
            public_key: String::new(),
        });
        p.santree = Some(crate::shared::SantreeDoor {
            open: 1,
            max: 4,
            last_refused: None,
        });
        let s = santree_rows(Some(&p));
        assert_eq!(
            s,
            SantreeRows {
                title: "santree · 1 open".into(),
                host: "Session host: s2.toscanini.me:7789".into(),
                open: "Open connections: 1 of 4".into(),
                refused: "Last refused: —".into(),
            }
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn the_tray_pairs_through_the_elevated_verb_with_checked_words_only() {
        let key = crate::identity::format_fingerprint(&[6; 32]);
        let args = |text: &str| crate::pair::parse_pasted(text).map(|p| pair_args(&p));
        assert_eq!(
            args(&format!(
                "sudo daedalus-agent pair --pin '{key}' --controller box.lan:7788"
            ))
            .unwrap(),
            ["pair", "--pin", &key, "--controller", "box.lan:7788"]
        );
        assert_eq!(args(&key).unwrap(), ["pair", "--pin", &key]);
        // Malformed pastes are refused before any prompt: no key, a key
        // that is not one, an address that is not host:port.
        for bad in [
            String::new(),
            "hello".into(),
            "3f2a:9c01".into(),
            format!("--pin {key} --controller '$(reboot):1'"),
            format!("--pin {key} --controller box.lan"),
            format!("--pin {key}x"),
        ] {
            assert!(pair_command(&bad).is_err(), "{bad:?}");
        }

        let exe = Path::new("/usr/local/bin/daedalus-agent");
        let a: Vec<String> = ["pair", "--pin", &key, "--controller", "box.lan:7788"]
            .map(String::from)
            .into();
        let os = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();

        // Linux: pkexec, the absolute binary, then the words as they are.
        let mut want = os(&["/run/wrappers/bin/pkexec", "/usr/local/bin/daedalus-agent"]);
        want.extend(a.iter().map(OsString::from));
        assert_eq!(
            pkexec_argv(Path::new("/run/wrappers/bin/pkexec"), exe, &a),
            want
        );

        // Windows: the parameters line, quoted as CommandLineToArgvW reads it.
        assert_eq!(
            windows_parameters(&a),
            format!("pair --pin {key} --controller box.lan:7788")
        );
        let q =
            |v: &[&str]| windows_parameters(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(q(&["a b", ""]), "\"a b\" \"\"");
        assert_eq!(q(&["say \"hi\""]), "\"say \\\"hi\\\"\"");
        assert_eq!(q(&["C:\\dir\\ x\\"]), "\"C:\\dir\\ x\\\\\"");
        assert_eq!(q(&["C:\\plain\\"]), "C:\\plain\\");
    }

    /// A log-in's last step runs as root behind the administrator prompt:
    /// a fixed script, the binary first after it, the words as arguments —
    /// nothing the browser sent inside any `-e`.
    #[test]
    fn the_elevated_log_in_passes_its_words_as_arguments_only() {
        let exe = Path::new(
            "/Library/Application Support/daedalus-agent/Daedalus Agent.app/Contents/MacOS/daedalus-agent",
        );
        // What the callback brought back, as hostile as it may be, and a
        // prompt naming an account that is.
        let code = "c0de'; rm -rf / # box.example.org";
        let prompt = "It serves \"x\" & (do shell script \"id\")";
        let a: Vec<String> = vec!["enroll-finish".into(), code.into()];
        let v = osascript_argv(exe, &a, prompt);
        let at = v.iter().position(|w| w == exe.as_os_str()).unwrap();
        assert_eq!(
            v[at + 1..v.len() - 1],
            a.iter().map(OsString::from).collect::<Vec<_>>()
        );
        assert_eq!(v.last().unwrap(), prompt);
        for pair in v[..at].chunks(2) {
            assert_eq!(pair[0], "-e");
            let line = pair[1].to_str().unwrap();
            assert!(
                !line.contains("rm -rf")
                    && !line.contains("box.example")
                    && !line.contains("\"id\""),
                "{line}"
            );
        }
        let script: Vec<_> = v[..at].iter().skip(1).step_by(2).collect();
        assert!(script.iter().any(|l| l
            .to_str()
            .unwrap()
            .contains("with administrator privileges")));
        assert!(script
            .iter()
            .all(|l| !l.to_str().unwrap().contains("do shell script cmd &")));
    }

    /// Every glyph the menu names is in the bundle's sources, at both sizes.
    #[test]
    fn every_menu_glyph_ships_at_18_and_36_px() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("macos/icons");
        for name in ICONS {
            assert!(dir.join(format!("{name}.svg")).is_file(), "{name}.svg");
            for (file, px) in [
                (format!("{name}Template.png"), 18),
                (format!("{name}Template@2x.png"), 36),
            ] {
                let f = std::fs::File::open(dir.join(&file)).unwrap();
                let info = png::Decoder::new(std::io::BufReader::new(f))
                    .read_info()
                    .unwrap()
                    .info()
                    .clone();
                assert_eq!((info.width, info.height), (px, px), "{file}");
            }
        }
    }
}
