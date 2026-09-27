//! The tray's Windows side: one instance per session (a named mutex), the
//! Win32 message loop that drives `tray::Tray`, Explorer as the opener, and
//! the relaunch onto a new binary.

use std::time::Duration;

use anyhow::Result;

use crate::tray::{Flow, Tray};

/// Refuse to be the second tray. The mutex lives as long as the process.
///
/// Tried for up to ten seconds: after an update the OLD tray spawns us and
/// then leaves, and its leaving first stops the Claude server it
/// supervised — a second or two during which its mutex is still held. A
/// single check would quit the new tray on that overlap.
fn claim_single_instance() -> bool {
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

/// Start this same program again from its path, before leaving: the file
/// under our feet is a newer one by then, and nothing else would start it
/// until the next logon.
pub fn relaunch_self() {
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
    let mut t = Tray::start()?;
    loop {
        if !pump() {
            return Ok(());
        }
        if t.menu() == Flow::Quit || t.tick() == Flow::Quit {
            return Ok(());
        }
        wait_for_input(Duration::from_millis(250));
    }
}
