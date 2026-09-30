//! The tray icon: the daedalus mark in the taskbar's corner, showing what
//! the service reports — a UI over the session (session.rs).
//!
//! A separate, windowless program in the desktop session, because the
//! service runs in session 0 where there is no taskbar to draw on. The
//! session reads the status document through the local socket (local.rs)
//! every `session::POLL`; the
//! tray reflects each read: the icon (ember when all is well, an amber dot
//! when something wants attention, grey when the service does not answer),
//! the tooltip, and a menu whose first lines are the state and whose rest
//! are the few things worth a click — the status document, a check for
//! updates, a Claude restart, the two logs, quit.
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
//! Either way quitting the tray stops nothing but the tray.
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
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use crate::claude::Report;
use crate::os::tray::{open, relaunch_self};
use crate::paths;
use crate::session::{Page, Places, Session, Tick, Watcher};
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

    fn tick(&mut self) -> Tick {
        match self {
            Backing::Owns(s) => s.tick(),
            Backing::Watches(w) => w.tick(),
        }
    }
}

/// What quitting the tray does, for the menu: nothing but the tray.
const QUIT_LABEL: &str = "Quit tray (Claude remote control and the service keep running)";

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

/// `HH:MM` of an RFC 3339 stamp, left in UTC: converting to the local clock
/// is more than the tray needs, and the hour and minute say "recent" well
/// enough in the date-less menu.
fn clock(ts: &str) -> &str {
    ts.get(11..16).unwrap_or(ts)
}

/// The menu's update line. A release this agent cannot apply (a Mac's app
/// bundle, update/) says how to get it instead of "up to date".
fn update_line(p: &crate::session::Page) -> String {
    if p.restart_pending {
        return "Updates: installed, restarting".to_string();
    }
    if let Some(r) = &p.reinstall_required {
        return crate::update::reinstall_line(&r.version);
    }
    match (
        &p.update_available,
        &p.last_update_result,
        &p.last_update_check,
    ) {
        (Some(v), _, _) => format!("Updates: {v} available"),
        (None, Some(r), Some(t)) => format!("Updates: {r} · {}", clock(t)),
        (None, Some(r), None) => format!("Updates: {r}"),
        _ => "Updates: not checked yet".to_string(),
    }
}

struct Ui {
    tray: TrayIcon,
    icons: Icons,
    look: Look,
    line_hold: MenuItem,
    line_update: MenuItem,
    line_link: MenuItem,
    /// The machine's own tunnel (`tunnel_line`): in the menu, under the link's
    /// line, only while a tunnel config governs the machine.
    line_tunnel: MenuItem,
    tunnel_shown: bool,
    line_key_own: MenuItem,
    line_key_controller: MenuItem,
    line_claude: MenuItem,
    /// The menu, kept to add and take away `join` (and `log_out`).
    menu: Menu,
    /// `JOIN_LABEL`: in the menu only while the machine has not joined the
    /// box — unpaired, or on a Mac logged out.
    join: MenuItem,
    join_shown: bool,
    /// "Log out": on a Mac, in the menu only while it is logged in.
    #[cfg(target_os = "macos")]
    log_out: MenuItem,
    #[cfg(target_os = "macos")]
    log_out_shown: bool,
    open_status: MenuItem,
    check_now: MenuItem,
    restart_claude: MenuItem,
    open_logs: MenuItem,
    open_claude_log: MenuItem,
    quit: MenuItem,
}

