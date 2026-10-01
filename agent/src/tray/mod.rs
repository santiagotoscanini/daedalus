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
//! a `Backing` (session.rs):
//!
//! - a `Session` (Windows, macOS): the tray runs the session — the Claude
//!   supervisor (claude/) — because this process is the one in the user's
//!   desktop session, with the user's Claude login. `claude remote-control`
//!   and the sessions it resumed are not its children but jobs of the OS
//!   (a launchd job, a detached process; jobs/), reported to the
//!   service every poll: quitting, updating or crashing the tray ends no
//!   Claude session, and the next tray re-attaches to them.
//! - a `Watcher` (Linux): the session is a systemd user unit that runs with
//!   or without a desktop, so Claude never waits on a login; the tray only
//!   shows it, through the service (`session::Watcher`), and its restart
//!   goes to the session by way of the service.
//!
//! Either way quitting the tray stops nothing but the tray: Claude remote
//! control and the service keep running.
//!
//! It also keeps itself current: when a poll sees the page report a
//! release above its own, an update has swapped the binaries under
//! it, and the tray restarts itself onto the new one. One instance at a
//! time, and the loop that drives all this, are the OS's
//! (os/windows/tray.rs: a named mutex and the Win32 message loop;
//! os/macos/tray.rs: a file lock and a tao event loop; os/linux/tray.rs: a
//! file lock and GTK's main loop).
//!
//! Where each part lives: this file is the `Tray` and its menu's clicks,
//! and the backing's thread (`Worker`); model.rs what each row says,
//! pure and tested; menu.rs the menu built and drawn; elevate.rs pairing
//! through the OS's administrator prompt.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tray_icon::menu::MenuEvent;

use crate::config;
use crate::local::LocalRequest;
use crate::os::tray::{open, relaunch_self};
use crate::paths;
use crate::session::{Backing, Places, Poll, Session, Tick, Watcher};
use crate::settings::Key;

pub mod elevate;
mod menu;
mod model;

use menu::*;
use model::*;

/// What a menu click asks of the backing's thread.
enum Ask {
    CheckUpdates,
    RestartClaude,
    /// `claude.update` through the service.
    UpdateClaude,
    /// A switch: the setting, and the value asked for (`settings.set`).
    Set(Key, bool),
    /// The status document, written into this directory and opened.
    ShowStatus(PathBuf),
}

/// What the backing's thread tells the tray.
enum Told {
    /// A poll, and whether the box wants the server running after it.
    Polled(Box<Poll>, bool),
    /// An update swapped the binary: the tray leaves for the new one.
    VersionChanged,
}

/// How often the backing's thread ticks when nothing is asked of it.
const TICK: Duration = Duration::from_millis(250);

