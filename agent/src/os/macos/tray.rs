//! The menu bar app's macOS side: one instance per user (a file lock), the
//! tao event loop AppKit requires, which drives `tray::Tray`, `open` as the
//! opener, leaving through launchd, and logging in and out (enroll.rs) —
//! AppleScript's dialogs through osascript, each on a thread of its own.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

use crate::enroll::{Begin, Loopback, Outcome, LOG_IN_TIMEOUT};
use crate::paths;
use crate::tray::{write_failure, Flow, Tray};
use crate::util::LockExt;

/// One tray per user: a lock on a file in the user's log directory,
/// held for the life of the process.
fn claim_single_instance() -> bool {
    use std::os::fd::AsRawFd;
    let dir = paths::user_log_dir();
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

/// Under launchd, leaving is enough: KeepAlive starts the new binary.
pub fn relaunch_self() {}

/// Quit means quit: launchd would otherwise start us again within
/// seconds, so the job is booted out of this login session (it returns
/// at the next).
fn bootout() {
    // SAFETY: no arguments.
    let uid = unsafe { libc::getuid() };
    let _ = std::process::Command::new("launchctl")
        .args([
            "bootout",
            &format!("gui/{uid}/{}", super::launchd::TRAY_LABEL),
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
    let mut tray: Option<Tray> = None;
    event_loop.run(move |event, _, control_flow| {
        if let Event::NewEvents(StartCause::Init) = event {
            match Tray::start() {
                Ok(t) => tray = Some(t),
                Err(e) => {
                    // `run` never returns, so the reason is written where
                    // the bin would have written it.
                    write_failure(&e);
                    *control_flow = ControlFlow::Exit;
                    return;
                }
            }
        }
        let Some(t) = tray.as_mut() else {
            *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));
            return;
        };
        let menu = t.menu();
        if menu == Flow::Quit {
            bootout();
            *control_flow = ControlFlow::Exit;
            return;
        }
        if t.tick() == Flow::Quit {
            // Leaving on a version change; launchd starts the new binary.
            *control_flow = ControlFlow::Exit;
            return;
        }
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));
    });
}

// ── logging in and out (enroll.rs) ────────────────────────────────────────

/// What the menu shows in the link's place while a log-in waits for the
/// browser: this Mac's fingerprint, to compare with the app's page.
static NOTE: Mutex<Option<String>> = Mutex::new(None);
/// One log-in or log-out at a time.
static BUSY: AtomicBool = AtomicBool::new(false);

const TITLE: &str = "Daedalus";

/// The note for the menu (tray.rs), while a log-in waits.
pub fn log_in_note() -> Option<String> {
    NOTE.lock_ok().clone()
}

/// Run `work` on a thread of its own — the dialogs and the browser wait on
/// a person, and the tray's loop never does — and show what it said. One at
/// a time: a click while one runs does nothing.
fn one_at_a_time(name: &str, work: fn() -> Result<Option<String>, String>) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            match work() {
                Ok(Some(said)) => tell(&said, true),
                Ok(None) => {}
                Err(e) => tell(&e, false),
            }
            *NOTE.lock_ok() = None;
            BUSY.store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// "Log in…" (enroll.rs): the app's address asked for (the last one
/// offered), a log-in begun with the service (this Mac's key, a PKCE
/// challenge), the app's page opened on it, the callback taken on loopback,
/// then the code handed to the service — as root, behind the administrator
/// prompt — which redeems it and links through the tunnel.
pub fn join() {
    one_at_a_time("log-in", log_in);
}

fn log_in() -> Result<Option<String>, String> {
    let last = crate::config::load_for_user()
        .ok()
        .and_then(|c| c.app_url)
        .unwrap_or_default();
    let Some(typed) = osascript(
        "text returned of (display dialog (item 1 of argv) with title (item 2 of argv) \
         default answer (item 3 of argv) buttons {\"Cancel\", \"Continue\"} \
         default button \"Continue\" cancel button \"Cancel\")",
        &[
            "The address of your Daedalus app (https://…). The page that opens asks an \
             admin to confirm this Mac.",
            TITLE,
            &last,
        ],
    ) else {
        return Ok(None);
    };
    let begin: Begin =
        crate::local::call_as("enroll.begin", serde_json::json!({ "app_url": typed }))
            .map_err(|e| format!("Not logged in: {e}"))?;
    let loopback = Loopback::new().map_err(|e| format!("Not logged in: {e}"))?;
    *NOTE.lock_ok() = Some(format!(
        "Confirm in your browser — this Mac is {}",
        begin.fingerprint
    ));
    open(&loopback.url(&begin));
    let code = match loopback.wait(LOG_IN_TIMEOUT) {
        Ok(Outcome::Code(c)) => c,
        Ok(Outcome::Denied) => return Err("Not logged in: declined on the app's page.".into()),
        Err(e) => return Err(format!("Not logged in: {e}")),
    };
    *NOTE.lock_ok() = Some("Logging in — confirm with this Mac's password".into());
    let exe = crate::tray::agent_exe()?;
    let out = std::process::Command::new("/usr/bin/osascript")
        .args(crate::tray::osascript_argv(
            &exe,
            &["enroll-finish".to_string(), code],
        ))
        .output()
        .map_err(|e| format!("could not start osascript: {e}"))?;
    if out.status.success() {
        let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Ok(Some(if said.is_empty() {
            "Logged in.".into()
        } else {
            said
        }));
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if err.contains("-128") {
        return Err("Not logged in: cancelled at the administrator prompt.".into());
    }
    Err(format!("Not logged in: {err}"))
}

/// "Log out": asked once, then the service logs this Mac out (enroll.rs
/// `leave`: the box told — the app deletes the Mac's wg-easy client — the
/// tunnel and its config gone).
pub fn log_out() {
    one_at_a_time("log-out", || {
        let asked = osascript(
            "display dialog (item 1 of argv) with title (item 2 of argv) buttons \
             {\"Cancel\", \"Log out\"} default button \"Cancel\" cancel button \"Cancel\"",
            &[
                "Log this Mac out of Daedalus? It stops reaching the box until it logs in \
                 again, which an admin confirms.",
                TITLE,
            ],
        );
        if asked.is_none() {
            return Ok(None);
        }
        crate::local::call_within(
            "enroll.leave",
            serde_json::Value::Null,
            crate::local::ENROLL_DEADLINE,
        )
        .map(|v| v.as_str().map(str::to_string))
        .map_err(|e| format!("Not logged out: {e}"))
    });
}

/// osascript with a fixed script and its words as `argv`, never spliced in;
/// None on Cancel (error -128) or any failure.
fn osascript(script: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", "on run argv", "-e", script, "-e", "end run"])
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn tell(text: &str, ok: bool) {
    let icon = if ok { "note" } else { "caution" };
    let _ = osascript(
        &format!(
            "display dialog (item 1 of argv) with title (item 2 of argv) buttons {{\"OK\"}} \
             default button \"OK\" with icon {icon}"
        ),
        &[text, TITLE],
    );
}
