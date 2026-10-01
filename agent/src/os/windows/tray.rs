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
pub fn join() {
    crate::tray::elevate::pair_on_a_thread(input_box, message_box);
}

/// How long the question waits for an answer before it is put away.
const ASK_FOR: std::time::Duration = std::time::Duration::from_secs(15 * 60);

fn input_box() -> Option<String> {
    // Windows PowerShell from the system directory, never one on PATH.
    let ps = super::system_tool(r"WindowsPowerShell\v1.0\powershell.exe")?;
    let mut cmd = std::process::Command::new(ps);
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName Microsoft.VisualBasic; \
         [Microsoft.VisualBasic.Interaction]::InputBox($env:DAEDALUS_PROMPT, $env:DAEDALUS_TITLE, '')",
    ])
    // The words ride the environment, so nothing in them is PowerShell.
    .env("DAEDALUS_PROMPT", crate::tray::elevate::PAIR_PROMPT)
    .env("DAEDALUS_TITLE", crate::tray::elevate::PAIR_TITLE);
    let text = crate::exec::stdout_or(cmd, ASK_FOR, crate::exec::Text::Lossy).ok()?;
    let text = text.trim().to_string();
    // Cancel answers an empty string.
    (!text.is_empty()).then_some(text)
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
            &HSTRING::from(crate::tray::elevate::PAIR_TITLE),
            MB_OK | MB_SETFOREGROUND | icon,
        );
    }
}

/// Run `pair` as an administrator behind UAC: `ShellExecuteExW` with the
/// verb `runas` on the agent binary, its window hidden, waited for, and
/// judged by its exit code (an elevated process's output cannot be read
/// from here). The parameters are the checked arguments, quoted as
/// `CommandLineToArgvW` reads them (tray.rs `windows_parameters`).
pub fn pair_elevated(
    exe: &std::path::Path,
    args: &[String],
    p: &crate::pair::Pairing,
) -> Result<String, String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED};
    use windows::Win32::System::Com::{
        CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
    let by_hand = || {
        format!(
            "In an administrator PowerShell:\n  {}",
            crate::pair::command_line(&p.pin, p.controller.as_deref())
        )
    };
    let file = HSTRING::from(exe.as_os_str());
    let params = HSTRING::from(crate::tray::elevate::windows_parameters(args));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    // SAFETY: `info` is sized and filled as the call documents; the wide
    // strings it points at outlive the call. COM is initialised on this
    // thread (the pairing thread) as ShellExecuteEx asks; a second
    // initialisation is harmless.
    let started = unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        ShellExecuteExW(&mut info)
    };
    if let Err(e) = started {
        if e.code() == ERROR_CANCELLED.to_hresult() {
            return Err("cancelled at the administrator prompt".into());
        }
        return Err(format!(
            "could not run `pair` as an administrator: {e}\n{}",
            by_hand()
        ));
    }
    if info.hProcess.is_invalid() {
        return Err(format!(
            "`pair` started without a process to wait for\n{}",
            by_hand()
        ));
    }
    let mut code = 1u32;
    // SAFETY: the handle is the started process's, ours to wait on and close.
    unsafe {
        WaitForSingleObject(info.hProcess, INFINITE);
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
    }
    if code == 0 {
        Ok(format!(
            "paired: this machine trusts {} and connects now",
            p.pin
        ))
    } else {
        Err(format!("`pair` exited with {code}\n{}", by_hand()))
    }
}

/// Copy `text` to the clipboard through `clip.exe`, with no console, on a
/// thread of its own. The values copied are ASCII (keys, addresses), which
/// every code page `clip` may read them in agrees on.
pub fn copy(text: &str) {
    let text = text.to_string();
    let _ = std::thread::Builder::new()
        .name("copy".into())
        .spawn(move || {
            use std::io::Write;
            let mut cmd = std::process::Command::new("clip.exe");
            cmd.stdin(std::process::Stdio::piped());
            super::hide_console(&mut cmd);
            let Ok(mut child) = cmd.spawn() else {
                return;
            };
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        });
}
