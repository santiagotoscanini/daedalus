//! The `claude` command: where it is, how it was installed, and its
//! version — probed through the shared bounded shell-out (exec.rs), which
//! kills it at a deadline and hides it on Windows, as it does
//! `claude update` for the supervisor.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::profile::home_dir;
use super::InstallMethod;
use crate::exec;

/// The `claude` command: the native install's place first, then npm's, then
/// Homebrew's two prefixes, then PATH — the fixed places before PATH
/// because the tray's PATH is the one it was started with (Explorer's at
/// logon, launchd's system default), which misses them or predates an
/// install made since. The file names are the OS's
/// (`os::CLAUDE_CLI_NAMES`: `claude.exe`, `.cmd`, `.bat` on Windows).
pub fn find_cli() -> Option<PathBuf> {
    let names = crate::os::CLAUDE_CLI_NAMES;
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = home_dir() {
        dirs.push(h.join(".local").join("bin"));
    }
    if let Some(a) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(a).join("npm"));
    }
    // A LaunchAgent's PATH is the system's four directories; Homebrew
    // (Apple silicon and Intel) lives outside it.
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

/// How Claude Code was installed here, named from where `find_cli` found it.
///
/// It decides which verb updates it, and `claude update` is only the right
/// one for the first two. For a package-manager install it is a documented
/// no-op that answers "Claude is up to date!", and the upgrade goes through
/// that manager — which is what `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE`
/// on the spawned server asks Claude Code to do for itself.
pub fn install_method(cli: &Path) -> InstallMethod {
    let p = cli.to_string_lossy().replace('\\', "/").to_lowercase();
    if p.contains("/.local/bin/") || p.contains("/.local/share/claude/") {
        InstallMethod::Native
    } else if p.contains("/npm/") || p.contains("/node_modules/") {
        InstallMethod::Npm
    } else if p.contains("/homebrew/") || p.contains("/cellar/") {
        InstallMethod::Homebrew
    } else if p.contains("/winget") || p.contains("/windowsapps/") {
        InstallMethod::Winget
    } else {
        InstallMethod::Path
    }
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

/// "2.1.276 (Claude Code)" → "2.1.276".
pub fn parse_version(line: &str) -> Option<String> {
    let v = line.split_whitespace().next()?;
    v.chars().next().filter(char::is_ascii_digit)?;
    Some(v.to_string())
}

pub fn cli_version(cli: &Path) -> Option<String> {
    let mut cmd = Command::new(cli);
    cmd.arg("--version");
    exec::first_line(cmd, Duration::from_secs(20)).and_then(|l| parse_version(&l))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The path find_cli returned is the whole of what names the install
    // method, so these are the shapes it actually returns on each OS.
    #[test]
    fn the_install_method_is_read_off_the_path() {
        let m = |p: &str| install_method(Path::new(p));
        assert_eq!(m("/home/u/.local/bin/claude"), InstallMethod::Native);
        assert_eq!(
            m("C:\\Users\\u\\.local\\bin\\claude.exe"),
            InstallMethod::Native
        );
        assert_eq!(
            m("/home/u/.local/share/claude/versions/2.1.281"),
            InstallMethod::Native
        );
        assert_eq!(
            m("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd"),
            InstallMethod::Npm
        );
        assert_eq!(
            m("/usr/lib/node_modules/@anthropic-ai/claude-code/claude"),
            InstallMethod::Npm
        );
        assert_eq!(m("/opt/homebrew/bin/claude"), InstallMethod::Homebrew);
        // Anything else is still updatable by `claude update`; it just has
        // no name, and the page says nothing rather than guessing.
        assert_eq!(m("/usr/local/bin/claude"), InstallMethod::Path);
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
