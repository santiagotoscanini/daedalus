//! The menu bar app's macOS side: one instance per user (a file lock), the
//! tao event loop AppKit requires, which drives `tray::Tray`, `open` as the
//! opener, leaving through launchd, logging in and out (enroll.rs) and
//! uninstalling — AppleScript's dialogs through osascript, each on a thread
//! of its own — and Login Items' word on the service.
//!
//! **The first open.** The same executable is Daedalus Agent.app's main
//! one, so opening the app from Finder runs it outside launchd
//! (`XPC_SERVICE_NAME` is not the job's label). Then it is an opener, not
//! the menu bar app: with this version or a newer one installed, it starts
//! the menu bar app in this login (the installed one, from its own place)
//! and leaves; otherwise one administrator prompt — saying what it
//! installs and for whom — runs this bundle's `install --installer-uid
//! <this user>`, which puts the bundle in its place and starts both jobs.
//! Under `DAEDALUS_AGENT_SMOKE` it builds the menu and leaves (CI).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

use crate::enroll::{Begin, Loopback, Outcome, LOG_IN_TIMEOUT};
use crate::local::LocalRequest;
use crate::os::mac::bundle;
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
    let _ = std::process::Command::new("/bin/launchctl")
        .args([
            "bootout",
            &format!("gui/{uid}/{}", super::launchd::TRAY_LABEL),
        ])
        .spawn();
}

/// Set in CI: build the menu, then leave with 0 (or 1 and `tray.err`).
const SMOKE_ENV: &str = "DAEDALUS_AGENT_SMOKE";

