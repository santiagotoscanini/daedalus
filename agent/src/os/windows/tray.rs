//! The tray's Windows side: one instance per session (a named mutex), the
//! Win32 message loop that drives `tray::Tray`, Explorer as the opener, and
//! the relaunch onto a new binary.

use std::time::Duration;

use anyhow::Result;

use crate::tray::{Flow, Tray};

/// Refuse to be the second tray. The mutex lives as long as the process.
///
/// Tried for up to ten seconds: after an update the OLD tray spawns us and
/// then leaves — a moment during which its mutex is still held (Claude runs
/// on in its own jobs; the new tray re-attaches to them). A
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

/// "Pair with the box…": Windows has no text-input dialog one call away,
/// so PowerShell's (Visual Basic's `InputBox`, part of .NET on every
/// Windows) asks, on a thread of its own, with no console; the answer is a
/// plain message box (tray.rs `pair_on_a_thread`).
pub fn ask_pairing() {
    crate::tray::pair_on_a_thread(input_box, message_box);
}

fn input_box() -> Option<String> {
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName Microsoft.VisualBasic; \
         [Microsoft.VisualBasic.Interaction]::InputBox($env:DAEDALUS_PROMPT, $env:DAEDALUS_TITLE, '')",
    ])
    // The words ride the environment, so nothing in them is PowerShell.
    .env("DAEDALUS_PROMPT", crate::tray::PAIR_PROMPT)
    .env("DAEDALUS_TITLE", crate::tray::PAIR_TITLE);
    super::hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // Cancel answers an empty string.
    (out.status.success() && !text.is_empty()).then_some(text)
}

fn message_box(text: &str, ok: bool) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONINFORMATION, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND,
    };
    let icon = if ok {
        MB_ICONINFORMATION
    } else {
        MB_ICONWARNING
    };
    // SAFETY: two valid wide strings that outlive the call; no owner window.
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(text),
            &HSTRING::from(crate::tray::PAIR_TITLE),
            MB_OK | MB_SETFOREGROUND | icon,
        );
    }
}
