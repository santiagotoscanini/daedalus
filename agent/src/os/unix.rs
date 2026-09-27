//! What macOS and Linux share: the machine's name from `gethostname`, the
//! identity file's 0600 posture, the executable bit, the Ctrl-C / SIGTERM
//! relay, and processes in groups of their own. Each OS module re-exports
//! the parts it uses.

use std::path::Path;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};

/// `gethostname`, without a DHCP or `.local` suffix; None when it fails or
/// is empty (launchd hands a daemon no HOSTNAME, so this is the fallback).
pub fn short_hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: a buffer of the stated size; the name is NUL-terminated.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
    name.split('.')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The seed is kept as it is: the file's mode is the protection, the
/// ordinary SSH-key posture.
pub fn seal(seed: &[u8]) -> Result<Vec<u8>> {
    Ok(seed.to_vec())
}

pub fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    Ok(sealed.to_vec())
}

/// Write a file only its owner can read: created 0600.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("writing {}", path.display()))?;
    std::io::Write::write_all(&mut f, bytes)?;
    Ok(())
}

/// Mode 0755: a downloaded binary is not executable until it is said to be.
pub fn mark_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

/// No console to hide on unix.
pub fn hide_console(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Signal 0 delivers nothing and says whether the pid exists (EPERM means
/// it does, owned by someone else).
pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: kill with signal 0 has no effect on the target.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Run the child in a process group of its own, so `stop_process_tree` can
/// reach what it spawns and not only the child.
pub fn own_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

/// SIGTERM to the group the child leads (`own_process_group`), then a
/// moment — two seconds — to leave on its own. The caller kills and reaps
/// whatever is left.
pub fn stop_process_tree(child: &mut Child) {
    let pid = child.id();
    // SAFETY: a signal to the group the child leads; nothing else is in it.
    unsafe {
        let _ = libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
    }
    for _ in 0..20 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// SIGINT or SIGTERM runs `f`, once. A C handler cannot carry a closure; a
/// flag and a relay thread can — the thread looks every 200 ms. What `serve`
/// uses in a terminal, and what `run` uses under launchd, which sends
/// SIGTERM on `bootout` and at shutdown.
pub fn on_interrupt<F: Fn() + Send + Sync + 'static>(f: F) {
    static HIT: AtomicBool = AtomicBool::new(false);
    extern "C" fn on_signal(_: libc::c_int) {
        HIT.store(true, Ordering::Relaxed);
    }
    // SAFETY: the handler only stores to an atomic.
    unsafe {
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
    }
    std::thread::spawn(move || loop {
        if HIT.load(Ordering::Relaxed) {
            f();
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    });
}

/// `claude`, on every unix.
pub const CLAUDE_CLI_NAMES: &[&str] = &["claude"];
