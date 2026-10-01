//! Joining the box from the tray: the pasted key checked and the `pair`
//! verb run as an administrator behind the OS's own prompt — polkit's
//! `pkexec`, osascript's administrator prompt, UAC — with its words as
//! arguments only.

use std::path::PathBuf;

/// The pairing dialog's title and prompt (os/*/tray.rs `join`).
#[cfg(not(target_os = "macos"))]
pub const PAIR_TITLE: &str = "Pair with the box";
#[cfg(not(target_os = "macos"))]
pub const PAIR_PROMPT: &str = "Paste the controller key from Settings › Machines on the box. \
     The whole pair or install line from that page works too.";

/// What the dialog's text becomes: the `pair` verb, run as an
/// administrator behind the OS's own prompt (os/*/tray.rs
/// `pair_elevated`: UAC, macOS's administrator password, polkit), or the
/// reason it did not, for the answer's dialog. Pairing names the
/// controller that commands this machine's service, so it asks what
/// `install` asks; the tray never writes config.toml, and the local
/// socket has no door for it (ipc/local/). The paste is checked first
/// (pair.rs `parse_pasted`): nothing malformed ever reaches the prompt,
/// and only the checked key and address — a fingerprint and host:port —
/// reach the command line.
#[cfg(not(target_os = "macos"))]
pub fn pair_pasted(text: &str) -> std::result::Result<String, String> {
    let (exe, args, p) = pair_command(text)?;
    crate::os::tray::pair_elevated(&exe, &args, &p)
}

/// The paste, checked, as the agent binary beside the tray and the `pair`
/// arguments to run it with.
#[cfg(not(target_os = "macos"))]
pub(super) fn pair_command(
    text: &str,
) -> std::result::Result<(PathBuf, Vec<String>, crate::node::pair::Pairing), String> {
    let p = crate::node::pair::parse_pasted(text).map_err(|e| format!("{e:#}"))?;
    Ok((agent_exe()?, pair_args(&p), p))
}

/// `pair --pin KEY [--controller HOST:PORT]` for a checked pairing.
#[cfg(not(target_os = "macos"))]
pub fn pair_args(p: &crate::node::pair::Pairing) -> Vec<String> {
    let mut a = vec!["pair".to_string(), "--pin".to_string(), p.pin.clone()];
    if let Some(c) = &p.controller {
        a.extend(["--controller".to_string(), c.clone()]);
    }
    a
}

/// The service's binary, installed beside the tray on every OS.
pub(crate) fn agent_exe() -> std::result::Result<PathBuf, String> {
    let me = std::env::current_exe().map_err(|e| format!("locating the tray: {e}"))?;
    let exe = me.with_file_name(format!(
        "{}{}",
        crate::SERVICE_NAME,
        std::env::consts::EXE_SUFFIX
    ));
    if exe.is_file() {
        Ok(exe)
    } else {
        Err(format!("no {} beside the tray", exe.display()))
    }
}

/// Linux: polkit's `pkexec` runs the agent as root, after its own prompt.
#[cfg(any(test, target_os = "linux"))]
pub fn pkexec_argv(
    pkexec: &std::path::Path,
    exe: &std::path::Path,
    args: &[String],
) -> Vec<std::ffi::OsString> {
    let mut v = vec![pkexec.as_os_str().to_owned(), exe.as_os_str().to_owned()];
    v.extend(args.iter().map(Into::into));
    v
}

/// macOS: osascript's arguments to run the agent as root behind the
/// administrator prompt, which says `prompt` (the app's install, a
/// log-in's `enroll-finish`, "Uninstall…"; os/macos/tray.rs). The script is
/// fixed; the binary, its arguments and the prompt ride `argv`, and each
/// word of the command is shell-quoted by AppleScript's `quoted form of`,
/// so nothing the browser sent — nor an account's name — is ever spliced
/// into the script or the shell line. The binary comes first: an absolute
/// path, so osascript reads every word after it as an argument, never an
/// option; the prompt is the last.
#[cfg(any(test, target_os = "macos"))]
pub fn osascript_argv(
    exe: &std::path::Path,
    args: &[String],
    prompt: &str,
) -> Vec<std::ffi::OsString> {
    const SCRIPT: [&str; 8] = [
        "on run argv",
        "set n to count of argv",
        "set cmd to quoted form of (item 1 of argv)",
        "repeat with i from 2 to (n - 1)",
        "set cmd to cmd & \" \" & quoted form of (item i of argv)",
        "end repeat",
        "do shell script cmd with prompt (item n of argv) \
         with administrator privileges without altering line endings",
        "end run",
    ];
    let mut v: Vec<std::ffi::OsString> = Vec::new();
    for line in SCRIPT {
        v.push("-e".into());
        v.push(line.into());
    }
    v.push(exe.as_os_str().to_owned());
    v.extend(args.iter().map(Into::into));
    v.push(prompt.into());
    v
}

/// Windows: `ShellExecuteExW`'s parameters line, each argument quoted as
/// `CommandLineToArgvW` (and Rust's own argument parsing) reads it back.
#[cfg(any(test, windows))]
pub fn windows_parameters(args: &[String]) -> String {
    let mut line = String::new();
    for (i, a) in args.iter().enumerate() {
        if i > 0 {
            line.push(' ');
        }
        if !a.is_empty() && !a.contains([' ', '\t', '\n', '\u{b}', '"']) {
            line.push_str(a);
            continue;
        }
        line.push('"');
        let mut slashes = 0;
        for c in a.chars() {
            match c {
                '\\' => slashes += 1,
                '"' => {
                    line.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
                    line.push('"');
                    slashes = 0;
                }
                c => {
                    line.extend(std::iter::repeat_n('\\', slashes));
                    line.push(c);
                    slashes = 0;
                }
            }
        }
        line.extend(std::iter::repeat_n('\\', slashes * 2));
        line.push('"');
    }
    line
}

/// Windows, whose dialogs are another program (PowerShell): ask on a thread
/// of its own so the tray's loop never waits on a person, pair with what
/// came back, and show the outcome. One at a time.
#[cfg(windows)]
pub fn pair_on_a_thread(ask: fn() -> Option<String>, tell: fn(&str, bool)) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static OPEN: AtomicBool = AtomicBool::new(false);
    if OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("pair".into())
        .spawn(move || {
            if let Some(text) = ask().filter(|t| !t.trim().is_empty()) {
                match pair_pasted(&text) {
                    Ok(said) => tell(&said, true),
                    Err(e) => tell(&format!("Not paired: {e}"), false),
                }
            }
            OPEN.store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        OPEN.store(false, Ordering::SeqCst);
    }
}
