//! The tray icon: the daedalus mark in the taskbar's corner, showing what
//! the service reports.
//!
//! A separate, windowless program in the desktop session, because the
//! service runs in session 0 where there is no taskbar to draw on. It reads
//! the status page on loopback every few seconds and reflects it: the icon
//! (ember when the hold is on, an amber dot when something wants attention,
//! grey when the service does not answer), the tooltip, and a menu whose
//! first lines are the state and whose rest are the few things worth a
//! click — the status page, a check for updates, the log folder.
//!
//! It is also the Claude supervisor (claude.rs): this process is the one in
//! the user's session, with the user's Claude login, so `claude
//! remote-control` runs as its child. Every poll it sends the service a
//! report of that and reads back the box's policy — run it or not — and
//! the one instruction, restart. The service, in session 0, could do
//! neither.
//!
//! It also keeps itself current: when the page reports a version other than
//! its own, an update has swapped the binaries under it, and it restarts
//! itself onto the new one. One instance at a time, through a named mutex.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Deserialize;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use crate::claude::{self, Report, ReportAnswer, Supervisor};
use crate::hello::Policy;
use crate::{config, DISPLAY_NAME, VERSION};

const POLL: Duration = Duration::from_secs(5);
const ICON_OK: &[u8] = include_bytes!("../assets/tray-ok.png");
const ICON_WARN: &[u8] = include_bytes!("../assets/tray-warn.png");
const ICON_OFF: &[u8] = include_bytes!("../assets/tray-off.png");

/// The part of the status page the tray reads. Everything else it ignores.
#[derive(Deserialize, Default)]
struct Page {
    version: String,
    awake_hold: bool,
    hold_error: Option<String>,
    update_available: Option<String>,
    restart_pending: bool,
    last_update_check: Option<String>,
    last_update_result: Option<String>,
    #[serde(default)]
    control_plane: Box_,
    #[serde(default)]
    policy: Policy,
}

/// The box, as the page reports it.
#[derive(Deserialize, Default)]
struct Box_ {
    url: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

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

/// Refuse to be the second tray. The mutex lives as long as the process.
fn claim_single_instance() -> bool {
    use windows::core::w;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    // SAFETY: plain Win32 call; the handle is intentionally leaked so the
    // mutex outlives this function and is released when the process ends.
    unsafe {
        let _ = CreateMutexW(None, false, w!("Local\\daedalus-agent-tray"));
        GetLastError() != ERROR_ALREADY_EXISTS
    }
}

fn read_page(port: u16) -> Option<Page> {
    ureq::get(&format!("http://127.0.0.1:{port}/status"))
        .timeout(Duration::from_secs(2))
        .call()
        .ok()?
        .into_json()
        .ok()
}

fn request_check(port: u16) {
    let _ = ureq::post(&format!("http://127.0.0.1:{port}/update/check"))
        .timeout(Duration::from_secs(2))
        .call();
}

/// Open a URL or a folder through Explorer, which needs no console and
/// hands a URL to the default browser.
fn open(target: &str) {
    let _ = std::process::Command::new("explorer.exe")
        .arg(target)
        .spawn();
}

/// Time of day from an RFC 3339 UTC stamp, in the machine's local clock is
/// more than this tray needs; the UTC hour and minute say "recent" well
/// enough beside the date-less menu.
fn clock(ts: &str) -> &str {
    ts.get(11..16).unwrap_or(ts)
}

struct Ui {
    tray: TrayIcon,
    icons: Icons,
    look: Look,
    line_hold: MenuItem,
    line_update: MenuItem,
    line_box: MenuItem,
    line_claude: MenuItem,
    open_status: MenuItem,
    check_now: MenuItem,
    restart_claude: MenuItem,
    open_logs: MenuItem,
    open_claude_log: MenuItem,
    quit: MenuItem,
}

impl Ui {
    fn build() -> Result<Self> {
        let icons = Icons {
            ok: decode(ICON_OK)?,
            warn: decode(ICON_WARN)?,
            off: decode(ICON_OFF)?,
        };
        let title = MenuItem::new(format!("{DISPLAY_NAME} {VERSION}"), false, None);
        let line_hold = MenuItem::new("Awake hold: …", false, None);
        let line_update = MenuItem::new("Updates: …", false, None);
        let line_box = MenuItem::new("Box: …", false, None);
        let line_claude = MenuItem::new("Claude: …", false, None);
        let open_status = MenuItem::new("Open status page", true, None);
        let check_now = MenuItem::new("Check for updates now", true, None);
        let restart_claude = MenuItem::new("Restart Claude remote control", true, None);
        let open_logs = MenuItem::new("Open logs folder", true, None);
        let open_claude_log = MenuItem::new("Open Claude remote-control log", true, None);
        let quit = MenuItem::new(
            "Quit tray (stops Claude remote control; the service keeps running)",
            true,
            None,
        );

        let menu = Menu::new();
        menu.append_items(&[
            &title,
            &line_hold,
            &line_update,
            &line_box,
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
            line_box,
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
            self.line_box.set_text("Box: unknown");
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
        let host = p.control_plane.url.as_deref().map(|u| {
            u.trim_start_matches("https://")
                .trim_start_matches("http://")
                .to_string()
        });
        let box_line = match (
            p.control_plane.state.as_deref(),
            host,
            &p.control_plane.error,
        ) {
            (Some("approved"), Some(h), _) => format!("Box: approved by {h}"),
            (Some("pending"), Some(h), _) => format!("Box: {h} — waiting for approval"),
            (Some("revoked"), Some(h), _) => format!("Box: {h} — revoked"),
            (_, _, Some(e)) => format!("Box: {e}"),
            _ => "Box: looking…".to_string(),
        };
        self.line_box.set_text(&box_line);

        // The hold is a fault only when the box wants it; Claude, only when
        // it is wanted and not (yet) running.
        let hold_bad = !p.awake_hold && p.policy.awake_hold;
        let claude_bad = claude_wanted && !matches!(claude.state.as_str(), "running" | "starting");
        let short = if hold_bad {
            "awake hold OFF"
        } else if p.update_available.is_some() || p.restart_pending {
            "update pending"
        } else if claude_bad {
            "Claude remote control not running"
        } else {
            "up to date"
        };
        let _ = self.tray.set_tooltip(Some(format!(
            "{DISPLAY_NAME} {}\n{short}\n{claude_line}",
            p.version
        )));

        let look = if hold_bad || p.update_available.is_some() || p.restart_pending || claude_bad {
            Look::Warn
        } else {
            Look::Ok
        };
        self.set_look(look);
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
        other => format!("Claude: remote control {other}"),
    }
}

/// Send the supervisor's report to the service; its answer says whether the
/// box wants the server running and whether to restart it now.
fn send_report(port: u16, report: &Report) -> Option<ReportAnswer> {
    ureq::post(&format!("http://127.0.0.1:{port}/claude/report"))
        .timeout(Duration::from_secs(2))
        .send_json(serde_json::to_value(report).ok()?)
        .ok()?
        .into_json()
        .ok()
}

/// Start this same program again from its path and leave. Used when the
/// service reports a version other than ours: the file under our feet is a
/// newer one by then. The supervisor is dropped with us, so the Claude
/// server restarts under the new tray — the one interruption an agent
/// update costs a session on this machine.
fn relaunch_self() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).spawn();
    }
}

