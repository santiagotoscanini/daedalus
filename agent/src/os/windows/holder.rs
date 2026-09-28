//! `daedalus-agent claude-holder <command line>`: a resumed Claude session's
//! terminal on Windows.
//!
//! `claude --resume` needs a terminal (with pipes it falls back to
//! `--print` and exits), and on Windows a terminal a process can own
//! without a window is a pseudo-console. The session (the tray) starts this
//! agent's own binary in this mode as a detached job (jobs.rs), in the
//! session's directory and with its log as stdout; the holder makes a
//! pseudo-console (`CreatePseudoConsole`), starts the command line in it,
//! drains what it shows — escape sequences stripped, the status box's lines
//! dropped (`claude::job::LineFilter`) — into the log, and leaves with the
//! CLI's exit code. Nothing is ever typed into it: the session is driven
//! from claude.ai through `--remote-control`.
//!
//! Its input pipe stays open for the holder's life: a pseudo-console whose
//! input closes ends its client.

use std::io::Write;

use anyhow::{bail, Context, Result};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::ReadFile;
use windows::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, COORD, HPCON};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, UpdateProcThreadAttribute, WaitForSingleObject,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTUPINFOEXW,
};

use crate::claude::job::LineFilter;

/// The pseudo-console's size: wide enough that the CLI does not wrap the
/// lines worth keeping.
const SIZE: COORD = COORD { X: 160, Y: 50 };

/// A handle that crosses to the reader thread (a raw handle is not `Send`).
struct Sendable(isize);
// SAFETY: a pipe handle may be read from any thread.
unsafe impl Send for Sendable {}

pub fn run(args: &[String]) -> Result<i32> {
    let [line] = args else {
        bail!("usage: daedalus-agent claude-holder <command line>");
    };
    // SAFETY: plain Win32 calls; every handle made here is closed here, and
    // the attribute list's buffer outlives the process start that reads it.
    unsafe {
        let (mut in_read, mut in_write) = (HANDLE::default(), HANDLE::default());
        let (mut out_read, mut out_write) = (HANDLE::default(), HANDLE::default());
        CreatePipe(&mut in_read, &mut in_write, None, 0).context("the input pipe")?;
        CreatePipe(&mut out_read, &mut out_write, None, 0).context("the output pipe")?;
        let hpc: HPCON =
            CreatePseudoConsole(SIZE, in_read, out_write, 0).context("CreatePseudoConsole")?;
        // The pseudo-console holds its own copies.
        let _ = CloseHandle(in_read);
        let _ = CloseHandle(out_write);

        let mut size = 0usize;
        // Asks for the size; "fails" with the buffer too small, by design.
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut size);
        let mut buf = vec![0u8; size.max(64)];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buf.as_mut_ptr().cast());
        InitializeProcThreadAttributeList(Some(list), 1, None, &mut size)
            .context("InitializeProcThreadAttributeList")?;
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            Some(hpc.0 as *const core::ffi::c_void),
            std::mem::size_of::<HPCON>(),
            None,
            None,
        )
        .context("UpdateProcThreadAttribute")?;
        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.lpAttributeList = list;
        let mut wide: Vec<u16> = line.encode_utf16().chain(std::iter::once(0)).collect();
        let mut pi = PROCESS_INFORMATION::default();
        let started = CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(wide.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT,
            None,
            PCWSTR::null(),
            &si.StartupInfo,
            &mut pi,
        );
        if let Err(e) = started {
            DeleteProcThreadAttributeList(list);
            ClosePseudoConsole(hpc);
            bail!("the session was not started: {e}");
        }
        println!("── claude-holder: started pid {} ──", pi.dwProcessId);

        let out = Sendable(out_read.0 as isize);
        let reader = std::thread::spawn(move || {
            let h = HANDLE(out.0 as *mut core::ffi::c_void);
            let mut filter = LineFilter::default();
            let mut chunk = [0u8; 8192];
            let stdout = std::io::stdout();
            loop {
                let mut n = 0u32;
                if ReadFile(h, Some(&mut chunk), Some(&mut n), None).is_err() || n == 0 {
                    break;
                }
                let mut o = stdout.lock();
                for l in filter.feed(&chunk[..n as usize]) {
                    let _ = writeln!(o, "{l}");
                }
                let _ = o.flush();
            }
            let mut o = stdout.lock();
            for l in filter.finish() {
                let _ = writeln!(o, "{l}");
            }
            let _ = CloseHandle(h);
        });

        WaitForSingleObject(pi.hProcess, INFINITE);
        let mut code = 0u32;
        let _ = GetExitCodeProcess(pi.hProcess, &mut code);
        // Closing the console ends the output stream, which ends the reader.
        ClosePseudoConsole(hpc);
        let _ = reader.join();
        let _ = CloseHandle(in_write);
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(pi.hProcess);
        DeleteProcThreadAttributeList(list);
        drop(buf);
        println!("── claude-holder: the session left with exit code {code} ──");
        Ok(code as i32)
    }
}
