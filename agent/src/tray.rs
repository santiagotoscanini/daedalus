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
//! It also keeps itself current: when the page reports a version other than
//! its own, an update has swapped the binaries under it, and it restarts
//! itself onto the new one. One instance at a time, through a named mutex.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Deserialize;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

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
    open_status: MenuItem,
    check_now: MenuItem,
    open_logs: MenuItem,
    hide: MenuItem,
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
        let open_status = MenuItem::new("Open status page", true, None);
        let check_now = MenuItem::new("Check for updates now", true, None);
        let open_logs = MenuItem::new("Open logs folder", true, None);
        let hide = MenuItem::new("Hide icon (the service keeps running)", true, None);

        let menu = Menu::new();
        menu.append_items(&[
            &title,
            &line_hold,
            &line_update,
            &line_box,
            &PredefinedMenuItem::separator(),
            &open_status,
            &check_now,
            &open_logs,
            &PredefinedMenuItem::separator(),
            &hide,
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
            open_status,
            check_now,
            open_logs,
            hide,
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

    /// Reflect one read of the page (or its absence).
    fn show(&mut self, page: Option<&Page>) {
        let Some(p) = page else {
            self.set_look(Look::Off);
            self.line_hold.set_text("Awake hold: service not answering");
            self.line_update.set_text("Updates: unknown");
            self.line_box.set_text("Box: unknown");
            let _ = self.tray.set_tooltip(Some(format!(
                "{DISPLAY_NAME} {VERSION}\nService not answering"
            )));
            return;
        };

        let hold = if p.awake_hold {
            "Awake hold: on".to_string()
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

        let short = if !p.awake_hold {
            "awake hold OFF"
        } else if p.update_available.is_some() || p.restart_pending {
            "update pending"
        } else {
            "awake hold on · up to date"
        };
        let _ = self
            .tray
            .set_tooltip(Some(format!("{DISPLAY_NAME} {}\n{short}", p.version)));

        let look = if !p.awake_hold || p.update_available.is_some() || p.restart_pending {
            Look::Warn
        } else {
            Look::Ok
        };
        self.set_look(look);
    }
}

/// Start this same program again from its path and leave. Used when the
/// service reports a version other than ours: the file under our feet is a
/// newer one by then.
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
    let mut ui = Ui::build()?;

    let mut next_poll = Instant::now();
    loop {
        if !pump() {
            return Ok(());
        }
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            let id = ev.id();
            if *id == ui.open_status.id() {
                open(&format!("http://127.0.0.1:{port}/status"));
            } else if *id == ui.check_now.id() {
                request_check(port);
                next_poll = Instant::now() + Duration::from_secs(2);
            } else if *id == ui.open_logs.id() {
                open(&logs.to_string_lossy());
            } else if *id == ui.hide.id() {
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
            ui.show(page.as_ref());
            next_poll = Instant::now() + POLL;
        }
        wait_for_input(Duration::from_millis(250));
    }
}
