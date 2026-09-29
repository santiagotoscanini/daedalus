//! The menu bar app's macOS side: one instance per user (a file lock), the
//! tao event loop AppKit requires, which drives `tray::Tray`, `open` as the
//! opener, and leaving through launchd.

use std::time::{Duration, Instant};

use anyhow::Result;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

use crate::paths;
use crate::tray::{write_failure, Flow, Tray};

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