impl Ui {
    fn build(quit_label: &str) -> Result<Self> {
        let icons = Icons {
            ok: decode(ICON_OK)?,
            warn: decode(ICON_WARN)?,
            off: decode(ICON_OFF)?,
        };
        let title = MenuItem::new(format!("{DISPLAY_NAME} {VERSION}"), false, None);
        let line_hold = MenuItem::new("Awake hold: …", false, None);
        let line_update = MenuItem::new("Updates: …", false, None);
        let line_link = MenuItem::new("Controller: …", false, None);
        let line_tunnel = MenuItem::new("VPN: …", false, None);
        let line_key_own = MenuItem::new("This machine's key: …", false, None);
        let line_key_controller = MenuItem::new("Controller's key: …", false, None);
        let line_claude = MenuItem::new("Claude: …", false, None);
        let join = MenuItem::new(JOIN_LABEL, true, None);
        #[cfg(target_os = "macos")]
        let log_out = MenuItem::new("Log out", true, None);
        let open_status = MenuItem::new("Show status", true, None);
        let check_now = MenuItem::new("Check for updates now", true, None);
        let restart_claude = MenuItem::new("Restart Claude remote control", true, None);
        let open_logs = MenuItem::new("Open logs folder", true, None);
        let open_claude_log = MenuItem::new("Open Claude remote-control log", true, None);
        let quit = MenuItem::new(quit_label, true, None);

        let menu = Menu::new();
        menu.append_items(&[
            &title,
            &line_hold,
            &line_update,
            &line_link,
            &line_key_own,
            &line_key_controller,
            &line_claude,
            &PredefinedMenuItem::separator(),
            &open_status,
            &check_now,
            &restart_claude,
            &open_logs,
            &open_claude_log,
            &PredefinedMenuItem::separator(),
            &quit,
        ])
        .context("building the menu")?;

        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu.clone()))
            .with_tooltip(format!("{DISPLAY_NAME} {VERSION}"))
            .with_icon(icons.off.clone())
            .build()
            .context("creating the tray icon")?;

        Ok(Self {
            tray,
            icons,
            look: Look::Off,
            line_hold,
            line_update,
            line_link,
            line_tunnel,
            tunnel_shown: false,
            line_key_own,
            line_key_controller,
            line_claude,
            menu,
            join,
            join_shown: false,
            #[cfg(target_os = "macos")]
            log_out,
            #[cfg(target_os = "macos")]
            log_out_shown: false,
            open_status,
            check_now,
            restart_claude,
            open_logs,
            open_claude_log,
            quit,
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

    /// Reflect one read of the page (or its absence) and the supervisor's state.
    fn show(&mut self, page: Option<&Page>, claude: &Report, claude_wanted: bool) {
        let claude_line = claude_line(claude);
        self.line_claude.set_text(&claude_line);

        let Some(p) = page else {
            self.set_look(Look::Off);
            self.line_hold.set_text("Awake hold: service not answering");
            self.line_update.set_text("Updates: unknown");
            self.line_link.set_text("Controller: unknown");
            let _ = self.tray.set_tooltip(Some(format!(
                "{DISPLAY_NAME} {VERSION}\nService not answering\n{claude_line}"
            )));
            return;
        };

        let hold = if p.awake_hold {
            "Awake hold: on".to_string()
        } else if !p.policy.awake_hold {
            "Awake hold: off — the box lets this machine sleep".to_string()
        } else {
            match &p.hold_error {
                Some(e) => format!("Awake hold: OFF — {e}"),
                None => "Awake hold: OFF".to_string(),
            }
        };
        let update = update_line(p);
        self.line_hold.set_text(&hold);
        self.line_update.set_text(&update);
        let (link, own, theirs) = link_lines(p.controller.as_ref());
        // A log-in waiting for the browser says so where the link would.
        #[cfg(target_os = "macos")]
        let link = crate::os::tray::log_in_note().unwrap_or(link);
        self.line_link.set_text(&link);
        self.line_key_own.set_text(&own);
        self.line_key_controller.set_text(&theirs);
        self.show_tunnel(p.controller.as_ref().and_then(|l| l.tunnel.as_ref()));
        let link_bad = p.controller.as_ref().is_some_and(|l| {
            matches!(
                l.state.as_deref(),
                Some("key-changed" | "revoked" | "refused")
            )
        });
        // Not joined to the box: unpaired — on a Mac, no tunnel config (it
        // logs in rather than pairs, enroll.rs).
        let unpaired = if cfg!(target_os = "macos") {
            p.controller.as_ref().is_some_and(|l| l.tunnel.is_none())
        } else {
            p.controller
                .as_ref()
                .is_some_and(|l| l.state.as_deref() == Some("unpaired"))
        };
        self.show_join(unpaired);
        #[cfg(target_os = "macos")]
        self.show_log_out(p.controller.as_ref().is_some_and(|l| l.tunnel.is_some()));

        // The hold is a fault only when the box wants it; Claude, only when
        // it is wanted and not (yet) running.
        let hold_bad = !p.awake_hold && p.policy.awake_hold;
        let claude_bad = claude_wanted && !matches!(claude.state.as_str(), "running" | "starting");
        let short = if link_bad {
            "controller refused — see the menu"
        } else if unpaired {
            UNJOINED
        } else if hold_bad {
            "awake hold OFF"
        } else if p.restart_pending || p.update_available.is_some() {
            "update pending"
        } else if p.reinstall_required.is_some() {
            "a newer version needs a re-install — see the menu"
        } else if claude_bad {
            "Claude remote control not running"
        } else {
            "up to date"
        };
        let _ = self.tray.set_tooltip(Some(format!(
            "{DISPLAY_NAME} {}\n{short}\n{claude_line}",
            p.version
        )));

        let look = if link_bad
            || unpaired
            || hold_bad
            || p.update_available.is_some()
            || p.reinstall_required.is_some()
            || p.restart_pending
            || claude_bad
        {
            Look::Warn
        } else {
            Look::Ok
        };
        self.set_look(look);
    }

    /// Where the actions start: after the title, the lines (six, and the
    /// tunnel's when shown) and the separator.
    fn actions_at(&self) -> usize {
        8 + usize::from(self.tunnel_shown)
    }

    /// The tunnel's line, under the link's, while there is a tunnel.
    fn show_tunnel(&mut self, tunnel: Option<&crate::link::TunnelStatus>) {
        if let Some(t) = tunnel {
            self.line_tunnel.set_text(tunnel_line(t));
        }
        if tunnel.is_some() == self.tunnel_shown {
            return;
        }
        let done = if tunnel.is_some() {
            // The title, the awake hold, updates and the link come first.
            self.menu.insert(&self.line_tunnel, 4)
        } else {
            self.menu.remove(&self.line_tunnel)
        };
        if done.is_ok() {
            self.tunnel_shown = tunnel.is_some();
        }
    }

    /// The joining entry, just above "Show status", while unjoined.
    fn show_join(&mut self, unjoined: bool) {
        if unjoined == self.join_shown {
            return;
        }
        let done = if unjoined {
            self.menu.insert(&self.join, self.actions_at())
        } else {
            self.menu.remove(&self.join)
        };
        if done.is_ok() {
            self.join_shown = unjoined;
        }
    }

    /// "Log out", in the same place, while a Mac is logged in.
    #[cfg(target_os = "macos")]
    fn show_log_out(&mut self, logged_in: bool) {
        if logged_in == self.log_out_shown {
            return;
        }
        let done = if logged_in {
            self.menu.insert(&self.log_out, self.actions_at())
        } else {
            self.menu.remove(&self.log_out)
        };
        if done.is_ok() {
            self.log_out_shown = logged_in;
        }
    }
}

/// The entry that joins the box while the machine has not: a Mac logs in
/// (enroll.rs, os/macos/tray.rs `join`), every other machine pairs
/// (pair.rs, os/*/tray.rs `join`).
#[cfg(target_os = "macos")]
pub const JOIN_LABEL: &str = "Log in…";
#[cfg(not(target_os = "macos"))]
pub const JOIN_LABEL: &str = "Pair with the box…";
/// The tooltip's word for a machine that has not joined.
#[cfg(target_os = "macos")]
const UNJOINED: &str = "logged out — Log in… in the menu";
#[cfg(not(target_os = "macos"))]
const UNJOINED: &str = "not paired — Pair with the box… in the menu";

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
/// administrator prompt (a log-in's `enroll-finish`, os/macos/tray.rs).
/// The script is fixed; the binary and its arguments ride `argv` and each is
/// shell-quoted by AppleScript's `quoted form of`, so nothing the browser
/// sent is ever spliced into the script or the shell line. The binary comes
/// first: an absolute path, so osascript reads every word after it as an
/// argument, never an option.
#[cfg(any(test, target_os = "macos"))]
pub fn osascript_argv(exe: &std::path::Path, args: &[String]) -> Vec<std::ffi::OsString> {
    const SCRIPT: [&str; 7] = [
        "on run argv",
        "set cmd to quoted form of (item 1 of argv)",
        "repeat with a in (rest of argv)",
        "set cmd to cmd & \" \" & quoted form of (contents of a)",
        "end repeat",
        "do shell script cmd with prompt \"The daedalus agent logs this Mac in to the box.\" \
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

/// The link's three menu lines: where the machine stands with the
/// controller, and the two keys — this machine's and the controller's it
/// trusts, in full, so the operator can compare them with Settings ›
/// Machines before approving (link/node.rs).
fn link_lines(link: Option<&crate::session::LinkPage>) -> (String, String, String) {
    let Some(l) = link else {
        return (
            "Controller: not started yet".into(),
            "This machine's key: —".into(),
            "Controller's key: —".into(),
        );
    };
    let at = l.address.as_deref().unwrap_or("not found yet");
    let first = match (l.state.as_deref(), l.error.as_deref()) {
        (Some("unpaired"), _) => "Controller: not paired — connects to nothing until paired".into(),
        (Some("approved"), _) => format!("Controller: {at} — approved"),
        (Some("pending"), _) => {
            format!("Controller: {at} — waiting for approval; compare both keys")
        }
        (Some("revoked"), _) => format!("Controller: {at} — revoked by the box"),
        (Some("key-changed"), _) => format!("Controller: {at} — KEY CHANGED, refused"),
        (_, Some(e)) => format!("Controller: {at} — {e}"),
        (Some(s), None) => format!("Controller: {at} — {s}"),
        (None, None) => {
            "Controller: none found; set controller_address (install --controller)".into()
        }
    };
    let own = format!("This machine's key: {}", l.fingerprint);
    // The one it trusts is config.toml's pin (link/node.rs).
    let theirs = match (&l.controller_fingerprint, l.state.as_deref()) {
        (Some(fp), _) => format!("Controller's key: {fp} (pinned)"),
        (None, Some("unpaired")) => "Controller's key: none trusted yet".into(),
        (None, _) => "Controller's key: not seen yet".into(),
    };
    (first, own, theirs)
}

/// A session older than this without a new handshake is gone (WireGuard's
/// REJECT_AFTER_TIME); the tunnel's keepalive handshakes every two minutes.
const HANDSHAKE_STALE_SECS: u64 = 180;

/// The machine's own tunnel in one menu line (tunnel/): up or down, how
/// fresh its handshake is, where it goes — or what went wrong.
fn tunnel_line(t: &crate::link::TunnelStatus) -> String {
    match (&t.error, t.last_handshake_secs) {
        (Some(e), _) => format!("VPN: down — {e}"),
        (None, Some(s)) if s < HANDSHAKE_STALE_SECS => {
            format!("VPN: up · handshake {s} s ago · {}", t.endpoint)
        }
        (None, Some(s)) => format!("VPN: down · last handshake {s} s ago · {}", t.endpoint),
        (None, None) => format!("VPN: no handshake yet · {}", t.endpoint),
    }
}

/// One line for Claude Code, as the menu and the tooltip show it.
fn claude_line(r: &Report) -> String {
    let sessions = r.sessions.iter().filter(|s| s.alive).count();
    let version = r
        .server
        .version
        .as_deref()
        .or(r.cli_version.as_deref())
        .unwrap_or("");
    match r.state.as_str() {
        "running" => format!(
            "Claude: remote control running {version} · {sessions} session{}",
            if sessions == 1 { "" } else { "s" }
        ),
        "starting" => format!("Claude: remote control starting {version}"),
        "waiting" => format!(
            "Claude: remote control exited — {}",
            r.detail.as_deref().unwrap_or("retrying")
        ),
        "off" => "Claude: remote control off (the box's policy)".to_string(),
        "not-installed" => "Claude: Claude Code is not installed for this user".to_string(),
        // Only a tray that watches a session elsewhere (session::Watcher).
        "no-session" => "Claude: the session is not reporting".to_string(),
        other => format!("Claude: remote control {other}"),
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
        let ui = Ui::build(QUIT_LABEL)?;
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

    /// "Show status": the service's status document, as its local socket
    /// answers it, written to `status.json` in the tray's log directory and
    /// opened — there is no page to point a browser at.
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

    /// Every menu click since the last look.
    pub fn menu(&mut self) -> Flow {
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            let id = ev.id();
            #[cfg(target_os = "macos")]
            if *id == self.ui.log_out.id() {
                crate::os::tray::log_out();
                continue;
            }
            if *id == self.ui.join.id() {
                crate::os::tray::join();
            } else if *id == self.ui.open_status.id() {
                self.show_status();
            } else if *id == self.ui.check_now.id() {
                self.session.check_updates_now();
            } else if *id == self.ui.restart_claude.id() {
                self.session.restart_claude();
            } else if *id == self.ui.open_logs.id() {
                open(&self.logs.to_string_lossy());
            } else if *id == self.ui.open_claude_log.id() {
                open(&self.claude_log.to_string_lossy());
            } else if *id == self.ui.quit.id() {
                return Flow::Quit;
            }
        }
        Flow::Continue
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
    use crate::session::LinkPage;
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn a_release_to_re_install_says_so_instead_of_up_to_date() {
        use crate::session::Page;
        let checked = Page {
            last_update_result: Some("up to date".into()),
            last_update_check: Some("2026-09-30T10:00:00Z".into()),
            ..Page::default()
        };
        assert_eq!(update_line(&checked), "Updates: up to date · 10:00");
        let pending = Page {
            update_available: Some("0.23.1".into()),
            ..Page::default()
        };
        assert_eq!(update_line(&pending), "Updates: 0.23.1 available");
        let reinstall = Page {
            reinstall_required: Some(crate::update::ReinstallRequired {
                version: "0.24.0".into(),
            }),
            ..checked
        };
        assert_eq!(
            update_line(&reinstall),
            "Daedalus Agent 0.24.0 is available: re-install it from the website or with install.sh"
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
        let exe = Path::new("/Library/Application Support/daedalus-agent/bin/daedalus-agent");
        // What the callback brought back, as hostile as it may be.
        let code = "c0de'; rm -rf / # box.example.org";
        let a: Vec<String> = vec!["enroll-finish".into(), code.into()];
        let v = osascript_argv(exe, &a);
        let at = v.iter().position(|w| w == exe.as_os_str()).unwrap();
        assert_eq!(
            v[at + 1..],
            a.iter().map(OsString::from).collect::<Vec<_>>()
        );
        for pair in v[..at].chunks(2) {
            assert_eq!(pair[0], "-e");
            let line = pair[1].to_str().unwrap();
            assert!(
                !line.contains("rm -rf") && !line.contains("box.example"),
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

    #[test]
    fn the_tunnel_line_says_up_or_down_how_fresh_and_where() {
        let t = |error: Option<&str>, secs: Option<u64>| crate::link::TunnelStatus {
            endpoint: "box.example.org:51820".into(),
            error: error.map(String::from),
            last_handshake_secs: secs,
            ..Default::default()
        };
        assert_eq!(
            tunnel_line(&t(None, Some(12))),
            "VPN: up · handshake 12 s ago · box.example.org:51820"
        );
        assert_eq!(
            tunnel_line(&t(None, Some(600))),
            "VPN: down · last handshake 600 s ago · box.example.org:51820"
        );
        assert_eq!(
            tunnel_line(&t(None, None)),
            "VPN: no handshake yet · box.example.org:51820"
        );
        assert_eq!(
            tunnel_line(&t(Some("box.example.org:51820 does not resolve"), Some(12))),
            "VPN: down — box.example.org:51820 does not resolve"
        );
    }

    #[test]
    fn the_link_lines_show_both_keys_and_what_is_wrong() {
        assert!(link_lines(None).0.contains("not started"));
        let pending = LinkPage {
            address: Some("box.lan:7788".into()),
            state: Some("pending".into()),
            connected: true,
            fingerprint: "aaaa:bbbb".into(),
            controller_fingerprint: Some("cccc:dddd".into()),
            error: None,
            tunnel: None,
        };
        let (first, own, theirs) = link_lines(Some(&pending));
        assert_eq!(
            first,
            "Controller: box.lan:7788 — waiting for approval; compare both keys"
        );
        assert_eq!(own, "This machine's key: aaaa:bbbb");
        assert_eq!(theirs, "Controller's key: cccc:dddd (pinned)");
        let changed = LinkPage {
            state: Some("key-changed".into()),
            error: Some("controller key changed: …".into()),
            ..pending
        };
        assert!(link_lines(Some(&changed)).0.contains("KEY CHANGED"));
        let approved = LinkPage {
            state: Some("approved".into()),
            error: None,
            ..changed.clone()
        };
        let (first, _, _) = link_lines(Some(&approved));
        assert_eq!(first, "Controller: box.lan:7788 — approved");
        let nowhere = LinkPage {
            address: None,
            state: None,
            ..approved
        };
        assert!(link_lines(Some(&nowhere)).0.contains("controller_address"));
        let unpaired = LinkPage {
            state: Some("unpaired".into()),
            controller_fingerprint: None,
            connected: false,
            ..nowhere
        };
        let (first, _, theirs) = link_lines(Some(&unpaired));
        assert!(first.contains("not paired"), "{first}");
        assert_eq!(theirs, "Controller's key: none trusted yet");
    }
}