/// Pump the Win32 message queue until it is empty; the tray and its menu
/// are windows on this thread and need it.
fn pump() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE, WM_QUIT,
    };
    let mut msg = MSG::default();
    // SAFETY: standard message loop on the thread that owns the windows.
    unsafe {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            if msg.message == WM_QUIT {
                return false;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    true
}

/// Wait up to `timeout` for input on this thread's queue, so the loop below
/// idles instead of spinning.
fn wait_for_input(timeout: Duration) {
    use windows::Win32::UI::WindowsAndMessaging::{MsgWaitForMultipleObjects, QS_ALLINPUT};
    // SAFETY: no handles, just the queue with a timeout.
    unsafe {
        let _ = MsgWaitForMultipleObjects(None, false, timeout.as_millis() as u32, QS_ALLINPUT);
    }
}

pub fn run() -> Result<()> {
    if !claim_single_instance() {
        return Ok(());
    }
    let cfg = config::load_or_default()?;
    let port = cfg.port;
    let logs: PathBuf = config::log_dir();
    let claude_log = logs.join("claude-rc.log");
    let mut ui = Ui::build()?;

    // The Claude server, in this session with this user's login. Wanted by
    // the config until the service relays the box's policy.
    let workdir = cfg
        .claude_workdir
        .as_deref()
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(claude::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut sup = Supervisor::new(workdir, claude_log.clone(), cfg.claude_remote_control);

    let mut next_poll = Instant::now();
    loop {
        if !pump() {
            return Ok(());
        }
        sup.tick();
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            let id = ev.id();
            if *id == ui.open_status.id() {
                open(&format!("http://127.0.0.1:{port}/status"));
            } else if *id == ui.check_now.id() {
                request_check(port);
                next_poll = Instant::now() + Duration::from_secs(2);
            } else if *id == ui.restart_claude.id() {
                sup.restart();
                next_poll = Instant::now() + Duration::from_secs(1);
            } else if *id == ui.open_logs.id() {
                open(&logs.to_string_lossy());
            } else if *id == ui.open_claude_log.id() {
                open(&claude_log.to_string_lossy());
            } else if *id == ui.quit.id() {
                return Ok(());
            }
        }
        if Instant::now() >= next_poll {
            let page = read_page(port);
            if let Some(p) = &page {
                if p.version != VERSION && !p.restart_pending {
                    relaunch_self();
                    return Ok(());
                }
            }
            sup.tick();
            let report = sup.report();
            if let Some(answer) = send_report(port, &report) {
                sup.set_wanted(answer.wanted);
                if answer.restart {
                    sup.restart();
                }
            }
            ui.show(page.as_ref(), &report, sup.wanted());
            next_poll = Instant::now() + POLL;
        }
        wait_for_input(Duration::from_millis(250));
    }
}