/// The backing on a thread of its own. Everything it does can block — the
/// local socket's calls, and on Windows and macOS the session's
/// supervision of Claude's jobs (`launchctl`, `taskkill`, `security`, the
/// waits after a stop) — and the menu must never wait on any of it: the
/// tray's thread is the OS's UI loop (AppKit's, the Win32 message pump,
/// GTK's). A click becomes an `Ask` sent here; each poll comes back as a
/// `Told`, and the tray draws the latest. Dropped, it asks the thread to
/// end and gives it a moment to, so the session's lock is let go before a
/// new tray needs it.
struct Worker {
    asks: Sender<Ask>,
    told: Receiver<Told>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Worker {
    fn start(backing: Box<dyn Backing>) -> Result<Self> {
        let (asks, asked) = std::sync::mpsc::channel();
        let (tell, told) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("tray-session".into())
            .spawn(move || run_backing(backing, &asked, &tell))
            .context("no thread for the session")?;
        Ok(Self {
            asks,
            told,
            thread: Some(thread),
        })
    }

    fn ask(&self, a: Ask) {
        let _ = self.asks.send(a);
    }

    /// Everything the thread told since the last look: the newest poll,
    /// and whether the binary was replaced.
    fn drain(&self) -> (Option<(Box<Poll>, bool)>, bool) {
        let mut latest = None;
        let mut replaced = false;
        while let Ok(t) = self.told.try_recv() {
            match t {
                Told::Polled(p, wanted) => latest = Some((p, wanted)),
                Told::VersionChanged => replaced = true,
            }
        }
        (latest, replaced)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // A closed channel ends the thread's loop at its next look.
        let (closed, _) = std::sync::mpsc::channel();
        drop(std::mem::replace(&mut self.asks, closed));
        let Some(thread) = self.thread.take() else {
            return;
        };
        let until = std::time::Instant::now() + LEAVE_WAIT;
        while !thread.is_finished() && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        if thread.is_finished() {
            let _ = thread.join();
        }
    }
}

/// How long a leaving tray waits for its backing's thread to finish what
/// it is doing (a stop of Claude's job waits up to five seconds).
const LEAVE_WAIT: Duration = Duration::from_secs(10);

/// The backing's thread: each ask as it comes, a tick at least every
/// `TICK`, each poll told; it ends when the tray goes, or once the binary
/// was replaced (dropping the session, which leaves Claude running in its
/// jobs and lets its lock go).
fn run_backing(mut backing: Box<dyn Backing>, asked: &Receiver<Ask>, tell: &Sender<Told>) {
    loop {
        match asked.recv_timeout(TICK) {
            Ok(a) => answer(backing.as_mut(), a),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let told = match backing.tick() {
            Tick::Idle => continue,
            Tick::VersionChanged => {
                let _ = tell.send(Told::VersionChanged);
                return;
            }
            Tick::Polled(poll) => Told::Polled(poll, backing.claude_wanted()),
        };
        if tell.send(told).is_err() {
            return;
        }
    }
}

/// One click's work, on the backing's thread.
fn answer(backing: &mut dyn Backing, a: Ask) {
    match a {
        Ask::CheckUpdates => backing.check_updates_now(),
        Ask::RestartClaude => backing.restart_claude(),
        Ask::UpdateClaude => {
            let _ = crate::local::call::<String>(&LocalRequest::ClaudeUpdate);
            backing.poll_now();
        }
        Ask::Set(key, value) => {
            let answer = crate::local::call::<crate::local::SetAnswer>(&LocalRequest::SettingsSet(
                crate::local::SetParams { key, value },
            ));
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
            backing.poll_now();
        }
        Ask::ShowStatus(logs) => show_status(&logs),
    }
}

/// "Show status (JSON)": the service's status document, as its local
/// socket answers it, written to `status.json` in the tray's log
/// directory and opened — there is no page to point a browser at.
fn show_status(logs: &Path) {
    let text = match crate::local::call::<serde_json::Value>(&LocalRequest::Status) {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
        Err(e) => format!(
            "{{\"error\": {}}}",
            serde_json::Value::String(e.to_string())
        ),
    };
    let path = logs.join("status.json");
    if std::fs::create_dir_all(logs)
        .and_then(|()| {
            crate::util::write_atomic(&path, text.as_bytes(), crate::util::Access::Inherit)
        })
        .is_ok()
    {
        open(&path.to_string_lossy());
    }
}

/// The app this machine logged in to (config.toml's `app_url`), if any.
fn app_url() -> Option<String> {
    config::load_for_user().ok().and_then(|c| c.app_url)
}

/// What a tick or a menu click decided.
#[derive(PartialEq, Eq)]
pub enum Flow {
    Continue,
    Quit,
}

/// The tray between ticks: what it stands over (on its own thread, `Worker`),
/// the menu, and the two log paths the menu opens. The platform loops (os/*/tray.rs) drive it — Win32
/// messages on Windows, a tao event loop on macOS, GTK's on Linux — and it
/// knows nothing about any of them. Fields drop in order: an owned session
/// (its supervisor; the Claude jobs run on) before the icon.
pub struct Tray {
    session: Worker,
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
        let backing = if crate::os::TRAY_OWNS_SESSION {
            Box::new(Session::new(places)?) as Box<dyn Backing>
        } else {
            Box::new(Watcher::new())
        };
        let session = Worker::start(backing)?;
        Ok(Self {
            session,
            ui,
            logs,
            claude_log,
        })
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
    /// the click; the read puts the service's word back. All of it on the
    /// backing's thread (`answer`).
    fn ask(&mut self, key: Key) {
        if let Some(s) = &self.ui.settings {
            self.session.ask(Ask::Set(key, next_value(key, s)));
        }
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
                self.session.ask(Ask::CheckUpdates);
            } else if *id == ui.update_claude.id() {
                self.session.ask(Ask::UpdateClaude);
            } else if *id == ui.restart_claude.id() {
                self.session.ask(Ask::RestartClaude);
            } else if *id == ui.open_claude_log.id() {
                open(&self.claude_log.to_string_lossy());
            } else if *id == ui.open_status.id() {
                self.session.ask(Ask::ShowStatus(self.logs.clone()));
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

    /// Draw the newest poll the backing's thread told, if one came since
    /// the last look; never waits on it. Quit means an update swapped the
    /// binary and we are leaving for the new one — on Windows and Linux by
    /// starting it first (`os::tray::relaunch_self`); under launchd, leaving
    /// is enough, as KeepAlive starts it. Claude runs on untouched in its
    /// jobs, and the new tray re-attaches to them.
    pub fn tick(&mut self) -> Flow {
        let (latest, replaced) = self.session.drain();
        if replaced {
            relaunch_self();
            return Flow::Quit;
        }
        if let Some((poll, claude_wanted)) = latest {
            self.ui
                .show(poll.page.as_ref(), &poll.report, claude_wanted);
        }
        Flow::Continue
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
mod tests;
