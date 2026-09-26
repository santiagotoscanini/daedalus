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
//! It is also the Claude supervisor (claude/): this process is the one in
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

use crate::claude::{Report, ReportAnswer, Supervisor};
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
/// update costs a session on this machine. Under launchd, leaving is
/// enough: KeepAlive starts the new binary.
fn relaunch_self() {
    #[cfg(windows)]
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).spawn();
    }
}

/// What a tick or a menu click decided.
#[derive(PartialEq, Eq)]
enum Flow {
    Continue,
    Quit,
}

/// The tray's state between ticks: the supervisor, the menu, and when to
/// look at the page next. The platform loops below drive it — Win32
/// messages on Windows, a tao event loop on macOS — and it knows nothing
/// about either.
struct Session {
    port: u16,
    logs: PathBuf,
    claude_log: PathBuf,
    sup: Supervisor,
    ui: Ui,
    next_poll: Instant,
    cfg_workdir: Option<String>,
}

impl Session {
    fn start() -> Result<Self> {
        let cfg = config::load_or_default()?;
        let logs: PathBuf = config::user_log_dir();
        let claude_log = logs.join("claude-rc.log");
        let ui = Ui::build()?;
        // The Claude server, in this session with this user's login. Wanted by
        // the config until the service relays the box's policy; run in the
        // directory the config names, else the most recent trusted project.
        let sup = Supervisor::new(
            cfg.claude_workdir.clone(),
            claude_log.clone(),
            cfg.claude_remote_control,
        );
        Ok(Self {
            port: cfg.port,
            logs,
            claude_log,
            sup,
            ui,
            next_poll: Instant::now(),
            cfg_workdir: cfg.claude_workdir,
        })
    }

