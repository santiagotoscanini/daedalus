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

struct Ui {
    tray: TrayIcon,
    icons: Icons,
    look: Look,
    line_hold: MenuItem,
    line_update: MenuItem,
    line_link: MenuItem,
    line_key_own: MenuItem,
    line_key_controller: MenuItem,
    line_claude: MenuItem,
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
        let line_key_own = MenuItem::new("This machine's key: …", false, None);
        let line_key_controller = MenuItem::new("Controller's key: …", false, None);
        let line_claude = MenuItem::new("Claude: …", false, None);
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
            .with_menu(Box::new(menu))
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
            line_key_own,
            line_key_controller,
            line_claude,
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
        let update = match (&p.update_available, p.restart_pending) {
            (_, true) => "Updates: installed, restarting".to_string(),
            (Some(v), _) => format!("Updates: {v} available"),
            (None, _) => match (&p.last_update_result, &p.last_update_check) {
                (Some(r), Some(t)) => format!("Updates: {r} · {}", clock(t)),
                (Some(r), None) => format!("Updates: {r}"),
                _ => "Updates: not checked yet".to_string(),
            },
        };
        self.line_hold.set_text(&hold);
        self.line_update.set_text(&update);
        let (link, own, theirs) = link_lines(p.controller.as_ref());
        self.line_link.set_text(&link);
        self.line_key_own.set_text(&own);
        self.line_key_controller.set_text(&theirs);
        let link_bad = p.controller.as_ref().is_some_and(|l| {
            matches!(
                l.state.as_deref(),
                Some("key-changed" | "revoked" | "refused")
            )
        });
        // A first-use key nothing confirmed: prominent, not an alarm.
        let link_unconfirmed = p
            .controller
            .as_ref()
            .is_some_and(|l| l.unconfirmed && l.controller_fingerprint.is_some());

        // The hold is a fault only when the box wants it; Claude, only when
        // it is wanted and not (yet) running.
        let hold_bad = !p.awake_hold && p.policy.awake_hold;
        let claude_bad = claude_wanted && !matches!(claude.state.as_str(), "running" | "starting");
        let short = if link_bad {
            "controller refused — see the menu"
        } else if hold_bad {
            "awake hold OFF"
        } else if p.update_available.is_some() || p.restart_pending {
            "update pending"
        } else if claude_bad {
            "Claude remote control not running"
        } else if link_unconfirmed {
            "controller trusted on first use, unconfirmed"
        } else {
            "up to date"
        };
        let _ = self.tray.set_tooltip(Some(format!(
            "{DISPLAY_NAME} {}\n{short}\n{claude_line}",
            p.version
        )));

        let look = if link_bad
            || hold_bad
            || p.update_available.is_some()
            || p.restart_pending
            || claude_bad
            || link_unconfirmed
        {
            Look::Warn
        } else {
            Look::Ok
        };
        self.set_look(look);
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
    let theirs = match (&l.controller_fingerprint, &l.pinned_via) {
        (Some(fp), _) if l.unconfirmed => {
            format!("Controller's key: {fp} (trusted on first use, UNCONFIRMED: pin it)")
        }
        (Some(fp), Some(via)) => format!("Controller's key: {fp} (trusted via {via})"),
        (Some(fp), None) => format!("Controller's key: {fp}"),
        (None, _) => "Controller's key: not seen yet".into(),
    };
    (first, own, theirs)
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
        let cfg = config::load_or_default()?;
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
            .and_then(|()| std::fs::write(&path, text))
            .is_ok()
        {
            open(&path.to_string_lossy());
        }
    }

    /// Every menu click since the last look.
    pub fn menu(&mut self) -> Flow {
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            let id = ev.id();
            if *id == self.ui.open_status.id() {
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
    let _ = std::fs::write(dir.join("tray.err"), format!("{e:#}\n"));
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

    #[test]
    fn the_link_lines_show_both_keys_and_what_is_wrong() {
        assert!(link_lines(None).0.contains("not started"));
        let pending = LinkPage {
            address: Some("box.lan:7788".into()),
            state: Some("pending".into()),
            connected: true,
            fingerprint: "aaaa:bbbb".into(),
            controller_fingerprint: Some("cccc:dddd".into()),
            pinned_via: Some("config".into()),
            unconfirmed: false,
            error: None,
        };
        let (first, own, theirs) = link_lines(Some(&pending));
        assert_eq!(
            first,
            "Controller: box.lan:7788 — waiting for approval; compare both keys"
        );
        assert_eq!(own, "This machine's key: aaaa:bbbb");
        assert_eq!(theirs, "Controller's key: cccc:dddd (trusted via config)");
        let changed = LinkPage {
            state: Some("key-changed".into()),
            error: Some("controller key changed: …".into()),
            ..pending
        };
        assert!(link_lines(Some(&changed)).0.contains("KEY CHANGED"));
        let tofu = LinkPage {
            state: Some("approved".into()),
            error: None,
            pinned_via: Some("tofu".into()),
            unconfirmed: true,
            ..changed.clone()
        };
        let (first, _, theirs) = link_lines(Some(&tofu));
        assert_eq!(first, "Controller: box.lan:7788 — approved");
        assert!(theirs.contains("UNCONFIRMED"), "{theirs}");
        let nowhere = LinkPage {
            address: None,
            state: None,
            ..tofu
        };
        assert!(link_lines(Some(&nowhere)).0.contains("controller_address"));
    }
}
