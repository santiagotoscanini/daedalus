//! The `claude` command: where it is, how it was installed, and running
//! it — to completion or killed at a deadline, hidden on Windows — for the
//! version probe and `claude update`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::profile::home_dir;

/// The `claude` command: the native install's place first, then npm's, then
/// PATH — asked in that order because the tray's PATH is the one Explorer
/// had at logon, which predates an install made since.
pub fn find_cli() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd", "claude.bat"]
    } else {
        &["claude"]
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = home_dir() {
        dirs.push(h.join(".local").join("bin"));
    }
    if let Some(a) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(a).join("npm"));
    }
    // A LaunchAgent's PATH is the system's four directories; Homebrew and
    // the native installer both live outside it.
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(PathBuf::from(d));
    }
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    dirs.into_iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

pub(super) fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// How Claude Code was installed here, named from where `find_cli` found it.
///
/// It decides which verb updates it, and `claude update` is only the right
/// one for the first two. For a package-manager install it is a documented
/// no-op that answers "Claude is up to date!", and the upgrade goes through
/// that manager — which is what `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE`
/// on the spawned server asks Claude Code to do for itself.
pub fn install_method(cli: &Path) -> &'static str {
    let p = cli.to_string_lossy().replace('\\', "/").to_lowercase();
    if p.contains("/.local/bin/") || p.contains("/.local/share/claude/") {
        "native"
    } else if p.contains("/npm/") || p.contains("/node_modules/") {
        "npm"
    } else if p.contains("/homebrew/") || p.contains("/cellar/") {
        "homebrew"
    } else if p.contains("/winget") || p.contains("/windowsapps/") {
        "winget"
    } else {
        "path"
    }
}

/// What a command did: its status and everything it printed.
///
/// `first_line` below is this, narrowed to the one line a version probe
/// wants — it discarded stderr and the exit code, which is exactly what an
/// update run needs to report. A refusal ("Updates are disabled by your
/// administrator") arrives on one stream or the other depending on the
/// version, so both are captured and joined.
pub struct Ran {
    pub ok: bool,
    /// stdout and stderr, in the order each thread finished reading them.
    pub output: String,
}

/// Run to completion, or kill it and give up after `timeout`.
pub(super) fn run(mut cmd: Command, timeout: Duration) -> Option<Ran> {
    let mut child = hidden(&mut cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    // Both pipes drained on their own threads: a child that fills one while
    // nobody reads the other blocks forever, and `claude update` is chatty
    // on both.
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    let (tx, rx) = mpsc::channel();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        let _ = tx2.send(s);
    });
    let deadline = Instant::now() + timeout;
    let mut text = String::new();
    for _ in 0..2 {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(s) => {
                if !s.trim().is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(s.trim());
                }
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let status = child.wait().ok()?;
    Some(Ran {
        ok: status.success(),
        output: text,
    })
}

/// The last line worth showing of an update run, cut to a status field.
pub(super) fn last_meaningful(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("no output")
        .chars()
        .take(200)
        .collect()
}

/// Run a command to completion, or give up after `timeout`; the first line
/// of its stdout, trimmed. `run` above is this with both streams and the
/// exit code, which a version probe does not want and an update run does.
fn first_line(mut cmd: Command, timeout: Duration) -> Option<String> {
    let mut child = hidden(&mut cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let text = match rx.recv_timeout(timeout) {
        Ok(t) => t,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();
    text.lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// "2.1.276 (Claude Code)" → "2.1.276".
pub fn parse_version(line: &str) -> Option<String> {
    let v = line.split_whitespace().next()?;
    v.chars().next().filter(char::is_ascii_digit)?;
    Some(v.to_string())
}

pub fn cli_version(cli: &Path) -> Option<String> {
    let mut cmd = Command::new(cli);
    cmd.arg("--version");
    first_line(cmd, Duration::from_secs(20)).and_then(|l| parse_version(&l))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The path find_cli returned is the whole of what names the install
    // method, so these are the shapes it actually returns on each OS.
    #[test]
    fn the_install_method_is_read_off_the_path() {
        let m = |p: &str| install_method(Path::new(p));
        assert_eq!(m("/home/u/.local/bin/claude"), "native");
        assert_eq!(m("C:\\Users\\u\\.local\\bin\\claude.exe"), "native");
        assert_eq!(m("/home/u/.local/share/claude/versions/2.1.281"), "native");
        assert_eq!(m("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd"), "npm");
        assert_eq!(
            m("/usr/lib/node_modules/@anthropic-ai/claude-code/claude"),
            "npm"
        );
        assert_eq!(m("/opt/homebrew/bin/claude"), "homebrew");
        // Anything else is still updatable by `claude update`; it just has
        // no name, and the page says nothing rather than guessing.
        assert_eq!(m("/usr/local/bin/claude"), "path");
    }

    // Every branch of the update record has to produce something a person
    // can read, including the one where the command said nothing at all.
    #[test]
    fn the_last_meaningful_line_is_what_gets_reported() {
        assert_eq!(
            last_meaningful(
                "Checking for updates...\nSuccessfully updated from 2.1.276 to version 2.1.281\n\n"
            ),
            "Successfully updated from 2.1.276 to version 2.1.281"
        );
        assert_eq!(
            last_meaningful("Claude is up to date!"),
            "Claude is up to date!"
        );
        assert_eq!(last_meaningful("   \n\n  "), "no output");
        assert_eq!(last_meaningful(""), "no output");
        assert_eq!(last_meaningful(&"x".repeat(400)).len(), 200);
    }

    #[test]
    fn version_line() {
        assert_eq!(
            parse_version("2.1.276 (Claude Code)").as_deref(),
            Some("2.1.276")
        );
        assert_eq!(parse_version("Claude Code 2.1.276"), None);
        assert_eq!(parse_version(""), None);
    }
}