    /// Every menu click since the last look.
    fn menu(&mut self) -> Flow {
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            let id = ev.id();
            if *id == self.ui.open_status.id() {
                open(&format!("http://127.0.0.1:{}/status", self.port));
            } else if *id == self.ui.check_now.id() {
                request_check(self.port);
                self.next_poll = Instant::now() + Duration::from_secs(2);
            } else if *id == self.ui.restart_claude.id() {
                self.sup.restart();
                self.next_poll = Instant::now() + Duration::from_secs(1);
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

    /// Advance the supervisor and, when due, read the page, report, and
    /// redraw. Quit means an update swapped the binary and we are leaving
    /// for the new one.
    fn tick(&mut self) -> Flow {
        self.sup.tick();
        if Instant::now() < self.next_poll {
            return Flow::Continue;
        }
        let page = read_page(self.port);
        if let Some(p) = &page {
            if p.version != VERSION && !p.restart_pending {
                relaunch_self();
                return Flow::Quit;
            }
        }
        self.sup.tick();
        let report = self.sup.report();
        if let Some(answer) = send_report(self.port, &report) {
            self.sup
                .set_named_workdir(answer.workdir.or_else(|| self.cfg_workdir.clone()));
            self.sup.set_wanted(answer.wanted);
            // Update before restart, so a tick carrying both lands the new
            // binary first and the server comes back up on it. The update
            // runs on its own thread (claude/) — inline it would freeze
            // this loop for minutes, and this loop is the only thing that
            // reports to the service.
            if answer.update {
                self.sup.update_claude();
            }
            if answer.restart {
                self.sup.restart();
            }
        }
        self.ui.show(page.as_ref(), &report, self.sup.wanted());
        self.next_poll = Instant::now() + POLL;
        Flow::Continue
    }
}

#[cfg(windows)]
mod platform {
    use super::*;

    /// Refuse to be the second tray. The mutex lives as long as the process.
    ///
    /// Tried for up to ten seconds: after an update the OLD tray spawns us and
    /// then leaves, and its leaving first stops the Claude server it
    /// supervised — a second or two during which its mutex is still held. A
    /// single check here quit the new tray on that overlap and left the
    /// machine with no tray until the next login.
    pub fn claim_single_instance() -> bool {
        use windows::core::w;
        use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
        use windows::Win32::System::Threading::CreateMutexW;
        for _ in 0..40 {
            // SAFETY: plain Win32 calls; on success the handle is intentionally
            // leaked so the mutex outlives this function and is released when
            // the process ends. A losing attempt closes its handle so the
            // winner's mutex is not kept alive by us.
            unsafe {
                let h = CreateMutexW(None, false, w!("Local\\daedalus-agent-tray"));
                if GetLastError() != ERROR_ALREADY_EXISTS {
                    return true;
                }
                if let Ok(h) = h {
                    let _ = CloseHandle(h);
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        false
    }

    /// Open a URL or a folder through Explorer, which needs no console and
    /// hands a URL to the default browser.
    pub fn open(target: &str) {
        let _ = std::process::Command::new("explorer.exe")
            .arg(target)
            .spawn();
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

    /// Wait up to `timeout` for input on this thread's queue, so the loop
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
        let mut s = Session::start()?;
        loop {
            if !pump() {
                return Ok(());
            }
            if s.menu() == Flow::Quit || s.tick() == Flow::Quit {
                return Ok(());
            }
            wait_for_input(Duration::from_millis(250));
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use tao::event::{Event, StartCause};
    use tao::event_loop::{ControlFlow, EventLoop};
    use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

    /// One tray per user: a lock on a file in the user's log directory,
    /// held for the life of the process.
    pub fn claim_single_instance() -> bool {
        use std::os::fd::AsRawFd;
        let dir = config::user_log_dir();
        let _ = std::fs::create_dir_all(&dir);
        let Ok(f) = std::fs::File::create(dir.join("tray.lock")) else {
            return true;
        };
        // SAFETY: flock on a file we own; the descriptor is leaked on purpose.
        let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        std::mem::forget(f);
        rc == 0
    }

    /// `open` hands a URL to the default browser and a folder to Finder.
    pub fn open(target: &str) {
        let _ = std::process::Command::new("open").arg(target).spawn();
    }

    /// Quit means quit: launchd would otherwise start us again within
    /// seconds, so the job is booted out of this login session (it returns
    /// at the next).
    fn bootout() {
        // SAFETY: no arguments.
        let uid = unsafe { libc::getuid() };
        let _ = std::process::Command::new("launchctl")
            .args([
                "bootout",
                &format!("gui/{uid}/{}", crate::launchd::TRAY_LABEL),
            ])
            .spawn();
    }

    pub fn run() -> Result<()> {
        if !claim_single_instance() {
            return Ok(());
        }
        // AppKit wants the event loop on the main thread and the tray made
        // once it runs; as an accessory the process has no Dock icon.
        let mut event_loop = EventLoop::new();
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
        let mut session: Option<Session> = None;
        event_loop.run(move |event, _, control_flow| {
            if let Event::NewEvents(StartCause::Init) = event {
                match Session::start() {
                    Ok(s) => session = Some(s),
                    Err(e) => {
                        // `run` never returns, so the reason is written where
                        // the bin would have written it.
                        let dir = config::user_log_dir();
                        let _ = std::fs::create_dir_all(&dir);
                        let _ = std::fs::write(dir.join("tray.err"), format!("{e:#}\n"));
                        *control_flow = ControlFlow::Exit;
                        return;
                    }
                }
            }
            let Some(s) = session.as_mut() else {
                *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));
                return;
            };
            let menu = s.menu();
            if menu == Flow::Quit {
                bootout();
                *control_flow = ControlFlow::Exit;
                return;
            }
            if s.tick() == Flow::Quit {
                // Leaving on a version change; launchd starts the new binary.
                *control_flow = ControlFlow::Exit;
                return;
            }
            *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));
        });
    }
}

use platform::open;

pub fn run() -> Result<()> {
    platform::run()
}