pub fn run() -> Result<()> {
    if std::env::var_os(SMOKE_ENV).is_some() {
        smoke();
    }
    if let Some(app) = opened_by_hand() {
        first_open(&app);
        return Ok(());
    }
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

/// The menu built once, in the event loop AppKit wants it in; nothing else.
fn smoke() -> ! {
    let mut event_loop = EventLoop::new();
    event_loop.set_activation_policy(ActivationPolicy::Accessory);
    event_loop.run(move |event, _, control_flow| {
        if let Event::NewEvents(StartCause::Init) = event {
            *control_flow = match crate::tray::smoke() {
                Ok(()) => ControlFlow::Exit,
                Err(e) => {
                    write_failure(&e);
                    ControlFlow::ExitWithCode(1)
                }
            };
        }
    })
}

// ── the first open ────────────────────────────────────────────────────────

/// The bundle this runs from, when it was opened by hand rather than by its
/// launchd job; None for the job, and for a development build outside any
/// bundle.
fn opened_by_hand() -> Option<std::path::PathBuf> {
    let job = std::env::var("XPC_SERVICE_NAME").is_ok_and(|v| v == super::launchd::TRAY_LABEL);
    if job {
        return None;
    }
    bundle::running_app()
}

/// What opening the app does (the module doc): start the installed menu
/// bar app, or install this one behind the administrator prompt.
fn first_open(app: &Path) {
    let mine = match bundle::info(app) {
        Ok(i) => i.version,
        Err(e) => {
            return tell(
                &format!("This copy of Daedalus Agent is damaged: {e:#}"),
                false,
            )
        }
    };
    // SAFETY: no arguments.
    let uid = unsafe { libc::getuid() };
    if bundle::installed().is_some_and(|v| v >= mine) {
        if let Err(e) = super::launchd::start_tray(uid) {
            tell(
                &format!("Daedalus Agent is installed, but its menu bar item did not start: {e:#}"),
                false,
            );
        }
        return;
    }
    let user = super::launchd::account_of_uid(uid)
        .map(|(name, _)| name)
        .unwrap_or_else(|| format!("uid {uid}"));
    let args = [
        "install".to_string(),
        "--installer-uid".to_string(),
        uid.to_string(),
    ];
    match elevated(&bundle::service_exe(app), &args, &install_prompt(&user)) {
        Elevated::Done(_) | Elevated::Cancelled => {}
        Elevated::Failed(e) => tell(&format!("Daedalus Agent was not installed: {e}"), false),
    }
}

/// The administrator prompt's words for an install: what it puts on the
/// Mac, and the one account it serves (review S3).
fn install_prompt(user: &str) -> String {
    format!(
        "Daedalus Agent is installing a background service that runs as root, and a menu \
         bar item. It serves {user}: only that account can log this Mac in to your box and \
         reach it through santree."
    )
}

/// How a run behind the administrator prompt ended.
enum Elevated {
    Done(String),
    Cancelled,
    Failed(String),
}

/// `exe args…` as root behind the administrator prompt, which says
/// `prompt` (tray.rs `osascript_argv`).
fn elevated(exe: &Path, args: &[String], prompt: &str) -> Elevated {
    let out = match std::process::Command::new("/usr/bin/osascript")
        .args(crate::tray::elevate::osascript_argv(exe, args, prompt))
        .output()
    {
        Ok(o) => o,
        Err(e) => return Elevated::Failed(format!("could not start osascript: {e}")),
    };
    if out.status.success() {
        return Elevated::Done(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if err.contains("-128") {
        Elevated::Cancelled
    } else {
        Elevated::Failed(err)
    }
}

// ── uninstalling, and Login Items ─────────────────────────────────────────

/// "Uninstall Daedalus Agent…": asked once, then the installed service's
/// `uninstall --app` behind the administrator prompt (launchd.rs): logged
/// out, the jobs and the app removed, this menu bar app last. The data
/// directory stays.
pub fn uninstall() {
    one_at_a_time("uninstall", || {
        let asked = osascript(
            "display dialog (item 1 of argv) with title (item 2 of argv) buttons \
             {\"Cancel\", \"Uninstall\"} default button \"Cancel\" cancel button \"Cancel\"",
            &[
                "Uninstall Daedalus Agent? This Mac logs out of the box, and the service, the \
                 menu bar item and the app are removed. Its identity stays, so installing again \
                 brings back the same machine.",
                TITLE,
            ],
        );
        if asked.is_none() {
            return Ok(None);
        }
        let exe = bundle::service_exe(&bundle::canonical());
        let args = ["uninstall".to_string(), "--app".to_string()];
        match elevated(
            &exe,
            &args,
            "Daedalus Agent is removing its background service, its menu bar item and the app.",
        ) {
            Elevated::Done(said) => Ok(Some(said)),
            Elevated::Cancelled => Ok(None),
            Elevated::Failed(e) => Err(format!("Not uninstalled: {e}")),
        }
    });
}

/// Whether the user switched the service off in System Settings › Login
/// Items: Background Task Management's status for the daemon's plist
/// (`SMAppService.statusForLegacyURL`).
pub fn service_switched_off() -> bool {
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    let path = super::launchd::daemon_plist();
    let url = objc2_foundation::NSURL::fileURLWithPath(&objc2_foundation::NSString::from_str(
        &path.to_string_lossy(),
    ));
    // SAFETY: a file URL, read by a class method with no other input.
    let status = unsafe { SMAppService::statusForLegacyURL(&url) };
    status == SMAppServiceStatus::RequiresApproval
}

/// System Settings, at Login Items.
pub fn open_login_items() {
    // SAFETY: no arguments; it opens a pane.
    unsafe { objc2_service_management::SMAppService::openSystemSettingsLoginItems() }
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
    let begin: Begin = crate::local::call(&LocalRequest::EnrollBegin(crate::local::BeginParams {
        app_url: typed,
    }))
    .map_err(|e| format!("Not logged in: {e}"))?;
    let loopback = Loopback::new().map_err(|e| format!("Not logged in: {e}"))?;
    *NOTE.lock_ok() = Some(format!(
        "Confirm in your browser — this Mac is {}",
        crate::settings::short_fingerprint(&begin.fingerprint)
    ));
    open(&loopback.url(&begin));
    let code = match loopback.wait(LOG_IN_TIMEOUT) {
        Ok(Outcome::Code(c)) => c,
        Ok(Outcome::Denied) => return Err("Not logged in: declined on the app's page.".into()),
        Err(e) => return Err(format!("Not logged in: {e}")),
    };
    *NOTE.lock_ok() = Some("Logging in — confirm with this Mac's password".into());
    let exe = crate::tray::elevate::agent_exe()?;
    match elevated(
        &exe,
        &["enroll-finish".to_string(), code],
        "Daedalus Agent is logging this Mac in to your box.",
    ) {
        Elevated::Done(said) if said.is_empty() => Ok(Some("Logged in.".into())),
        Elevated::Done(said) => Ok(Some(said)),
        Elevated::Cancelled => Err("Not logged in: cancelled at the administrator prompt.".into()),
        Elevated::Failed(e) => Err(format!("Not logged in: {e}")),
    }
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
        crate::local::call_within::<String>(
            &LocalRequest::EnrollLeave,
            crate::local::ENROLL_DEADLINE,
        )
        .map(Some)
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

/// Copy `text` to the clipboard: muda has no clipboard, so `pbcopy` takes
/// it on its stdin, on a thread of its own (the menu never waits on it).
pub fn copy(text: &str) {
    let text = text.to_string();
    let _ = std::thread::Builder::new()
        .name("copy".into())
        .spawn(move || {
            use std::io::Write;
            let Ok(mut child) = std::process::Command::new("/usr/bin/pbcopy")
                .stdin(std::process::Stdio::piped())
                .spawn()
            else {
                return;
            };
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        });
}
